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
async function loadPois() {
  poiLayer.clearLayers().addTo(map);
  $('pois').innerHTML = '';
  $('poiSummary').textContent = '';
  if (!routeCoords) return;
  // Schutzhütten kommen bei Gewitter, Regen oder Schnee unterwegs automatisch dazu
  const active = POI_TYPES.filter(t => $('poiTypes').querySelector(`input[value="${t.id}"]`).checked || (t.id === 'shelter' && wxShelter));
  if (!active.length) return;

  const req = ++poiRequest;
  $('poiSummary').textContent = 'Suche POIs …';
  const line = simplify(routeCoords).map(([la, lo]) => `${la.toFixed(5)},${lo.toFixed(5)}`).join(',');
  const around = t => `(around:${Math.max(+$('radius').value, t.minRadius || 0)},${line})`;
  const query = `[out:json][timeout:60];(${active.flatMap(t => t.filters.map(f => `nwr${f}${around(t)};`)).join('')});out center tags;`;
  try {
    let elements, note = '';
    try {
      elements = (await overpassFetch(query, (host, n) => {
        if (req === poiRequest) $('poiSummary').textContent = n ? `Suche POIs … ${host} (Ausweichserver ${n})` : `Suche POIs … ${host}`;
      })).elements;
      store.set('lastPois', { query, elements });
    } catch (err) {
      const camp = active.find(t => t.id === 'camp'), lastPois = store.get('lastPois', null);
      if (lastPois?.query === query) { // offline oder Server weg: letzte Abfrage für genau diese Route
        elements = lastPois.elements; note = ' · 📴 gespeicherte POIs';
      } else if (camp) { // Overpass weg: wenigstens Zeltplätze über Nominatim/Photon, an Punkten entlang der Route
        const rad = Math.max(+$('radius').value, camp.minRadius), total = routeKm.at(-1);
        const n = Math.min(12, Math.max(2, Math.ceil(total / (2 * rad / 1000)) + 1));
        const { camps, source } = await findCamps(Array.from({ length: n }, (_, i) => pointAtKm(total * i / (n - 1))), rad);
        elements = camps.map(c => ({ lat: c.lat, lon: c.lon, tags: { tourism: 'camp_site', ...(c.name ? { name: c.name } : {}) } }));
        note = ` · ⚠️ Overpass nicht erreichbar, nur Zeltplätze (über ${source})`;
      } else throw err;
    }
    if (req !== poiRequest) return;

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
    $('poiSummary').textContent = (pois.length ? `${pois.length} POIs entlang der Route` : 'Keine POIs im Umkreis gefunden.') +
      (wxShelter && !$('poiTypes').querySelector('input[value="shelter"]').checked ? ' · 🛖 Schutzhütten wegen Wetter eingeblendet' : '') + note;
    $('pois').innerHTML = pois.map((p, i) =>
      `<li data-i="${i}">${p.type.icon} km ${p.km.toFixed(1)} · ${escapeHtml(p.tags.name || p.tags.brand || p.type.name)}</li>`).join('');
    $('pois').onclick = e => {
      const p = pois[e.target.closest('li')?.dataset.i];
      if (p) { map.setView([p.lat, p.lon], 16); p.marker.openPopup(); }
    };
  } catch (err) {
    if (req === poiRequest) $('poiSummary').textContent = '⚠️ POIs: ' + err.message;
  }
}
