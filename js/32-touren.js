// --- Meine Touren: gemerkte Planungen, am PC geplant und am Handy übernommen, ohne Konto.
// Gespeichert werden nur Wegpunkte mit ihrer Art, wie Valhalla sie kennt (break = Halt, through = Formpunkt);
// die Route rechnet jedes Gerät selbst neu. Abgleich über den Profil-Sync (26-profil.js) in einem eigenen Fach:
// Kennung = SHA-256(Profil-Kennung + ':touren'), Inhalt mit demselben AES-GCM-Schlüssel, der Server sieht nur Chiffrat.
// Zusammenführen je Tour nach Änderungszeit; gelöschte Touren bleiben als Grabstein (weg: true), damit sie nicht zurückkommen.
const TOUREN_MAX = 100;
let touren = store.get('touren', []); // [{ id, name, t, waypoints: [{ lat, lon, type, name, notiz?, nacht?, faehre? }], excluded, weg? }]
const tourenSichtbar = () => touren.filter(t => !t.weg).sort((a, b) => b.t - a.t);
const tourenSpeichern = () => {
  // Grabsteine nach 90 Tagen weg, sonst wächst die Liste endlos
  const alt = Date.now() - 90 * 86400e3;
  touren = touren.filter(t => !t.weg || t.t > alt);
  store.set('touren', touren);
  tourenZeigen();
};

function tourAusPlanung(name) {
  const wps = waypoints.filter(w => w.latlng);
  return {
    id: crypto.randomUUID(), name, t: Date.now(),
    waypoints: wps.map((w, i) => {
      const p = { lat: +w.latlng.lat.toFixed(6), lon: +w.latlng.lng.toFixed(6), name: kurzText(w),
        // Start und Ziel sind immer Halte; Formpunkte fährt Valhalla nur durch
        type: w.shaping && i > 0 && i < wps.length - 1 ? 'through' : 'break' };
      if (w.note) p.notiz = w.note;
      if (w.night) p.nacht = w.night;
      if (w.faehre) p.faehre = w.faehre;
      return p;
    }),
    excluded: excluded.map(ll => [+ll.lat.toFixed(6), +ll.lng.toFixed(6)]),
  };
}
function tourInPlanung(t) {
  const wps = t.waypoints.map(p => ({ latlng: L.latLng(p.lat, p.lon), text: p.name || '', shaping: p.type === 'through',
    ...(p.notiz ? { note: p.notiz } : {}), ...(p.nacht ? { night: p.nacht } : {}), ...(p.faehre ? { faehre: p.faehre } : {}) }));
  changeWaypoints(() => { waypoints = wps; excluded = (t.excluded || []).map(([a, b]) => L.latLng(a, b)); });
  map.fitBounds(L.latLngBounds(wps.map(w => w.latlng)), { padding: [30, 30] });
}

function tourenZeigen() {
  const liste = tourenSichtbar();
  $('tourenBox').hidden = !liste.length && !syncDaten;
  $('tourenZahl').textContent = liste.length ? `(${liste.length})` : '';
  $('tourenAbgleich').hidden = !syncDaten || !serverAn();
  $('tourenListe').innerHTML = liste.map(t => {
    const halte = t.waypoints.filter(p => p.type === 'break').length, form = t.waypoints.length - halte;
    return `<li><button class="touren-laden" data-id="${t.id}">${escapeHtml(t.name)}</button>` +
      `<span class="hint">${new Date(t.t).toLocaleDateString('de-DE')} · ${halte} Halte${form ? ` · ${form} ◆` : ''}</span>` +
      `<button class="secondary" data-weg="${t.id}" title="Tour löschen">✕</button></li>`;
  }).join('') || '<li class="hint">Noch keine Tour gemerkt. Route planen, dann ⭐ Tour merken.</li>';
}
$('tourenListe').onclick = e => {
  const laden = e.target.closest('[data-id]')?.dataset.id, weg = e.target.closest('[data-weg]')?.dataset.weg;
  const t = touren.find(x => x.id === (laden || weg));
  if (!t) return;
  if (laden) {
    const leer = !waypoints.some(w => w.latlng && w.text !== OWN_LOCATION);
    if (leer || confirm(`Tour „${t.name}“ laden? Die aktuelle Planung lässt sich mit ↶ zurückholen.`)) tourInPlanung(t);
    return;
  }
  if (!confirm(`Tour „${t.name}“ löschen?`)) return;
  Object.assign(t, { weg: true, t: Date.now(), waypoints: [], excluded: [] });
  tourenSpeichern();
  if (syncDaten && serverAn()) tourenAbgleichen(true);
};

