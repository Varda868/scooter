// --- GPX: Tracks werden zur Referenzlinie, Wegpunkte (z. B. Geocaches aus c:geo/GSAK/Pocket Queries) zu Markern ---
const CACHE_ICONS = { traditional: '📦', multi: '🧩', unknown: '❓', mystery: '❓', quiz: '❓', math: '❓', earthcache: '🌍', 'drive-in': '🚗', moving: '🚚',
  letterbox: '✉️', wherigo: '📱', virtual: '👻', event: '🎉', webcam: '📷' };
const childText = (el, name) => el.getElementsByTagNameNS('*', name)[0]?.textContent.trim() || '';

function cacheIcon(type, isCache) {
  if (!isCache) return '📍';
  const key = Object.keys(CACHE_ICONS).find(k => type.toLowerCase().includes(k));
  return key ? CACHE_ICONS[key] : '📦';
}

function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Keine gültige GPX-Datei');
  const pts = sel => [...doc.getElementsByTagNameNS('*', sel)].map(p => [+p.getAttribute('lat'), +p.getAttribute('lon')]);
  const track = pts('trkpt').length ? pts('trkpt') : pts('rtept');
  const wpts = [...doc.getElementsByTagNameNS('*', 'wpt')].map(w => {
    const cache = w.getElementsByTagNameNS('*', 'cache')[0];
    const code = childText(w, 'name');
    const sym = childText(w, 'sym');
    const isCache = !!cache || /^geocache/i.test(sym) || /^GC[0-9A-Z]+$/i.test(code);
    const type = (cache && childText(cache, 'type')) || childText(w, 'type').replace(/^Geocache\|/i, '');
    return {
      own: childText(w, 'type') === 'scooterways', sym, desc: childText(w, 'desc'),
      lat: +w.getAttribute('lat'), lon: +w.getAttribute('lon'), code, isCache, type,
      title: (cache && childText(cache, 'name')) || childText(w, 'desc') || code,
      difficulty: cache ? childText(cache, 'difficulty') : '',
      terrain: cache ? childText(cache, 'terrain') : '',
      container: cache ? childText(cache, 'container') : '',
      url: childText(w, 'url') || (/^GC/i.test(code) ? `https://coord.info/${code}` : '')
    };
  });
  return { track, wpts };
}

// Dichte Logger-Tracks (1 Punkt/s) auf Punkte im Mindestabstand ausdünnen
function thin(coords, minMeters = 15) {
  const out = coords.slice(0, 1);
  for (const c of coords.slice(1)) if (map.distance(out[out.length - 1], c) >= minMeters) out.push(c);
  if (coords.length > 1 && out[out.length - 1] !== coords[coords.length - 1]) out.push(coords[coords.length - 1]);
  return out;
}

$('gpxCaches').onchange = e => $('gpx').onchange(e);
$('gpx').onchange = async e => {
  let tracks = 0, added = 0;
  try {
    for (const file of e.target.files) {
      const { track, wpts } = parseGpx(await file.text());
      if (track.length > 1) {
        tracks++;
        if (routeLayer) map.removeLayer(routeLayer);
        setRouteCoords(thin(track));
        routeKmh = null;
        routeLayer = L.polyline(routeCoords, { color: '#2e86e4', weight: 4 }).addTo(map);
        fitFein(routeLayer.getBounds());
        $('steps').innerHTML = '';
        $('summary').textContent = `GPX-Track „${file.name}“ · ${routeKm[routeKm.length - 1].toFixed(1)} km`;
        loadElevation();
      }
      // Eigene POIs (aus „GPX speichern“) zurück in die POI-Liste, Duplikate überspringen
      for (const w of wpts.filter(w => w.own)) {
        if (!myPois.some(p => p.lat === w.lat && p.lon === w.lon)) {
          myPois.push({ id: Date.now().toString(36) + myPois.length, lat: w.lat, lon: w.lon, name: w.code, icon: w.sym || '⭐', note: w.desc });
        }
      }
      store.set('myPois', myPois);
      renderMyPois();
      caches.push(...wpts.filter(w => !w.own));
      added += wpts.length;
    }
    if (tracks) loadPois();
    renderCaches();
    if (!tracks && added) map.fitBounds(L.latLngBounds(caches.map(c => [c.lat, c.lon])), { padding: [30, 30] });
    if (!tracks && !added) $('cacheSummary').textContent = '⚠️ Die Datei enthält weder Track noch Wegpunkte.';
  } catch (err) {
    $('cacheSummary').textContent = '⚠️ GPX: ' + err.message;
  }
  e.target.value = '';
};

// Cache-Typen zum Filtern; Typnamen aus GPX (Groundspeak) und OKAPI landen per Teilwort in einer Gruppe
const CACHE_GROUPS = [
  { id: 'trad', icon: '📦', color: '#02874d', name: 'Tradi', words: ['traditional'] },
  { id: 'multi', icon: '🧩', color: '#e98300', name: 'Multi', words: ['multi'] },
  { id: 'mystery', icon: '❓', color: '#0b5fb4', name: 'Mystery/Quiz', words: ['unknown', 'mystery', 'quiz', 'math'] },
  { id: 'virtual', icon: '🌍', color: '#0aa3a3', name: 'Earth/Virtual/Webcam', words: ['earth', 'virtual', 'webcam'] },
  { id: 'event', icon: '🎉', color: '#c0392b', name: 'Event', words: ['event'] },
  { id: 'other', icon: '📍', color: '#777', name: 'Andere', words: [] }
];
const cacheGroup = c => !c.isCache ? 'other'
  : (CACHE_GROUPS.find(g => g.words.some(w => (c.type || '').toLowerCase().includes(w))) || CACHE_GROUPS.at(-1)).id;
const cacheTypesOn = new Set(store.get('cacheTypes', CACHE_GROUPS.map(g => g.id)));
$('cacheTypes').insertAdjacentHTML('beforeend', CACHE_GROUPS.map(g =>
  `<label><input type="checkbox" value="${g.id}"${cacheTypesOn.has(g.id) ? ' checked' : ''}> ${g.icon} ${g.name}</label>`).join(''));
$('cacheTypes').onchange = e => {
  e.target.checked ? cacheTypesOn.add(e.target.value) : cacheTypesOn.delete(e.target.value);
  store.set('cacheTypes', [...cacheTypesOn]);
  updateCacheBoxSummary();
  renderCaches();
};
