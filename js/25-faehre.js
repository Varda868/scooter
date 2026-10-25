// Fähren auf der Route: Valhalla meldet Ein- und Ausschiffen nur als Manöver (28/29, travel_type bleibt das Fahrzeug),
// Betreiber, Dauer und Link holen wir aus OSM (route=ferry). Fahrpläne und Preise gibt es dort nicht.
const FAEHRE_EIN = 28, FAEHRE_AUS = 29, FAEHRE_R = 300;
const faehreCache = new Map(); // "lat,lon" → Promise mit OSM-Tags der Linie oder null
let faehreReq = 0;

// Fährstücke der Route: [{ km, bisKm, lat, lon, zLat, zLon, s, name }]
function faehrenDerRoute(trip) {
  const out = [];
  let off = 0, cur = null;
  for (const l of trip.legs) {
    for (const m of l.maneuvers) {
      const i = off + m.begin_shape_index, p = routeCoords[i];
      // travel_type bleibt bei Valhalla das Fahrzeug, die Fähre steckt nur in den Manövern dazwischen
      if (m.type === FAEHRE_EIN && p) cur = { km: routeKm[i] ?? 0, lat: p[0], lon: p[1], s: m.time || 0, name: m.street_names?.[0] || '' };
      else if (m.type === FAEHRE_AUS && cur && p) {
        const bisKm = routeKm[i] ?? cur.km;
        // Ohne Zeit von Valhalla mit 25 km/h schätzen (wie faehrTrip)
        Object.assign(cur, { bisKm, zLat: p[0], zLon: p[1], s: cur.s || (bisKm - cur.km) / 25 * 3600 }); out.push(cur); cur = null;
      } else if (cur) { cur.s += m.time || 0; cur.name ||= m.street_names?.[0] || ''; }
    }
    off += decode(l.shape).length - 1;
  }
  return out;
}

// Linie am Anleger suchen: zuerst in den eigenen Kacheln (poi/f/), sonst Overpass.
// Die mit passendem Namen gewinnt, sonst die erste (bei Overpass bevorzugt die Relation)
function faehreLinie(f) {
  const key = `${f.lat.toFixed(4)},${f.lon.toFixed(4)}`;
  if (!faehreCache.has(key)) faehreCache.set(key, faehreAusKacheln(f).catch(() => null).then(t => t || faehreOverpass(f, key)));
  return faehreCache.get(key);
}
async function faehreAusKacheln(f) {
  const ix = await poiTileIndex();
  const k = `${Math.floor(f.lat)}_${Math.floor(f.lon)}`;
  if (!ix?.ferryTiles?.includes(k)) return null;
  const n = f.name.toLowerCase(), nah = (await faehrKachel(ix, k)).filter(([, pts]) => faehreAbstand(f.lat, f.lon, pts) <= FAEHRE_R);
  const el = nah.find(([, , t]) => n && (t.name || '').toLowerCase() === n) || nah[0];
  return el ? { ...el[2], '@osm': `way/${el[0].slice(1)}` } : null;
}
// Kürzester Abstand in m vom Punkt zur Linie (flach gerechnet, reicht für ein paar hundert Meter)
function faehreAbstand(lat, lon, pts) {
  const ky = 110540, kx = 111320 * Math.cos(lat * Math.PI / 180);
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const ax = (pts[i][1] - lon) * kx, ay = (pts[i][0] - lat) * ky;
    if (i === pts.length - 1) { best = Math.min(best, Math.hypot(ax, ay)); break; }
    const bx = (pts[i + 1][1] - lon) * kx, by = (pts[i + 1][0] - lat) * ky, dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / ((dx * dx + dy * dy) || 1)));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}
const faehrKacheln = new Map();
function faehrKachel(ix, k) {
  const url = `${POI_TILE_URL}f/${k}.json?v=${ix.date}`;
  if (!faehrKacheln.has(url)) faehrKacheln.set(url, fetch(url, { signal: AbortSignal.timeout(20000) })
    .then(r => { if (!r.ok) throw new Error(`Fähr-Kachel ${k}: ${r.status}`); return r.json(); })
    .catch(err => { faehrKacheln.delete(url); throw err; }));
  return faehrKacheln.get(url);
}
function faehreOverpass(f, key) {
  const um = `(around:${FAEHRE_R},${f.lat.toFixed(5)},${f.lon.toFixed(5)})`;
  return overpassFetch(`[out:json][timeout:25];(way[route=ferry]${um};relation[route=ferry]${um};);out tags;`)
    .then(d => {
      const els = (d?.elements || []).filter(e => e.tags);
      const n = f.name.toLowerCase();
      const el = els.find(e => n && (e.tags.name || '').toLowerCase() === n) ||
        els.find(e => e.type === 'relation') || els[0];
      return el ? { ...el.tags, '@osm': `${el.type}/${el.id}` } : null;
    })
    .catch(err => { faehreCache.delete(key); throw err; });
}