// Knopf wie „Tour als GPX“: erst mit fertiger Route
new MutationObserver(() => { $('tourMerken').hidden = $('gpxTour').hidden; }).observe($('gpxTour'), { attributes: true, attributeFilter: ['hidden'] });
$('tourMerken').onclick = async () => {
  const s = waypoints[0]?.text === OWN_LOCATION ? 'Start' : waypoints[0]?.text, z = waypoints.at(-1)?.text;
  const name = prompt('Name der Tour', s && z ? `${s.split(',')[0]} → ${z.split(',')[0]}` : 'Tour');
  if (name === null) return;
  if (tourenSichtbar().length >= TOUREN_MAX) { alert(`Höchstens ${TOUREN_MAX} Touren. Bitte erst alte löschen.`); return; }
  touren.push(tourAusPlanung(name.trim().slice(0, 80) || 'Tour'));
  tourenSpeichern();
  $('tourenBox').open = true;
  $('tourenStatus').textContent = '⭐ Gemerkt.';
  if (syncDaten && serverAn()) tourenAbgleichen(true);
};

// --- Abgleich über den eigenen Server (eigenes Fach neben dem Profil)
async function tourenFach() {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(syncDaten.id + ':touren'));
  return Array.from(new Uint8Array(h), x => x.toString(16).padStart(2, '0')).join('');
}
async function tourenAnfrage(body) {
  const res = await fetch(API_URL + 'profil.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: await tourenFach(), ...body }) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.fehler || 'Server meldet ' + res.status);
  return j;
}
function tourenZusammen(a, b) {
  const m = new Map();
  for (const t of [...a, ...b]) if (t?.id && (!m.has(t.id) || m.get(t.id).t < t.t)) m.set(t.id, t);
  return [...m.values()];
}
let tourenLaeuft = false;
async function tourenAbgleichen(leise = false) {
  // Server-Einstellung noch nicht geladen (frisch gekoppelt): nachholen, sobald sie da ist
  if (syncDaten && !serverAn()) tourenAbgleichen.offen = true;
  if (tourenLaeuft || !syncDaten || !serverAn()) return;
  tourenAbgleichen.offen = false;
  tourenLaeuft = true;
  const st = $('tourenStatus');
  try {
    if (!leise) st.textContent = 'Gleiche ab …';
    const j = await tourenAnfrage({ aktion: 'runter' });
    let fern = [];
    if (!j.leer) {
      const d = b64uDec(j.daten);
      if (d[0] !== 1) throw new Error('Unbekanntes Format');
      let roh;
      try { roh = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: d.slice(1, 13) }, await syncSchluessel(), d.slice(13)); }
      catch { throw new Error('Nicht lesbar: anderes Sync-Passwort?'); }
      const inhalt = JSON.parse(new TextDecoder().decode(await strom(roh, new DecompressionStream('gzip'))));
      if (inhalt?.app !== 'scooterways-touren' || !Array.isArray(inhalt.touren)) throw new Error('Keine Scooterways-Touren');
      fern = inhalt.touren;
    }
    const vorher = tourenSichtbar().length;
    touren = tourenZusammen(touren, fern);
    tourenSpeichern();
    const roh = await strom(JSON.stringify({ app: 'scooterways-touren', version: 1, touren }), new CompressionStream('gzip'));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await syncSchluessel(), roh));
    const daten = new Uint8Array(13 + ct.length); daten.set([1]); daten.set(iv, 1); daten.set(ct, 13);
    await tourenAnfrage({ aktion: 'hoch', daten: b64u(daten) });
    const neu = tourenSichtbar().length - vorher;
    st.textContent = `☁️ Abgeglichen ${new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}` + (neu > 0 ? `, ${neu} neu` : '');
  } catch (e) { st.textContent = '⚠️ ' + e.message; }
  finally { tourenLaeuft = false; }
}
$('tourenAbgleich').onclick = () => tourenAbgleichen();
// Beim Aufklappen einmal abgleichen, damit am Handy gleich die am PC gemerkten Touren da sind
$('tourenBox').addEventListener('toggle', () => { if ($('tourenBox').open && !tourenAbgleichen.einmal) { tourenAbgleichen.einmal = true; tourenAbgleichen(true); } });
document.addEventListener('serverkonfig', () => { tourenZeigen(); if (tourenAbgleichen.offen) tourenAbgleichen(); });

