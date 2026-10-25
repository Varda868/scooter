// --- Eigene Vektorkarte: PMTiles-Datei auf dem eigenen Server (OSM-Daten via Protomaps), gezeichnet von MapLibre
// als Ebene in Leaflet. Jede geladene Kachel landet in IndexedDB; "Karte für diese Tour offline speichern" lädt
// den Korridor um die Route vorab. Fehlt die Datei, bleibt die OSM-Rasterkarte.
// Die Datei schneidet .github/workflows/karte.yml aus dem Protomaps-Build und lädt sie neben die POI-Kacheln.
const VECTOR_MAP_URL = BASIS_URL + 'poi/karte.pmtiles';
const VM_LIBS = ['https://cdn.jsdelivr.net/npm/maplibre-gl@5.6.0/dist/maplibre-gl.js', 'https://cdn.jsdelivr.net/npm/pmtiles@4.3.0/dist/pmtiles.js',
  'https://cdn.jsdelivr.net/npm/@protomaps/basemaps@5.5.0/dist/basemaps.js', 'https://cdn.jsdelivr.net/npm/@maplibre/maplibre-gl-leaflet@0.1.3/leaflet-maplibre-gl.js'];
const VM_CSS = 'https://cdn.jsdelivr.net/npm/maplibre-gl@5.6.0/dist/maplibre-gl.css';
const VM_ASSETS = 'https://protomaps.github.io/basemaps-assets/';
const vm = { archive: null, header: null, db: null, layer: null, maxZoom: 15 };

const loadScript = src => new Promise((ok, fail) => { const el = document.createElement('script'); el.src = src; el.onload = ok; el.onerror = fail; document.head.append(el); });

