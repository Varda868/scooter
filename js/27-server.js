// --- Eigener Server (api/): Endpunkte aus dem Admin-Bereich, Proxy mit Zwischenspeicher, TomTom-Schlüssel auf dem Server.
// Ohne Server, wenn er ausfällt oder abgeschaltet ist, geht alles wie bisher direkt an die Dienste.
const API_URL = BASIS_URL + 'api/';
const VALHALLA_STANDARD = new URL(VALHALLA_URL).origin;
let serverKonfig = store.get('serverKonfig', null);
const direktFetch = window.fetch.bind(window);

const serverAn = () => !!serverKonfig?.eingerichtet && settings.server !== false;
// Anfrage auf den Proxy umschreiben; null = direkt lassen
function proxyZiel(url, init) {
  if (!serverAn()) return null;
  const k = serverKonfig, p = API_URL + 'proxy.php?d=';
  // Valhalla nicht über den Proxy (große POSTs, nichts zu speichern), aber auf den im Admin-Bereich eingestellten Server
  if (k.valhalla && k.valhalla !== VALHALLA_STANDARD && url.startsWith(VALHALLA_STANDARD + '/')) return [k.valhalla + url.slice(VALHALLA_STANDARD.length), init];
  if (!k.proxy) return null;
  const q = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
  if (url.startsWith(WEATHER_URL + '?')) return [p + 'wetter&' + q, init];
  if (url.startsWith(PHOTON_URL + '?')) return [p + 'photon&' + q, init];
  const ov = overpassServers.findIndex(s => s.url === url);
  if (ov >= 0 && init?.method === 'POST') return [p + 'overpass&s=' + ov, init];
  if (k.tomtomAmServer && url.startsWith(TOMTOM_URL + '/services/5/incidentDetails?')) {
    const sp = new URLSearchParams(q); sp.delete('key');
    return [p + 'tomtom&' + sp, init];
  }
  return null;
}
window.fetch = function (input, init) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : null;
  const ziel = url && proxyZiel(url, init);
  if (!ziel) return direktFetch(input, init);
  // Wetter zuerst direkt: Open-Meteo zählt je IP, so hat jedes Gerät sein eigenes Kontingent. Der Server
  // (mit Zwischenspeicher und MET Norway als Ersatz) springt nur bei Überlast oder Störung ein.
  if (url.startsWith(WEATHER_URL + '?')) return direktFetch(input, init).then(res => res.status === 429 || res.status >= 500 ? direktFetch(...ziel).catch(() => res) : res,
    err => { if (init?.signal?.aborted) throw err; return direktFetch(...ziel); });
  // Server nicht erreichbar, gedrosselt oder Dienst dahinter gestört: einmal direkt versuchen
  return direktFetch(...ziel).then(res => res.status === 429 || res.status >= 500 ? direktFetch(input, init).catch(() => res) : res,
    err => { if (init?.signal?.aborted) throw err; return direktFetch(input, init); });
};

function serverZeigen() {
  const k = serverKonfig;
  $('serverSummary').textContent = !k?.eingerichtet ? 'nicht eingerichtet' : !serverAn() ? 'aus' :
    [k.proxy ? 'Proxy an' : 'Proxy aus', k.tomtomAmServer ? 'TomTom-Schlüssel' : ''].filter(Boolean).join(' · ');
  const tomtom = serverAn() && !!k.proxy && !!k.tomtomAmServer;
  if (tomtom !== ttServer) { ttServer = tomtom; applyTraffic(); }
  document.dispatchEvent(new Event('serverkonfig'));
}
async function serverKonfigLaden() {
  try {
    const res = await direktFetch(API_URL + 'konfig.php', { signal: AbortSignal.timeout(8000), cache: 'no-store' });
    // Kein PHP (404) oder nicht eingerichtet: ohne Server weiter
    serverKonfig = res.ok && /json/.test(res.headers.get('content-type') || '') ? await res.json() : null;
    store.set('serverKonfig', serverKonfig);
  } catch { /* offline: die zuletzt gespeicherte Einstellung gilt */ }
  serverZeigen();
}
$('useServer').checked = settings.server !== false;
$('useServer').onchange = () => { settings.server = $('useServer').checked; store.set('settings', settings); serverZeigen(); };
serverZeigen();
serverKonfigLaden();
