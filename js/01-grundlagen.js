// Zweitadressen zeigen die volle App, holen Server-Teil (api/), POI-Daten und Karte (poi/) aber von der Stammadresse:
// dort liegen Datenordner und FTP-Uploads, und fällt eine Zweitadresse weg, geht auf der Stammadresse alles weiter.
const STAMMADRESSE = 'https://scooter.thai-klasse.de/';
const ZWEITADRESSEN = ['scooterways.dns.navy', 'www.scooterways.dns.navy'];
const BASIS_URL = ZWEITADRESSEN.includes(location.hostname) ? STAMMADRESSE : new URL('./', location.href).href;
// In Phase 2 nur diese URL auf den eigenen Server umstellen.
const VALHALLA_URL = 'https://valhalla1.openstreetmap.de/route';
const VALHALLA_HEIGHT_URL = VALHALLA_URL.replace(/\/route$/, '/height');
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
// Hauptserver plus Spiegel; bei Überlast (429/504, oft ohne CORS-Kopf → "NetworkError") wird der nächste versucht
const OVERPASS_URLS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
// Overpass erlaubt je Nutzer nur wenige gleichzeitige Abfragen: je Server höchstens eine zur Zeit, aber die Server
// parallel. Neue Abfragen gehen an den Server mit der kürzesten Schlange; wer gerade versagt hat (Überlast 429/504,
// oft ohne CORS-Kopf → "NetworkError", oder Zeitüberschreitung), wird 2 Minuten lang nur noch als Letzter gefragt.
const overpassServers = OVERPASS_URLS.map(url => ({ url, host: new URL(url).hostname, queue: Promise.resolve(), waiting: 0, badUntil: 0 }));
// onTry(host, n) meldet, welcher Server gerade gefragt wird (für die Statuszeile); stale() bricht vor dem Start ab,
// wenn die Abfrage inzwischen überholt ist (Route geändert), damit sie keinen Platz in der Schlange blockiert
async function overpassFetch(query, onTry, stale) {
  const now = Date.now();
  const order = [...overpassServers].sort((a, b) => (a.badUntil > now) - (b.badUntil > now) || a.waiting - b.waiting);
  for (let n = 0; n < order.length; n++) {
    const srv = order[n];
    srv.waiting++;
    const turn = srv.queue.then(async () => {
      if (stale?.()) throw Object.assign(new Error('überholt'), { fatal: true });
      // Während des Wartens ausgefallen: gleich zum nächsten Server statt nochmal 40 s zu hängen
      if (srv.badUntil > Date.now() && n < order.length - 1) throw new Error('übersprungen');
      onTry?.(srv.host, n);
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 40000);
      try {
        const res = await fetch(srv.url, { method: 'POST', body: 'data=' + encodeURIComponent(query), signal: ctl.signal });
        if (res.ok) return await res.json();
        if (res.status === 400) throw Object.assign(new Error('Abfrage ungültig'), { fatal: true });
        throw new Error(res.status);
      } finally { clearTimeout(timer); }
    });
    srv.queue = turn.catch(() => {}).finally(() => srv.waiting--);
    try { const data = await turn; srv.badUntil = 0; return data; }
    catch (err) { if (err.fatal) throw err; if (err.message !== 'übersprungen') srv.badUntil = Date.now() + 120000; }
  }
  throw new Error('OSM-Datenserver (Overpass) nicht erreichbar oder überlastet. 💡 In einer Minute Route neu berechnen.');
}
const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';

// Overpass-Filter je POI-Typ; neue Typen einfach hier ergänzen.
// Standardmäßig nur Tankstellen an (off: true = aus, bis man es einschaltet)
const POI_TYPES = [
  { id: 'shelter', icon: '🛖', name: 'Schutzhütte', off: true, filters: [
    '[amenity=shelter][shelter_type!=public_transport]', '[tourism=wilderness_hut]', '[tourism=alpine_hut]' ] },
  { id: 'water', icon: '🚰', name: 'Trinkwasser', off: true, filters: [
    '[amenity=drinking_water]', '[amenity=water_point]', '[man_made=water_tap][drinking_water=yes]' ] },
  { id: 'fuel', icon: '⛽', name: 'Tankstelle', filters: [ '[amenity=fuel]' ] },
  { id: 'toilets', icon: '🚻', name: 'Toiletten', off: true, filters: [ '[amenity=toilets]' ] },
  { id: 'food', icon: '🛒', name: 'Lebensmittel', off: true, filters: [
    '[shop=supermarket]', '[shop=convenience]', '[shop=bakery]', '[shop=butcher]', '[shop=greengrocer]', '[shop=farm]' ] },
  // Anleger liegen am Wasser, oft abseits der Durchgangsstraße
  { id: 'ferry', icon: '⛴', name: 'Fähranleger', off: true, minRadius: 1000, filters: [ '[amenity=ferry_terminal]' ] },
  // Zeltplätze liegen oft etwas abseits, daher mindestens 2 km Umkreis
  { id: 'camp', icon: '⛺', name: 'Zeltplatz', off: true, minRadius: 2000, filters: [ '[tourism=camp_site]' ] },
  // Werkstätten nur für die Pannenhilfe (js/30-panne.js), nicht entlang der Route; Autowerkstätten als Notlösung
  { id: 'workshop', icon: '🔧', name: 'Werkstatt', panne: true, filters: [
    '[shop=motorcycle]', '[shop=motorcycle_repair]', '[shop=scooter]', '[craft=motorcycle_repair]', '[shop=car_repair]' ] }
];