// OSM-Dauer "01:45" oder "105" → Sekunden
function faehreDauer(d) {
  const m = /^(\d+):(\d\d)/.exec(d || '');
  return m ? (+m[1] * 60 + +m[2]) * 60 : /^\d+$/.test(d || '') ? +d * 60 : 0;
}

// Darf ein 50er mit? yes bei moped/motorcycle/motor_vehicle/motorcar/vehicle, no nur bei ausdrücklichem Verbot
function faehreMitnahme(t) {
  const ja = ['moped', 'mofa', 'motorcycle', 'motor_vehicle', 'motorcar', 'vehicle'].find(k => t[k] === 'yes');
  if (ja) return '🛵 Fahrzeuge ja';
  if (['moped', 'motorcycle', 'motor_vehicle', 'vehicle'].some(k => t[k] === 'no')) return '⚠ laut OSM keine Fahrzeuge';
  return 'Mitnahme unklar';
}

function faehreText(f, t) {
  return `⛴ km ${f.km.toFixed(0)} · ` + faehreDetails(t, f.name, f.s);
}
// Name · Betreiber · Dauer · Mitnahme · Links; s = Fahrzeit laut Valhalla, falls OSM keine Dauer kennt
function faehreDetails(t, nameFallback = '', s = 0) {
  const name = t?.name || nameFallback || 'Fähre';
  const dauer = faehreDauer(t?.duration) || s;
  const web = t && (t.website || t['contact:website'] || t.url);
  const such = `https://duckduckgo.com/?q=${encodeURIComponent([t?.operator, name, 'Fähre Fahrplan'].filter(Boolean).join(' '))}`;
  return escapeHtml(name) + (t?.operator ? ` · ${escapeHtml(t.operator)}` : '') +
    (dauer ? ` · ca. ${durText(dauer)}` : '') + (t ? ` · ${faehreMitnahme(t)}` : '') +
    (web && /^https?:\/\//.test(web) ? ` · <a href="${escapeHtml(web)}" target="_blank" rel="noopener">Betreiber ↗</a>`
      : ` · <a href="${such}" target="_blank" rel="noopener">suchen ↗</a>`) +
    (t?.['@osm'] ? ` · <a href="https://www.openstreetmap.org/${t['@osm']}" target="_blank" rel="noopener">OSM</a>` : '');
}

// Fährstücke auf der Route kenntlich machen: blau gestrichelt über dem Routenstrich, ⛴ in der Mitte
const faehrStrich = L.layerGroup().addTo(map);
function faehrStrichZeichnen(fs) {
  faehrStrich.clearLayers();
  // Neue Route: Ebene wieder nach der Regel (mit Fähre ausgeblendet); routeFaehren ist schon gesetzt
  faehrAlle = false;
  if (typeof faehrlinienZeigen === 'function') queueMicrotask(faehrlinienZeigen);
  for (const f of fs) {
    const pts = routeCoords.filter((_, i) => routeKm[i] >= f.km - 1e-6 && routeKm[i] <= f.bisKm + 1e-6);
    // Kurze Fähren (Fluss) nur mit ⛴, der Strich lohnt erst bei längeren Überfahrten
    if (pts.length >= 2 && f.bisKm - f.km >= FAEHR_KLEIN_KM) {
      L.polyline(pts, { color: '#fff', weight: 6, interactive: false }).addTo(faehrStrich);
      L.polyline(pts, { color: '#1f6fd1', weight: 4, dashArray: '8 7', interactive: false }).addTo(faehrStrich);
    }
    // Anleger der gewählten Fähre deutlich, die Linien-Ebene ist dann ausgeblendet
    // Antippen: dort übernachten (vor der Abfahrt oder nach der Ankunft)
    [[f.lat, f.lon, 'ab'], [f.zLat, f.zLon, 'an']].forEach(([la, lo, was]) => {
      if (la == null) return;
      const ll = L.latLng(la, lo), name = `⛴ ${f.name || 'Fähre'} · ${was}`;
      L.circleMarker(ll, { radius: 7, color: '#fff', weight: 2, fillColor: '#1f6fd1', fillOpacity: 1, bubblingMouseEvents: false })
        .bindPopup(() => { const box = document.createElement('div'); box.innerHTML = `<b>${escapeHtml(name)}</b>`;
          box.append(menuBox([['nacht', '🌙 Hier übernachten']], () =>
            changeWaypoints(() => { insertVia(ll); Object.assign(waypoints.find(w => w.latlng === ll), { text: name, night: 1 }); })));
          return box; }, { className: 'map-menu', minWidth: 170 }).addTo(faehrStrich);
    });
    L.marker(pointAtKm((f.km + f.bisKm) / 2), { keyboard: false, zIndexOffset: 300,
      icon: L.divIcon({ className: 'poi-icon', html: '⛴', iconSize: [24, 24] }) })
      .bindTooltip(`⛴ ${escapeHtml(f.name || 'Fähre')} · ${Math.round(f.bisKm - f.km)} km · ca. ${durText(f.s)}`).addTo(faehrStrich);
  }
}
async function faehrenZeigen(trip) {
  const req = ++faehreReq, box = $('faehreInfo');
  const fs = trip ? faehrenDerRoute(trip) : [];
  faehrStrichZeichnen(fs);
  box.innerHTML = fs.map(f => `<div>${faehreText(f, null)}</div>`).join('');
  if (!fs.length) return;
  const tags = await Promise.all(fs.map(f => faehreLinie(f).catch(() => null)));
  if (req !== faehreReq) return;
  box.innerHTML = fs.map((f, i) => `<div>${faehreText(f, tags[i])}</div>`).join('');
}

