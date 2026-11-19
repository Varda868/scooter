// --- GPX: Tracks werden zur Referenzlinie, Routen (<rte>) zu Wegpunkten, die Valhalla neu rechnet;
// Wegpunkte (<wpt>) kommen als eigene POIs in die Liste (eigene aus „GPX speichern“ wie gespeichert, fremde z. B. Geocaches
// mit Symbol nach Art und der Datei als Quelle, damit sie sich gesammelt wieder entfernen lassen) ---
const childText = (el, name) => el.getElementsByTagNameNS('*', name)[0]?.textContent.trim() || '';

function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Keine gültige GPX-Datei');
  const pts = sel => [...doc.getElementsByTagNameNS('*', sel)].map(p => [+p.getAttribute('lat'), +p.getAttribute('lon')]);
  const track = pts('trkpt');
  const rte = [...doc.getElementsByTagNameNS('*', 'rtept')].map(p => ({ lat: +p.getAttribute('lat'), lon: +p.getAttribute('lon'),
    name: [childText(p, 'name'), childText(p, 'desc')].filter(Boolean).join(' · ') }));
  const wpts = [...doc.getElementsByTagNameNS('*', 'wpt')].map(w => ({
    own: childText(w, 'type') === 'scooterways', sym: childText(w, 'sym'), desc: childText(w, 'desc'), typ: childText(w, 'type'),
    cmt: childText(w, 'cmt'), link: w.getElementsByTagNameNS('*', 'link')[0]?.getAttribute('href') || '',
    lat: +w.getAttribute('lat'), lon: +w.getAttribute('lon'), code: childText(w, 'name')
  })).filter(w => Number.isFinite(w.lat) && Number.isFinite(w.lon));
  return { track, rte, wpts };
}

// Dichte Logger-Tracks (1 Punkt/s) auf Punkte im Mindestabstand ausdünnen
function thin(coords, minMeters = 15) {
  const out = coords.slice(0, 1);
  for (const c of coords.slice(1)) if (map.distance(out[out.length - 1], c) >= minMeters) out.push(c);
  if (coords.length > 1 && out[out.length - 1] !== coords[coords.length - 1]) out.push(coords[coords.length - 1]);
  return out;
}

// Symbol für fremde Wegpunkte: Geocaches nach Art, sonst nach <sym>
function gpxIcon(w) {
  if (/geocache/i.test(w.typ + ' ' + w.sym)) return /unknown|myster/i.test(w.typ) ? '❓' : /multi/i.test(w.typ) ? '🧭' : '📦';
  return { residence: '🏠', flag: '🚩', 'gas station': '⛽', restaurant: '🍴', campground: '⛺', parking: '🅿' }[w.sym.toLowerCase()] || '📍';
}
// Name wie in der Datei, beim Geocache Code und Titel („GCBJN58 Geschickt geflickt“), ohne laufende Nummer aus cmt
const gpxName = w => [w.code, w.cmt.replace(/^\d+\s+/, '')].filter((x, i, a) => x && a.indexOf(x) === i && !(i && a[0].includes(x))).join(' ') || 'Wegpunkt';

$('gpx').onchange = async e => {
  let tracks = 0, added = 0;
  try {
    for (const file of e.target.files) {
      const { track, rte, wpts } = parseGpx(await file.text());
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
      } else if (rte.length > 1) {
        // Route statt Track: Punkte der Reihe nach als Halte, die Strecke rechnet Valhalla für den Roller
        tracks++;
        const wps = rte.map(p => ({ latlng: L.latLng(p.lat, p.lon), text: p.name }));
        changeWaypoints(() => { waypoints = wps; excluded = []; });
        map.fitBounds(L.latLngBounds(wps.map(w => w.latlng)), { padding: [30, 30] });
      }
      // Wegpunkte als eigene POIs, Duplikate (gleiche Stelle) überspringen
      let neu = 0;
      for (const w of wpts) {
        if (myPois.some(p => Math.abs(p.lat - w.lat) < 1e-5 && Math.abs(p.lon - w.lon) < 1e-5)) continue;
        myPois.push(w.own
          ? { id: Date.now().toString(36) + myPois.length, lat: w.lat, lon: w.lon, name: w.code, icon: w.sym || '⭐', note: w.desc }
          : { id: Date.now().toString(36) + myPois.length, lat: w.lat, lon: w.lon, name: gpxName(w), icon: gpxIcon(w),
              note: [w.desc, /^https?:\/\//.test(w.link) ? w.link : ''].filter(Boolean).join(' · '), quelle: file.name });
        neu++;
      }
      store.set('myPois', myPois);
      renderMyPois();
      added += neu;
      if (neu && wpts.some(w => !w.own)) gpxQuelle = file.name;
    }
    if (tracks) loadPois();
    gpxInfoZeigen(tracks || added ? '' : '⚠️ Die Datei enthält weder Track, Route noch Wegpunkte.', added);
  } catch (err) {
    $('gpxInfo').textContent = '⚠️ GPX: ' + err.message;
  }
  e.target.value = '';
};

// Hinweis nach dem Laden; fremde Wegpunkte einer Datei lassen sich mit einem Tipp wieder entfernen
let gpxQuelle = null;
function gpxInfoZeigen(text, added) {
  const n = gpxQuelle ? myPois.filter(p => p.quelle === gpxQuelle).length : 0;
  $('gpxInfo').innerHTML = escapeHtml(text) + (n ? `${text ? ' ' : ''}${added} POI(s) übernommen. <button type="button" class="secondary klein" id="gpxPoisWeg">🗑 ${n} POIs aus „${escapeHtml(gpxQuelle)}“ entfernen</button>` : '');
  const weg = $('gpxPoisWeg');
  if (weg) weg.onclick = () => {
    myPois = myPois.filter(p => p.quelle !== gpxQuelle);
    store.set('myPois', myPois);
    renderMyPois();
    poiHinweise();
    gpxQuelle = null;
    $('gpxInfo').textContent = 'POIs aus der Datei entfernt.';
  };
}
