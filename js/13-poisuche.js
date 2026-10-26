// Overpass akzeptiert bei around: eine Punktliste als Linie; zu viele Punkte machen die Abfrage langsam.
function simplify(coords, max = 150) {
  if (coords.length <= max) return coords;
  const step = (coords.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => coords[Math.round(i * step)]);
}

// Abstand zur Route (m) und Kilometer ab Start am nächsten Punkt, per Lotfußpunkt auf jedem Segment.
// Lokale Planprojektion reicht bei Segmentlängen von wenigen hundert Metern.
function locateOnRoute(lat, lon, coords = routeCoords, kms = coords === routeCoords ? routeKm : null) {
  const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540;
  let best = Infinity, bestKm = 0;
  for (let i = 1; i < coords.length; i++) {
    const [aLat, aLon] = coords[i - 1], [bLat, bLon] = coords[i];
    const ax = (aLon - lon) * kx, ay = (aLat - lat) * ky;
    const dx = (bLon - aLon) * kx, dy = (bLat - aLat) * ky;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best) { best = d; bestKm = kms ? kms[i - 1] + t * (kms[i] - kms[i - 1]) : 0; }
  }
  return { dist: best, km: bestKm };
}

let poiRequest = 0;
// Overpass-Ergebnisse je Routenabschnitt (Schlüssel = Punktliste der Abfrage): { at, r: { typ: Umkreis }, els }.
// Im Browser gespeichert, damit auch nach Neuladen oder offline die zuletzt gefragten Abschnitte da sind.
const POI_CACHE_MS = 864e5, POI_CACHE_MAX = 40;
const poiCache = new Map(store.get('poiCache', []));
try { localStorage.removeItem('scooterways.lastPois'); } catch {} // Vorgänger dieses Speichers
function savePoiCache() {
  const all = [...poiCache].slice(-POI_CACHE_MAX);
  poiCache.clear(); all.forEach(([k, v]) => poiCache.set(k, v));
  // localStorage ist knapp (≈5 MB): passt es nicht, die ältere Hälfte weglassen
  for (let list = all; list.length; list = list.slice(Math.ceil(list.length / 2))) {
    try { localStorage.setItem('scooterways.poiCache', JSON.stringify(list)); return; } catch {}
  }
}
// Tankstellen ausgedünnt: nur direkt an der Strecke, und davon etwa eine je 100 km
const FUEL_NAH_M = 150, FUEL_ABSTAND_KM = 100;
const fuelDuenn = () => settings.fuelThin !== false;
$('fuelThin').checked = fuelDuenn();
$('fuelThin').onchange = () => { settings.fuelThin = $('fuelThin').checked; store.set('settings', settings); loadPois(); };
const poiRadius = t => t.id === 'fuel' && fuelDuenn() ? FUEL_NAH_M : Math.max(+$('radius').value, t.minRadius || 0);
// Je 100-km-Marke die letzte Tankstelle davor; fehlt dort eine, die nächste danach. Kürzere Touren: die zur Mitte nächste
function fuelAuswahl(fuels, total) {
  const out = [];
  for (let pos = 0; pos + FUEL_ABSTAND_KM < total;) {
    const mark = pos + FUEL_ABSTAND_KM;
    const s = fuels.filter(f => f.km > pos && f.km <= mark).at(-1) || fuels.find(f => f.km > mark);
    if (!s) break;
    out.push(s); pos = s.km;
  }
  if (!out.length && fuels.length) out.push(fuels.reduce((a, b) => Math.abs(b.km - total / 2) < Math.abs(a.km - total / 2) ? b : a));
  return out;
}
// Lange Touren abschnittsweise abfragen (je höchstens 50 km): kleinere Overpass-Abfragen laufen seltener in die
// Zeitgrenze, und die ersten POIs stehen schon auf der Karte, während der Rest noch lädt.
const POI_CHUNK_KM = 50;
// Abschnitte, die komplett auf schon abgefragter Strecke liegen (Hin und zurück auf derselben Straße), entfallen
function routeChunks() {
  const out = [];
  let from = 0;
  for (let i = 1; i < routeCoords.length; i++) {
    if (routeKm[i] - routeKm[from] < POI_CHUNK_KM && i < routeCoords.length - 1) continue;
    const chunk = routeCoords.slice(from, i + 1), before = routeCoords.slice(0, from + 1);
    const known = from > 0 && simplify(chunk, 25).every(([la, lo]) => locateOnRoute(la, lo, before).dist < 300);
    if (!known) out.push(chunk);
    from = i;
  }
  return out.length ? out : [routeCoords];
}
// --- Eigene POI-Kacheln (1°×1°, monatlich aus Geofabrik gebaut: tools/poi-kacheln.py, .github/workflows/poi-kacheln.yml) ---
// Liegen neben der App unter poi/ (Plesk, später ggf. Raspi). Fehlen sie oder deckt der Stand die Route nicht ab: Overpass.
const POI_TILE_URL = BASIS_URL + 'poi/';
let poiIndex = null;
const poiTiles = new Map();
function poiTileIndex() {
  poiIndex ??= fetch(POI_TILE_URL + 'index.json', { cache: 'no-cache', signal: AbortSignal.timeout(8000) }).then(r => r.ok ? r.json() : null)
    .then(ix => ix && { ...ix, set: new Set(ix.tiles) }, () => null)
    .then(ix => { if (!ix) setTimeout(() => { poiIndex = null; }, 60000); return ix; }); // später erneut fragen
  return poiIndex;
}
// Punkte entlang der Route alle stepKm (für die Abstandsprüfung reicht das statt der Lotfußpunkte)
function routeSamples(stepKm) {
  const out = [routeCoords[0]];
  for (let i = 1, next = stepKm; i < routeCoords.length; i++) {
    const [a, b] = [routeCoords[i - 1], routeCoords[i]], k0 = routeKm[i - 1], k1 = routeKm[i];
    // Auf der Fähre nichts suchen (Meer), Anleger bleiben über die Punkte davor und danach
    for (; next <= k1; next += stepKm) { if (aufFaehre(next)) continue; const t = (next - k0) / ((k1 - k0) || 1); out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]); }
  }
  out.push(routeCoords.at(-1));
  return out;
}
// Elemente aus den Kacheln im Umkreis der Punkte; radiusFor(tags) = Umkreis in m oder 0 (nicht gesucht).
// null = keine eigenen Daten für dieses Gebiet (weniger als 90 % der Kacheln vorhanden; fehlende = Meer o. ä.)
async function tileElements(points, maxR, radiusFor) {
  const ix = await poiTileIndex();
  if (!ix) return null;
  const keys = new Set();
  for (const [la, lo] of points) {
    const dLat = maxR / 110540, dLon = maxR / (111320 * Math.cos(la * Math.PI / 180));
    for (let a = Math.floor(la - dLat); a <= Math.floor(la + dLat); a++)
      for (let o = Math.floor(lo - dLon); o <= Math.floor(lo + dLon); o++) keys.add(`${a}_${o}`);
  }
  // Abgedeckt, wenn fast alle Kacheln unter den Punkten selbst da sind; Nachbarkacheln im Umkreis fehlen an der Küste
  // oft (Meer), das darf nicht auf Overpass umschalten
  const have = [...keys].filter(k => ix.set.has(k)), unter = new Set(points.map(([la, lo]) => `${Math.floor(la)}_${Math.floor(lo)}`));
  if ([...unter].filter(k => ix.set.has(k)).length < unter.size * 0.9) return null;
  // Geladene Kacheln für die Sitzung behalten: neu berechnen oder Typ umschalten liest sie nur noch aus dem Speicher
  const tiles = await Promise.all(have.map(k => {
    const url = `${POI_TILE_URL}t/${k}.json?v=${ix.date}`;
    if (!poiTiles.has(url)) poiTiles.set(url, fetch(url, { signal: AbortSignal.timeout(20000) })
      .then(r => { if (!r.ok) throw new Error(`POI-Kachel ${k}: ${r.status}`); return r.json(); })
      .catch(err => { poiTiles.delete(url); throw err; }));
    return poiTiles.get(url);
  }));
  // Gitter (0,02°) über die Punkte, damit nicht jedes Element gegen jeden Punkt geprüft wird
  const CELL = 0.02, grid = new Map(), cellOf = (la, lo) => `${Math.floor(la / CELL)},${Math.floor(lo / CELL)}`;
  for (const p of points) { const g = cellOf(p[0], p[1]); if (!grid.has(g)) grid.set(g, []); grid.get(g).push(p); }
  const TYPES = { n: 'node', w: 'way', r: 'relation' }, out = [];
  for (const [id, lat, lon, tags] of tiles.flat()) {
    const r = radiusFor(tags);
    if (!r) continue;
    const ky = 110540, kx = 111320 * Math.cos(lat * Math.PI / 180), nLat = Math.ceil(r / (CELL * ky)), nLon = Math.ceil(r / (CELL * kx));
    const ca = Math.floor(lat / CELL), co = Math.floor(lon / CELL);
    let near = false;
    for (let a = ca - nLat; a <= ca + nLat && !near; a++)
      for (let o = co - nLon; o <= co + nLon && !near; o++)
        near = (grid.get(`${a},${o}`) || []).some(([pl, po]) => Math.hypot((pl - lat) * ky, (po - lon) * kx) <= r);
    if (near) out.push({ type: TYPES[id[0]], id: +id.slice(1), lat, lon, tags });
  }
  return { elements: out, date: ix.date };
}

