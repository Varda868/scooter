// --- Mehrtagestour: Etappen nach Fahrzeit pro Tag, Etappenende auf einen Halt ziehen, Zeltplätze in der Nähe ---
let stageRequest = 0;

// Ankunftszeit an Routen-km: Tag 1 ab jetzt, jeder weitere Tag ab der eingestellten Startzeit; Pausen je Tag gezählt
function etaAtKm(km) {
  const kmh = routeKmh || +$('speed').value * 0.8;
  const day = routeStages.filter(e => e < km - 1e-6).length;
  const from = day ? routeStages[day - 1] : 0;
  let base = Date.now();
  if (day) { const d = new Date(); d.setDate(d.getDate() + day); d.setHours(+$('dayStart').value, 0, 0, 0); base = d.getTime(); }
  return base + withBreaks((km - from) / kmh * 3600) * 1000;
}

// Spritkosten aus „Mein Roller“ (Verbrauch l/100 km, Preis €/l); ohne Verbrauch nichts
const fuelText = km => {
  const l = km * (+roller.fuel || 0) / 100;
  if (!l) return '';
  const eur = l * (+roller.price || 0);
  return ` · ⛽ ${l.toFixed(1).replace('.', ',')} l` + (eur ? ` ≈ ${eur.toFixed(2).replace('.', ',')} €` : '');
};
const climbText = () => tripClimb ? ` · ↑ ${tripClimb.up} m ↓ ${tripClimb.down} m` : '';
const stageTripText = s => (routeStages.length
  ? `${s.length.toFixed(1)} km · ${durText(tripTime(s))} Fahrzeit · ${routeStages.length + 1} Tage · an ${etaText(etaAtKm(routeKm.at(-1)))}`
  : tripText(s)) + fuelText(s.length) + climbText();

function planStages() {
  routeStages = [];
  stageLayer.clearLayers();
  $('stageSummary').textContent = '';
  const hours = +$('dayMax').value, total = routeKm?.at(-1);
  if (!hours || !total || !routeKmh) return;
  const perDay = routeKmh * hours;
  if (total <= perDay * 1.1) return;
  // Halte (keine Formpunkte) als bevorzugte Etappenenden
  const located = waypoints.filter(w => w.latlng);
  const stopKms = located.filter((w, i) => i && i < located.length - 1 && !w.shaping).map(w => locateOnRoute(w.latlng.lat, w.latlng.lng).km);
  let from = 0;
  while (total - from > perDay * 1.1) {
    const target = from + perDay;
    const near = stopKms.filter(k => k > from + perDay * 0.5 && Math.abs(k - target) <= perDay * 0.15).sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
    from = near ?? target;
    routeStages.push(from);
  }
  const ends = [...routeStages, total];
  $('stageSummary').textContent = '🌙 ' + ends.map((e, d) => `Tag ${d + 1}: ${(e - (d ? ends[d - 1] : 0)).toFixed(0)} km`).join(' · ');
  routeStages.forEach((km, d) => {
    L.marker(pointAtKm(km), { zIndexOffset: 500, icon: L.divIcon({ className: 'stage-pin', html: `🌙${d + 1}`, iconSize: [30, 18], iconAnchor: [15, 9] }) })
      .bindTooltip(`Ende Tag ${d + 1} · km ${km.toFixed(0)} · an ca. ${etaText(etaAtKm(km))}`).addTo(stageLayer);
  });
  loadStageCamps();
}

