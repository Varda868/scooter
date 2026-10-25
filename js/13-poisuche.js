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
async function loadPois() {
  poiLayer.clearLayers().addTo(map);
  $('pois').innerHTML = '';
  $('poiSummary').textContent = '';
  mapBusy('poi', null);
  if (!routeCoords) return;
  // Schutzhütten kommen bei Gewitter, Regen oder Schnee unterwegs automatisch dazu
  const active = POI_TYPES.filter(t => $('poiTypes').querySelector(`input[value="${t.id}"]`).checked || (t.id === 'shelter' && wxShelter));
  if (!active.length) return;

  const req = ++poiRequest;
  const queries = routeChunks().map(chunk => {
    const line = simplify(chunk, 100).map(([la, lo]) => `${la.toFixed(5)},${lo.toFixed(5)}`).join(',');
    const around = t => `(around:${Math.max(+$('radius').value, t.minRadius || 0)},${line})`;
    return `[out:json][timeout:60];(${active.flatMap(t => t.filters.map(f => `nwr${f}${around(t)};`)).join('')});out center tags;`;
  });
  const key = queries.join('|'), n = queries.length;
  const busy = (text, ms) => { if (req === poiRequest) mapBusy('poi', text, ms); };
  const seen = new Set(), elements = [];
  let note = '', failed = 0, lastErr = null;
  const add = els => { for (const el of els) { const id = el.type + el.id; if (!el.id || !seen.has(id)) { seen.add(id); elements.push(el); } } };
  // Alle Abschnitte gleichzeitig anstoßen; overpassFetch verteilt sie auf die Server (je Server eine zur Zeit)
  let done = 0;
  const progress = host => busy(`📍 POIs laden${n > 1 ? ` ${done}/${n}` : ''} …${host ? ' ' + host : ''}`);
  progress();
  $('poiSummary').textContent = 'Suche POIs …';
  await Promise.all(queries.map(q => overpassFetch(q, host => {
    if (req !== poiRequest) return;
    $('poiSummary').textContent = `Suche POIs … ${host}`;
    progress(host);
  }, () => req !== poiRequest).then(data => {
    if (req !== poiRequest) return;
    add(data?.elements || []); done++;
    progress();
    showPois(elements, active, '', done < n);
  }, err => { failed++; lastErr = err; })));
  if (req !== poiRequest) return;
  try {
    if (failed < n) {
      store.set('lastPois', { query: key, elements });
      if (failed) note = ` · ⚠️ ${failed} von ${n} Abschnitten nicht geladen`;
    } else {
      const camp = active.find(t => t.id === 'camp'), lastPois = store.get('lastPois', null);
      if (lastPois?.query === key) { // offline oder Server weg: letzte Abfrage für genau diese Route
        add(lastPois.elements); note = ' · 📴 gespeicherte POIs';
      } else if (camp) { // Overpass weg: wenigstens Zeltplätze über Nominatim/Photon, an Punkten entlang der Route
        busy('📍 Overpass weg, suche Zeltplätze …');
        const rad = Math.max(+$('radius').value, camp.minRadius), total = routeKm.at(-1);
        const k = Math.min(12, Math.max(2, Math.ceil(total / (2 * rad / 1000)) + 1));
        const { camps, source } = await findCamps(Array.from({ length: k }, (_, i) => pointAtKm(total * i / (k - 1))), rad);
        add(camps.map(c => ({ lat: c.lat, lon: c.lon, tags: { tourism: 'camp_site', ...(c.name ? { name: c.name } : {}) } })));
        note = ` · ⚠️ Overpass nicht erreichbar, nur Zeltplätze (über ${source})`;
      } else throw lastErr;
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
    return type && lat != null ? { lat, lon, type, tags: el.tags || {}, km: locateOnRoute(lat, lon).km } : null;
  }).filter(p => p && (p.type.id !== 'workshop' || brandMatch(p.tags))).sort((a, b) => a.km - b.km);

  for (const p of pois) {
    const title = p.tags.name || p.tags.brand || p.type.name;
    p.marker = L.marker([p.lat, p.lon], {
      icon: L.divIcon({ className: 'poi-icon', html: p.type.icon, iconSize: [24, 24] }), title
    }).bindPopup(`<b>${escapeHtml(title)}</b><br>${p.type.name} · km ${p.km.toFixed(1)}` +
      (p.tags.opening_hours ? `<br>${escapeHtml(p.tags.opening_hours)}` : '') + workshopInfo(p)).addTo(poiLayer);
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
  return pois.length;
}
