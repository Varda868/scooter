// --- Entdecker (wie Statshunters/VeloViewer): gefahrene Touren als Heatmap und als Kacheln der Zoomstufe 14
// (ca. 1,6 × 1,6 km). Zählt besuchte Kacheln, den Cluster (Kacheln mit allen vier Nachbarn besucht) und das
// größte lückenlose Quadrat. Touren liegen nur in diesem Browser (IndexedDB), ausgedünnt auf 25 m.
const EXP_Z = 14, EXP_N = 2 ** EXP_Z;
const exp = { rides: [], tiles: new Set(), cluster: new Set(), square: null, routeNew: new Set(), rec: [], db: null };
const expPrefs = { tiles: false, heat: false, rec: true, ...store.get('explore', {}) };
const expKey = (x, y) => x * EXP_N + y;
const expTileXY = (lat, lon) => {
  const r = lat * Math.PI / 180;
  return [Math.floor((lon + 180) / 360 * EXP_N), Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * EXP_N)];
};
const expTileCenter = (x, y) => {
  const n = Math.PI - 2 * Math.PI * (y + 0.5) / EXP_N;
  return L.latLng(180 / Math.PI * Math.atan(Math.sinh(n)), (x + 0.5) / EXP_N * 360 - 180);
};

// Alle Kacheln, die eine Linie berührt: Abschnitte alle 200 m abtasten (Kachel ≥ 1 km, Ecken schneidet das kaum)
function tilesOf(coords, set = new Set()) {
  for (let i = 0; i < coords.length; i++) {
    const [lat, lon] = coords[i];
    if (i) {
      const [plat, plon] = coords[i - 1], steps = Math.ceil(map.distance([plat, plon], [lat, lon]) / 200);
      for (let k = 1; k < steps; k++) set.add(expKey(...expTileXY(plat + (lat - plat) * k / steps, plon + (lon - plon) * k / steps)));
    }
    set.add(expKey(...expTileXY(lat, lon)));
  }
  return set;
}
const newTilesOf = coords => { const out = new Set(); for (const k of tilesOf(coords)) if (!exp.tiles.has(k)) out.add(k); return out; };

// Nächstgelegene unbefahrene Kachel (Mitte) im Umkreis, sonst der Punkt selbst
function nearestNewTile(ll, maxM) {
  const [cx, cy] = expTileXY(ll.lat, ll.lng);
  if (!exp.tiles.has(expKey(cx, cy))) return ll;
  const reach = Math.max(1, Math.ceil(maxM / 1600));
  let best = null, bestD = Infinity;
  for (let dx = -reach; dx <= reach; dx++) for (let dy = -reach; dy <= reach; dy++) {
    if (exp.tiles.has(expKey(cx + dx, cy + dy))) continue;
    const c = expTileCenter(cx + dx, cy + dy), d = map.distance(ll, c);
    if (d < bestD && d <= maxM) { best = c; bestD = d; }
  }
  return best || ll;
}

function expStats() {
  exp.tiles = new Set();
  for (const r of exp.rides) tilesOf(r.coords, exp.tiles);
  const has = (x, y) => exp.tiles.has(expKey(x, y));
  const xy = [...exp.tiles].map(k => [Math.floor(k / EXP_N), k % EXP_N]);
  // Cluster: größte zusammenhängende Gruppe von Kacheln, deren vier Nachbarn alle besucht sind
  const inner = new Set(xy.filter(([x, y]) => has(x - 1, y) && has(x + 1, y) && has(x, y - 1) && has(x, y + 1)).map(([x, y]) => expKey(x, y)));
  const seen = new Set();
  exp.cluster = new Set();
  for (const start of inner) {
    if (seen.has(start)) continue;
    const group = [], todo = [start]; seen.add(start);
    while (todo.length) {
      const k = todo.pop(), x = Math.floor(k / EXP_N), y = k % EXP_N;
      group.push(k);
      for (const n of [expKey(x - 1, y), expKey(x + 1, y), expKey(x, y - 1), expKey(x, y + 1)])
        if (inner.has(n) && !seen.has(n)) { seen.add(n); todo.push(n); }
    }
    if (group.length > exp.cluster.size) exp.cluster = new Set(group);
  }
  // Größtes Quadrat: dp(x,y) = Kantenlänge des größten Quadrats mit unterer rechter Ecke (x,y)
  const dp = new Map();
  exp.square = null;
  xy.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  for (const [x, y] of xy) {
    const v = 1 + Math.min(dp.get(expKey(x - 1, y)) || 0, dp.get(expKey(x, y - 1)) || 0, dp.get(expKey(x - 1, y - 1)) || 0);
    dp.set(expKey(x, y), v);
    if (!exp.square || v > exp.square.size) exp.square = { x: x - v + 1, y: y - v + 1, size: v };
  }
}