// Eine Linie der Kartenebene: zart mit ⛴ in der Mitte; Hover oder Antippen hebt sie hervor, zeigt die Anleger
// und das Infokästchen. Kurze Fluss- und Seefähren (unter FAEHR_KLEIN_KM) bleiben weg, die stehen nur an der Route.
const FAEHR_KLEIN_KM = 5;
const faehrLaenge = pts => pts.reduce((s, p, i) => i ? s + L.latLng(pts[i - 1]).distanceTo(p) : 0, 0) / 1000;
function faehrLinie(id, pts, t) {
  const g = L.layerGroup().addTo(faehrLayer);
  if (pts.length < 2 || faehrLaenge(pts) < FAEHR_KLEIN_KM) return g;
  const mit = faehreMitnahme(t), ok = mit.startsWith('🛵'), nein = mit.startsWith('⚠');
  const farbe = nein ? '#8a8a8a' : '#1f6fd1', zart = { weight: 1.5, opacity: 0.55 }, stark = { weight: 4, opacity: 1 };
  const linie = L.polyline(pts, { color: farbe, ...zart, dashArray: ok ? null : '6 6' }).addTo(g);
  const anleger = L.layerGroup([pts[0], pts.at(-1)].map(p => L.circleMarker(p, { radius: 5, color: '#fff', weight: 2, fillColor: farbe, fillOpacity: 1, interactive: false })));
  const mitte = L.marker(linie.getCenter(), { keyboard: false,
    icon: L.divIcon({ className: 'poi-icon faehr-mitte', html: '⛴', iconSize: [20, 20] }), title: t.name || 'Fähre' }).addTo(g);
  let offen = false;
  const hell = an => { linie.setStyle(an ? stark : zart); if (an) { linie.bringToFront(); anleger.addTo(g); } else if (!offen) g.removeLayer(anleger); };
  const popup = () => {
    const box = document.createElement('div');
    box.innerHTML = `⛴ ${faehreDetails({ ...t, '@osm': `way/${id.slice(1)}` })}`;
    if (waypoints[0].latlng && waypoints.at(-1).latlng)
      box.append(menuBox([['faehre', '⛴ Diese Fähre in die Route']], () => faehreInRoute(pts, t.name)));
    else box.insertAdjacentHTML('beforeend', '<div class="hint">Erst Start und Ziel setzen, dann lässt sich die Fähre einbauen.</div>');
    return box;
  };
  for (const l of [linie, mitte]) l.bindPopup(popup).on('mouseover', () => hell(true)).on('mouseout', () => offen || hell(false))
    .on('popupopen', () => { offen = true; hell(true); }).on('popupclose', () => { offen = false; hell(false); });
  return g;
}

// Beide Anleger als Zwischenziele, in Fahrtrichtung: der vom vorigen Punkt aus nähere zuerst
function faehreInRoute(pts, name) {
  const a = L.latLng(pts[0]), b = L.latLng(pts.at(-1)), text = was => `⛴ ${name || 'Fähre'} · ${was}`;
  changeWaypoints(() => {
    insertVia(a);
    const i = waypoints.findIndex(w => w.latlng === a), vor = waypoints[i - 1]?.latlng;
    const zuerstB = vor && vor.distanceTo(b) < vor.distanceTo(a);
    waypoints[i].text = text(zuerstB ? 'an' : 'ab');
    waypoints.splice(zuerstB ? i : i + 1, 0, { latlng: b, text: text(zuerstB ? 'ab' : 'an'), shaping: false });
  });
}

