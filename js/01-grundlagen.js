// In Phase 2 nur diese URL auf den eigenen Server umstellen.
const VALHALLA_URL = 'https://valhalla1.openstreetmap.de/route';
const VALHALLA_HEIGHT_URL = VALHALLA_URL.replace(/\/route$/, '/height');
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
// Hauptserver plus Spiegel; bei Überlast (429/504, oft ohne CORS-Kopf → "NetworkError") wird der nächste versucht
const OVERPASS_URLS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
// Overpass erlaubt je Nutzer nur wenige gleichzeitige Abfragen: alle nacheinander über eine Warteschlange,
// bei Fehler der Reihe nach die Spiegelserver. Der zuletzt erfolgreiche Server wird zuerst gefragt.
let overpassQueue = Promise.resolve(), overpassBest = 0;
// onTry(host, n) meldet, welcher Server gerade gefragt wird (für die Statuszeile)
function overpassFetch(query, onTry) {
  const run = async () => {
    for (let n = 0; n < OVERPASS_URLS.length; n++) {
      const k = (overpassBest + n) % OVERPASS_URLS.length;
      onTry?.(new URL(OVERPASS_URLS[k]).hostname, n);
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 45000);
      try {
        const res = await fetch(OVERPASS_URLS[k], { method: 'POST', body: 'data=' + encodeURIComponent(query), signal: ctl.signal });
        if (res.ok) { overpassBest = k; return await res.json(); }
        if (res.status === 400) throw Object.assign(new Error('Abfrage ungültig'), { fatal: true });
      } catch (err) { if (err.fatal) throw err; }
      finally { clearTimeout(timer); }
    }
    throw new Error('OSM-Datenserver (Overpass) nicht erreichbar oder überlastet. 💡 In einer Minute Route neu berechnen.');
  };
  const p = overpassQueue.then(run, run);
  overpassQueue = p.catch(() => {});
  return p;
}
const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';

// Overpass-Filter je POI-Typ; neue Typen einfach hier ergänzen.
const POI_TYPES = [
  { id: 'shelter', icon: '🛖', name: 'Schutzhütte', filters: [
    '[amenity=shelter][shelter_type!=public_transport]', '[tourism=wilderness_hut]', '[tourism=alpine_hut]' ] },
  { id: 'water', icon: '🚰', name: 'Trinkwasser', filters: [
    '[amenity=drinking_water]', '[amenity=water_point]', '[man_made=water_tap][drinking_water=yes]' ] },
  { id: 'fuel', icon: '⛽', name: 'Tankstelle', filters: [ '[amenity=fuel]' ] },
  { id: 'toilets', icon: '🚻', name: 'Toiletten', filters: [ '[amenity=toilets]' ] },
  // Zeltplätze liegen oft etwas abseits, daher mindestens 2 km Umkreis; standardmäßig aus
  { id: 'camp', icon: '⛺', name: 'Zeltplatz', off: true, minRadius: 2000, filters: [ '[tourism=camp_site]' ] },
  // Werkstätten liegen meist im Ort, daher mindestens 2 km Umkreis; standardmäßig aus
  { id: 'workshop', icon: '🔧', name: 'Zweiradwerkstatt', off: true, minRadius: 2000, filters: [
    '[shop=motorcycle]', '[shop=motorcycle_repair]', '[shop=scooter]', '[craft=motorcycle_repair]' ] }
];

const map = L.map('map').setView([51.16, 10.45], 6);
// crossOrigin: CORS-Antworten statt "opaque", damit der Service Worker angesehene Kacheln platzsparend zwischenspeichern kann
const rasterBase = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, crossOrigin: true, attribution: '© OpenStreetMap-Mitwirkende'
}).addTo(map);

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
let routeStages = [], currentTrip = null; // Mehrtagestour: km am Ende jedes Tages außer dem letzten
const sim = { km: 0, running: false, frame: 0, last: 0, zoomAt: 0, zoomFrom: 0, zoomTo: 0, marker: null, profile: false };
const gradeSignLayer = L.layerGroup().addTo(map);
const stageLayer = L.layerGroup().addTo(map);
const poiLayer = L.layerGroup();
const cacheLayer = L.layerGroup().addTo(map);
let caches = [];
const oc = { key: '', on: true, request: 0 };