// Kachelgitter als Canvas-Ebene: besucht grün, Cluster blau, neue Kacheln der geplanten Route orange
map.createPane('explore').style.zIndex = 350;
map.getPane('explore').style.pointerEvents = 'none';
const ExpGrid = L.GridLayer.extend({
  createTile(c) {
    const tile = L.DomUtil.create('canvas'), size = this.getTileSize();
    tile.width = size.x; tile.height = size.y;
    const ctx = tile.getContext('2d'), s = size.x * 2 ** (c.z - EXP_Z), ox = c.x * size.x, oy = c.y * size.y;
    const x0 = Math.floor(ox / s), x1 = Math.floor((ox + size.x - 1) / s), y0 = Math.floor(oy / s), y1 = Math.floor((oy + size.y - 1) / s);
    const paint = (k, color) => {
      const x = Math.floor(k / EXP_N), y = k % EXP_N;
      if (x < x0 || x > x1 || y < y0 || y > y1) return;
      ctx.fillStyle = color; ctx.fillRect(x * s - ox, y * s - oy, Math.max(s, 1), Math.max(s, 1));
    };
    for (const k of exp.tiles) paint(k, exp.cluster.has(k) ? 'rgba(46,110,228,.38)' : 'rgba(46,160,67,.32)');
    for (const k of exp.routeNew) paint(k, 'rgba(255,150,0,.42)');
    if (s >= 10) { // Gitterlinien erst, wenn eine Kachel groß genug ist
      ctx.strokeStyle = 'rgba(0,0,0,.18)'; ctx.lineWidth = 1; ctx.beginPath();
      for (let x = x0; x <= x1 + 1; x++) { ctx.moveTo(x * s - ox + .5, 0); ctx.lineTo(x * s - ox + .5, size.y); }
      for (let y = y0; y <= y1 + 1; y++) { ctx.moveTo(0, y * s - oy + .5); ctx.lineTo(size.x, y * s - oy + .5); }
      ctx.stroke();
    }
    return tile;
  }
});
const expGrid = new ExpGrid({ pane: 'explore', updateWhenZooming: false });
const expSquare = L.rectangle([[0, 0], [0, 0]], { pane: 'explore', color: '#1f4fa0', weight: 2, fill: false, interactive: false, className: 'exp-square' });
const expHeat = L.layerGroup();
const expRenderer = L.canvas({ pane: 'explore' });

function expRender() {
  expGrid.redraw();
  const sq = exp.square;
  if (sq) {
    const n = (y) => 180 / Math.PI * Math.atan(Math.sinh(Math.PI - 2 * Math.PI * y / EXP_N));
    expSquare.setBounds([[n(sq.y + sq.size), sq.x / EXP_N * 360 - 180], [n(sq.y), (sq.x + sq.size) / EXP_N * 360 - 180]]);
  }
  map[expPrefs.tiles ? 'addLayer' : 'removeLayer'](expGrid);
  map[expPrefs.tiles && sq ? 'addLayer' : 'removeLayer'](expSquare);
  expHeat.clearLayers();
  // Heatmap: halbtransparente Linien übereinander; oft gefahrene Straßen werden kräftiger
  if (expPrefs.heat) for (const r of exp.rides) L.polyline(r.coords, { renderer: expRenderer, color: '#d7263d', weight: 3, opacity: 0.3, interactive: false }).addTo(expHeat);
  map[expPrefs.heat ? 'addLayer' : 'removeLayer'](expHeat);
  const km = exp.rides.reduce((sum, r) => sum + (r.km || 0), 0);
  const fresh = exp.routeNew.size && routeCoords ? ` · Route +${exp.routeNew.size} neue` : '';
  $('exploreSummary').textContent = exp.tiles.size ? `${exp.tiles.size} Kacheln · □ ${sq?.size || 0}×${sq?.size || 0} · Cluster ${exp.cluster.size}${fresh}` : 'noch keine Fahrten';
  $('exploreStats').textContent = exp.rides.length
    ? `${exp.rides.length} Fahrten · ${Math.round(km)} km · ${exp.tiles.size} Kacheln · größtes Quadrat ${sq.size}×${sq.size} · Cluster ${exp.cluster.size} Kacheln.` +
      (routeCoords ? ` Geplante Route: ${exp.routeNew.size} neue Kacheln (orange).` : '')
    : 'Importiere gefahrene Touren (GPX vom Logger, aus OsmAnd usw.) oder fahre mit dem Navi.';
  $('expClear').hidden = !exp.rides.length;
  queueMicrotask(rollerRender); // km-Stand zählt gefahrene Touren mit
}