// Zeltplätze um Punkte: zuerst Overpass, fällt es aus, Nominatim (Sonderbegriff „Campingplatz“ = tourism=camp_site),
// zuletzt Photon (komoot). Rückgabe { camps: [{ lat, lon, name }], source }
const PHOTON_URL = 'https://photon.komoot.io/api/';
async function findCamps(points, radiusM = 8000) {
  try {
    const around = points.map(([la, lo]) => `nwr[tourism=camp_site](around:${radiusM},${la.toFixed(5)},${lo.toFixed(5)});`).join('');
    const data = await overpassFetch(`[out:json][timeout:30];(${around});out center tags;`);
    return { source: 'Overpass', camps: data.elements.map(el => ({ lat: el.lat ?? el.center?.lat, lon: el.lon ?? el.center?.lon, name: el.tags?.name })).filter(c => c.lat != null) };
  } catch {}
  // Umkreis als Rechteck um jeden Punkt
  const boxes = points.map(([la, lo]) => { const dLat = radiusM / 111320, dLon = dLat / Math.cos(la * Math.PI / 180); return [lo - dLon, la - dLat, lo + dLon, la + dLat]; });
  const dedupe = list => [...new Map(list.map(c => [`${c.lat.toFixed(4)},${c.lon.toFixed(4)}`, c])).values()];
  try {
    const camps = [];
    for (const [w, so, e, n] of boxes) {
      const res = await fetch(`${NOMINATIM_URL}?format=json&limit=30&bounded=1&accept-language=de&q=Campingplatz&viewbox=${w},${n},${e},${so}`);
      if (!res.ok) throw new Error();
      for (const r of await res.json()) if (r.class === 'tourism' && r.type === 'camp_site') camps.push({ lat: +r.lat, lon: +r.lon, name: r.name || r.display_name?.split(',')[0] });
      await new Promise(ok => setTimeout(ok, 1100)); // Nominatim: höchstens 1 Anfrage pro Sekunde
    }
    return { source: 'Nominatim', camps: dedupe(camps) };
  } catch {}
  const camps = [];
  for (const [w, so, e, n] of boxes) {
    const res = await fetch(`${PHOTON_URL}?q=camping&osm_tag=tourism:camp_site&limit=30&bbox=${w},${so},${e},${n}`);
    if (!res.ok) throw new Error('Zeltplatz-Suche: kein Dienst erreichbar (Overpass, Nominatim, Photon). 💡 Später erneut versuchen.');
    for (const f of (await res.json()).features || []) camps.push({ lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], name: f.properties?.name });
  }
  return { source: 'Photon', camps: dedupe(camps) };
}

async function loadStageCamps() {
  const req = ++stageRequest;
  try {
    const { camps, source } = await findCamps(routeStages.map(km => pointAtKm(km)));
    if (req !== stageRequest) return;
    for (const c of camps) {
      const ll = L.latLng(c.lat, c.lon), name = c.name || 'Zeltplatz';
      L.marker(ll, { icon: L.divIcon({ className: 'poi-icon', html: '⛺', iconSize: [24, 24] }), title: name })
        .bindPopup(() => {
          const box = document.createElement('div');
          box.innerHTML = `<b>⛺ ${escapeHtml(name)}</b>`;
          box.append(menuBox([['via', 'Als Übernachtung (Zwischenziel)']], () =>
            changeWaypoints(() => { insertVia(ll); waypoints.find(w => w.latlng === ll).text = name; })));
          return box;
        }, { className: 'map-menu', minWidth: 170 }).addTo(stageLayer);
    }
    const n = camps.length, via = source === 'Overpass' ? '' : ` (über ${source})`;
    $('stageSummary').textContent += (n ? ` · ⛺ ${n} ${n > 1 ? 'Zeltplätze' : 'Zeltplatz'} nahe den Etappenenden` : ' · ⛺ keine Zeltplätze im Umkreis von 8 km') + via;
  } catch (err) {
    if (req === stageRequest) $('stageSummary').textContent += ` · ⚠️ Zeltplätze: ${err.message}`;
  }
}

const replanTimes = () => {
  if (!currentTrip || !routeCoords) return;
  planStages();
  loadWeather(currentTrip);
  loadRouteWeather();
  $('summary').textContent = stageTripText(currentTrip.summary);
};
['dayMax', 'breakMin', 'dayStart'].forEach(id => $(id).addEventListener('change', replanTimes));
