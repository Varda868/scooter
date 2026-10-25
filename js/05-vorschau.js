// --- Vorschaufahrt: Strecke im Zeitraffer abfahren, Karte folgt, Zoom je nach Tempo und nächster Abbiegung ---
const TURN_ARROWS = { 1: '▶', 2: '▶', 3: '▶', 4: '🏁', 5: '🏁', 6: '🏁', 9: '↗', 10: '→', 11: '↘', 12: '↶', 13: '↶', 14: '↙', 15: '←', 16: '↖',
  20: '↗', 21: '↖', 24: '↖', 25: '↗', 26: '⟳', 27: '⟳', 28: '⛴', 29: '⛴' };
// Abbiegepfeile als Skizze "um die Ecke": Stamm von unten, dann Knick im Winkel des Manövers (Grad, + = rechts).
// Kreisverkehr: Ring mit Nummer der Ausfahrt. Start, Ziel und Fähre bleiben Zeichen.
const TURN_WINKEL = { 7: 0, 8: 0, 9: 45, 10: 90, 11: 135, 14: -135, 15: -90, 16: -45, 17: 0, 18: 35, 19: -35,
  20: 35, 21: -35, 22: 0, 23: 20, 24: -20, 25: 0 };
function turnIcon(m, ersatz = '↑') {
  if (!m) return ersatz;
  const kopf = (x, y, dx, dy) => `<path d="M${x + dx * 8} ${y + dy * 8}L${x - dy * 8} ${y + dx * 8}L${x + dy * 8} ${y - dx * 8}Z" fill="currentColor"/>`;
  const svg = inner => `<svg class="turn-svg" viewBox="0 0 48 48" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">${inner}</g></svg>`;
  if (m.type === 12 || m.type === 13) { // Wende: 13 links herum, 12 rechts herum
    const s = m.type === 13 ? -1 : 1, a = 24 - s * 7, b = 24 + s * 7;
    return svg(`<path d="M${a} 44V22A7 7 0 0 ${s > 0 ? 1 : 0} ${b} 22V30"/>`).replace('</g>', `</g>${kopf(b, 31, 0, 1)}`);
  }
  if (m.type === 26 || m.type === 27) {
    const n = m.exits;
    return svg(`<path d="M24 44V33"/><circle cx="24" cy="20" r="11" stroke-width="5"/>` + (m.type === 27 ? '<path d="M35 20H39"/>' : ''))
      .replace('</g>', '</g>' + (m.type === 27 ? kopf(41, 20, 1, 0)
        : n ? `<text x="24" y="25.5" text-anchor="middle" font-size="15" font-weight="700" fill="currentColor">${n}</text>` : ''));
  }
  const w = TURN_WINKEL[m.type];
  if (w == null) return TURN_ARROWS[m.type] || ersatz;
  const r = w * Math.PI / 180, dx = Math.sin(r), dy = -Math.cos(r);
  if (!w) return svg('<path d="M24 44V14"/>').replace('</g>', `</g>${kopf(24, 9, 0, -1)}`);
  const ex = 24 + dx * 15, ey = 24 + dy * 15;
  return svg(`<path d="M24 44V24L${ex.toFixed(1)} ${ey.toFixed(1)}"/>`).replace('</g>', `</g>${kopf(ex + dx * 3, ey + dy * 3, dx, dy)}`);
}
map.getContainer().appendChild($('sim'));
L.DomEvent.disableClickPropagation($('sim'));
L.DomEvent.disableScrollPropagation($('sim'));

function heightAt(km) {
  const { xs, hs } = eleData;
  let i = xs.findIndex(x => x >= km);
  if (i <= 0) return hs[Math.max(0, i)] ?? hs[hs.length - 1];
  const t = (km - xs[i - 1]) / ((xs[i] - xs[i - 1]) || 1);
  return hs[i - 1] + t * (hs[i] - hs[i - 1]);
}
// Steigung in % über ±100 m, glättet Sprünge im Höhenmodell
const gradeAt = km => eleData ? (heightAt(km + 0.1) - heightAt(Math.max(0, km - 0.1))) / (Math.min(km, 0.1) + 0.1) / 10 : null;
const gradeColor = g => g > 8 ? '#c0392b' : g > 5 ? '#e67e22' : g > 2 ? '#e6b800' : g < -5 ? '#1f5fbf' : g < -2 ? '#5aa9e6' : '#2e9e4f';

// Steile Abschnitte: Beginn ab Schwelle, Ende erst unter 70 % davon (Hysterese gegen Flackern im Höhenmodell),
// mindestens 100 m lang. Richtung = Fahrtrichtung der Route.
function steepSections(limit) {
  const out = [], total = routeKm[routeKm.length - 1];
  let cur = null;
  for (let km = 0; km <= total; km += 0.05) {
    // Auf der Fähre gibt es keine Steigung, das Höhenmodell springt dort nur an der Küste
    const g = aufFaehre(km) ? 0 : gradeAt(km), dir = Math.sign(g);
    if (cur && (Math.abs(g) < limit * 0.7 || dir !== cur.dir)) {
      if (km - cur.from >= 0.1) out.push({ ...cur, to: km });
      cur = null;
    }
    if (!cur && Math.abs(g) >= limit) cur = { from: km, dir, max: 0 };
    if (cur) cur.max = Math.max(cur.max, Math.abs(g));
  }
  if (cur && total - cur.from >= 0.1) out.push({ ...cur, to: total });
  return out;
}