function tileDb() {
  vm.db ??= new Promise((ok, fail) => {
    const r = indexedDB.open('scooterways-karte', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('tiles');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
  return vm.db;
}
async function dbTile(key, value) {
  const db = await tileDb();
  return new Promise((ok, fail) => {
    const tx = db.transaction('tiles', value === undefined ? 'readonly' : 'readwrite'), st = tx.objectStore('tiles');
    const r = value === undefined ? st.get(key) : st.put(value, key);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}

// Kachel aus dem Gerät, sonst aus der PMTiles-Datei (und merken). Leere Kacheln (Meer, Wald) gibt es nicht als Eintrag.
async function vectorTile(z, x, y, signal) {
  const key = `${z}/${x}/${y}`;
  const hit = await dbTile(key).catch(() => undefined);
  if (hit !== undefined) return hit;
  const t = await vm.archive.getZxy(z, x, y, signal);
  const data = t ? new Uint8Array(t.data) : new Uint8Array();
  dbTile(key, data).catch(() => {});
  return data;
}

// Schriften und Symbole des Kartenstils: fehlt offline ein Schriftbereich, zeichnet MapLibre die ganze Kachel nicht.
// Deshalb die Bereiche für Deutsch und Nachbarländer (Latin, Latin Extended, Satzzeichen) vorab holen; der Service Worker hält sie.
const VM_FONTS = ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic'], VM_RANGES = ['0-255', '256-511', '8192-8447'];
function prefetchMapAssets() {
  const urls = ['', '@2x'].flatMap(r => ['.json', '.png'].map(e => `${VM_ASSETS}sprites/v4/light${r}${e}`))
    .concat(VM_FONTS.flatMap(f => VM_RANGES.map(r => `${VM_ASSETS}fonts/${encodeURIComponent(f)}/${r}.pbf`)));
  return Promise.allSettled(urls.map(u => fetch(u).then(r => { if (!r.ok) throw new Error(r.status); })))
    .then(rs => rs.filter(r => r.status === 'rejected').length);
}

async function initVectorMap() {
  // Gibt es die Kartendatei? Offline zählt der zuletzt bekannte Stand.
  let available = false;
  let stand = store.get('vectorMapStand', null);
  try {
    const res = await fetch(VECTOR_MAP_URL, { headers: { range: 'bytes=0-15' } });
    available = res.status === 206 || res.ok;
    stand = res.headers.get('etag') || res.headers.get('last-modified') || stand;
    res.body?.cancel().catch(() => {});
  } catch { available = store.get('vectorMap', false); }
  store.set('vectorMap', available);
  if (!available) return;
  // Neue Kartendatei (Update im März/Juli/Oktober): gespeicherte Kacheln der alten verwerfen
  if (stand && stand !== store.get('vectorMapStand', null)) {
    if (store.get('vectorMapStand', null)) await tileDb().then(db => new Promise(ok => { const tx = db.transaction('tiles', 'readwrite'); tx.objectStore('tiles').clear(); tx.oncomplete = tx.onerror = ok; })).catch(() => {});
    store.set('vectorMapStand', stand);
  }
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = VM_CSS; document.head.append(css);
  for (const src of VM_LIBS) await loadScript(src);
  vm.archive = new pmtiles.PMTiles(new URL(VECTOR_MAP_URL, location.href).href);
  vm.header = await vm.archive.getHeader().catch(() => store.get('vectorMapHeader', null));
  if (!vm.header) return;
  store.set('vectorMapHeader', { maxZoom: vm.header.maxZoom, minZoom: vm.header.minZoom });
  vm.maxZoom = vm.header.maxZoom;
  maplibregl.addProtocol('scw', async (params, ctl) => {
    const [, z, x, y] = params.url.match(/scw:\/\/(\d+)\/(\d+)\/(\d+)/).map(Number);
    const d = await vectorTile(z, x, y, ctl.signal);
    return { data: d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) };
  });
  const style = {
    version: 8, glyphs: VM_ASSETS + 'fonts/{fontstack}/{range}.pbf', sprite: VM_ASSETS + 'sprites/v4/light',
    sources: { protomaps: { type: 'vector', tiles: ['scw://{z}/{x}/{y}'], minzoom: vm.header.minZoom, maxzoom: vm.header.maxZoom,
      attribution: '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://protomaps.com">Protomaps</a>' } },
    layers: basemaps.layers('protomaps', basemaps.namedFlavor('light'), { lang: 'de' })
  };
  if (navigator.onLine) prefetchMapAssets();
  vm.layer = L.maplibreGL({ style, interactive: false }).addTo(map);
  map.removeLayer(rasterBase);
  if (routeCoords) $('mapSave').hidden = false;
}

// Kacheln im Korridor um die Route, je Zoomstufe (bis zur höchsten Stufe der Datei; darüber vergrößert MapLibre)
function corridorTiles(bufferM = 2000, minZ = 6) {
  const keys = new Set();
  const step = Math.max(0.2, bufferM / 2000);
  const pts = [];
  for (let km = 0; km <= routeKm.at(-1) + 1e-6; km += step) pts.push(pointAtKm(Math.min(km, routeKm.at(-1))));
  for (let z = minZ; z <= vm.maxZoom; z++) {
    const n = 2 ** z;
    const tx = lon => Math.floor((lon + 180) / 360 * n);
    const ty = lat => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n); };
    for (const [lat, lon] of pts) {
      const dLat = bufferM / 111320, dLon = dLat / Math.cos(lat * Math.PI / 180);
      for (let x = tx(lon - dLon); x <= tx(lon + dLon); x++)
        for (let y = ty(lat + dLat); y <= ty(lat - dLat); y++) keys.add(`${z}/${x}/${y}`);
    }
  }
  return [...keys].map(k => k.split('/').map(Number));
}

$('mapSave').onclick = async () => {
  if (!vm.archive || !routeCoords) return;
  $('mapSave').disabled = true;
  navigator.storage?.persist?.().catch(() => {});
  const tiles = corridorTiles();
  let done = 0, bytes = 0, failed = await prefetchMapAssets();
  const work = tiles.slice();
  // 6 Abrufe parallel; jede Kachel ist ein kleiner Byte-Bereich aus der einen Datei
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (work.length) {
      const [z, x, y] = work.pop();
      try { bytes += (await vectorTile(z, x, y)).byteLength; } catch { failed++; }
      done++;
      if (done % 20 === 0 || done === tiles.length) $('mapSaveInfo').textContent = `Karte speichern … ${done}/${tiles.length} Kacheln`;
    }
  }));
  $('mapSaveInfo').textContent = failed
    ? `⚠️ ${failed} von ${tiles.length} Kacheln bzw. Schriftdateien fehlgeschlagen. 💡 Mit Netz erneut tippen, Gespeichertes bleibt.`
    : `✓ Karte für diese Tour gespeichert: ${tiles.length} Kacheln, ${(bytes / 1048576).toFixed(1)} MB`;
  $('mapSave').disabled = false;
};
initVectorMap().catch(() => {});
