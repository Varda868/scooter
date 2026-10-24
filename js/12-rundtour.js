// Rundtour: Formpunkte auf einem Kreis, Start = Ziel. Faktor 1,3 für Umwege der Straßen gegenüber dem Kreis.
// Gerade bei kurzen Touren gibt es wenige gute Straßen, daher mehrere gedrehte Varianten rechnen und die sauberste nehmen.
function offset(ll, meters, bearingDeg) {
  const b = bearingDeg * Math.PI / 180;
  return L.latLng(ll.lat + meters * Math.cos(b) / 110540, ll.lng + meters * Math.sin(b) / (111320 * Math.cos(ll.lat * Math.PI / 180)));
}
const bearing = (from, to) => (Math.atan2((to.lng - from.lng) * Math.cos(from.lat * Math.PI / 180), to.lat - from.lat) * 180 / Math.PI + 360) % 360;
const RT_TURNS = [0, 35, -35, 70], RT_TURNS_EXPLORE = [0, 35, -35, 70, -70, 110];

$('roundtrip').onclick = async () => {
  const start = waypoints[0].latlng;
  if (!start) { $('summary').textContent = '⚠️ Für eine Rundtour zuerst den Start setzen.'; return; }
  const km = Math.max(5, +$('rtKm').value || 40);
  const dir = $('rtDir').value === '' ? Math.random() * 360 : +$('rtDir').value;
  const r = km * 1000 / (2 * Math.PI * 1.3);
  // Kurze Touren: Dreieck mit zwei Formpunkten, sonst Viereck mit drei
  const angles = km < 25 ? [120, 240] : [90, 180, 270];
  const variants = (expPreferOn() ? RT_TURNS_EXPLORE : RT_TURNS).map(turn => {
    const center = offset(start, r, dir + turn);
    const back = (dir + turn + 180) % 360; // Richtung vom Mittelpunkt zum Start
    // Entdecker: Formpunkte in die nächste unbefahrene Kachel schieben
    return { center, back, targets: angles.map(a => expPreferOn() ? nearestNewTile(offset(center, r, back + a), r * 0.35) : offset(center, r, back + a)) };
  });
  $('roundtrip').disabled = true;
  $('summary').textContent = 'Suche Orte für die Rundtour …';
  try {
    const snapped = await snapRoundtrip(variants.map(v => v.targets), start, Math.min(8000, Math.max(1500, r * 0.4)));
    const minGap = Math.min(1500, r * 0.5);
    const cands = variants.map((v, i) => {
      // Nach Winkel um den Mittelpunkt sortieren: Reihenfolge bleibt ein konvexes Vieleck, die Tour kreuzt sich nicht
      const angle = p => (bearing(v.center, p.latlng) - v.back + 360) % 360;
      const pts = snapped[i].sort((a, b) => angle(a) - angle(b))
        .filter((p, j, arr) => map.distance(p.latlng, start) > minGap && arr.slice(0, j).every(q => map.distance(q.latlng, p.latlng) > minGap));
      return pts;
    }).filter(pts => pts.length);
    const seen = new Set();
    const unique = cands.filter(pts => { const k = pts.map(p => p.latlng.toString()).join(); return !seen.has(k) && seen.add(k); });
    $('summary').textContent = `Vergleiche ${unique.length} Varianten …`;
    let best = null;
    // Nacheinander statt parallel: die öffentliche Valhalla-Instanz drosselt sonst
    for (const pts of unique) {
      const locs = [{ latlng: start }, ...pts.map(p => ({ latlng: p.latlng, shaping: true })), { latlng: start }];
      try {
        const trip = (await fetchRoute(routeBody(locs))).trip;
        const score = scoreRoundtrip(trip, km) - (expPreferOn() ? 1.5 * freshShare(tripCoords(trip)) : 0);
        if (!best || score < best.score) best = { pts, score, trip };
      } catch {}
    }
    if (best) best = await pruneSpurs(start, best, km);
    const pts = best ? best.pts : unique[0] || [];
    if (unique.length > 1) summaryNote = ` · beste von ${unique.length} Rundtour-Varianten` + (expPreferOn() ? ' (unbefahren bevorzugt)' : '') +
      (best?.pruned ? ` · ${best.pruned} Stich${best.pruned > 1 ? 'e' : ''} entfernt` : '');
    changeWaypoints(() => {
      waypoints = [waypoints[0], ...pts.map(p => ({ latlng: p.latlng, text: p.name || coordText(p.latlng), shaping: true })),
        { latlng: start, text: waypoints[0].text }];
    });
  } finally {
    $('roundtrip').disabled = false;
  }
};