// Warnschild wie Zeichen 108/110: rotes Dreieck, Keil in Fahrtrichtung, Prozentzahl
function gradeSignSvg(dir, pct) {
  const wedge = dir > 0 ? '7,19 21,19 21,12' : '7,12 7,19 21,19';
  return `<svg class="grade-sign" width="28" height="25" viewBox="0 0 28 25"><path d="M14 1.5 L26.5 23.5 H1.5 Z" fill="#fff" stroke="#c0392b" stroke-width="2.5" stroke-linejoin="round"/>
    <polygon points="${wedge}" fill="#222"/><text x="14" y="13" font-size="6" font-family="system-ui,sans-serif" font-weight="700" text-anchor="middle" fill="#222">${pct}%</text></svg>`;
}

function drawGradeSigns() {
  gradeSignLayer.clearLayers();
  const limit = +$('gradeWarn').value;
  if (!eleData || !routeCoords || !limit) return;
  for (const sec of steepSections(limit)) {
    const pos = pointAtKm(sec.from), ahead = pointAtKm(Math.min(sec.from + 0.05, sec.to));
    // Schild rechts neben die Straße: senkrecht zur Fahrtrichtung in Bildschirmpixeln versetzen (Mercator ist winkeltreu)
    const b = (bearing(L.latLng(pos), L.latLng(ahead)) + 90) * Math.PI / 180, dx = Math.sin(b) * 22, dy = -Math.cos(b) * 22;
    const pct = Math.round(sec.max);
    L.marker(pos, { keyboard: false, icon: L.divIcon({ className: '', html: gradeSignSvg(sec.dir, pct), iconSize: [28, 25], iconAnchor: [14 - dx, 12.5 - dy] }) })
      .bindTooltip(`${sec.dir > 0 ? 'Steigung' : 'Gefälle'} bis ${pct} % über ${Math.round((sec.to - sec.from) * 1000)} m · km ${sec.from.toFixed(1)}`)
      .addTo(gradeSignLayer);
  }
}
$('gradeWarn').addEventListener('change', drawGradeSigns);
// Neuer Schnitt: Zeiten, Ankunft und Wetter je Halt neu berechnen
$('avgSpeed').addEventListener('change', () => ready() && route());

// Kleines Höhenprofil in der Fahrtleiste, steile Abschnitte rot
function drawSimProfile() {
  const svg = $('simProfile');
  // SVG-Elemente kennen die hidden-Eigenschaft nicht, daher style.display
  const show = sim.profile && !!eleData;
  svg.style.display = show ? '' : 'none';
  $('simProfileBtn').classList.toggle('active', sim.profile);
  if (!show) return;
  const { xs, hs } = eleData, total = xs[xs.length - 1];
  const lo = Math.min(...hs), hi = Math.max(lo + 30, Math.max(...hs));
  const X = km => km / total * 300, Y = h => 42 - (h - lo) / (hi - lo) * 38;
  const line = xs.map((x, i) => `${X(x).toFixed(1)},${Y(hs[i]).toFixed(1)}`).join(' ');
  const limit = +$('gradeWarn').value;
  const steep = limit ? steepSections(limit).map(s => `<line class="steep" x1="${X(s.from)}" x2="${X(s.to)}" y1="43" y2="43"/>`).join('') : '';
  svg.innerHTML = `<polygon class="area" points="0,44 ${line} 300,44"/>${steep}<line class="cur" y1="0" y2="44"/>`;
}
$('simProfileBtn').onclick = () => {
  sim.profile = !sim.profile;
  store.set('simProfile', sim.profile);
  drawSimProfile();
  if (sim.marker && !sim.running) renderSim(performance.now());
};
sim.profile = store.get('simProfile', true);