async function loadPois() {
  if (globalThis.navPause?.('pois', loadPois)) return;
  poiLayer.clearLayers(); if (!settings.poiAus) poiLayer.addTo(map);
  $('pois').innerHTML = '';
  $('poiSummary').textContent = '';
  mapBusy('poi', null);
  if (!routeCoords) return;
  // Schutzhütten kommen bei Gewitter, Regen oder Schnee unterwegs automatisch dazu
  const active = POI_TYPES.filter(t => $('poiTypes').querySelector(`input[value="${t.id}"]`)?.checked || (t.id === 'shelter' && wxShelter));
  if (!active.length) return;

  const req = ++poiRequest;
  const busy = (text, ms) => { if (req === poiRequest) mapBusy('poi', text, ms); };
  const radiusOf = poiRadius;
  try {
    busy('📍 POIs laden …');
    const local = await tileElements(routeSamples(0.25), Math.max(...active.map(radiusOf)), tags => {
      const t = active.find(t => t.filters.some(f => matches(tags, f)));
      return t ? radiusOf(t) : 0;
    });
    if (req !== poiRequest) return;
    if (local) {
      const count = showPois(local.elements, active, ` · 📦 eigene Daten, Stand ${local.date.split('-').reverse().join('.')}`, false);
      return busy(count ? `📍 ${count} POIs` : '📍 keine POIs im Umkreis', 3000);
    }
  } catch {} // Kachel fehlt oder offline ohne Speicher: weiter mit Overpass
  if (req !== poiRequest) return;
  // Je Abschnitt nur fragen, was im Zwischenspeicher fehlt (Typ neu an, Umkreis größer, Eintrag älter als ein Tag)
  const now = Date.now(), jobs = routeChunks().map(chunk => {
    const line = simplify(chunk, 100).map(([la, lo]) => `${la.toFixed(5)},${lo.toFixed(5)}`).join(',');
    const hit = poiCache.get(line), fresh = hit && now - hit.at < POI_CACHE_MS;
    const need = active.filter(t => !(fresh && hit.r[t.id] >= radiusOf(t)));
    const query = need.length && `[out:json][timeout:60];(${need.flatMap(t => t.filters.map(f => `nwr${f}(around:${radiusOf(t)},${line});`)).join('')});out center tags;`;
    return { line, hit, need, query };
  });
  const seen = new Set(), elements = [];
  let note = '', failed = 0, lastErr = null;
  const add = els => { for (const el of els) { const id = el.type + el.id; if (!el.id || !seen.has(id)) { seen.add(id); elements.push(el); } } };
  jobs.forEach(j => { if (j.hit) add(j.hit.els); });
  const open = jobs.filter(j => j.query), n = open.length;
  if (n) {
    // Alle offenen Abschnitte gleichzeitig anstoßen; overpassFetch verteilt sie auf die Server (je Server eine zur Zeit)
    let done = 0;
    const progress = host => busy(`📍 POIs laden${n > 1 ? ` ${done}/${n}` : ''} …${host ? ' ' + host : ''}`);
    progress();
    if (elements.length) showPois(elements, active, '', true); else $('poiSummary').textContent = 'Suche POIs …';
    await Promise.all(open.map(j => overpassFetch(j.query, host => {
      if (req !== poiRequest) return;
      $('poiSummary').textContent = `Suche POIs … ${host}`;
      progress(host);
    }, () => req !== poiRequest).then(data => {
      const els = data?.elements || [];
      // Ergebnis merken, auch wenn die Anzeige inzwischen überholt ist: die nächste Abfrage braucht es vermutlich
      const e = j.hit && now - j.hit.at < POI_CACHE_MS ? j.hit : { at: now, r: {}, els: [] };
      const ids = new Set(e.els.map(el => el.type + el.id));
      e.els.push(...els.filter(el => !ids.has(el.type + el.id)));
      j.need.forEach(t => { e.r[t.id] = radiusOf(t); });
      poiCache.delete(j.line); poiCache.set(j.line, e);
      if (req !== poiRequest) return;
      add(els); done++;
      progress();
      showPois(elements, active, '', done < n);
    }, err => { failed++; lastErr = err; })));
    savePoiCache();
  }
  if (req !== poiRequest) return;
  try {
    if (failed && failed === n && !jobs.some(j => j.hit)) {
      const camp = active.find(t => t.id === 'camp');
      if (!camp) throw lastErr;
      // Overpass weg und nichts gespeichert: wenigstens Zeltplätze über Nominatim/Photon, an Punkten entlang der Route
      busy('📍 Overpass weg, suche Zeltplätze …');
      const rad = radiusOf(camp), total = routeKm.at(-1);
      const k = Math.min(12, Math.max(2, Math.ceil(total / (2 * rad / 1000)) + 1));
      const { camps, source } = await findCamps(Array.from({ length: k }, (_, i) => pointAtKm(total * i / (k - 1))), rad);
      add(camps.map(c => ({ lat: c.lat, lon: c.lon, tags: { tourism: 'camp_site', ...c.tags, ...(c.name ? { name: c.name } : {}) } })));
      note = ` · ⚠️ Overpass nicht erreichbar, nur Zeltplätze (über ${source})`;
    } else if (failed) {
      // Offline oder Server weg: ältere gespeicherte Ergebnisse dieser Abschnitte sind besser als nichts
      note = jobs.some(j => j.hit) ? ' · 📴 teils gespeicherte POIs' : ` · ⚠️ ${failed} von ${n} Abschnitten nicht geladen`;
    }
    if (req !== poiRequest) return;
    const count = showPois(elements, active, note, false);
    busy(count ? `📍 ${count} POIs` : '📍 keine POIs im Umkreis', 3000);
  } catch (err) {
    if (req !== poiRequest) return;
    $('poiSummary').textContent = '⚠️ POIs: ' + err.message;
    busy('⚠️ POIs: Server nicht erreichbar', 6000);
  }
}