// Stiche entfernen: Fährt die Route zu einem Formpunkt hin und auf derselben Straße zurück (Sackgasse, Schleife
// um einen Ortskern), liegen die Punkte kurz vor und kurz nach ihm fast aufeinander. Solche Formpunkte fliegen
// raus, die Tour wird neu gerechnet und nur übernommen, wenn sie insgesamt besser bewertet ist.
const SPUR_MAX_M = 8000; // längster Stich, der noch als Stich zählt (hin + zurück)
function spurPoints(trip, pts) {
  // Route alle 50 m abtasten (lokale Meter), Paare suchen, die ≥ 0,5 km auseinander gefahren, aber < 30 m entfernt sind
  const coords = tripCoords(trip), kx = 111320 * Math.cos(coords[0][0] * Math.PI / 180), ky = 110540, step = 50;
  const smp = [];
  let along = 0, carry = 0;
  for (let i = 1; i < coords.length; i++) {
    const x0 = coords[i - 1][1] * kx, y0 = coords[i - 1][0] * ky, x1 = coords[i][1] * kx, y1 = coords[i][0] * ky, len = Math.hypot(x1 - x0, y1 - y0);
    for (let d = carry; d < len; d += step) smp.push({ x: x0 + (x1 - x0) * d / len, y: y0 + (y1 - y0) * d / len, s: along + d });
    carry = (carry - len) % step; if (carry < 0) carry += step;
    along += len;
  }
  const pairs = [];
  for (let i = 0; i < smp.length; i++) for (let j = i + 10; j < smp.length && smp[j].s - smp[i].s < SPUR_MAX_M; j++)
    if (Math.hypot(smp[i].x - smp[j].x, smp[i].y - smp[j].y) < 30) pairs.push([smp[i].s, smp[j].s]);
  return pts.filter(p => {
    const px = p.latlng.lng * kx, py = p.latlng.lat * ky;
    const s = smp.reduce((b, q) => Math.hypot(q.x - px, q.y - py) < b.d ? { d: Math.hypot(q.x - px, q.y - py), s: q.s } : b, { d: Infinity, s: 0 }).s;
    // Stich: mindestens 300 m Hin-und-zurück, das den Formpunkt umschließt
    return pairs.filter(([a, b]) => a < s && s < b).length * step >= 300;
  });
}
async function pruneSpurs(start, best, km) {
  for (let round = 0; round < 2; round++) {
    const spurs = spurPoints(best.trip, best.pts);
    if (!spurs.length || spurs.length >= best.pts.length) return best;
    const pts = best.pts.filter(p => !spurs.includes(p));
    try {
      const locs = [{ latlng: start }, ...pts.map(p => ({ latlng: p.latlng, shaping: true })), { latlng: start }];
      const trip = (await fetchRoute(routeBody(locs))).trip;
      const score = scoreRoundtrip(trip, km) - (expPreferOn() ? 1.5 * freshShare(tripCoords(trip)) : 0);
      if (score >= best.score) return best;
      best = { pts, score, trip, pruned: (best.pruned || 0) + spurs.length };
    } catch { return best; }
  }
  return best;
}

// Bewertung (kleiner = besser): Abweichung von der Wunschlänge, doppelt gefahrene Strecke (Stiche, hin und zurück)
// und niedriges Durchschnittstempo als Zeichen für Stadtverkehr.
function scoreRoundtrip(trip, km) {
  const s = trip.summary;
  const lengthDev = Math.abs(s.length - km) / km;
  const speed = s.length / (s.time / 3600);
  const slow = Math.max(0, 1 - speed / Math.max(25, +$('speed').value * 0.8));
  return lengthDev + 2 * overlapShare(tripCoords(trip)) + slow;
}

// Anteil der Strecke, die nahe an einem mindestens 1 km entfernten anderen Stück derselben Route liegt
function overlapShare(coords, step = 50, near = 25, apart = 1000) {
  if (coords.length < 2) return 0;
  const kx = 111320 * Math.cos(coords[0][0] * Math.PI / 180), ky = 110540;
  const pts = [];
  let along = 0, carry = 0;
  for (let i = 1; i < coords.length; i++) {
    const x0 = coords[i - 1][1] * kx, y0 = coords[i - 1][0] * ky, x1 = coords[i][1] * kx, y1 = coords[i][0] * ky;
    const len = Math.hypot(x1 - x0, y1 - y0);
    for (let d = carry; d < len; d += step) pts.push({ x: x0 + (x1 - x0) * d / len, y: y0 + (y1 - y0) * d / len, s: along + d });
    carry = (carry - len) % step; if (carry < 0) carry += step;
    along += len;
  }
  // Raster mit Zellgröße "near", damit nicht jeder Punkt gegen jeden geprüft wird
  const grid = new Map(), key = (cx, cy) => cx + ',' + cy;
  for (const p of pts) {
    const k = key(Math.floor(p.x / near), Math.floor(p.y / near));
    (grid.get(k) || grid.set(k, []).get(k)).push(p);
  }
  let doubled = 0;
  for (const p of pts) {
    const cx = Math.floor(p.x / near), cy = Math.floor(p.y / near);
    let hit = false;
    for (let dx = -1; dx <= 1 && !hit; dx++) for (let dy = -1; dy <= 1 && !hit; dy++)
      hit = (grid.get(key(cx + dx, cy + dy)) || []).some(q => Math.abs(q.s - p.s) > apart && Math.hypot(q.x - p.x, q.y - p.y) < near);
    if (hit) doubled++;
  }
  return doubled / pts.length;
}

