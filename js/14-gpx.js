// --- GPX: Tracks werden zur Referenzlinie, eigene POIs (aus „GPX speichern“) kommen in die POI-Liste ---
const childText = (el, name) => el.getElementsByTagNameNS('*', name)[0]?.textContent.trim() || '';

function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Keine gültige GPX-Datei');
  const pts = sel => [...doc.getElementsByTagNameNS('*', sel)].map(p => [+p.getAttribute('lat'), +p.getAttribute('lon')]);
  const track = pts('trkpt').length ? pts('trkpt') : pts('rtept');
  const wpts = [...doc.getElementsByTagNameNS('*', 'wpt')].map(w => ({
    own: childText(w, 'type') === 'scooterways', sym: childText(w, 'sym'), desc: childText(w, 'desc'),
    lat: +w.getAttribute('lat'), lon: +w.getAttribute('lon'), code: childText(w, 'name')
  }));
  return { track, wpts };
}

// Dichte Logger-Tracks (1 Punkt/s) auf Punkte im Mindestabstand ausdünnen
function thin(coords, minMeters = 15) {
  const out = coords.slice(0, 1);
  for (const c of coords.slice(1)) if (map.distance(out[out.length - 1], c) >= minMeters) out.push(c);
  if (coords.length > 1 && out[out.length - 1] !== coords[coords.length - 1]) out.push(coords[coords.length - 1]);
  return out;
}

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
      added += wpts.filter(w => w.own).length;
    }
    if (tracks) loadPois();
    $('gpxInfo').textContent = tracks || added ? '' : '⚠️ Die Datei enthält weder Track noch eigene POIs.';
  } catch (err) {
    $('gpxInfo').textContent = '⚠️ GPX: ' + err.message;
  }
  e.target.value = '';
};
