// --- Routenvergleich: kleines Etikett je Route (km · Zeit · ↑hm), Bestwert je Kennzahl grün ---
const climbCache = new Map();
let compareRequest = 0;

// Höhen aus der Route selbst (elevation_interval), sonst null; jeder Abschnitt beginnt bei seiner Länge davor
function tripElevation(trip) {
  if (!trip?.legs?.length || !trip.legs.every(l => l.elevation?.length > 1)) return null;
  const pts = [];
  let off = 0;
  for (const l of trip.legs) {
    const iv = l.elevation_interval || 30, len = l.summary.length * 1000;
    l.elevation.forEach((h, i) => { if (h != null && h > -1000) pts.push([off + Math.min(i * iv, len), h]); });
    off += len;
  }
  return pts.length > 1 ? pts : null;
}

async function routeClimb(coords, trip) {
  const eigen = tripElevation(trip);
  if (eigen) return climb(eigen).up;
  const shape = simplify(coords, 200);
  const key = shape.map(([a, b]) => a.toFixed(4) + ',' + b.toFixed(4)).join(';');
  if (!climbCache.has(key)) climbCache.set(key, (async () => {
    const res = await fetch(VALHALLA_HEIGHT_URL, { method: 'POST', body: JSON.stringify({
      range: true, shape: shape.map(([lat, lon]) => ({ lat, lon })), resample_distance: 50
    }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const pts = (data.range_height || []).filter(([, h]) => h != null && h > -1000);
    if (pts.length < 2) throw new Error('keine Höhendaten');
    return climb(pts).up;
  })().catch(err => { climbCache.delete(key); throw err; }));
  return climbCache.get(key);
}

// Kurvigkeit: Richtungswechsel in Grad je km. Linie erst alle 50 m neu abtasten (sonst zählt die Punktdichte mit),
// Knicke unter 10° sind GPS-/Kartenzittern und fallen weg.
const KURV_M = 50, KURV_MIN_GRAD = 10;
function kurvigkeit(coords) {
  const pts = [L.latLng(coords[0])];
  let rest = KURV_M, km = 0;
  for (let i = 1; i < coords.length; i++) {
    let a = L.latLng(coords[i - 1]);
    const b = L.latLng(coords[i]);
    let d = a.distanceTo(b);
    km += d / 1000;
    while (d >= rest) {
      const t = rest / d;
      a = L.latLng(a.lat + (b.lat - a.lat) * t, a.lng + (b.lng - a.lng) * t);
      pts.push(a); d -= rest; rest = KURV_M;
    }
    rest -= d;
  }
  let grad = 0;
  for (let i = 2; i < pts.length; i++) {
    const w = Math.abs(((bearing(pts[i - 1], pts[i]) - bearing(pts[i - 2], pts[i - 1]) + 540) % 360) - 180);
    if (w >= KURV_MIN_GRAD) grad += w;
  }
  return km > 0.5 ? Math.round(grad / km) : 0;
}

// Etikett dort, wo die Route am weitesten von den anderen abweicht, damit sie sich nicht überdecken
function labelPoint(own, others) {
  const pts = simplify(own, 60), far = others.flatMap(c => simplify(c, 120));
  let best = pts[Math.floor(pts.length / 2)], bestD = -1;
  for (const p of pts.slice(1, -1)) {
    let d = Infinity;
    for (const q of far) d = Math.min(d, (p[0] - q[0]) ** 2 + ((p[1] - q[1]) * Math.cos(p[0] * Math.PI / 180)) ** 2);
    if (d > bestD) { bestD = d; best = p; }
  }
  return best;
}

async function compareRoutes(trips, pick) {
  const req = ++compareRequest;
  const coords = trips.map(tripCoords);
  const rows = trips.map((t, i) => ({ km: t.summary.length, sec: tripTime(t.summary), up: null, kurv: kurvigkeit(coords[i]) }));
  // Etikett zur Seite weg von den anderen Routen; Hauptroute darüber
  const tips = coords.map((c, i) => {
    const others = coords.filter((_, j) => j !== i), at = labelPoint(c, others);
    const lonOthers = others.flat().reduce((sum, q) => sum + q[1], 0) / others.flat().length;
    const direction = i ? (at[1] < lonOthers ? 'left' : 'right') : 'top';
    return L.tooltip({ permanent: true, interactive: true, direction, offset: i ? [0, 0] : [0, -8], className: 'route-cmp' + (i ? '' : ' main') })
      .setLatLng(at).addTo(altLayer);
  });
  tips.forEach((tip, i) => i && tip.getElement()?.addEventListener('click', e => { L.DomEvent.stop(e); pick(i - 1); }));
  const render = () => {
    const min = f => Math.min(...rows.map(f).filter(v => v != null));
    const best = { km: min(r => r.km), sec: min(r => r.sec), up: min(r => r.up), kurv: -min(r => -r.kurv) };
    // Mehr ist besser bei Kurven, sonst weniger
    const val = (r, f, text) => r[f] == null ? '' : (rows.length > 1 && (f === 'kurv' ? r[f] >= best[f] && r[f] > 0 : r[f] <= best[f] + (f === 'km' ? 0.05 : f === 'sec' ? 30 : 0)) ? `<b>${text}</b>` : text);
    rows.forEach((r, i) => tips[i].setContent([val(r, 'km', `${r.km.toFixed(1)} km`), val(r, 'sec', durText(r.sec)), r.up == null ? '' : val(r, 'up', `↑${r.up} m`), val(r, 'kurv', `〰${r.kurv}°/km`)].filter(Boolean).join(' · ')));
  };
  render();
  await Promise.all(coords.map((c, i) => routeClimb(c, trips[i]).then(up => { rows[i].up = up; }).catch(() => {})));
  if (req === compareRequest && altLayer.hasLayer(tips[0])) render();
}

// --- Höhenprofil: Valhalla /height liefert [Distanz m, Höhe m] entlang der Linie (Höhenmodell, nicht GPS) ---
let elevationRequest = 0;
const eleCursor = L.circleMarker([0, 0], { radius: 6, color: '#fff', weight: 2, fillColor: '#222', fillOpacity: 1, interactive: false });

async function loadElevation(trip) {
  const req = ++elevationRequest;
  tripClimb = null;
  $('elevation').innerHTML = '<div class="ele-stats">Höhenprofil wird geladen …</div>';
  const lenM = routeKm[routeKm.length - 1] * 1000;
  const eigen = tripElevation(trip);
  if (eigen) { renderElevation(eigen, lenM); return; }
  try {
    const res = await fetch(VALHALLA_HEIGHT_URL, { method: 'POST', body: JSON.stringify({
      range: true,
      shape: simplify(routeCoords, 500).map(([lat, lon]) => ({ lat, lon })),
      resample_distance: Math.max(30, Math.round(lenM / 400))
    }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (req !== elevationRequest) return;
    // Lücken im Höhenmodell (null) auslassen
    const pts = (data.range_height || []).filter(([, h]) => h != null && h > -1000);
    if (pts.length < 2) throw new Error('keine Höhendaten');
    renderElevation(pts, lenM);
  } catch (err) {
    if (req === elevationRequest) $('elevation').innerHTML = `<div class="ele-stats">⚠️ Höhenprofil: ${escapeHtml(err.message)}</div>`;
  }
}

// Auf- und Abstieg mit 3 m Hysterese, damit Rauschen im Höhenmodell nicht aufsummiert wird
function climb(pts, threshold = 3) {
  let up = 0, down = 0, ref = pts[0][1];
  for (const [, h] of pts) {
    if (h - ref >= threshold) { up += h - ref; ref = h; }
    else if (ref - h >= threshold) { down += ref - h; ref = h; }
  }
  return { up: Math.round(up), down: Math.round(down) };
}

function renderElevation(pts, lenM) {
  // Distanzen aus /height beziehen sich auf die vereinfachte Linie; auf die echte Länge strecken
  const scale = lenM / pts[pts.length - 1][0];
  const xs = pts.map(p => p[0] * scale / 1000), hs = pts.map(p => p[1]);
  const minH = Math.min(...hs), maxH = Math.max(...hs);
  const lo = Math.floor((minH - 10) / 10) * 10, hi = Math.max(lo + 50, Math.ceil((maxH + 10) / 10) * 10);
  const W = Math.max(200, $('elevation').clientWidth || 300), H = 110, L0 = 30, R0 = 4, T0 = 6, B0 = 16;
  const X = km => L0 + km / xs[xs.length - 1] * (W - L0 - R0);
  const Y = h => T0 + (hi - h) / (hi - lo) * (H - T0 - B0);
  const line = xs.map((x, i) => `${X(x).toFixed(1)},${Y(hs[i]).toFixed(1)}`).join(' ');
  const { up, down } = climb(pts);
  // Höhenmeter auch in die Zusammenfassung unter „Route berechnen“
  if (currentTrip) { const ohne = stageTripText(currentTrip.summary); tripClimb = { up, down };
    $('summary').textContent = $('summary').textContent.replace(ohne, stageTripText(currentTrip.summary)); tankPlan(); }
  // Steilster Abschnitt über mindestens 200 m
  let maxGrade = 0;
  for (let i = 0, j = 0; i < pts.length; i++) {
    while (j < pts.length && (xs[j] - xs[i]) * 1000 < 200) j++;
    if (j < pts.length) maxGrade = Math.max(maxGrade, Math.abs(hs[j] - hs[i]) / ((xs[j] - xs[i]) * 1000) * 100);
  }
  const totalKm = xs[xs.length - 1];
  eleData = { xs, hs };
  drawGradeSigns();
  $('elevation').innerHTML = `<div class="ele-stats">↑ ${up} m · ↓ ${down} m · ${Math.round(minH)}–${Math.round(maxH)} m ü. NN · max. ${maxGrade.toFixed(0)} % Steigung</div>
    <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Höhenprofil">
      <line class="ele-grid" x1="${L0}" x2="${W - R0}" y1="${Y(hi)}" y2="${Y(hi)}"/>
      <line class="ele-grid" x1="${L0}" x2="${W - R0}" y1="${Y(lo)}" y2="${Y(lo)}"/>
      <text class="ele-axis" x="${L0 - 3}" y="${Y(hi) + 4}" text-anchor="end">${hi}</text>
      <text class="ele-axis" x="${L0 - 3}" y="${Y(lo)}" text-anchor="end">${lo}</text>
      <text class="ele-axis" x="${L0}" y="${H - 3}">0</text>
      <text class="ele-axis" x="${W - R0}" y="${H - 3}" text-anchor="end">${totalKm.toFixed(0)} km</text>
      <polygon class="ele-area" points="${X(0)},${Y(lo)} ${line} ${X(totalKm)},${Y(lo)}"/>
      <g class="ele-etappen"></g>
      <line class="ele-cursor" y1="${T0}" y2="${H - B0}" visibility="hidden"/>
      <text class="ele-axis ele-label" y="${T0 + 8}" visibility="hidden"></text>
    </svg>`;
  eleGeo = { X, top: T0, bottom: H - B0, totalKm };
  eleEtappenZeichnen();
  const svg = $('elevation').querySelector('svg');
  const cursor = svg.querySelector('.ele-cursor'), label = svg.querySelector('.ele-label');
  const show = ev => {
    const r = svg.getBoundingClientRect();
    showKm(Math.max(0, Math.min(totalKm, ((ev.clientX - r.left) / r.width * W - L0) / (W - L0 - R0) * totalKm)));
    eleCursor.addTo(map);
  };
  // Auch von der Vorschaufahrt genutzt
  eleShowKm = showKm;
  function showKm(km) {
    const i = xs.findIndex(x => x >= km);
    const h = hs[Math.max(0, i)];
    const x = X(km);
    cursor.setAttribute('x1', x); cursor.setAttribute('x2', x); cursor.setAttribute('visibility', 'visible');
    label.textContent = `km ${km.toFixed(1)} · ${Math.round(h)} m`;
    label.setAttribute('x', x < W / 2 ? x + 4 : x - 4);
    label.setAttribute('text-anchor', x < W / 2 ? 'start' : 'end');
    label.setAttribute('visibility', 'visible');
    eleCursor.setLatLng(pointAtKm(km));
  }
  const hide = () => { cursor.setAttribute('visibility', 'hidden'); label.setAttribute('visibility', 'hidden'); eleCursor.remove(); };
  svg.addEventListener('pointermove', show);
  svg.addEventListener('pointerdown', show);
  svg.addEventListener('pointerleave', hide);
}

let eleShowKm = null, eleGeo = null;
// Etappenenden der Mehrtagestour im Höhenprofil (gestrichelt, 🌙 mit Tag); planStages ruft das nach jeder Neuplanung
function eleEtappenZeichnen() {
  const g = $('elevation').querySelector('.ele-etappen');
  if (!g || !eleGeo) return;
  g.innerHTML = routeStages.filter(km => km > 0 && km < eleGeo.totalKm).map((km, d) => {
    const x = eleGeo.X(km).toFixed(1);
    return `<line class="ele-etappe" x1="${x}" x2="${x}" y1="${eleGeo.top}" y2="${eleGeo.bottom}"/>` +
      `<text class="ele-axis ele-etappe-tag" x="${x}" y="${eleGeo.top + 9}" text-anchor="middle">🌙${1 + nightsBefore(d)}</text>`;
  }).join('');
}

// Position auf der Route nach Kilometern (linear zwischen Stützpunkten)
function pointAtKm(km) {
  let i = routeKm.findIndex(k => k >= km);
  if (i <= 0) return routeCoords[Math.max(0, i)];
  const t = (km - routeKm[i - 1]) / ((routeKm[i] - routeKm[i - 1]) || 1);
  const [a, b] = [routeCoords[i - 1], routeCoords[i]];
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}