const map = L.map('map').setView([51.16, 10.45], 6);
// crossOrigin: CORS-Antworten statt "opaque", damit der Service Worker angesehene Kacheln platzsparend zwischenspeichern kann
const rasterBase = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, crossOrigin: true, attribution: '© OpenStreetMap-Mitwirkende'
}).addTo(map);
// Übersichten (ganze Route, GPX) in Zehntel-Zoomstufen einpassen, sonst bleibt bei langen Touren links und rechts
// bis zur Hälfte der Breite leer; danach wieder ganze Stufen für Tippen und Ziehen. Links Platz für die Kartenknöpfe.
function fitFein(bounds, opts = {}) {
  if (globalThis.navOhneKarte?.()) return; // Pfeil-Modus im Navi: keine Kacheln laden
  map.options.zoomSnap = 0.1;
  try { map.fitBounds(bounds, { paddingTopLeft: [52, 24], paddingBottomRight: [16, 24], ...opts }); }
  finally { map.options.zoomSnap = 1; }
}

// Wegpunkte: erster = Start, letzter = Ziel, dazwischen Zwischenziele. latlng null = noch nicht aufgelöst.
let waypoints = [{ latlng: null, text: '' }, { latlng: null, text: '' }];
let excluded = []; // gesperrte Stellen (Valhalla exclude_locations)

// Browser-Speicher: Planung und eigene POIs überleben ein Neuladen (nur auf diesem Gerät)
const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem('scooterways.' + key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem('scooterways.' + key, JSON.stringify(value)); } catch {} }
};
const saved = store.get('plan', null);
if (saved?.waypoints?.length >= 2) {
  waypoints = saved.waypoints.map(w => ({ ...w, latlng: w.latlng && L.latLng(w.latlng) }));
  excluded = (saved.excluded || []).map(ll => L.latLng(ll));
}
const savePlan = () => store.set('plan', { waypoints, excluded });
let myPois = store.get('myPois', []);
const myPoiLayer = L.layerGroup().addTo(map);
const undoStack = [];
const wpLayer = L.layerGroup().addTo(map);
const exclLayer = L.layerGroup().addTo(map);
const altLayer = L.layerGroup().addTo(map);
let routeLayer = null;
let routeCoords = null;
let routeKm = null; // kumulierte km je Routenpunkt
let routeManeuvers = []; // [{km, text, type}] aus Valhalla, für die Vorschaufahrt
let routeKmh = null; // Durchschnittstempo laut Valhalla
let eleData = null; // { xs: km, hs: m } aus dem Höhenprofil
let wxShelter = false; // Schutzhütten wegen Wetter automatisch einblenden
let routeStages = [], currentTrip = null, tripClimb = null; // Mehrtagestour: km am Ende jedes Tages außer dem letzten
let routeStageNights = []; // je Etappenende: Nächte dort (2 = Ruhetag), parallel zu routeStages
let routeFaehren = []; // Fährstücke der Route als [{ km, bisKm, s }]: zählen nicht als Fahrt (Tank, Etappen, Steigung)
// Gefahrene km bis Routen-km (ohne Fährstrecken) und umgekehrt; auf einer Fähre steht der Zähler still,
// die Umkehrung liefert dann den Anleger davor
const fahrKm = km => routeFaehren.reduce((r, f) => r - Math.max(0, Math.min(km, f.bisKm) - f.km), km);
function beiFahrKm(fk) {
  let km = fk;
  for (const f of routeFaehren) if (f.km < km) km += f.bisKm - f.km; else break;
  return km;
}
const aufFaehre = km => routeFaehren.some(f => km > f.km && km < f.bisKm);
const sim = { km: 0, running: false, frame: 0, last: 0, zoomAt: 0, zoomFrom: 0, zoomTo: 0, marker: null, profile: false };
const gradeSignLayer = L.layerGroup().addTo(map);
const stageLayer = L.layerGroup().addTo(map);
const poiLayer = L.layerGroup();
// Ladeanzeige oben auf der Karte, je Quelle eine Zeile (POIs, Wetter …); text = null nimmt sie weg, ms blendet nach Zeit aus
const mapBusyBox = L.DomUtil.create('div', 'map-busy', map.getContainer()), mapBusyTimer = {};
function mapBusy(key, text, ms) {
  clearTimeout(mapBusyTimer[key]);
  let el = mapBusyBox.querySelector(`[data-k="${key}"]`);
  if (text == null) { el?.remove(); return; }
  if (!el) { el = L.DomUtil.create('div', '', mapBusyBox); el.dataset.k = key; }
  el.textContent = text;
  if (ms) mapBusyTimer[key] = setTimeout(() => el.remove(), ms);
}