// --- Kartenebene: alle Fährlinien (und ab Zoom 10 die Anleger) im Ausschnitt, aus den eigenen Kacheln ---
const FAEHR_ZOOM = 6, FAEHR_ANLEGER_ZOOM = 10, FAEHR_MAX_KACHELN = 80;
const faehrLayer = L.layerGroup(), faehrGezeigt = new Map(); // id → Layer
let faehrReq = 0;
// Hat die Route schon eine Fähre, treten die übrigen Linien zurück: dann sieht man eindeutig die gewählte Überfahrt
// und ihre Anleger. „trotzdem zeigen“ holt alle zurück, etwa um eine andere Fähre zu wählen.
let faehrAlle = false;
async function faehrlinienZeigen() {
  const req = ++faehrReq, an = $('ferryLines').checked, routeHat = routeFaehren.length > 0 && !faehrAlle;
  if (!an || map.getZoom() < FAEHR_ZOOM || routeHat) {
    faehrLayer.clearLayers(); faehrGezeigt.clear(); map.removeLayer(faehrLayer);
    $('ferryLinesHint').innerHTML = !an ? '' : routeHat ? 'ausgeblendet, die Route hat eine Fähre · <a href="#" id="faehrAlle">trotzdem zeigen</a>'
      : 'erst ab näherem Zoom';
    return;
  }
  faehrLayer.addTo(map);
  const ix = await poiTileIndex();
  if (req !== faehrReq) return;
  if (!ix?.ferryTiles) { $('ferryLinesHint').textContent = 'noch keine Fährdaten auf dem Server'; return; }
  const b = map.getBounds(), set = new Set(ix.ferryTiles), keys = [], poiKeys = [];
  for (let a = Math.floor(b.getSouth()); a <= Math.floor(b.getNorth()); a++)
    for (let o = Math.floor(b.getWest()); o <= Math.floor(b.getEast()); o++) {
      if (set.has(`${a}_${o}`)) keys.push(`${a}_${o}`);
      if (ix.set.has(`${a}_${o}`)) poiKeys.push(`${a}_${o}`);
    }
  const tiles = await Promise.all(keys.slice(0, FAEHR_MAX_KACHELN).map(k => faehrKachel(ix, k).catch(() => [])));
  if (req !== faehrReq) return;
  const sichtbar = new Set();
  for (const [id, pts, t] of tiles.flat()) {
    sichtbar.add(id);
    if (faehrGezeigt.has(id)) continue;
    faehrGezeigt.set(id, faehrLinie(id, pts, t));
  }
  // Anleger aus den POI-Kacheln, nur nah genug, sonst wird es voll
  if (map.getZoom() >= FAEHR_ANLEGER_ZOOM) {
    const pt = await Promise.all(poiKeys.slice(0, 9).map(k => {
      const url = `${POI_TILE_URL}t/${k}.json?v=${ix.date}`;
      if (!poiTiles.has(url)) poiTiles.set(url, fetch(url, { signal: AbortSignal.timeout(20000) }).then(r => r.ok ? r.json() : [])
        .catch(() => { poiTiles.delete(url); return []; }));
      return poiTiles.get(url).catch(() => []);
    }));
    if (req !== faehrReq) return;
    for (const [id, lat, lon, t] of pt.flat()) {
      if (t.amenity !== 'ferry_terminal') continue;
      sichtbar.add(id);
      if (faehrGezeigt.has(id)) continue;
      faehrGezeigt.set(id, L.marker([lat, lon], { icon: L.divIcon({ className: 'poi-icon faehr-anleger', html: '⛴', iconSize: [22, 22] }), title: t.name || 'Fähranleger' })
        .bindPopup(() => `<b>${escapeHtml(t.name || 'Fähranleger')}</b>` + contactInfo(t)).addTo(faehrLayer));
    }
  }
  // Was weit aus dem Bild ist, wieder weg
  for (const [id, l] of faehrGezeigt) if (!sichtbar.has(id)) { faehrLayer.removeLayer(l); faehrGezeigt.delete(id); }
  $('ferryLinesHint').textContent = `${[...faehrGezeigt].filter(([id, l]) => id[0] === 'w' && l.getLayers().length).length} Linien · Stand ${ix.date.split('-').reverse().join('.')}` +
    (keys.length > FAEHR_MAX_KACHELN ? ' · näher heran für alle' : '');
}
$('ferryLinesHint').addEventListener('click', e => { if (e.target.id !== 'faehrAlle') return; e.preventDefault(); faehrAlle = true; faehrlinienZeigen(); });
$('ferryLines').checked = !!settings.ferryLines;
$('ferryLines').onchange = () => { settings.ferryLines = $('ferryLines').checked; store.set('settings', settings); faehrlinienZeigen(); };
map.on('moveend', () => { if ($('ferryLines').checked) faehrlinienZeigen(); });
faehrlinienZeigen();