// Referenzlinie für POI-/Cache-Filter: berechnete Route oder geladener GPX-Track
function setRouteCoords(coords) {
  stopSim();
  routeManeuvers = [];
  eleData = null;
  gradeSignLayer.clearLayers();
  wxRouteLayer.clearLayers();
  $('wxRouteSummary').textContent = '';
  // nach showTrip, das routeKmh erst danach setzt
  queueMicrotask(loadRouteWeather);
  routeStages = []; stageLayer.clearLayers(); $('stageSummary').textContent = '';
  $('play').hidden = false;
  $('navStart').hidden = false;
  $('gpxTour').hidden = false;
  $('mapSave').hidden = !vm.layer; $('mapSaveInfo').textContent = '';
  routeCoords = coords;
  routeKm = [0];
  for (let i = 1; i < coords.length; i++) routeKm.push(routeKm[i - 1] + map.distance(coords[i - 1], coords[i]) / 1000);
  loadOpencaching();
  queueMicrotask(expRouteChanged);
}

const $ = id => document.getElementById(id);
const label = (v, words) => words[Math.min(words.length - 1, Math.floor(v * words.length))];
const primaryWords = ['strikt meiden', 'meiden', 'neutral', 'bevorzugen'];
const hillsWords = ['meiden', 'eher meiden', 'egal', 'gern'];

$('speed').oninput = e => $('speedVal').textContent = e.target.value;
$('primary').oninput = e => $('primaryVal').textContent = label(+e.target.value, primaryWords);
$('hills').oninput = e => $('hillsVal').textContent = label(+e.target.value, hillsWords);
$('radius').oninput = e => $('radiusVal').textContent = e.target.value;
$('radius').onchange = () => { loadPois(); loadOpencaching(); };
$('cachesNearRoute').onchange = () => renderCaches();
$('poiTypes').insertAdjacentHTML('beforeend', POI_TYPES.map(t =>
  `<label><input type="checkbox" value="${t.id}"${t.off ? '' : ' checked'}> ${t.icon} ${t.name}</label>`).join(''));
$('poiTypes').onchange = () => loadPois();
$('brand').onchange = () => loadPois();
// Nur Marken, die aktuell 50er/45-km/h-Fahrzeuge anbieten (Honda und Yamaha nur noch elektrisch: EM1 e:, Neo's). Suzuki hat keine mehr.
const BRANDS = ['Peugeot', 'Piaggio', 'Vespa', 'Aprilia', 'Kymco', 'SYM', 'Rieju', 'Beta', 'Kreidler', 'Rex', 'Nova Motors', 'Baotian', 'Niu', 'Honda', 'Yamaha'];
$('brands').insertAdjacentHTML('beforeend', BRANDS.map(b => `<label><input type="checkbox" value="${b}"> ${b}</label>`).join(''));
$('brands').onchange = () => loadPois();
// Regler und Klappzustand merken; Kurzfassung im eingeklappten Kopf
const SETTING_IDS = ['speed', 'primary', 'hills', 'radius', 'gradeWarn', 'avgSpeed', 'wxWindow', 'dayMax', 'breakMin', 'dayStart'];
const settings = store.get('settings', {});
SETTING_IDS.forEach(id => { if (settings[id] != null) $(id).value = settings[id]; });
['profileBox', 'poiBox', 'trafficBox', 'ocBox'].forEach(id => {
  $(id).open = !!settings[id];
  $(id).addEventListener('toggle', () => { settings[id] = $(id).open; store.set('settings', settings); });
});
function updateFoldSummaries() {
  SETTING_IDS.forEach(id => { settings[id] = $(id).value; });
  store.set('settings', settings);
  $('profileSummary').textContent = `${$('speed').value} km/h${+$('avgSpeed').value > 0 ? ` (Ø ${$('avgSpeed').value})` : ''} · Hauptstr. ${$('primaryVal').textContent} · Steigung ${$('hillsVal').textContent}` +
    (+$('gradeWarn').value ? ` · ⚠ ab ${$('gradeWarn').value} %` : '') + (+$('dayMax').value ? ` · 🌙 ${$('dayMax').value} h/Tag` : '') + (+$('breakMin').value ? ` · ☕ ${$('breakMin').value} min/2 h` : '');
  const on = POI_TYPES.filter(t => $('poiTypes').querySelector(`input[value="${t.id}"]`)?.checked).map(t => t.icon).join('');
  $('poiBoxSummary').textContent = `${on || 'aus'} · ${$('radius').value} m`;
}
$('panel').addEventListener('input', e => { if (e.target.closest('details.fold')) updateFoldSummaries(); });
$('panel').addEventListener('change', e => { if (e.target.closest('details.fold')) updateFoldSummaries(); });
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
showRideStyle();

const coordText = ll => `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`;
const isEnd = i => i === 0 || i === waypoints.length - 1;
