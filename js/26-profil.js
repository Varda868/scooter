// --- Profil sichern und übertragen: alles aus localStorage (scooterways.*) plus gefahrene Touren (IndexedDB) als eine JSON-Datei.
// Zwischenspeicher (POI-Cache, Offline-Karte) bleiben draußen. Schlüssel nur auf Wunsch, dann deutlich gekennzeichnet.
const PROFIL_APP = 'scooterways-profil', PROFIL_PREFIX = 'scooterways.';
// sync: Schlüssel des Server-Abgleichs bleibt immer auf dem Gerät (nie in Datei oder Abgleich, beim Laden nicht gelöscht)
const PROFIL_CACHE = ['poiCache', 'vectorMapHeader', 'vectorMapStand', 'devlog', 'dev', 'sync'];
// Geheimnisse: [Speicher-Schlüssel, Feld im Objekt oder null für den ganzen Eintrag]
const PROFIL_GEHEIM = [['tomtom', 'key'], ['talk', 'pw'], ['talkSk', null]];

function profilDaten(mitSchluessel) {
  const daten = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k?.startsWith(PROFIL_PREFIX) || PROFIL_CACHE.includes(k.slice(PROFIL_PREFIX.length))) continue;
    daten[k.slice(PROFIL_PREFIX.length)] = localStorage.getItem(k);
  }
  if (!mitSchluessel) for (const [k, feld] of PROFIL_GEHEIM) {
    if (!(k in daten)) continue;
    if (!feld) { delete daten[k]; continue; }
    try { const o = JSON.parse(daten[k]); delete o[feld]; daten[k] = JSON.stringify(o); } catch {}
  }
  return daten;
}

async function profilInhalt(mit) {
  let fahrten = [];
  try { fahrten = (await rideTx('readonly', st => st.getAll())) || []; } catch {}
  return { app: PROFIL_APP, version: 1, erstellt: new Date().toISOString(), enthaeltSchluessel: mit, daten: profilDaten(mit), fahrten };
}
async function profilDatei() {
  const mit = $('profilSchluessel').checked, inhalt = await profilInhalt(mit);
  const tag = new Date().toISOString().slice(0, 10);
  return new File([JSON.stringify(inhalt)], `scooterways-profil-${tag}${mit ? '-MIT-SCHLUESSELN' : ''}.json`, { type: 'application/json' });
}

$('profilSchluessel').onchange = () => { $('profilWarnung').hidden = !$('profilSchluessel').checked; };
$('profilExport').onclick = async () => {
  const f = await profilDatei(), a = document.createElement('a');
  a.href = URL.createObjectURL(f); a.download = f.name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  $('profilStatus').textContent = `💾 ${f.name} (${Math.ceil(f.size / 1024)} kB) gespeichert`;
};
// Android: Teilen-Menü (Nearby Share, Mail an sich selbst …) statt Umweg über den Download-Ordner
$('profilTeilen').hidden = !navigator.canShare?.({ files: [new File(['{}'], 'x.json', { type: 'application/json' })] });
$('profilTeilen').onclick = async () => {
  const f = await profilDatei();
  try { await navigator.share({ files: [f], title: 'Scooterways-Profil' }); } catch {}
};

