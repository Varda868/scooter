// --- Wetter entlang der Strecke: alle paar km die 15-min-Vorhersage zur geschätzten Durchfahrt (± Fenster) prüfen ---
const wxRouteLayer = L.layerGroup().addTo(map);
let wxRouteRequest = 0, wxQuelle = '';
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
  warnungenLaden(samples, req, win);
  try {
    const qs = new URLSearchParams({
      latitude: samples.map(p => p.ll[0].toFixed(3)).join(','), longitude: samples.map(p => p.ll[1].toFixed(3)).join(','),
      minutely_15: 'precipitation,snowfall,weather_code,temperature_2m,wind_gusts_10m',
      forecast_days: Math.min(7, tourDays() + 1), timeformat: 'unixtime', wind_speed_unit: 'kmh'
    });
    const res = await fetch(`${WEATHER_URL}?${qs}`);
    if (!res.ok || req !== wxRouteRequest) return;
    let data = await res.json();
    if (req !== wxRouteRequest) return;
    if (!Array.isArray(data)) data = [data];
    wxQuelle = data[0]?.quelle || '';  // Ersatzquelle des Servers (MET Norway, CC BY 4.0) nennen
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
      + (sections.length > 4 ? ` · +${sections.length - 4}` : '') + (wxQuelle ? ` · Daten: ${wxQuelle}` : '')
    : '';
}
$('wxWindow').addEventListener('change', loadRouteWeather);

// --- Amtliche Warnungen (DWD über Bright Sky, MeteoAlarm) über den eigenen Server; ohne Server nur die Ableitung oben ---
const WARN_FARBE = ['', '#e9c400', '#f08a00', '#d7263d', '#8e3fbf'], WARN_NAME = ['', 'gelb', 'orange', 'rot', 'extrem'];
const WARN_ICON = { gewitter: '⛈️', glaette: '🧊', schnee: '🌨️', wind: '💨', regen: '🌧️', nebel: '🌫️', hitze: '🌡️', kaelte: '🥶',
  feuer: '🔥', lawine: '🏔️', kueste: '🌊', sonst: '⚠️' };
// Für Roller zählen vor allem diese; Hitze, Nebel usw. nur als Hinweis (ab Orange)
const WARN_WICHTIG = ['gewitter', 'glaette', 'schnee', 'wind', 'regen'];
async function warnungenLaden(samples, req, win) {
  $('wxWarnSummary').textContent = '';
  if (!serverAn() || !serverKonfig.warnungen) return;
  const p = samples.map(s => s.ll[0].toFixed(2) + ',' + s.ll[1].toFixed(2)).join(';');
  let liste;
  try {
    const res = await direktFetch(`${API_URL}warnungen.php?p=${p}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok || req !== wxRouteRequest) return;
    liste = (await res.json()).warnungen || [];
  } catch { return; }
  if (req !== wxRouteRequest) return;
  // Nur, was zur geschätzten Durchfahrt (± Fenster) gilt
  const treffer = [];
  for (const w of liste) {
    if (!WARN_WICHTIG.includes(w.art) && w.stufe < 2) continue;
    const pk = w.punkte.map(i => samples[i]).filter(s => s && (!w.von || s.at >= w.von * 1000 - win * 60000) && (!w.bis || s.at <= w.bis * 1000 + win * 60000));
    if (pk.length) treffer.push({ w, von: pk[0], bis: pk.at(-1) });
  }
  for (const { w, von, bis } of treffer) {
    const zeit = [w.von && 'ab ' + etaText(w.von * 1000), w.bis && 'bis ' + etaText(w.bis * 1000)].filter(Boolean).join(' ');
    L.marker(von.ll, { keyboard: false, zIndexOffset: 500 + w.stufe, icon: L.divIcon({ className: 'wx-pin warn-pin',
      html: `<span style="border-color:${WARN_FARBE[w.stufe]};background:${WARN_FARBE[w.stufe]}33">${WARN_ICON[w.art] || '⚠️'}</span>`, iconSize: [30, 30] }) })
      .bindPopup(`<b>${escapeHtml(w.ereignis)}</b> (${WARN_NAME[w.stufe]})<br>${escapeHtml(w.titel)}<br><small>km ${von.km.toFixed(0)}${bis.km > von.km ? '–' + bis.km.toFixed(0) : ''}`
        + `${w.gebiet ? ' · ' + escapeHtml(w.gebiet) : ''} · ${zeit}</small>${w.text ? '<br><small>' + escapeHtml(w.text) + '</small>' : ''}`
        + `<br><small>Amtliche Warnung: ${w.quelle === 'DWD' ? 'Deutscher Wetterdienst (DWD)' : escapeHtml(w.quelle.replace('MeteoAlarm', 'MeteoAlarm/EUMETNET'))}</small>`)
      .addTo(wxRouteLayer);
  }
  if (!treffer.length) return;
  const roteste = Math.max(...treffer.map(t => t.w.stufe));
  $('wxWarnSummary').textContent = `${roteste >= 3 ? '🟥' : roteste === 2 ? '🟧' : '🟨'} Amtliche Warnung: `
    + treffer.slice(0, 3).map(({ w, von }) => `${warnTag(von.km)}${WARN_ICON[w.art] || '⚠️'} ${w.ereignis} ab km ${von.km.toFixed(0)}${w.gebiet ? ' (' + w.gebiet + ')' : ''}`).join(' · ')
    + (treffer.length > 3 ? ` · +${treffer.length - 3}` : '');
  routeWarnungen = treffer;
  document.dispatchEvent(new Event('warnungen'));
}
let routeWarnungen = [];
// Bei Mehrtagestour den Etappentag nennen
const warnTag = km => routeStages.length ? `Tag ${1 + nightsBefore(routeStages.filter(s => s < km).length)}: ` : '';

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
  if (globalThis.navPause?.('wetter', () => loadWeather(trip))) return;
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
  const days = tourDays();
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
          + (data[k].quelle ? ` (Daten: ${data[k].quelle})` : '')
      };
    });
    renderWaypoints();
  } catch {}
}
