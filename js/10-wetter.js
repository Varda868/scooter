// --- Wetter entlang der Strecke: alle paar km die 15-min-Vorhersage zur geschätzten Durchfahrt (± Fenster) prüfen ---
const wxRouteLayer = L.layerGroup().addTo(map);
let wxRouteRequest = 0;
const SHELTER_HAZARDS = ['storm', 'rain', 'snow'];
function setWxShelter(on) {
  if (on === wxShelter) return;
  wxShelter = on;
  loadPois();
}
// Reihenfolge = Vorrang, wenn an einem Punkt mehreres zutrifft
const WX_HAZARDS = [
  { id: 'storm', color: '#c0392b', icon: '⛈️', name: 'Gewitter', test: v => [95, 96, 99].includes(v.code) },
  { id: 'ice', color: '#1f6fb2', icon: '🧊', name: 'Glättegefahr', test: v => [56, 57, 66, 67].includes(v.code) || (v.temp <= 1 && v.precip > 0) || v.temp <= 0,
    detail: v => `${Math.round(v.temp)} °C` },
  { id: 'snow', color: '#5fa8d3', icon: '🌨️', name: 'Schnee', test: v => v.snow > 0, detail: v => `${v.snow.toFixed(1)} cm/15 min` },
  { id: 'wind', color: '#7a7a7a', icon: '💨', name: 'Sturmböen', test: v => v.gust >= 55, detail: v => `Böen ${Math.round(v.gust)} km/h` },
  { id: 'rain', color: '#2e86e4', icon: '🌧️', name: 'Regen', test: v => v.precip >= 0.3, detail: v => `${v.precip.toFixed(1)} mm/15 min` }
];

async function loadRouteWeather() {
  const req = ++wxRouteRequest, win = +$('wxWindow').value;
  wxRouteLayer.clearLayers();
  $('wxRouteSummary').textContent = '';
  if (!routeCoords || !win) return setWxShelter(false);
  const total = routeKm[routeKm.length - 1], step = Math.max(3, total / 40), kmh = routeKmh || +$('speed').value * 0.8;
  const start = Date.now(), samples = [];
  for (let km = 0; km <= total + 0.01; km += step) {
    const k = Math.min(km, total);
    samples.push({ km: k, ll: pointAtKm(k), at: etaAtKm(k) });
  }
  try {
    const qs = new URLSearchParams({
      latitude: samples.map(p => p.ll[0].toFixed(3)).join(','), longitude: samples.map(p => p.ll[1].toFixed(3)).join(','),
      minutely_15: 'precipitation,snowfall,weather_code,temperature_2m,wind_gusts_10m',
      forecast_days: Math.min(7, routeStages.length + 2), timeformat: 'unixtime', wind_speed_unit: 'kmh'
    });
    const res = await fetch(`${WEATHER_URL}?${qs}`);
    if (!res.ok || req !== wxRouteRequest) return;
    let data = await res.json();
    if (req !== wxRouteRequest) return;
    if (!Array.isArray(data)) data = [data];
    // Je Punkt das schlimmste Ereignis im Fenster um die Durchfahrt
    samples.forEach((p, k) => {
      const m = data[k]?.minutely_15;
      if (!m) return;
      for (const hz of WX_HAZARDS) {
        const hits = m.time.map((ts, j) => ({ ts: ts * 1000, code: m.weather_code?.[j], temp: m.temperature_2m?.[j] ?? 99,
          precip: m.precipitation?.[j] ?? 0, snow: m.snowfall?.[j] ?? 0, gust: m.wind_gusts_10m?.[j] ?? 0 }))
          .filter(v => Math.abs(v.ts - p.at) <= win * 60000 && hz.test(v));
        if (hits.length) { p.hazard = hz; p.hit = hits[0]; break; }
      }
    });
  } catch { return; }
  // Gleiche Gefahr an aufeinanderfolgenden Punkten zu einem Abschnitt zusammenfassen, ein Symbol am Anfang
  const sections = [];
  samples.forEach((p, i) => {
    if (!p.hazard) return;
    const last = sections.at(-1);
    if (last && last.hazard === p.hazard && last.end === i - 1) { last.to = p.km; last.end = i; }
    else sections.push({ hazard: p.hazard, from: p.km, to: p.km, end: i, points: [p] });
  });
  for (const sec of sections) {
    const p0 = sec.points[0], hz = sec.hazard;
    const details = hz.detail ? ' · ' + hz.detail(p0.hit) : '';
    L.marker(p0.ll, { keyboard: false, icon: L.divIcon({ className: 'wx-pin', html: `<span style="border-color:${hz.color}">${hz.icon}</span>`, iconSize: [28, 28] }) })
      .bindTooltip(`${hz.name} km ${sec.from.toFixed(0)}${sec.to > sec.from ? `–${sec.to.toFixed(0)}` : ''} · ca. ${etaText(p0.at)}${details}`)
      .addTo(wxRouteLayer);
  }
  setWxShelter(sections.some(sec => SHELTER_HAZARDS.includes(sec.hazard.id)));
  $('wxRouteSummary').textContent = sections.length
    ? '⚠️ Wetter unterwegs: ' + sections.slice(0, 4).map(s => `${s.hazard.icon} ${s.hazard.name} ab km ${s.from.toFixed(0)} (ca. ${etaText(s.points[0].at)})`).join(' · ')
      + (sections.length > 4 ? ` · +${sections.length - 4}` : '')
    : '';
}
$('wxWindow').addEventListener('change', loadRouteWeather);