$('profilImport').onchange = async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  let inhalt;
  try { inhalt = JSON.parse(await f.text()); } catch { $('profilStatus').textContent = '⚠️ Keine lesbare Profildatei'; return; }
  if (inhalt?.app !== PROFIL_APP || typeof inhalt.daten !== 'object') { $('profilStatus').textContent = '⚠️ Das ist keine Scooterways-Profildatei'; return; }
  await profilAnwenden(inhalt);
};
// Profil übernehmen (Datei oder Server); fragt vorher nach und lädt danach neu
async function profilAnwenden(inhalt) {
  const n = Object.keys(inhalt.daten).length, fahrten = Array.isArray(inhalt.fahrten) ? inhalt.fahrten : [];
  if (!confirm(`Profil vom ${new Date(inhalt.erstellt).toLocaleString('de-DE')} laden?\n${n} Einträge, ${fahrten.length} Touren` +
    `${inhalt.enthaeltSchluessel ? ', mit Schlüsseln' : ''}.\n\nDas ersetzt das Profil in diesem Browser. Schlüssel, die nicht in der Datei stehen, bleiben erhalten.`)) return;
  // Hier vorhandene Geheimnisse merken, damit eine Datei ohne Schlüssel sie nicht löscht
  const alt = {};
  for (const [k, feld] of PROFIL_GEHEIM) {
    const v = localStorage.getItem(PROFIL_PREFIX + k);
    if (v == null) continue;
    try { alt[k] = feld ? JSON.parse(v)[feld] : v; } catch {}
  }
  for (const k of Object.keys(localStorage)) if (k.startsWith(PROFIL_PREFIX) && !PROFIL_CACHE.includes(k.slice(PROFIL_PREFIX.length))) localStorage.removeItem(k);
  for (const [k, v] of Object.entries(inhalt.daten)) if (typeof v === 'string') localStorage.setItem(PROFIL_PREFIX + k, v);
  for (const [k, feld] of PROFIL_GEHEIM) {
    if (alt[k] == null) continue;
    const v = localStorage.getItem(PROFIL_PREFIX + k);
    if (!feld) { if (v == null) localStorage.setItem(PROFIL_PREFIX + k, alt[k]); continue; }
    let o = {};
    try { o = JSON.parse(v) || {}; } catch {}
    if (!o[feld]) { o[feld] = alt[k]; localStorage.setItem(PROFIL_PREFIX + k, JSON.stringify(o)); }
  }
  try {
    await rideTx('readwrite', st => { st.clear(); for (const r of fahrten) st.put(r); });
  } catch { alert('Touren konnten nicht übernommen werden, der Rest schon.'); }
  location.reload();
}