// Referenzlinie für POI-/Cache-Filter: berechnete Route oder geladener GPX-Track
function setRouteCoords(coords) {
  stopSim();
  routeManeuvers = [];
  eleData = null;
  gradeSignLayer.clearLayers();
  wxRouteLayer.clearLayers();
  $('wxRouteSummary').textContent = ''; $('wxWarnSummary').textContent = ''; routeWarnungen = [];
  // nach showTrip, das routeKmh erst danach setzt
  queueMicrotask(loadRouteWeather);
  routeStages = []; routeStageNights = []; stageLayer.clearLayers(); $('stageSummary').textContent = '';
  $('play').hidden = false;
  $('navStart').hidden = false;
  $('gpxTour').hidden = false;
  $('mapSave').hidden = typeof vm === 'undefined' || !vm.layer; $('mapSaveInfo').textContent = '';
  routeCoords = coords;
  routeFaehren = [];
  routeKm = [0];
  for (let i = 1; i < coords.length; i++) routeKm.push(routeKm[i - 1] + map.distance(coords[i - 1], coords[i]) / 1000);
}

const $ = id => document.getElementById(id);
const label = (v, words) => words[Math.min(words.length - 1, Math.floor(v * words.length))];
const primaryWords = ['strikt meiden', 'meiden', 'neutral', 'bevorzugen'];
const hillsWords = ['meiden', 'eher meiden', 'egal', 'gern'];

$('speed').oninput = e => $('speedVal').textContent = e.target.value;
$('primary').oninput = e => $('primaryVal').textContent = label(+e.target.value, primaryWords);
$('hills').oninput = e => $('hillsVal').textContent = label(+e.target.value, hillsWords);
$('radius').oninput = e => $('radiusVal').textContent = e.target.value;
$('radius').onchange = () => loadPois();
// Vorgabe seit v35: alles aus außer Tankstellen. Einmalig auch eine früher gespeicherte Auswahl zurücksetzen
{ const s = store.get('settings', {}); if (s.poiStd !== 2) { delete s.poiTypes; s.poiStd = 2; store.set('settings', s); } }
$('poiTypes').insertAdjacentHTML('beforeend', POI_TYPES.filter(t => !t.panne).map(t =>
  `<label><input type="checkbox" value="${t.id}"${(store.get('settings', {}).poiTypes?.[t.id] ?? !t.off) ? ' checked' : ''}> ${t.icon} ${t.name}</label>`).join(''));
