// Valhalla liefert Polylines mit Präzision 6
function decode(str, precision = 6) {
  let idx = 0, lat = 0, lng = 0;
  const coords = [], f = Math.pow(10, precision);
  while (idx < str.length) {
    for (const axis of [0, 1]) {
      let shift = 0, result = 0, b;
      do { b = str.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = (result & 1) ? ~(result >> 1) : (result >> 1);
      if (axis === 0) lat += d; else lng += d;
    }
    coords.push([lat / f, lng / f]);
  }
  return coords;
}

function routeBody(locs) {
  const body = {
    // Formpunkte: "through" = Route muss durch, aber kein Halt und kein eigener Abschnitt
    // search_filter: Formpunkte nur an richtige Straßen binden, nicht an Feld-/Waldwege oder Zufahrten
    locations: locs.map((w, i) => {
      const shaping = w.shaping && i && i < locs.length - 1;
      // Formpunkte aus der Grobroute (w.grob): nicht auf Autobahn oder Kraftfahrstraße einrasten
      return { lat: w.latlng.lat, lon: w.latlng.lng, type: shaping ? 'through' : 'break',
        ...(shaping ? { search_filter: { min_road_class: 'residential', ...(w.grob ? { max_road_class: 'primary' } : {}) } } : {}) };
    }),
    costing: 'motor_scooter',
    costing_options: { motor_scooter: {
      top_speed: +$('speed').value,
      use_primary: +$('primary').value,
      use_hills: +$('hills').value,
      // Schotter, Feld- und Waldwege: ausschließen (außer direkt an Start und Ziel)
      ...($('unpaved').checked ? { exclude_unpaved: true, use_tracks: 0 } : {}),
      // Valhalla-Standard 0,5 meidet Fähren leicht; 1 = nimmt sie gern
      ...($('ferry').checked ? { use_ferry: 1 } : {})
    } },
    directions_options: { language: 'de-DE', units: 'kilometers' },
    // Höhen alle 30 m je Abschnitt gleich mit der Route (spart /height), Spuren je Manöver fürs Navi
    elevation_interval: 30,
    turn_lanes: true
  };
  if (excluded.length) body.exclude_locations = excluded.map(ll => ({ lat: ll.lat, lon: ll.lng }));
  return body;
}

// Valhalla-Fehlercodes auf Deutsch, jeweils mit Hinweis, was hilft
const VALHALLA_ERRORS = {
  150: ['Zu viele Wegpunkte für den Routing-Server.', 'Einige Zwischenziele oder Formpunkte entfernen.'],
  154: ['Strecke zu lang für den Routing-Server (höchstens 200 km Luftlinie je Abschnitt).', 'Zwischenziele setzen, damit jedes Teilstück kürzer wird.'],
  157: ['Zu viele gemiedene Stellen.', 'Mit „Zurück“ einige „Straße meiden“ zurücknehmen.'],
  170: ['Zwischen den Punkten gibt es keine Straßenverbindung.', 'Prüfen, ob ein Punkt auf einer Insel liegt oder nur per Fähre erreichbar ist, und ihn verschieben.'],
  171: ['Kein befahrbarer Weg in der Nähe eines Punkts.', 'Den Punkt näher an eine Straße setzen; Feld-, Wald- und Radwege sind für Roller tabu.'],
  442: ['Keine Route für den Roller gefunden.', 'Punkte näher an Straßen setzen, „Straße meiden“ zurücknehmen oder im Fahrprofil Hauptstraßen weniger strikt meiden.'],
  443: ['Keine Route für den Roller gefunden.', 'Punkte näher an Straßen setzen oder ein Zwischenziel auf erlaubter Strecke ergänzen.']
};
function valhallaError(status, data) {
  const code = data.error_code ?? (/max distance/i.test(data.error || '') ? 154 : null);
  const known = VALHALLA_ERRORS[code];
  if (known) return `${known[0]} 💡 ${known[1]}`;
  if ([429, 502, 503, 504].includes(status)) return 'Routing-Server gerade ausgelastet. 💡 In einer Minute erneut berechnen.';
  return `Routing-Fehler (${data.error || 'HTTP ' + status}). 💡 Punkte leicht verschieben oder später erneut versuchen.`;
}

async function fetchRoute(body) {
  let res;
  try { res = await fetch(VALHALLA_URL, { method: 'POST', body: JSON.stringify(body) }); }
  catch { throw Object.assign(new Error('Keine Verbindung zum Routing-Server. 💡 Internetverbindung prüfen und erneut berechnen.'), { offline: true }); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(valhallaError(res.status, data));
  return data;
}

// Die öffentliche Valhalla-Instanz rechnet höchstens 200 km Luftlinie je Anfrage. Lange Strecken: zwischen weit
// entfernten Punkten Formpunkte auf der Luftlinie einfügen, in Anfragen bis MAX_REQUEST_KM teilen und wieder zusammensetzen.
const MAX_REQUEST_KM = 180;
function chunkLocations(locs) {
  const pts = [];
  locs.forEach((w, i) => {
    // Zwischen zwei Fährhäfen keine Punkte aufs Wasser setzen
    if (i && !(locs[i - 1].hafen === 'ab' && w.hafen === 'an')) {
      const a = locs[i - 1].latlng, b = w.latlng, n = Math.ceil(a.distanceTo(b) / 1000 / (MAX_REQUEST_KM * 0.9));
      for (let k = 1; k < n; k++) pts.push({ latlng: L.latLng(a.lat + (b.lat - a.lat) * k / n, a.lng + (b.lng - a.lng) * k / n), shaping: true });
    }
    pts.push(w);
  });
  const chunks = [];
  let cur = [pts[0]], sum = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = pts[i - 1].latlng.distanceTo(pts[i].latlng) / 1000;
    if (sum + d > MAX_REQUEST_KM && cur.length > 1) { chunks.push(cur); cur = [pts[i - 1]]; sum = 0; }
    cur.push(pts[i]); sum += d;
  }
  chunks.push(cur);
  return chunks;
}

function encode(coords, precision = 6) {
  const f = 10 ** precision;
  let out = '', prev = [0, 0];
  for (const c of coords) {
    for (const axis of [0, 1]) {
      const v = Math.round(c[axis] * f);
      let d = v - prev[axis];
      prev[axis] = v;
      d = d < 0 ? ~(d << 1) : d << 1;
      while (d >= 0x20) { out += String.fromCharCode((0x20 | (d & 0x1f)) + 63); d >>= 5; }
      out += String.fromCharCode(d + 63);
    }
  }
  return out;
}

// Zwei Abschnitte an einem Formpunkt verbinden: Ankunft/Abfahrt dort entfallen, Manöver-Indizes verschieben
function joinLegs(a, b) {
  const ca = decode(a.shape), cb = decode(b.shape);
  return {
    shape: encode([...ca, ...cb.slice(1)]),
    maneuvers: [...a.maneuvers.slice(0, -1), ...b.maneuvers.slice(1).map(m => ({ ...m, begin_shape_index: m.begin_shape_index + ca.length - 1 }))],
    summary: { length: a.summary.length + b.summary.length, time: a.summary.time + b.summary.time }
  };
}

// Lange Strecken: Formpunkte nicht auf die Luftlinie (landet im Meer, rastet auf falsche Fähren ein, erzwingt Umwege),
// sondern auf eine Grobroute fürs Auto ohne Autobahn, die das öffentliche Valhalla am Stück rechnet. Alle GROB_KM ein Punkt;
// auf Fährabschnitten keiner, stattdessen an Abfahrts- und Ankunftshafen. Klappt die Grobroute nicht: Luftlinie wie bisher.
const GROB_KM = 150, grobCache = new Map();
async function grobePunkte(locs) {
  const lang = locs.some((w, i) => i && locs[i - 1].latlng.distanceTo(w.latlng) / 1000 > MAX_REQUEST_KM * 0.9);
  if (!lang) return locs;
  const key = JSON.stringify([locs.map(w => [w.latlng.lat.toFixed(4), w.latlng.lng.toFixed(4), !!w.shaping]), $('ferry').checked]);
  if (!grobCache.has(key)) grobCache.set(key, fetchRoute({
    locations: locs.map((w, i) => ({ lat: w.latlng.lat, lon: w.latlng.lng, type: w.shaping && i && i < locs.length - 1 ? 'through' : 'break' })),
    costing: 'auto', costing_options: { auto: { use_highways: 0, use_tolls: 0, ...($('ferry').checked ? { use_ferry: 1 } : {}) } },
    directions_options: { units: 'kilometers' }
  }).catch(err => { grobCache.delete(key); throw err; }));
  let trip;
  try { trip = (await grobCache.get(key)).trip; } catch { return locs; }
  if (trip?.legs?.length !== locs.length - 1) return locs;
  const out = [locs[0]];
  trip.legs.forEach((leg, j) => {
    const a = locs[j], b = locs[j + 1];
    if (a.latlng.distanceTo(b.latlng) / 1000 > MAX_REQUEST_KM * 0.9) {
      const pts = decode(leg.shape), km = [0];
      for (let i = 1; i < pts.length; i++) km.push(km[i - 1] + L.latLng(pts[i - 1]).distanceTo(L.latLng(pts[i])) / 1000);
      // Fährstücke als Index-Bereiche [von, bis] der Shape
      // Valhalla meldet Fähren nur über die Manövertypen 28 (an Bord) und 29 (von Bord), travel_type bleibt das Fahrzeug
      const faehren = [];
      leg.maneuvers.forEach((m, k) => { if (m.type === 28) {
        const aus = leg.maneuvers.slice(k + 1).find(n => n.type === 29);
        faehren.push([m.begin_shape_index, aus ? aus.begin_shape_index : m.end_shape_index]);
      } });
      const aufFaehre = i => faehren.find(([v, z]) => i > v && i < z);
      const add = (i, hafen) => out.push({ latlng: L.latLng(pts[i]), shaping: true, grob: true, hafen });
      let last = 0;
      for (let i = 1; i < pts.length - 1; i++) {
        const f = aufFaehre(i);
        if (f) {
          // Hafen davor (falls nicht gerade erst gesetzt) und danach; weiter zählen ab Ankunft
          if (km[f[0]] - km[last] > 5 || !out.at(-1).grob) add(f[0], 'ab'); else out.at(-1).hafen = 'ab';
          add(f[1], 'an'); last = f[1]; i = f[1];
          // Fährstrecke selbst merken: zu lang für eine Roller-Anfrage, aber Fähre ist Fähre, egal mit welchem Fahrzeug
          const fm = leg.maneuvers.filter(m => m.begin_shape_index >= f[0] && m.begin_shape_index < f[1] && m.type !== 29);
          out.at(-1).faehre = { coords: pts.slice(f[0], f[1] + 1), m: fm[0] || {},
            km: km[f[1]] - km[f[0]], s: fm.reduce((t, m) => t + (m.time || 0), 0) };
          continue;
        }
        if (km[i] - km[last] >= GROB_KM && km.at(-1) - km[i] > 20) { add(i); last = i; }
      }
    }
    out.push(b);
  });
  return out;
}

// Lange Fähre als eigener Abschnitt aus der Grobroute; Start und Ankunft sind Platzhalter, die joinLegs wegschneidet
function faehrTrip(fa) {
  const n = fa.coords.length - 1, name = fa.m.street_names, len = fa.km, time = fa.s || len / 25 * 3600;
  const leg = { shape: encode(fa.coords), summary: { length: len, time }, maneuvers: [
    { type: 1, instruction: 'Start', begin_shape_index: 0 },
    { type: 28, instruction: fa.m.instruction || 'Nehmen Sie die Fähre.', street_names: name, travel_type: 'ferry', time, length: len, begin_shape_index: 0 },
    { type: 29, instruction: 'Verlassen Sie die Fähre.', begin_shape_index: n },
    { type: 4, instruction: 'Ziel', begin_shape_index: n }] };
  return { legs: [leg], summary: leg.summary };
}

async function planRoute(locs, exclude = []) {
  const chunks = chunkLocations(await grobePunkte(locs));
  const trips = [];
  for (const chunk of chunks) {
    const fa = chunk.length === 2 && chunk[0].hafen === 'ab' && chunk[1].faehre;
    if (fa && chunk[0].latlng.distanceTo(chunk[1].latlng) / 1000 > MAX_REQUEST_KM * 0.9) { trips.push(faehrTrip(fa)); continue; }
    const body = routeBody(chunk);
    if (exclude.length) body.exclude_locations = [...(body.exclude_locations || []), ...exclude].slice(0, 50);
    // Valhalla liefert Alternativen nur ohne Zwischenpunkte
    if (chunks.length === 1 && locs.length === 2) body.alternates = 2;
    const data = await fetchRoute(body);
    if (chunks.length === 1) return data;
    trips.push(data.trip);
  }
  const legs = [];
  trips.forEach((t, k) => t.legs.forEach((l, j) => legs.push(k && !j && chunks[k][0].shaping ? joinLegs(legs.pop(), l) : l)));
  const sum = f => legs.reduce((acc, l) => acc + l.summary[f], 0);
  return { trip: { legs, summary: { length: sum('length'), time: sum('time') } } };
}

// Hin und zurück: Endet die Tour wieder am Start (≤ 300 m) und ist „Rückweg anders“ an, rechnet der Rückweg
// ab dem letzten Halt mit Meidepunkten auf dem Hinweg. Valhalla nimmt höchstens 50 Meidepunkte; sie liegen
// gleichmäßig auf dem Hinweg, nur nicht im ersten und letzten Kilometer (Ortsausfahrt und Wendepunkt dürfen gleich sein).
const BACK_EXCLUDE_MAX = 50, BACK_FREE_KM = 1, BACK_HOME_M = 300;
function backSplit(locs) {
  if (!$('backDiff').checked || locs.length < 3 || locs[0].latlng.distanceTo(locs.at(-1).latlng) > BACK_HOME_M) return -1;
  for (let i = locs.length - 2; i > 0; i--) if (!locs[i].shaping) return i;
  return -1;
}
function backAvoidPoints(coords, n) {
  const km = [0];
  for (let i = 1; i < coords.length; i++) km.push(km[i - 1] + L.latLng(coords[i - 1]).distanceTo(L.latLng(coords[i])) / 1000);
  const from = BACK_FREE_KM, to = km.at(-1) - BACK_FREE_KM, pts = [];
  if (n < 1 || to <= from) return pts;
  for (let j = 0, i = 0; j < n; j++) {
    const at = from + (to - from) * (j + 0.5) / n;
    while (km[i + 1] < at) i++;
    pts.push({ lat: coords[i][0], lon: coords[i][1] });
  }
  return pts;
}
// Anteil des Rückwegs (alle ~100 m geprüft), der mehr als 30 m vom Hinweg entfernt liegt
function backShare(outCoords, backCoords) {
  const step = Math.max(1, Math.round(backCoords.length / 200));
  let n = 0, other = 0;
  for (let i = 0; i < backCoords.length; i += step, n++) if (locateOnRoute(backCoords[i][0], backCoords[i][1], outCoords).dist > 30) other++;
  return n ? other / n : 0;
}
// Rückweg mit Meidepunkten auf dem Hinweg (outCoords); findet Valhalla mit allen keinen Weg (z. B. einzige Brücke),
// mit jedem zweiten erneut versuchen, zuletzt ohne
async function planBack(locs, outCoords, extra) {
  // Viele Sperrungen (extra) dürfen die Meidepunkte nicht ganz verdrängen; Valhalla schneidet bei 50 ab
  const avoid = backAvoidPoints(outCoords, Math.max(15, BACK_EXCLUDE_MAX - excluded.length - extra.length));
  for (const pts of [avoid, avoid.filter((_, i) => i % 2)]) {
    if (!pts.length) break;
    try {
      const back = await planRoute(locs, [...pts, ...extra]); // Meidepunkte zuerst, die 50er-Grenze kürzt dann Sperrungen
      summaryNote += ` · ↩ Rückweg zu ${Math.round(backShare(outCoords, tripCoords(back.trip)) * 100)} % anders`;
      return back;
    } catch (err) { if (err.offline) throw err; }
  }
  summaryNote += ' · ↩ kein anderer Rückweg gefunden';
  return planRoute(locs, extra);
}
// Rückweg nach der Ankunft (Navi): Hinweg ist die gefahrene Spur; gilt nur, solange Start und Ziel noch dazu passen
let backOf = null;
const backOfMatch = locs => !!backOf && locs.length === 2 &&
  locs[0].latlng.distanceTo(backOf.from) < BACK_HOME_M && locs[1].latlng.distanceTo(backOf.to) < BACK_HOME_M;
async function planTrip(locs, extra = []) {
  const k = backSplit(locs);
  if (k < 0) return backOfMatch(locs) ? planBack(locs, backOf.coords, extra) : planRoute(locs, extra);
  const out = await planRoute(locs.slice(0, k + 1), extra);
  const back = await planBack(locs.slice(k), tripCoords(out.trip), extra);
  const legs = [...out.trip.legs, ...back.trip.legs];
  const sum = f => legs.reduce((acc, l) => acc + l.summary[f], 0);
  return { trip: { legs, summary: { length: sum('length'), time: sum('time') } } };
}

let summaryNote = '';
async function route() {
  summaryNote = ''; // Reste eines abgebrochenen Laufs (z. B. offline) nicht doppelt zeigen
  $('summary').textContent = 'Berechne …';
  $('steps').innerHTML = '';
  try {
    for (const w of waypoints) {
      if (!w.latlng && w.text.trim()) w.latlng = await geocode(w.text);
    }
    renderWaypoints();
    const locs = waypoints.filter(w => w.latlng);
    if (locs.length < 2) throw new Error('Bitte Start und Ziel angeben.');
    // Offline: zuletzt berechnete Route nehmen, wenn Wegpunkte und Fahrprofil gleich sind
    const tripKey = JSON.stringify([locs.map(w => [w.latlng.lat.toFixed(5), w.latlng.lng.toFixed(5), !!w.shaping]), excluded, $('backDiff').checked, backOfMatch(locs), ...['speed', 'primary', 'hills'].map(id => $(id).value), $('unpaved').checked, $('ferry').checked]);
    let data;
    try {
      data = await planTrip(locs);
      store.set('lastTrip', { key: tripKey, trip: data.trip });
    } catch (err) {
      const last = store.get('lastTrip', null);
      if (!err.offline || last?.key !== tripKey) throw err;
      data = { trip: last.trip };
      summaryNote += ' · 📴 offline: gespeicherte Route';
    }
    let incidents = [];
    if (ttKeyDa()) {
      try {
        incidents = await loadIncidents(tripCoords(data.trip));
        // Gesperrte Straßen auf der Route: Punkte der Sperrung an Valhalla als "meiden" geben und neu rechnen
        const coords = tripCoords(data.trip);
        const closed = tt.avoid ? incidents.filter(i => i.properties.iconCategory === 8 &&
          incidentPoints(i).some(([lat, lon]) => locateOnRoute(lat, lon, coords).dist < 30)) : [];
        if (closed.length) {
          // Die Rückweg-Notiz des ersten Laufs gilt dann nicht mehr, sonst stehen „97 % anders“ und „kein anderer“ nebeneinander
          const vorher = summaryNote;
          summaryNote = summaryNote.replace(/ · ↩[^·]*/g, '');
          try {
            data = await planTrip(locs, closed.flatMap(closurePoints));
            summaryNote += ` · ${closed.length} Sperrung${closed.length > 1 ? 'en' : ''} umfahren`;
          } catch { summaryNote = vorher + ' · ⚠️ Sperrung auf der Route, keine Umfahrung gefunden'; }
        }
      } catch (err) { summaryNote += ` · ⚠️ Verkehr: ${err.message}`; }
    }
    let trip = data.trip, alts = (data.alternates || []).map(a => a.trip);
    // Obere Streckenstufen (kurvig, sehr kurvig): die kurvigste Alternative nehmen, wenn sie höchstens 15 % länger ist
    if (rideStyleOf() >= 2 && alts.length) {
      const kurv = t => kurvigkeit(tripCoords(t)), alle = [trip, ...alts].map(t => ({ t, k: kurv(t) }));
      const top = alle.filter(x => x.t.summary.length <= trip.summary.length * 1.15).sort((a, b) => b.k - a.k)[0];
      if (top.t !== trip && top.k > alle[0].k) {
        summaryNote += ` · 〰 kurvigere Variante (${top.k} statt ${alle[0].k}°/km)`;
        alts = [trip, ...alts.filter(t => t !== top.t)]; trip = top.t;
      }
    }
    showTrip(trip, alts);
    renderIncidents(incidents);
  } catch (err) {
    $('summary').textContent = '⚠️ ' + err.message;
  }
}

// Bei Zwischenzielen liefert Valhalla einen Abschnitt (leg) je Teilstrecke.
const tripCoords = trip => trip.legs.flatMap((l, i) => decode(l.shape).slice(i ? 1 : 0));
const hhmm = d => d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
// Fahrzeit in s: eigener Schnitt aus dem Fahrprofil, sonst Valhalla (gilt für Abschnitte und ganze Route)
const tripTime = s => +$('avgSpeed').value > 0 ? s.length / +$('avgSpeed').value * 3600 : s.time;
const durText = sec => { const m = Math.round(sec / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} h`; };
// Uhrzeit, an anderen Tagen mit Wochentag (Mehrtagestour)
const etaText = ts => {
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString() ? hhmm(d) : `${d.toLocaleDateString('de-DE', { weekday: 'short' })} ${hhmm(d)}`;
};
// Fahrzeit plus Pausen (je volle 2 h Fahrt eine Pause aus dem Fahrprofil)
const withBreaks = sec => sec + Math.floor(sec / 7200) * +$('breakMin').value * 60;
const tripText = s => {
  const t = tripTime(s), min = Math.round(t / 60);
  return `${s.length.toFixed(1)} km · ${Math.floor(min / 60)} h ${min % 60} min · an ca. ${etaText(Date.now() + withBreaks(t) * 1000)}`;
};

// Uhr im Header, auf die volle Minute synchronisiert
function tick() {
  $('clock').textContent = hhmm(new Date());
  setTimeout(tick, 60000 - Date.now() % 60000 + 50);
}
tick();

function showTrip(trip, alternates = []) {
  waypoints.forEach(w => w.latlng && !w.shaping && rememberPlace(w.text, w.latlng));
  currentTrip = trip; tripClimb = null;
  if (routeLayer) map.removeLayer(routeLayer);
  altLayer.clearLayers();
  // Alternativen grau darunter; Antippen macht sie zur Hauptroute
  const pick = k => showTrip(alternates[k], [trip, ...alternates.filter((_, j) => j !== k)]);
  alternates.forEach((alt, k) => {
    L.polyline(tripCoords(alt), { color: '#888', weight: 5, opacity: 0.7, dashArray: '8 6', bubblingMouseEvents: false })
      .on('click', () => pick(k))
      .addTo(altLayer);
  });
  if (alternates.length) compareRoutes([trip, ...alternates], pick);
  setRouteCoords(tripCoords(trip));
  routeFaehren = typeof faehrenDerRoute === 'function' ? faehrenDerRoute(trip) : []; // js/25 lädt später
  // Schnitt nur über die Fahrt, ohne Fährstrecke und -zeit (Valhalla-Länge und Shape-km weichen leicht ab, daher als Anteil)
  const fahrAnteil = routeKm.at(-1) ? fahrKm(routeKm.at(-1)) / routeKm.at(-1) : 1;
  const fahrt = { length: trip.summary.length * fahrAnteil, time: Math.max(60, trip.summary.time - routeFaehren.reduce((t, f) => t + f.s, 0)) };
  routeKmh = fahrt.length / (tripTime(fahrt) / 3600);
  planStages();
  loadWeather(trip);
  // begin_shape_index zählt je Abschnitt; tripCoords lässt den ersten Punkt jedes weiteren Abschnitts weg
  let off = 0;
  for (const l of trip.legs) {
    for (const m of l.maneuvers) routeManeuvers.push({ km: routeKm[off + m.begin_shape_index] ?? 0, text: m.instruction, type: m.type, exits: m.roundabout_exit_count,
      verbal: m.verbal_pre_transition_instruction || m.instruction, lanes: m.lanes?.some(x => x.active || x.valid) ? m.lanes : null });
    off += decode(l.shape).length - 1;
  }
  routeLayer = L.polyline(routeCoords, { color: '#e4572e', weight: 6, bubblingMouseEvents: false }).addTo(map);
  enableRouteEditing(routeLayer);
  if (!map.getBounds().contains(routeLayer.getBounds())) fitFein(routeLayer.getBounds());

  const rough = trip.legs.some(l => l.maneuvers.some(m => m.rough)) ? ' · ⚠ unbefestigte Stücke' : '';
  $('summary').textContent = stageTripText(trip.summary) + (alternates.length ? ` · ${alternates.length} Alternative(n) grau` : '') + rough + summaryNote;
  summaryNote = '';
  $('steps').innerHTML = trip.legs.flatMap(l => l.maneuvers).map(m => `<li>${escapeHtml(m.instruction)}</li>`).join('');
  loadElevation(trip);
  loadPois();
  renderCaches();
  renderMyPois();
  tankPlan();
  faehrenZeigen(trip);
}
