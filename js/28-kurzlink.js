// --- Tour als Kurzlink über den eigenen Server (api/kurz.php): /t/<id> öffnet die App mit dieser Tour.
// Eigene Links merkt sich der Browser samt Löschcode; ohne Server bleibt der Knopf weg.
const kurzMeine = store.get('kurzlinks', []); // [{ id, bis, loesch, name }]
const kurzBasis = EIGENE_ADRESSE ? HAUPTADRESSE : location.href.replace(/[?#].*$/, '');
// Schöne Form /t/<id> braucht die Weiterleitung aus .htaccess; ohne mod_rewrite bleibt ?t=<id>
let kurzSchoen = store.get('kurzSchoen', false);
const kurzUrl = id => kurzSchoen ? new URL(`t/${id}`, kurzBasis).href : `${kurzBasis}?t=${id}`;
async function kurzSchoenPruefen(id) {
  try { kurzSchoen = (await fetch(new URL(`t/${id}`, location.href.replace(/[?#].*$/, '')), { redirect: 'manual', cache: 'no-store' })).type === 'opaqueredirect'; } catch { kurzSchoen = false; }
  store.set('kurzSchoen', kurzSchoen);
}

// Knopf wie „Tour als GPX“: nur mit fertiger Route, und nur wenn der Server eingerichtet ist
new MutationObserver(() => kurzKnopf()).observe($('gpxTour'), { attributes: true, attributeFilter: ['hidden'] });
document.addEventListener('serverkonfig', () => kurzKnopf());
function kurzKnopf() { $('tourLink').hidden = $('gpxTour').hidden || !serverKonfig?.eingerichtet; }

function kurzListe() {
  const jetzt = Date.now() / 1000;
  kurzMeine.splice(0, Infinity, ...kurzMeine.filter(l => l.bis > jetzt));
  store.set('kurzlinks', kurzMeine);
  $('linkMeine').hidden = !kurzMeine.length;
  $('linkListe').innerHTML = kurzMeine.map((l, i) => `<li><a href="${kurzUrl(l.id)}" target="_blank" rel="noopener">${escapeHtml(l.name || l.id)}</a>` +
    ` <span class="hint">bis ${new Date(l.bis * 1000).toLocaleDateString('de-DE')}</span><button data-i="${i}" class="secondary" title="Link löschen">✕</button></li>`).join('');
}
$('linkListe').onclick = async e => {
  const l = kurzMeine[e.target.dataset?.i];
  if (!l || !confirm(`Link „${l.name || l.id}“ löschen? Wer ihn hat, kann die Tour dann nicht mehr öffnen.`)) return;
  try {
    const res = await fetch(API_URL + 'kurz.php', { method: 'POST', body: JSON.stringify({ loeschen: l.id, code: l.loesch }) });
    if (!res.ok && res.status !== 403) throw new Error(res.status);
  } catch (err) { alert('Löschen hat nicht geklappt: ' + err.message); return; }
  kurzMeine.splice(e.target.dataset.i, 1); kurzListe();
};

let kurzLetzter = null;
// „Mein Standort“ hieße beim Empfänger seine eigene Position, gemeint ist aber der Punkt des Absenders
const kurzText = w => w.text === OWN_LOCATION && w.latlng ? coordText(w.latlng) : w.text || '';
$('tourLink').onclick = () => {
  kurzLetzter = null;
  $('linkErgebnis').textContent = ''; $('linkTeilen').hidden = $('linkKopieren').hidden = true; $('linkMachen').hidden = false;
  const s = waypoints[0]?.text === OWN_LOCATION ? 'Start' : waypoints[0]?.text, z = waypoints.at(-1)?.text;
  $('linkName').value = s && z ? `${s.split(',')[0]} → ${z.split(',')[0]}` : '';
  kurzListe();
  $('linkDlg').showModal();
};
$('linkZu').onclick = () => $('linkDlg').close();
$('linkMachen').onclick = async () => {
  const wps = waypoints.filter(w => w.latlng);
  if (wps.length < 2) return;
  $('linkMachen').disabled = true; $('linkErgebnis').textContent = 'erzeuge Link …';
  try {
    const tour = { name: $('linkName').value.trim(), waypoints: wps.map(w => ({ lat: w.latlng.lat, lon: w.latlng.lng, text: kurzText(w) })),
      excluded: excluded.map(ll => [ll.lat, ll.lng]) };
    const res = await fetch(API_URL + 'kurz.php', { method: 'POST', body: JSON.stringify({ tour, tage: +$('linkTage').value }) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.fehler || `HTTP ${res.status}`);
    await kurzSchoenPruefen(d.id);
    kurzMeine.unshift({ id: d.id, bis: d.bis, loesch: d.loesch, name: tour.name });
    kurzListe();
    kurzLetzter = { url: kurzUrl(d.id), name: tour.name };
    $('linkErgebnis').innerHTML = `<a href="${kurzLetzter.url}" target="_blank" rel="noopener">${kurzLetzter.url}</a> · gültig bis ${new Date(d.bis * 1000).toLocaleDateString('de-DE')}`;
    $('linkMachen').hidden = true; $('linkKopieren').hidden = false; $('linkTeilen').hidden = !navigator.share;
  } catch (err) {
    $('linkErgebnis').textContent = '⚠ ' + (err.message === 'Failed to fetch' ? 'Server nicht erreichbar' : err.message);
  } finally { $('linkMachen').disabled = false; }
};
$('linkTeilen').onclick = () => navigator.share({ title: kurzLetzter.name || 'Scooterways-Tour', text: '🛵 ' + (kurzLetzter.name || 'Tour'), url: kurzLetzter.url }).catch(() => {});
$('linkKopieren').onclick = () => navigator.clipboard.writeText(kurzLetzter.url).then(() => { $('linkKopieren').textContent = 'Kopiert ✓'; setTimeout(() => $('linkKopieren').textContent = 'Kopieren', 1500); });

// Aufruf mit ?t=<id> (Weiterleitung von /t/<id>): Tour holen und nach Rückfrage übernehmen
async function kurzOeffnen(id) {
  history.replaceState(null, '', location.pathname + location.hash);
  try {
    const res = await fetch(`${API_URL}kurz.php?id=${encodeURIComponent(id)}`);
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.fehler || `HTTP ${res.status}`);
    const t = d.tour, wps = t.waypoints.map(w => ({ latlng: L.latLng(w.lat, w.lon), text: w.text }));
    const was = t.name || `${wps[0].text || 'Start'} → ${wps.at(-1).text || 'Ziel'}`;
    // Nur der GPS-Start beim Öffnen der App zählt nicht als Planung
    const leer = !waypoints.some(w => w.latlng && w.text !== OWN_LOCATION);
    if (!leer && !confirm(`Tour „${was}“ (${wps.length} Punkte) aus dem Link laden? Die aktuelle Planung lässt sich mit ↶ zurückholen.`)) return;
    changeWaypoints(() => { waypoints = wps; excluded = (t.excluded || []).map(([a, b]) => L.latLng(a, b)); });
    map.fitBounds(L.latLngBounds(wps.map(w => w.latlng)), { padding: [30, 30] });
  } catch (err) { alert('Tour-Link: ' + err.message); }
}
const kurzId = new URLSearchParams(location.search).get('t');
if (/^[A-Za-z0-9]{8}$/.test(kurzId || '')) kurzOeffnen(kurzId);
kurzKnopf();

// Auf der alten Adresse einmal auf den Haupteingang hinweisen; Daten im Browser gelten je Adresse.
// Nicht im Rahmen (Plesk-Rahmenweiterleitung zeigt diese Adresse unter dem Haupteingang)
if (location.origin + '/' === STAMMADRESSE && window.top === window && !store.get('hauptadresseGezeigt', false)) {
  const b = document.createElement('div');
  b.className = 'adress-hinweis';
  b.innerHTML = `Scooterways hat eine neue Adresse: <a href="${HAUPTADRESSE}">scooterways.dns.navy</a>. ` +
    'Touren und Einstellungen liegen je Adresse getrennt im Browser, mitnehmen über ⚙ → Profil → ☁. <button class="secondary">OK</button>';
  b.querySelector('button').onclick = () => { store.set('hauptadresseGezeigt', true); b.remove(); };
  document.body.append(b);
}