// --- Abgleich über den eigenen Server: Sync-Passwort → PBKDF2 → AES-GCM-Schlüssel + Fach-Kennung (je 256 bit).
// Hochgeladen wird nur gzip + AES-GCM; ohne Passwort kann weder der Server noch sonst wer etwas lesen.
const SYNC_SALZ = 'scooterways-profil-sync-v1', SYNC_RUNDEN = 310000;
const b64u = b => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uDec = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
let syncDaten = store.get('sync', null);
async function syncAbleiten(pw) {
  const basis = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(SYNC_SALZ), iterations: SYNC_RUNDEN }, basis, 512));
  return { k: b64u(bits.slice(0, 32)), id: Array.from(bits.slice(32), x => x.toString(16).padStart(2, '0')).join('') };
}
const syncSchluessel = () => crypto.subtle.importKey('raw', b64uDec(syncDaten.k), 'AES-GCM', false, ['encrypt', 'decrypt']);
async function strom(daten, art) {
  return new Uint8Array(await new Response(new Blob([daten]).stream().pipeThrough(art)).arrayBuffer());
}
async function syncAnfrage(body) {
  const res = await fetch(API_URL + 'profil.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: syncDaten.id, ...body }) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.fehler || 'Server meldet ' + res.status);
  return j;
}
const syncZeit = t => new Date(t * 1000).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
async function syncInfo() {
  try {
    const j = await syncAnfrage({ aktion: 'info' });
    syncStatusText(j.leer ? '☁️ Auf dem Server liegt noch nichts.' : `☁️ Auf dem Server: Stand ${syncZeit(j.t)} (${Math.ceil(j.groesse / 1024)} kB)`);
  } catch (e) { syncFehler(e.message); }
}
function syncZeigen() {
  $('syncBox').hidden = !serverAn();
  $('syncAus').hidden = !!syncDaten; $('syncAn').hidden = !syncDaten;
  if (syncDaten && serverAn() && !syncZeigen.gefragt) { syncZeigen.gefragt = true; syncInfo(); }
}
document.addEventListener('serverkonfig', syncZeigen);
function syncStatusText(t) { const st = $('syncStatus'); st.textContent = t; st.classList.remove('sync-fehler'); }
// Fehler gut sichtbar: großer roter Kasten statt kleinem Hinweis
function syncFehler(text) {
  const st = $('syncStatus');
  st.textContent = '⚠️ ' + text; st.classList.add('sync-fehler');
}
$('syncPw').addEventListener('input', () => { $('syncPw').classList.remove('feld-fehler'); $('syncStatus').classList.remove('sync-fehler'); });
$('syncSetzen').onclick = async () => {
  const pw = $('syncPw').value;
  $('syncStatus').classList.remove('sync-fehler');
  if (pw.length < 10) {
    syncFehler(`Passwort zu kurz: ${pw.length} von mindestens 10 Zeichen.`);
    $('syncPw').classList.add('feld-fehler'); $('syncPw').focus(); return;
  }
  syncStatusText('Schlüssel wird abgeleitet …');
  syncDaten = await syncAbleiten(pw); store.set('sync', syncDaten);
  $('syncPw').value = ''; syncZeigen.gefragt = false; syncZeigen();
};
$('syncHoch').onclick = async () => {
  const mit = $('profilSchluessel').checked;
  if (mit && !confirm('Mit Schlüsseln sichern? Sie liegen dann verschlüsselt auf dem Server, lesbar nur mit dem Sync-Passwort.')) return;
  try {
    syncStatusText('Sichere …');
    const roh = await strom(JSON.stringify(await profilInhalt(mit)), new CompressionStream('gzip'));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await syncSchluessel(), roh));
    const daten = new Uint8Array(1 + iv.length + ct.length); daten.set([1]); daten.set(iv, 1); daten.set(ct, 13);
    const j = await syncAnfrage({ aktion: 'hoch', daten: b64u(daten) });
    syncStatusText(`☁️ Gesichert ${syncZeit(j.t)} (${Math.ceil(daten.length / 1024)} kB${mit ? ', mit Schlüsseln' : ''})`);
  } catch (e) { syncFehler(e.message); }
};
$('syncRunter').onclick = async () => {
  try {
    syncStatusText('Lade …');
    const j = await syncAnfrage({ aktion: 'runter' });
    if (j.leer) { syncStatusText('☁️ Auf dem Server liegt noch nichts.'); return; }
    const d = b64uDec(j.daten);
    if (d[0] !== 1) throw new Error('Unbekanntes Format');
    let roh;
    try { roh = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: d.slice(1, 13) }, await syncSchluessel(), d.slice(13)); }
    catch { throw new Error('Nicht lesbar: anderes Sync-Passwort?'); }
    const inhalt = JSON.parse(new TextDecoder().decode(await strom(roh, new DecompressionStream('gzip'))));
    if (inhalt?.app !== PROFIL_APP) throw new Error('Kein Scooterways-Profil');
    syncStatusText('');
    await profilAnwenden(inhalt);
  } catch (e) { syncFehler(e.message); }
};
$('syncTrennen').onclick = async () => {
  if (!confirm('Dieses Gerät vom Abgleich trennen?')) return;
  if (confirm('Auch das Profil auf dem Server löschen (für alle Geräte mit diesem Passwort)?')) try { await syncAnfrage({ aktion: 'weg' }); } catch {}
  syncDaten = null; store.set('sync', null); localStorage.removeItem(PROFIL_PREFIX + 'sync');
  syncStatusText('Getrennt.'); syncZeigen();
};

// --- Kurzanleitung und Hinweis beim ersten Start (und jederzeit unter ⚙ Einstellung)
$('introOk').onclick = () => { store.set('intro', 1); $('intro').close(); };
$('introAuf').onclick = () => $('intro').showModal();
if (!store.get('intro', 0)) $('intro').showModal();