// --- Wetter je Halt zur voraussichtlichen Ankunft (Open-Meteo, stündlich, bis 3 Tage) ---
const WMO = [
  [[0], '☀️', 'klar'], [[1], '🌤️', 'überwiegend klar'], [[2], '⛅', 'teils bewölkt'], [[3], '☁️', 'bedeckt'],
  [[45, 48], '🌫️', 'Nebel'], [[51, 53, 55, 56, 57], '🌦️', 'Nieselregen'], [[61, 63, 65], '🌧️', 'Regen'],
  [[66, 67], '🧊', 'gefrierender Regen'], [[71, 73, 75, 77, 85, 86], '🌨️', 'Schnee'], [[80, 81, 82], '🌦️', 'Schauer'],
  [[95, 96, 99], '⛈️', 'Gewitter']
];
const wmo = code => WMO.find(([codes]) => codes.includes(code)) || [[], '❔', 'unbekannt'];
let weatherRequest = 0;

async function loadWeather(trip) {
  const req = ++weatherRequest;
  // Halte = Wegpunkte, die Valhalla als "break" bekommt; Ankunft = Summe der Abschnittszeiten
  const located = waypoints.filter(w => w.latlng);
  const stops = located.filter((w, i) => !(w.shaping && i && i < located.length - 1));
  waypoints.forEach(w => { delete w.wx; });
  let t = Date.now();
  const now = t;
  stops.forEach((w, k) => {
    if (k) t += (trip.legs[k - 1]?.summary ? tripTime(trip.legs[k - 1].summary) : 0) * 1000;
    // w.dur = reine Fahrzeit; bei Mehrtagestour liegt die Ankunft am jeweiligen Etappentag
    w.dur = (t - now) / 1000;
    w.eta = !routeStages.length ? now + withBreaks(w.dur) * 1000 : etaAtKm(k === stops.length - 1 ? routeKm.at(-1) : locateOnRoute(w.latlng.lat, w.latlng.lng).km);
  });
  const days = routeStages.length + 1;
  // Fahrzeit je Halt sofort zeigen, das Wetter kommt danach
  renderWaypoints();
  try {
    const qs = new URLSearchParams({
      latitude: stops.map(w => w.latlng.lat.toFixed(3)).join(','),
      longitude: stops.map(w => w.latlng.lng.toFixed(3)).join(','),
      hourly: 'weather_code,temperature_2m,precipitation_probability,wind_speed_10m',
      forecast_days: Math.min(16, days + 2), timeformat: 'unixtime', wind_speed_unit: 'kmh'
    });
    const res = await fetch(`${WEATHER_URL}?${qs}`);
    if (!res.ok) return;
    let data = await res.json();
    if (req !== weatherRequest) return;
    if (!Array.isArray(data)) data = [data];
    stops.forEach((w, k) => {
      const h = data[k]?.hourly;
      if (!h) return;
      // nächste volle Stunde zur Ankunft; außerhalb des Vorhersagezeitraums kein Symbol
      const idx = h.time.reduce((best, ts, j) => Math.abs(ts * 1000 - w.eta) < Math.abs(h.time[best] * 1000 - w.eta) ? j : best, 0);
      if (Math.abs(h.time[idx] * 1000 - w.eta) > 90 * 60000) return;
      const [, icon, text] = wmo(h.weather_code[idx]);
      w.wx = {
        icon, temp: Math.round(h.temperature_2m[idx]),
        title: `${etaText(w.eta)}: ${text}, ${Math.round(h.temperature_2m[idx])} °C, Regen ${h.precipitation_probability[idx] ?? '–'} %, Wind ${Math.round(h.wind_speed_10m[idx])} km/h`
      };
    });
    renderWaypoints();
  } catch {}
}
