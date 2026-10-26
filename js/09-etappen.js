// --- Mehrtagestour: Etappen nach Fahrzeit pro Tag, Etappenende auf einen Halt ziehen, Zeltplätze in der Nähe ---
let stageRequest = 0;

// Nächte bis einschließlich Etappenende n-1; ein Ruhetag (2 Nächte) schiebt alle folgenden Tage um einen weiter
const nightsBefore = n => routeStageNights.slice(0, n).reduce((a, b) => a + b, 0);
const tourDays = () => 1 + nightsBefore(routeStages.length);

// Ankunftszeit an Routen-km: Tag 1 ab jetzt, jeder weitere Tag ab der eingestellten Startzeit; Pausen je Tag gezählt
function etaAtKm(km) {
  const kmh = routeKmh || +$('speed').value * 0.8;
  const n = routeStages.filter(e => e < km - 1e-6).length, day = nightsBefore(n);
  const from = n ? routeStages[n - 1] : 0;
  let base = Date.now();
  if (day) { const d = new Date(); d.setDate(d.getDate() + day); d.setHours(+$('dayStart').value, 0, 0, 0); base = d.getTime(); }
  // Fährzeit kommt dazu, ohne Pausen auszulösen
  const faehre = routeFaehren.reduce((t, f) => t + (f.km >= from && f.km < km ? f.s * Math.min(1, (km - f.km) / ((f.bisKm - f.km) || 1)) : 0), 0);
  return base + (withBreaks((fahrKm(km) - fahrKm(from)) / kmh * 3600) + faehre) * 1000;
}

// Spritkosten aus „Mein Roller“ (Verbrauch l/100 km, Preis €/l); ohne Verbrauch nichts.
// Zuschläge: Steigung als Hubarbeit m·g·h (180 kg Roller und Fahrer, 32 MJ/l Benzin, ~18 % Wirkungsgrad
// → gut 0,03 l je 100 hm bergauf, bergab zurück gibt es fast nichts); Mehrtagestour mit Gepäck: +20 kg und
// +5 % auf der Ebene (Roll- und Luftwiderstand der Taschen).
const FUEL_MASSE = 180, FUEL_GEPAECK = 20, FUEL_MJ_L = 32 * 0.18;
const fuelLiters = km => {
  const gepaeck = routeStages.length > 0, masse = FUEL_MASSE + (gepaeck ? FUEL_GEPAECK : 0);
  return km * roller.fuel / 100 * (gepaeck ? 1.05 : 1) + (tripClimb ? masse * 9.81 * tripClimb.up / 1e6 / FUEL_MJ_L : 0);
};
const fuelText = km => {
  if (!(+roller.fuel > 0)) return '';
  const l = fuelLiters(km);
  const eur = l * (+roller.price || 0);
  return ` · ⛽ ${l.toFixed(1).replace('.', ',')} l` + (eur ? ` ≈ ${eur.toFixed(2).replace('.', ',')} €` : '');
};
const climbText = () => tripClimb ? ` · ↑ ${tripClimb.up} m ↓ ${tripClimb.down} m` : '';
const stageTripText = s => (routeStages.length
  ? `${s.length.toFixed(1)} km · ${durText(tripTime(s))} Fahrzeit · ${tourDays()} Tage · an ${etaText(etaAtKm(routeKm.at(-1)))}`
  : tripText(s)) + fuelText(routeKm?.at(-1) ? s.length * fahrKm(routeKm.at(-1)) / routeKm.at(-1) : s.length) + climbText();

// Feste Übernachtungen (🌙 am Zwischenziel) als Routen-km. Über die Abschnittslängen statt locateOnRoute,
// weil bei Hin und zurück auf derselben Straße ein Punkt sonst auf der falschen Richtung landen kann.
function fixedNights(total) {
  const legs = currentTrip?.legs || [], located = waypoints.filter(w => w.latlng);
  const stops = located.filter((w, i) => !(w.shaping && i && i < located.length - 1));
  const legSum = legs.reduce((a, l) => a + (l.summary?.length || 0), 0);
  const scale = legSum ? total / legSum : 0;
  let km = 0;
  return stops.flatMap((w, k) => {
    if (k) km += (legs[k - 1]?.summary?.length || 0) * scale;
    if (!w.night || !k || k === stops.length - 1) return [];
    const at = legs.length === stops.length - 1 ? km : locateOnRoute(w.latlng.lat, w.latlng.lng).km;
    return [{ km: at, nights: w.night, name: w.text }];
  }).filter(f => f.km > 0.5 && f.km < total - 0.5);
}