function expRouteChanged() {
  exp.routeNew = routeCoords && exp.tiles.size ? newTilesOf(routeCoords) : new Set();
  expRender();
}

function rideDb() {
  exp.db ??= new Promise((ok, fail) => {
    const r = indexedDB.open('scooterways-fahrten', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('rides', { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
  return exp.db;
}
async function rideTx(mode, fn) {
  const db = await rideDb();
  return new Promise((ok, fail) => {
    const tx = db.transaction('rides', mode), r = fn(tx.objectStore('rides'));
    tx.oncomplete = () => ok(r?.result);
    tx.onerror = () => fail(tx.error);
  });
}
const lineKm = coords => coords.reduce((sum, c, i) => i ? sum + map.distance(coords[i - 1], c) / 1000 : 0, 0);

async function addRides(list) {
  const fresh = list.filter(r => r.coords.length > 1 && !exp.rides.some(o => o.name === r.name && o.coords.length === r.coords.length));
  for (const r of fresh) {
    r.coords = thin(r.coords, 25).map(([la, lo]) => [+la.toFixed(5), +lo.toFixed(5)]);
    r.km = lineKm(r.coords);
    r.id = await rideTx('readwrite', st => st.add(r));
  }
  exp.rides.push(...fresh);
  expStats(); expRouteChanged();
  return fresh.length;
}

// Navi-Fahrt mitschreiben (alle 25 m ein Punkt) und beim Beenden als Fahrt übernehmen
function expRecord(lat, lon) {
  if (!expPrefs.rec) return;
  const last = exp.rec.at(-1);
  if (!last || map.distance(last, [lat, lon]) >= 25) exp.rec.push([lat, lon]);
}
function expSaveRecording() {
  const coords = exp.rec; exp.rec = [];
  if (coords.length < 2 || lineKm(coords) < 0.3) return;
  const d = new Date();
  addRides([{ name: `Navi ${d.toLocaleDateString('de-DE')} ${d.toTimeString().slice(0, 5)}`, date: d.toISOString(), coords }]).catch(() => {});
}

$('gpxRides').onchange = async e => {
  const list = [];
  let bad = 0;
  for (const file of e.target.files) {
    try {
      const doc = new DOMParser().parseFromString(await file.text(), 'application/xml');
      if (doc.getElementsByTagName('parsererror').length) throw 0;
      // Jedes Tracksegment zählt für sich, damit Lücken im Logger keine Luftlinien quer durchs Land ziehen
      const segs = [...doc.getElementsByTagNameNS('*', 'trkseg')];
      segs.forEach((sg, i) => list.push({
        name: file.name + (segs.length > 1 ? ` #${i + 1}` : ''),
        date: doc.getElementsByTagNameNS('*', 'time')[0]?.textContent || '',
        coords: [...sg.getElementsByTagNameNS('*', 'trkpt')].map(p => [+p.getAttribute('lat'), +p.getAttribute('lon')])
      }));
      if (!segs.length) bad++;
    } catch { bad++; }
  }
  e.target.value = '';
  $('exploreStats').textContent = 'Importiere …';
  try {
    const n = await addRides(list);
    if (!expPrefs.tiles && !expPrefs.heat) { expPrefs.tiles = $('expTiles').checked = true; store.set('explore', expPrefs); expRender(); }
    $('exploreStats').textContent = `✓ ${n} Fahrten übernommen` + (list.length > n ? `, ${list.length - n} schon vorhanden` : '') +
      (bad ? `, ${bad} Dateien ohne Track` : '') + '. ' + $('exploreStats').textContent;
  } catch (err) {
    $('exploreStats').textContent = '⚠️ Speichern im Browser fehlgeschlagen: ' + err.message;
  }
};
for (const [id, key] of [['expTiles', 'tiles'], ['expHeat', 'heat'], ['expRec', 'rec']]) {
  $(id).checked = expPrefs[key];
  $(id).onchange = () => { expPrefs[key] = $(id).checked; store.set('explore', expPrefs); expRender(); };
}
$('expClear').onclick = async () => {
  if (!confirm(`Alle ${exp.rides.length} gespeicherten Fahrten in diesem Browser löschen?`)) return;
  await rideTx('readwrite', st => st.clear()).catch(() => {});
  exp.rides = []; expStats(); expRouteChanged();
};
rideTx('readonly', st => st.getAll()).then(rides => { exp.rides = rides || []; expStats(); expRouteChanged(); }).catch(() => expRender());
