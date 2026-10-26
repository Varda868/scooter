// --- Straßenart entlang der Route: Balken unter dem Höhenprofil und Kennzahlen für den Routenvergleich ---
// Valhalla nennt die Straßenklasse nicht in der Routenantwort; /trace_attributes läuft die Linie Kante für Kante ab
// (edge_walk, die Linie stammt ja aus Valhalla). Der öffentliche Server nimmt höchstens 200 km je Anfrage,
// daher Stücke zu 120 km, nacheinander (eine Anfrage gleichzeitig).
const TRACE_URL = VALHALLA_URL.replace(/\/route$/, '/trace_attributes');
const STRASSEN_STUECK_KM = 120;
const STRASSEN_ARTEN = [
  { id: 'schnell', name: 'Kraftstraße', farbe: '#6b1f1a' },
  { id: 'haupt', name: 'Hauptstraße', farbe: '#c0392b' },
  { id: 'land', name: 'Landstraße', farbe: '#e6a23c' },
  { id: 'neben', name: 'Nebenstraße', farbe: '#2e9e4f' },
  { id: 'schotter', name: 'Schotter', farbe: '#8d6e63' },
  { id: 'faehre', name: 'Fähre', farbe: '#1f6fd1' }
];
const strassenCache = new Map();
let strassenRequest = 0;

function strassenArt(e) {
  if (e.use === 'ferry' || e.use === 'rail-ferry') return 'faehre';
  if (e.unpaved || e.use === 'track') return 'schotter';
  return { motorway: 'schnell', trunk: 'schnell', primary: 'haupt', secondary: 'land', tertiary: 'land' }[e.road_class] || 'neben';
}

// Gegenstück zu decode(): Polyline mit Präzision 6
function encode6(coords) {
  let out = '', pLat = 0, pLon = 0;
  const zahl = v => { v = v < 0 ? ~(v << 1) : v << 1; let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const [lat, lon] of coords) {
    const a = Math.round(lat * 1e6), b = Math.round(lon * 1e6);
    out += zahl(a - pLat) + zahl(b - pLon); pLat = a; pLon = b;
  }
  return out;
}

// Linie → [{ von, bis, art }] in km ab Start; km je Stück auf die Linienlänge gestreckt (Valhalla rechnet minimal anders)
function strassenArten(coords) {
  const key = coords.length + ':' + coords[0].join() + ':' + coords.at(-1).join() + ':' + coords[coords.length >> 1].join();
  if (!strassenCache.has(key)) {
    const p = strassenHolen(coords);
    p.catch(() => strassenCache.delete(key));
    strassenCache.set(key, p);
  }
  return strassenCache.get(key);
}
async function strassenHolen(coords) {
  const kms = [0];
  for (let i = 1; i < coords.length; i++) kms.push(kms[i - 1] + L.latLng(coords[i - 1]).distanceTo(coords[i]) / 1000);
  const stuecke = [];
  for (let a = 0; a < coords.length - 1;) {
    let b = a + 1;
    while (b < coords.length - 1 && kms[b + 1] - kms[a] <= STRASSEN_STUECK_KM) b++;
    stuecke.push([a, b]); a = b;
  }
  const out = [];
  for (const [a, b] of stuecke) {
    const res = await fetch(TRACE_URL, { method: 'POST', body: JSON.stringify({
      encoded_polyline: encode6(coords.slice(a, b + 1)), shape_match: 'edge_walk',
      costing: 'motor_scooter', directions_options: { units: 'kilometers' },
      filters: { attributes: ['edge.length', 'edge.road_class', 'edge.use', 'edge.unpaved'], action: 'include' }
    }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.edges?.length) throw new Error(data.error || `HTTP ${res.status}`);
    const summe = data.edges.reduce((s, e) => s + (e.length || 0), 0) || 1, f = (kms[b] - kms[a]) / summe;
    let km = kms[a];
    for (const e of data.edges) {
      const art = strassenArt(e), bis = km + (e.length || 0) * f, letzte = out.at(-1);
      if (letzte?.art === art) letzte.bis = bis; else out.push({ von: km, bis, art });
      km = bis;
    }
  }
  return out;
}
const strassenKm = teile => Object.fromEntries(STRASSEN_ARTEN.map(a => [a.id, teile.filter(t => t.art === a.id).reduce((s, t) => s + t.bis - t.von, 0)]));

// Balken unter dem Höhenprofil; renderElevation ruft das nach jedem Zeichnen
async function strassenBalken() {
  const box = $('elevation').querySelector('.ele-strassen');
  if (!box || !routeCoords || !eleGeo) return;
  const req = ++strassenRequest, geo = eleGeo;
  box.innerHTML = '<div class="ele-stats">Straßenarten werden geladen …</div>';
  try {
    const teile = await strassenArten(routeCoords);
    if (req !== strassenRequest || geo !== eleGeo) return;
    const farbe = Object.fromEntries(STRASSEN_ARTEN.map(a => [a.id, a.farbe])), W = +$('elevation').querySelector('svg').getAttribute('width');
    const s = geo.totalKm / (teile.at(-1)?.bis || 1);  // auf die km des Profils
    const km = strassenKm(teile);
    box.innerHTML = `<svg class="ele-strassen-bar" viewBox="0 0 ${W} 8" width="${W}" height="8" role="img" aria-label="Straßenarten entlang der Route">` +
      teile.map(t => `<rect x="${geo.X(t.von * s).toFixed(1)}" width="${Math.max(0.5, geo.X(t.bis * s) - geo.X(t.von * s)).toFixed(1)}" y="0" height="8" fill="${farbe[t.art]}"/>`).join('') +
      '</svg><div class="ele-strassen-legende">' + STRASSEN_ARTEN.filter(a => km[a.id] >= 0.5).map(a =>
        `<span><i style="background:${a.farbe}"></i>${a.name} ${Math.round(km[a.id] * s)} km</span>`).join('') + '</div>';
  } catch (err) {
    if (req === strassenRequest) box.innerHTML = `<div class="ele-stats">⚠️ Straßenarten: ${escapeHtml(err.message)}</div>`;
  }
}