// Kreispunkte liegen oft im Feld oder Wald. Zweistufig einrasten:
// 1. Anker: nächstes Dorf im Umkreis, sonst der Kreispunkt selbst. Stadtteile (suburb) zählen nicht, sie ziehen die Tour in die Stadt.
// 2. Anker auf den nächsten Punkt einer Durchgangsstraße setzen (Overpass-Geometrie, Lotfußpunkt).
//    Wohnstraßen nur, wenn nichts Besseres in der Nähe ist: dort enden Formpunkte oft in Sackgassen und erzeugen Stiche.
// Fallback: Valhalla /locate, zuletzt der Rohpunkt.
// groups: je Variante eine Liste von Kreispunkten. Alles in zwei Overpass-Abfragen.
const PLACE_WEIGHT = { town: 1, village: 0.8, hamlet: 1 };
const SNAP_ROADS = '^(primary|secondary|tertiary|unclassified|residential|living_street)$';

async function overpass(query) {
  return (await overpassFetch(`[out:json][timeout:25];${query}`)).elements;
}

const aroundQuery = (filter, items) => `(${[...new Set(items.map(([ll, rad]) =>
  `${filter}(around:${Math.round(rad)},${ll.lat.toFixed(5)},${ll.lng.toFixed(5)});`))].join('')});`;

async function snapRoundtrip(groups, start, radius) {
  let places = [];
  try {
    places = (await overpass(aroundQuery('node[place~"^(town|village|hamlet)$"]', groups.flat().map(t => [t, radius])) + 'out;'))
      .map(e => ({ latlng: L.latLng(e.lat, e.lon), name: e.tags.name, weight: PLACE_WEIGHT[e.tags.place] || 1 }));
  } catch {}
  const anchorGroups = groups.map(targets => {
    const used = new Set();
    return targets.map(t => {
      const best = places
        .filter(p => !used.has(p) && map.distance(p.latlng, start) > 1000 && map.distance(p.latlng, t) <= radius)
        .sort((a, b) => map.distance(a.latlng, t) * a.weight - map.distance(b.latlng, t) * b.weight)[0];
      if (best) used.add(best);
      // Ortsmittelpunkt: Straße ganz in der Nähe; freier Kreispunkt: weiter suchen
      return best ? { ...best, search: 600 } : { latlng: t, search: Math.round(Math.min(radius, 2500)) };
    });
  });

  let ways = [];
  try {
    ways = await overpass(aroundQuery(`way[highway~"${SNAP_ROADS}"]`, anchorGroups.flat().map(a => [a.latlng, a.search])) + 'out geom;');
  } catch {}

  const out = [];
  for (const anchors of anchorGroups) {
    const pts = [];
    for (const a of anchors) {
      const onRoad = nearestOnWays(a.latlng, ways, a.search);
      pts.push({ name: a.name, latlng: onRoad || await snapToRoad(a.latlng) });
    }
    out.push(pts);
  }
  return out;
}

// Nächster Punkt auf den Straßengeometrien; Durchgangsstraßen klar bevorzugt
const ROAD_WEIGHT = { unclassified: 1.4, residential: 2.5, living_street: 3 };
function nearestOnWays(ll, ways, maxDist) {
  const kx = 111320 * Math.cos(ll.lat * Math.PI / 180), ky = 110540;
  let best = null, bestScore = Infinity;
  for (const w of ways) {
    const g = w.geometry || [];
    const weight = ROAD_WEIGHT[w.tags?.highway] || 1;
    for (let i = 1; i < g.length; i++) {
      const ax = (g[i - 1].lon - ll.lng) * kx, ay = (g[i - 1].lat - ll.lat) * ky;
      const dx = (g[i].lon - g[i - 1].lon) * kx, dy = (g[i].lat - g[i - 1].lat) * ky;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d <= maxDist && d * weight < bestScore) {
        bestScore = d * weight;
        best = L.latLng(g[i - 1].lat + t * (g[i].lat - g[i - 1].lat), g[i - 1].lon + t * (g[i].lon - g[i - 1].lon));
      }
    }
  }
  return best;
}

async function snapToRoad(ll) {
  try {
    const res = await fetch(VALHALLA_URL.replace(/\/route$/, '/locate'), { method: 'POST', body: JSON.stringify({
      locations: [{ lat: ll.lat, lon: ll.lng, search_filter: { min_road_class: 'residential' } }], costing: 'motor_scooter'
    }) });
    const edge = (await res.json())[0]?.edges?.[0];
    if (edge) return L.latLng(edge.correlated_lat, edge.correlated_lon);
  } catch {}
  return ll;
}

// Beim Öffnen den eigenen Standort als Start vorschlagen
if (navigator.geolocation) navigator.geolocation.getCurrentPosition(pos => {
  if (waypoints[0].latlng) return;
  const ll = L.latLng(pos.coords.latitude, pos.coords.longitude);
  waypoints[0] = { latlng: ll, text: 'Mein Standort' };
  renderWaypoints();
  map.setView(ll, 13);
}, () => {}, { timeout: 10000, maximumAge: 300000 });

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