// Auswahl merken (neue Typen starten mit ihrem Standard)
$('poiTypes').onchange = () => {
  settings.poiTypes = Object.fromEntries(POI_TYPES.filter(t => !t.panne).map(t => [t.id, $('poiTypes').querySelector(`input[value="${t.id}"]`).checked]));
  store.set('settings', settings);
  loadPois();
};
// Nur Marken, die aktuell 50er/45-km/h-Fahrzeuge anbieten (Honda und Yamaha nur noch elektrisch: EM1 e:, Neo's). Suzuki hat keine mehr.
const BRANDS = ['Peugeot', 'Piaggio', 'Vespa', 'Aprilia', 'Kymco', 'SYM', 'Rieju', 'Beta', 'Kreidler', 'Rex', 'Nova Motors', 'Baotian', 'Niu', 'Honda', 'Yamaha'];
// Regler und Klappzustand merken; Kurzfassung im eingeklappten Kopf
const SETTING_IDS = ['speed', 'primary', 'hills', 'radius', 'gradeWarn', 'avgSpeed', 'wxWindow', 'dayMax', 'breakMin', 'dayStart'];
const settings = store.get('settings', {});
// Mehrtagestour ist jetzt ab 6 h automatisch an; ältere Einstellungen hatten „aus“ als Vorgabe gespeichert
if (settings.dayAuto == null) { settings.dayAuto = 1; if (!+settings.dayMax) settings.dayMax = '6'; }
if (settings.dayMax === '2') settings.dayMax = '3'; // 2 h gibt es nicht mehr
SETTING_IDS.forEach(id => { if (settings[id] != null) $(id).value = settings[id]; });
['profileBox', 'poiBox', 'trafficBox'].forEach(id => {
  $(id).open = !!settings[id];
  $(id).addEventListener('toggle', () => { settings[id] = $(id).open; store.set('settings', settings); });
});
function updateFoldSummaries() {
  SETTING_IDS.forEach(id => { settings[id] = $(id).value; });
  store.set('settings', settings);
  $('profileSummary').textContent = `${$('speed').value} km/h${+$('avgSpeed').value > 0 ? ` (Ø ${$('avgSpeed').value})` : ''} · Hauptstr. ${$('primaryVal').textContent} · Steigung ${$('hillsVal').textContent}` +
    (+$('gradeWarn').value ? ` · ⚠ ab ${$('gradeWarn').value} %` : '') + (+$('dayMax').value ? ` · 🌙 ${$('dayMax').value} h/Tag` : '') + (+$('breakMin').value ? ` · ☕ ${$('breakMin').value} min/2 h` : '') + ($('unpaved').checked ? ' · nur befestigt' : '') + ($('ferry').checked ? ' · ⛴ Fähren gern' : '');
  const on = POI_TYPES.filter(t => $('poiTypes').querySelector(`input[value="${t.id}"]`)?.checked).map(t => t.icon).join('');
  $('poiBoxSummary').textContent = `${on || 'aus'} · ${$('radius').value} m`;
}
$('panel').addEventListener('input', e => { if (e.target.closest('details.fold') || SETTING_IDS.includes(e.target.id)) updateFoldSummaries(); });
$('panel').addEventListener('change', e => { if (e.target.closest('details.fold') || SETTING_IDS.includes(e.target.id)) updateFoldSummaries(); });
$('speedVal').textContent = $('speed').value;
$('radiusVal').textContent = $('radius').value;
$('primary').oninput({ target: $('primary') });
$('hills').oninput({ target: $('hills') });
updateFoldSummaries();

// Streckenstufen: nur Valhalla-Einstellungen (Hauptstraßen meiden, Steigungen zulassen), keine Kurvenwertung.
// use_hills 1 nimmt Steigungen ohne Aufschlag, sucht sie aber nicht aktiv; Hügel kommen über die kleinen Straßen dazu.
const RIDE_STYLES = [{ primary: 0.5, hills: 0.3 }, { primary: 0.2, hills: 0.5 }, { primary: 0.05, hills: 0.8 }, { primary: 0, hills: 1 }];
const rideStyleOf = () => RIDE_STYLES.findIndex(st => Math.abs(st.primary - $('primary').value) < 0.01 && Math.abs(st.hills - $('hills').value) < 0.01);
const showRideStyle = () => { const i = rideStyleOf(); $('rideStyle').value = i < 0 ? '' : String(i); };
$('rideStyle').onchange = () => {
  const st = RIDE_STYLES[$('rideStyle').value];
  if (!st) { showTab('setup'); $('profileBox').open = true; return; }
  for (const id of ['primary', 'hills']) { $(id).value = st[id]; $(id).oninput({ target: $(id) }); }
  updateFoldSummaries();
  if (ready()) route();
};
for (const id of ['primary', 'hills']) $(id).addEventListener('change', showRideStyle);
$('unpaved').checked = settings.unpaved !== false;
updateFoldSummaries();
$('unpaved').onchange = () => { settings.unpaved = $('unpaved').checked; updateFoldSummaries(); if (ready()) route(); };
$('ferry').checked = !!settings.ferry;
$('ferry').onchange = () => { settings.ferry = $('ferry').checked; updateFoldSummaries(); if (ready()) route(); };
showRideStyle();

const coordText = ll => `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`;
const isEnd = i => i === 0 || i === waypoints.length - 1;

const bearing = (from, to) => (Math.atan2((to.lng - from.lng) * Math.cos(from.lat * Math.PI / 180), to.lat - from.lat) * 180 / Math.PI + 360) % 360;
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