// --- Sicherung als Datei: ohne Konto gibt es kein „Passwort vergessen“
$('tourenExport').onclick = () => {
  const f = new File([JSON.stringify({ app: 'scooterways-touren', version: 1, erstellt: new Date().toISOString(), touren: tourenSichtbar() })],
    `scooterways-touren-${new Date().toISOString().slice(0, 10)}.json`, { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(f); a.download = f.name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  $('tourenStatus').textContent = `💾 ${f.name} gespeichert`;
};
$('tourenImport').onchange = async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const inhalt = JSON.parse(await f.text());
    if (inhalt?.app !== 'scooterways-touren' || !Array.isArray(inhalt.touren)) throw 0;
    const gueltig = inhalt.touren.filter(t => t?.id && Array.isArray(t.waypoints) && t.waypoints.length >= 2 && t.waypoints.every(p => Number.isFinite(p.lat) && Number.isFinite(p.lon)));
    const vorher = tourenSichtbar().length;
    touren = tourenZusammen(touren, gueltig.map(t => ({ ...t, name: String(t.name || 'Tour').slice(0, 80), weg: false })));
    tourenSpeichern();
    $('tourenStatus').textContent = `📂 ${tourenSichtbar().length - vorher} Touren übernommen`;
    if (syncDaten && serverAn()) tourenAbgleichen(true);
  } catch { $('tourenStatus').textContent = '⚠️ Das ist keine Scooterways-Tourendatei'; }
};

// --- Gerät koppeln: Kopplungslink mit Schlüssel und Fach-Kennung des Profil-Syncs im #-Teil.
// Der #-Teil geht nie an einen Server; wer den Link hat, kann das Profil lesen, deshalb nur aufs eigene Gerät.
const koppelLink = () => `${EIGENE_ADRESSE ? HAUPTADRESSE : location.href.replace(/[?#].*$/, '')}#koppeln=${syncDaten.k}.${syncDaten.id}`;
let qrLaden = null;
$('koppelnAuf').onclick = async () => {
  const link = koppelLink();
  $('koppelnLink').textContent = link;
  $('koppelnQr').replaceChildren();
  $('koppelnDlg').showModal();
  try {
    qrLaden ||= new Promise((ok, fehler) => {
      const s = document.createElement('script');
      s.src = 'vendor/qrcode-generator-1.4.4/qrcode.js'; s.onload = ok; s.onerror = fehler;
      document.head.append(s);
    });
    await qrLaden;
    const qr = qrcode(0, 'M'); qr.addData(link); qr.make();
    $('koppelnQr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  } catch { qrLaden = null; $('koppelnQr').textContent = 'QR-Code gerade nicht verfügbar. Link kopieren oder als Datei sichern.'; }
};
$('koppelnZu').onclick = () => $('koppelnDlg').close();
$('koppelnKopieren').onclick = () => navigator.clipboard.writeText(koppelLink())
  .then(() => { $('koppelnKopieren').textContent = 'Kopiert ✓'; setTimeout(() => $('koppelnKopieren').textContent = 'Link kopieren', 1500); }, () => {});
$('koppelnDatei').onclick = () => {
  const f = new File([`Scooterways-Kopplung (${new Date().toLocaleDateString('de-DE')})\n\nDieser Link verbindet ein Gerät mit deinem verschlüsselten Profil und deinen Touren.\n` +
    `Wer ihn hat, kann sie lesen: nur auf eigenen Geräten verwenden, nicht weitergeben.\n\n${koppelLink()}\n`], 'scooterways-kopplung.txt', { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(f); a.download = f.name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
};
function koppeln(text) {
  const m = /#koppeln=([A-Za-z0-9_-]{43})\.([a-f0-9]{64})/.exec(text || '');
  if (!m) return false;
  if (syncDaten?.k === m[1] && syncDaten?.id === m[2]) return true;
  if (!confirm(syncDaten ? 'Dieses Gerät ist schon mit einem Profil verbunden. Auf das Profil aus dem Kopplungslink umstellen?' :
    'Dieses Gerät mit deinem verschlüsselten Profil und deinen Touren verbinden?')) return true;
  syncDaten = { k: m[1], id: m[2] }; store.set('sync', syncDaten);
  syncZeigen.gefragt = false; syncZeigen(); tourenZeigen();
  $('tourenBox').open = true; tourenAbgleichen();
  return true;
}
$('koppelnImport').onchange = async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f && !koppeln(await f.text())) syncFehler('In der Datei steht kein Kopplungslink.');
};
if (location.hash.startsWith('#koppeln=')) {
  const h = location.hash;
  history.replaceState(null, '', location.pathname + location.search);
  koppeln(h);
}
tourenZeigen();