function startSim() {
  if (!routeCoords) return;
  stopSim();
  sim.km = 0;
  $('sim').hidden = false;
  drawSimProfile();
  sim.marker = L.marker(routeCoords[0], { interactive: false, zIndexOffset: 1000,
    icon: L.divIcon({ className: '', html: '<div class="sim-dot">➤</div>', iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(map);
  // Während der Fahrt Zwischenstufen erlauben, damit der Zoom gleiten kann
  map.options.zoomSnap = 0;
  map.setView(routeCoords[0], 16, { animate: false });
  sim.zoomAt = performance.now();
  sim.zoomFrom = sim.zoomTo = 16;
  resumeSim();
}

function resumeSim() {
  if (sim.km >= routeKm[routeKm.length - 1]) sim.km = 0;
  sim.running = true;
  sim.last = performance.now();
  $('simPause').textContent = '⏸';
  sim.frame = requestAnimationFrame(simStep);
}

function pauseSim() {
  sim.running = false;
  cancelAnimationFrame(sim.frame);
  $('simPause').textContent = '▶';
}

function stopSim() {
  if (!sim.marker) return;
  pauseSim();
  sim.marker.remove(); sim.marker = null;
  eleCursor.remove();
  map.options.zoomSnap = 1;
  map.setZoom(Math.round(map.getZoom()), { animate: false });
  $('sim').hidden = true;
}

function simStep(now) {
  if (!sim.running) return;
  const total = routeKm[routeKm.length - 1];
  const factor = +$('simSpeed').value;
  const kmh = routeKmh || +$('speed').value * 0.8;
  // Tempo auf den Grundzoom bezogen: näher herangezoomt (Abbiegung, Mausrad) entsprechend langsamer,
  // damit der Punkt auf dem Bildschirm gleich schnell wirkt
  const zoomScale = 2 ** (baseZoom(factor) - map.getZoom());
  sim.km = Math.min(total, sim.km + kmh * factor * zoomScale * Math.min(now - sim.last, 100) / 3600000);
  sim.last = now;
  renderSim(now);
  if (sim.km >= total) pauseSim();
  else sim.frame = requestAnimationFrame(simStep);
}

const ZOOM_GLIDE = 900, TURN_ZOOM = 0.45;
const baseZoom = factor => factor <= 20 ? 16 : factor <= 60 ? 15 : 14;

function renderSim(now) {
  const total = routeKm[routeKm.length - 1], factor = +$('simSpeed').value;
  const pos = pointAtKm(sim.km), ahead = pointAtKm(Math.min(total, sim.km + 0.03));
  const dir = bearing(L.latLng(pos), L.latLng(ahead));
  sim.marker.setLatLng(pos);
  const dot = sim.marker.getElement()?.firstChild;
  if (dot && map.distance(pos, ahead) > 1) dot.style.transform = `rotate(${dir - 90}deg)`;

  const next = routeManeuvers.find(m => m.km > sim.km + 0.005);
  const dist = next ? next.km - sim.km : total - sim.km;
  $('simArrow').innerHTML = next ? turnIcon(next) : '🏁';
  $('simDist').textContent = dist < 1 ? `${Math.round(dist * 100) * 10} m` : `${dist.toFixed(1)} km`;
  $('simText').textContent = next ? next.text : (routeManeuvers.length ? 'Ziel' : 'Ende des Tracks');

  const g = gradeAt(sim.km);
  $('simGrade').hidden = g == null;
  if (g != null) {
    $('simGrade').textContent = `${g > 0.5 ? '↗' : g < -0.5 ? '↘' : '→'} ${Math.abs(g).toFixed(0)} %`;
    $('simGrade').style.background = gradeColor(g);
  }
  $('simInfo').textContent = `km ${sim.km.toFixed(1)} / ${total.toFixed(1)}` + (eleData ? ` · ${Math.round(heightAt(sim.km))} m` : '');
  if (eleData && eleShowKm) eleShowKm(sim.km);
  const cur = $('simProfile').querySelector('.cur');
  if (cur && eleData) { const x = sim.km / eleData.xs[eleData.xs.length - 1] * 300; cur.setAttribute('x1', x); cur.setAttribute('x2', x); }

  // Nah an Abbiegungen etwas heran: Abbiegung voraus oder gerade passiert, so bleibt der Zoom in der Stadt mit
  // vielen Abbiegungen stehen, statt zu pendeln. Höchstens alle 4 s ein Wechsel, gleitend über ZOOM_GLIDE ms.
  // Nur TURN_ZOOM (< 0,5) Stufen: Die Kacheln bleiben auf ihrer Zoomstufe und werden nur skaliert, die Karte verschwindet nicht kurz.
  const nearTurn = routeManeuvers.some(m => m.km > sim.km - 0.15 && m.km < sim.km + 0.3);
  const want = baseZoom(factor) + (nearTurn ? TURN_ZOOM : 0);
  if (Math.abs(want - map.getZoom()) > 0.01 && now - sim.zoomAt > 4000) {
    sim.zoomAt = now; sim.zoomFrom = map.getZoom(); sim.zoomTo = want;
  }
  const u = Math.min(1, Math.max(0, (now - sim.zoomAt) / ZOOM_GLIDE)), ease = u * u * (3 - 2 * u);
  const zoom = u < 1 ? sim.zoomFrom + (sim.zoomTo - sim.zoomFrom) * ease : map.getZoom();
  map.setView(pos, zoom, { animate: false });
}

$('play').onclick = startSim;
$('simPause').onclick = () => sim.running ? pauseSim() : resumeSim();
$('simStop').onclick = stopSim;
$('simSpeed').oninput = () => $('simSpeedVal').textContent = $('simSpeed').value + '×';
// Karte von Hand verschieben hält die Fahrt an
map.on('dragstart', () => sim.running && pauseSim());