function planStages() {
  routeStages = []; routeStageNights = [];
  const fixedAt = [];
  stageLayer.clearLayers();
  $('stageSummary').textContent = '';
  eleEtappenZeichnen();
  const hours = einfach() ? 0 : +$('dayMax').value, routeTotal = routeKm?.at(-1);
  if (!routeTotal) return;
  // Geteilt wird nach gefahrenen km: Fährstrecken zählen nicht, ein Etappenende fällt nie aufs Wasser
  const total = fahrKm(routeTotal);
  const fixed = fixedNights(routeTotal).map(f => ({ ...f, km: fahrKm(f.km) }));
  // Ohne Tagesgrenze (aus) zählen nur die festen Übernachtungen
  const perDay = hours && routeKmh ? routeKmh * hours : Infinity;
  if (!fixed.length && total <= perDay * 1.1) return;
  // Halte (keine Formpunkte) als bevorzugte Etappenenden
  const located = waypoints.filter(w => w.latlng);
  const stopKms = located.filter((w, i) => i && i < located.length - 1 && !w.shaping).map(w => fahrKm(locateOnRoute(w.latlng.lat, w.latlng.lng).km));
  // Jeder Abschnitt bis zur nächsten festen Übernachtung (bzw. zum Ziel) wird für sich in Tage geteilt,
  // die Rückfahrt zählt also ab dem Übernachtungsort neu
  let from = 0;
  for (const seg of [...fixed, { km: total }]) {
    while (seg.km - from > perDay * 1.1) {
      const target = from + perDay;
      const near = stopKms.filter(k => k > from + perDay * 0.5 && k < seg.km - perDay * 0.2 && Math.abs(k - target) <= perDay * 0.15)
        .sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
      from = near ?? target;
      routeStages.push(from); routeStageNights.push(1); fixedAt.push(null);
    }
    if (seg.nights) { from = seg.km; routeStages.push(from); routeStageNights.push(seg.nights); fixedAt.push(seg); }
  }
  // Tageslängen in gefahrenen km, Etappenenden zurück auf Routen-km (Anleger vor der Fähre)
  const ends = [...routeStages, total], dayNo = d => 1 + nightsBefore(d);
  routeStages = routeStages.map(beiFahrKm);
  $('stageSummary').textContent = '🌙 ' + ends.map((e, d) => `Tag ${dayNo(d)}: ${(e - (d ? ends[d - 1] : 0)).toFixed(0)} km` +
    (routeStageNights[d] > 1 ? ` · Tag ${dayNo(d) + 1}: Ruhetag` : '')).join(' · ');
  routeStages.forEach((km, d) => {
    const f = fixedAt[d], rest = routeStageNights[d] > 1 ? ' + Ruhetag' : '';
    L.marker(pointAtKm(km), { zIndexOffset: 500, icon: L.divIcon({ className: 'stage-pin' + (f ? ' fixed' : ''), html: `🌙${dayNo(d)}`, iconSize: [30, 18], iconAnchor: [15, 9] }) })
      .bindTooltip(`Ende Tag ${dayNo(d)}${rest} · km ${km.toFixed(0)}${f ? ` · fest: ${escapeHtml(f.name || 'Übernachtung')}` : ''} · an ca. ${etaText(etaAtKm(km))}`).addTo(stageLayer);
  });
  eleEtappenZeichnen();
  // Zeltplätze nur für die automatisch gesetzten Etappenenden, die festen sind ja schon gebucht
  loadStageCamps(routeStages.filter((km, d) => !fixedAt[d]));
}

// Zeltplätze um Punkte: zuerst Overpass, fällt es aus, Nominatim (Sonderbegriff „Campingplatz“ = tourism=camp_site),
// zuletzt Photon (komoot). Rückgabe { camps: [{ lat, lon, name }], source }
const PHOTON_URL = 'https://photon.komoot.io/api/';
async function findCamps(points, radiusM = 8000) {
  try {
    const local = await tileElements(points, radiusM, tags => tags.tourism === 'camp_site' ? radiusM : 0);
    if (local) return { source: 'eigene Daten', camps: local.elements.map(el => ({ lat: el.lat, lon: el.lon, name: el.tags.name, tags: el.tags })) };
  } catch {}
  try {
    const around = points.map(([la, lo]) => `nwr[tourism=camp_site](around:${radiusM},${la.toFixed(5)},${lo.toFixed(5)});`).join('');
    const data = await overpassFetch(`[out:json][timeout:30];(${around});out center tags;`);
    return { source: 'Overpass', camps: data.elements.map(el => ({ lat: el.lat ?? el.center?.lat, lon: el.lon ?? el.center?.lon, name: el.tags?.name, tags: el.tags })).filter(c => c.lat != null) };
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

async function loadStageCamps(kms) {
  const req = ++stageRequest;
  if (!kms.length) return;
  try {
    const punkte = kms.map(km => pointAtKm(km)), { camps, source } = await findCamps(punkte);
    if (req !== stageRequest) return;
    // Etappenenden ohne Platz in 8 km (Alpen, Venetien): dort bis 20 km weiter suchen
    const ohne = punkte.filter(p => !camps.some(c => L.latLng(c.lat, c.lon).distanceTo(p) <= 8000));
    let weit = 0;
    if (ohne.length) {
      const mehr = (await findCamps(ohne, 20000).catch(() => ({ camps: [] }))).camps.filter(c => !camps.some(d => d.lat === c.lat && d.lon === c.lon));
      if (req !== stageRequest) return;
      camps.push(...mehr); weit = mehr.length;
    }
    for (const c of camps) {
      const ll = L.latLng(c.lat, c.lon), name = c.name || 'Zeltplatz';
      L.marker(ll, { icon: L.divIcon({ className: 'poi-icon', html: '⛺', iconSize: [24, 24] }), title: name })
        .bindPopup(() => {
          const box = document.createElement('div');
          box.innerHTML = `<b>⛺ ${escapeHtml(name)}</b>` + (c.tags?.opening_hours ? `<br>🕒 ${escapeHtml(c.tags.opening_hours)}` : '') + (c.tags ? contactInfo({ tourism: 'camp_site', ...c.tags }) : '');
          box.append(menuBox([['via', 'Als Übernachtung (Zwischenziel)']], () =>
            changeWaypoints(() => { insertVia(ll); Object.assign(waypoints.find(w => w.latlng === ll), { text: name, night: 1 }); })));
          return box;
        }, { className: 'map-menu', minWidth: 170 }).addTo(stageLayer);
    }
    const n = camps.length, via = ['Overpass', 'eigene Daten'].includes(source) ? '' : ` (über ${source})`;
    $('stageSummary').textContent += (n ? ` · ⛺ ${n} ${n > 1 ? 'Zeltplätze' : 'Zeltplatz'} nahe den Etappenenden${weit ? ' (teils bis 20 km entfernt)' : ''}`
      : ' · ⛺ keine Zeltplätze im Umkreis von 20 km') + via;
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