// Marker, Liste und Zusammenfassung aus den bisher geladenen Elementen; laeuft = weitere Abschnitte kommen noch
function showPois(elements, active, note, laeuft) {
  poiLayer.clearLayers();
  const pois = elements.map(el => {
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    const type = active.find(t => t.filters.some(f => matches(el.tags || {}, f)));
    if (!type || lat == null) return null;
    const at = locateOnRoute(lat, lon);
    // Zwischenspeicher kann einen größeren Umkreis enthalten als gerade eingestellt
    return at.dist <= poiRadius(type) + 50 ? { lat, lon, type, tags: el.tags || {}, km: at.km } : null;
  }).filter(Boolean).sort((a, b) => a.km - b.km);
  if (fuelDuenn()) {
    const wahl = new Set(fuelAuswahl(pois.filter(p => p.type.id === 'fuel'), routeKm.at(-1)));
    for (let i = pois.length - 1; i >= 0; i--) if (pois[i].type.id === 'fuel' && !wahl.has(pois[i])) pois.splice(i, 1);
  }

  for (const p of pois) {
    const title = p.tags.name || p.tags.brand || p.type.name;
    // Offen bei Ankunft? Nur wenn opening_hours lesbar ist; zu = Symbol blass
    const ank = new Date(etaAtKm(p.km)), offen = offenUm(p.tags, ank);
    const uhr = ank.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    p.marker = L.marker([p.lat, p.lon], {
      icon: L.divIcon({ className: 'poi-icon' + (offen === false ? ' poi-zu' : ''), html: p.type.id === 'fuel' ? `⛽<span class="poi-badge">${fuelBadges(p.tags)}</span>` : p.type.icon, iconSize: [24, 24] }), title
    }).bindPopup(() => poiPopup(p, `<b>${escapeHtml(title)}</b><br>${p.type.name} · km ${p.km.toFixed(1)}` +
      (p.tags.opening_hours ? `<br>🕒 ${escapeHtml(p.tags.opening_hours)}` : '') +
      (offen == null || p.tags.automated === 'yes' ? '' : offen ? `<br>🟢 bei Ankunft (${uhr}) offen` : `<br>🔴 bei Ankunft (${uhr}) zu`) + (p.type.id === 'fuel' ? fuelInfo(p.tags) : '') + contactInfo(p.tags) +
      (p.type.id === 'fuel' && +roller.tank > 0 ? '<br><button data-tank-voll>⛽ Hier vollgetankt</button>' : ''))).addTo(poiLayer);
  }
  $('poiSummary').textContent = (laeuft ? `${pois.length} POIs bisher, lade weiter …`
    : pois.length ? `${pois.length} POIs entlang der Route` : 'Keine POIs im Umkreis gefunden.') +
    (wxShelter && !$('poiTypes').querySelector('input[value="shelter"]').checked ? ' · 🛖 Schutzhütten wegen Wetter eingeblendet' : '') + note;
  $('pois').innerHTML = pois.map((p, i) =>
    `<li data-i="${i}">${p.type.icon} km ${p.km.toFixed(1)} · ${escapeHtml(p.tags.name || p.tags.brand || p.type.name)}</li>`).join('');
  $('pois').onclick = e => {
    const p = pois[e.target.closest('li')?.dataset.i];
    if (p) { map.setView([p.lat, p.lon], 16); p.marker.openPopup(); }
  };
  // Langer Druck (Android: contextmenu) übernimmt den POI gleich als Zwischenziel
  $('pois').oncontextmenu = e => {
    const p = pois[e.target.closest('li')?.dataset.i];
    if (!p) return;
    e.preventDefault();
    poiAlsHalt(p, 'via');
    mapBusy('poi', `➕ ${p.tags.name || p.tags.brand || p.type.name} als Zwischenziel`, 3000);
  };
  return pois.length;
}

// POI-Popup: Info plus dieselben Knöpfe wie bei Tankstopps und eigenen POIs
function poiPopup(p, html) {
  const box = document.createElement('div');
  box.innerHTML = html;
  box.append(menuBox([['via', '➕ Als Zwischenziel'], ['end', '🏁 Als Ziel']], act => poiAlsHalt(p, act), 'via'));
  return box;
}

// POI als Halt übernehmen; der Name wird zum Halt-Text wie bei den Tankstopps
function poiAlsHalt(p, act) {
  const ll = L.latLng(p.lat, p.lon);
  changeWaypoints(() => {
    if (act === 'end') setEnd(waypoints.length - 1, ll); else insertVia(ll);
    waypoints.find(w => w.latlng === ll).text = `${p.type.icon} ${p.tags.name || p.tags.brand || p.type.name}`;
  });
}
