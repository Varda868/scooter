// --- Tank und Reichweite: Tankinhalt und Reserve aus „Mein Roller“, „Vollgetankt“ setzt den Zähler zurück (gezählt
// werden die mit dem Navi gefahrenen km). Entlang der Route: wo die Reserve anfängt, wo der Tank leer wäre, und welche
// Tankstellen (bis 1 km neben der Strecke, zur Ankunftszeit offen) man ansteuern sollte. Preise spielen keine Rolle.
const TANK_M = 1000, TANK_ANSAGE_M = 1000;
const tank = { key: '', stations: [], stops: [], req: 0, layer: L.layerGroup().addTo(map) };

// Verbrauch je km auf der Route, mit Steigungs- und Gepäckzuschlag wie bei den Spritkosten
// (je gefahrenem km: Fährstrecken verbrauchen nichts)
const tankRate = () => +roller.fuel > 0 && routeKm?.length && fahrKm(routeKm.at(-1)) > 0 ? fuelLiters(fahrKm(routeKm.at(-1))) / fahrKm(routeKm.at(-1)) : 0;
// Seit dem letzten Volltanken gefahren: gespeicherte Fahrten danach plus die laufende Navi-Fahrt
function tankKmSeit() {
  if (!roller.voll) return null;
  const fahrten = exp.rides.filter(r => r.date && r.date > roller.voll), jetzt = nav.on && nav.t0 === roller.vollNav;
  // Während einer Navi-Fahrt vollgetankt: deren km vor dem Tanken abziehen (laufend oder schon gespeichert)
  const abzug = roller.vollAbzug && (jetzt || fahrten.length) ? roller.vollAbzug : 0;
  return Math.max(0, fahrten.reduce((s, r) => s + (r.km || 0), 0) + (nav.on ? nav.odo : 0) - abzug);
}
function tankStand() {
  if (!(+roller.tank > 0) || !(+roller.fuel > 0)) return null;
  const km = tankKmSeit();
  return { l: Math.max(0, +roller.tank - (km || 0) * roller.fuel / 100), km, geschaetzt: km == null };
}
const lText = l => l.toFixed(1).replace('.', ',');

// ---- Öffnungszeiten: einfache OSM-Regeln (24/7, Wochentage, Uhrzeiten, off). Unbekanntes → null
const OH_TAGE = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
function offenUm(tags, d) {
  if (tags.automated === 'yes') return true;
  const oh = tags.opening_hours?.trim();
  if (!oh) return null;
  if (oh === '24/7') return true;
  const wd = d.getDay(), min = d.getHours() * 60 + d.getMinutes();
  let offen = null, tagRegeln = 0;
  for (const regel of oh.split(';').map(s => s.trim()).filter(Boolean)) {
    if (/^(PH|SH)\b/.test(regel)) continue; // Feiertage/Ferien kennen wir nicht
    const m = regel.match(/^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?,?)+)?\s*(.*)$/);
    let gilt = !m[1];
    if (m[1]) tagRegeln++;
    for (const teil of (m[1] || '').split(',').filter(Boolean)) {
      const [a, b] = teil.split('-'), ia = OH_TAGE.indexOf(a), ib = b ? OH_TAGE.indexOf(b) : ia;
      for (let i = ia; ; i = (i + 1) % 7) { if (i === wd) gilt = true; if (i === ib) break; }
    }
    if (!gilt) continue;
    const zeit = m[2].replace(/,?\s*PH.*$/, '').trim();
    if (/^(off|closed)$/.test(zeit)) { offen = false; continue; }
    if (zeit === '24/7' || zeit === '00:00-24:00') { offen = true; continue; }
    const spannen = [...zeit.matchAll(/(\d\d?):(\d\d)\s*-\s*(\d\d?):(\d\d)/g)];
    if (!spannen.length) return null;
    offen = spannen.some(([, h1, m1, h2, m2]) => {
      const a = h1 * 60 + +m1, b = h2 * 60 + +m2;
      return b > a ? min >= a && min < b : min >= a || min < b;
    });
  }
  // Nur Regeln für andere Tage: an diesem Tag zu (OSM: nicht genannt = geschlossen)
  return offen ?? (tagRegeln ? false : null);
}

// ---- Bezahlen: kleine Zeichen am Tankstellensymbol (💳 Karte oder Automat, 💶 bar)
const tankKarte = t => t.automated === 'yes' || ['credit_cards', 'debit_cards', 'girocard', 'maestro', 'visa', 'mastercard'].some(k => t['payment:' + k] === 'yes');
const tankBar = t => ['cash', 'coins', 'notes'].some(k => t['payment:' + k] === 'yes');
const fuelBadges = t => (tankKarte(t) ? '💳' : '') + (tankBar(t) ? '💶' : '');
function fuelInfo(t) {
  const z = [t.automated === 'yes' ? '🤖 Automat' : t.self_service === 'yes' ? 'Selbstbedienung' : '',
    tankKarte(t) ? '💳 Karte' : '', tankBar(t) ? '💶 bar' : t['payment:cash'] === 'no' ? 'kein Bargeld' : ''].filter(Boolean);
  return z.length ? '<br>' + z.join(' · ') : '';
}

// ---- Tankstellen entlang der Route (eigene Kacheln, sonst Overpass), je Route einmal
function tankStations() {
  const key = `${routeCoords.length}:${routeKm.at(-1).toFixed(3)}:${routeCoords[0]}:${routeCoords.at(-1)}`;
  if (tank.key !== key) { tank.key = key; tank.stationsP = tankStationsLaden().catch(e => { tank.key = ''; throw e; }); }
  return tank.stationsP;
}
async function tankStationsLaden() {
  let els = null;
  try { els = (await tileElements(routeSamples(0.25), TANK_M, t => t.amenity === 'fuel' ? TANK_M : 0))?.elements; } catch {}
  if (!els) {
    const res = await Promise.all(routeChunks().map(ch => overpassFetch(`[out:json][timeout:60];nwr[amenity=fuel](around:${TANK_M},${
      simplify(ch, 100).map(([a, b]) => `${a.toFixed(5)},${b.toFixed(5)}`).join(',')});out center tags;`, () => {}, () => false).catch(() => null)));
    if (res.every(r => !r)) throw new Error('Tankstellen nicht geladen');
    els = res.flatMap(d => d?.elements || []);
  }
  const seen = new Set();
  tank.stations = els.map(el => ({ lat: el.lat ?? el.center?.lat, lon: el.lon ?? el.center?.lon, tags: el.tags || {}, id: el.type + el.id }))
    .filter(s => s.lat != null && !seen.has(s.id) && seen.add(s.id))
    .map(s => ({ ...s, ...locateOnRoute(s.lat, s.lon) })).filter(s => s.dist <= TANK_M).sort((a, b) => a.km - b.km);
  return tank.stations;
}

// ---- Planung: mit dem aktuellen Stand losfahren, immer die letzte offene Tankstelle vor der Reserve nehmen
async function tankPlan() {
  const req = ++tank.req;
  tank.layer.clearLayers(); tank.stops = [];
  $('tankInfo').textContent = '';
  const st = tankStand(), rate = tankRate();
  if (!routeCoords || !st || !rate) return;
  // Gerechnet in gefahrenen km (fahrKm), angezeigt und verglichen mit Tankstellen in Routen-km
  const total = routeKm.at(-1), reserve = Math.min(+roller.reserve || 0, +roller.tank * 0.9);
  const reserveKm = beiFahrKm((st.l - reserve) / rate), leerKm = beiFahrKm(st.l / rate);
  const start = `${st.geschaetzt ? 'Start mit vollem Tank angenommen' : `noch ≈ ${lText(st.l)} l`}`;
  if (leerKm >= total && reserveKm >= total) {
    $('tankInfo').textContent = `⛽ ${start} · reicht bis zum Ziel (am Ende ≈ ${lText(st.l - fahrKm(total) * rate)} l)`;
    return;
  }
  $('tankInfo').textContent = `⛽ ${start} · Tankstellen werden gesucht …`;
  let stations;
  try { stations = await tankStations(); } catch (e) { if (req === tank.req) $('tankInfo').textContent = `⛽ ${start} · Reserve ab km ${Math.max(0, reserveKm).toFixed(0)} · ⚠️ ${e.message}`; return; }
  if (req !== tank.req) return;
  const offen = s => offenUm(s.tags, new Date(etaAtKm(s.km)));
  const nutzbar = stations.filter(s => offen(s) !== false);
  let pos = 0, level = st.l, luecke = null;
  for (let n = 0; n < 30; n++) {
    const bisReserve = beiFahrKm(fahrKm(pos) + Math.max(0, level - reserve) / rate), bisLeer = beiFahrKm(fahrKm(pos) + level / rate);
    if (bisReserve >= total) break;
    let kandidaten = nutzbar.filter(s => s.km > pos + 0.3 && s.km <= bisReserve), inReserve = false;
    if (!kandidaten.length) { kandidaten = nutzbar.filter(s => s.km > pos + 0.3 && s.km <= bisLeer); inReserve = true; }
    if (!kandidaten.length) { if (bisLeer < total) luecke = { von: pos, leer: bisLeer }; break; }
    // Die letzte vor der Reserve, aber lieber eine direkt an der Strecke (≤150 m), wenn sie höchstens 15 km früher liegt
    const s = kandidaten.filter(x => x.dist <= 150 && x.km >= kandidaten.at(-1).km - 15).at(-1) || kandidaten.at(-1);
    tank.stops.push({ ...s, inReserve, ankunftL: level - (fahrKm(s.km) - fahrKm(pos)) * rate });
    level = +roller.tank; pos = s.km;
  }
  // Marken: Reserve und leer ohne Tanken, empfohlene Tankstopps
  const marke = (km, html, cls, title) => L.marker(pointAtKm(km), { zIndexOffset: 400, title,
    icon: L.divIcon({ className: 'stage-pin tank-pin ' + cls, html, iconSize: [46, 18], iconAnchor: [23, 9] }) }).addTo(tank.layer);
  if (!tank.stops.length || tank.stops[0].km > reserveKm) if (reserveKm < total && reserveKm > 0) marke(reserveKm, '⛽ Res.', 'reserve', 'Ab hier Reserve');
  if (luecke) marke(Math.min(total, luecke.leer), '⛽ leer', 'leer', 'Hier wäre der Tank leer');
  for (const s of tank.stops) {
    const name = s.tags.name || s.tags.brand || 'Tankstelle', o = offen(s), ll = L.latLng(s.lat, s.lon);
    const box = document.createElement('div');
    box.innerHTML = `<b>⛽ ${escapeHtml(name)}</b><br>Tankstopp bei km ${s.km.toFixed(1)}${s.dist > 150 ? ` · ${Math.round(s.dist)} m neben der Route` : ''}` +
      `<br>Ankunft ca. ${etaText(etaAtKm(s.km))} mit ≈ ${lText(Math.max(0, s.ankunftL))} l${s.inReserve ? ' (Reserve)' : ''}` +
      (s.tags.opening_hours ? `<br>🕒 ${escapeHtml(s.tags.opening_hours)}${o == null ? ' (nicht geprüft)' : ''}` : o ? '' : '<br>🕒 Öffnungszeit unbekannt') + fuelInfo(s.tags);
    box.insertAdjacentHTML('beforeend', '<br><button data-tank-voll class="secondary">⛽ Hier vollgetankt</button>');
    box.append(menuBox([['via', 'Als Zwischenziel']], () => changeWaypoints(() => { insertVia(ll); waypoints.find(w => w.latlng === ll).text = '⛽ ' + name; })));
    L.marker(ll, { zIndexOffset: 450, title: name, icon: L.divIcon({ className: 'poi-icon tank-stop', html: `⛽<span class="poi-badge">${fuelBadges(s.tags)}</span>`, iconSize: [28, 28] }) })
      .bindPopup(box, { minWidth: 200 }).addTo(tank.layer);
  }
  $('tankInfo').textContent = `⛽ ${start}` + (tank.stops.length ? ` · ${tank.stops.length === 1 ? 'Tankstopp' : tank.stops.length + ' Tankstopps'} bei km ${tank.stops.map(s => s.km.toFixed(0)).join(', ')}`
    : reserveKm < total ? ` · Reserve ab km ${Math.max(0, reserveKm).toFixed(0)}` : '') +
    (luecke ? ` · ⚠️ keine offene Tankstelle zwischen km ${luecke.von.toFixed(0)} und ${luecke.leer.toFixed(0)}, dort wäre der Tank leer` : '');
}

// ---- Navi: vor einem Tankstopp ansagen, wie weit die nächste Tankstelle danach ist
function tankNavi(km) {
  const s = tank.stops.find(x => x.km > km - 0.05);
  if (!s || s.angesagt) return;
  const m = (s.km - km) * 1000;
  if (m > TANK_ANSAGE_M) return;
  s.angesagt = true;
  const danach = tank.stations.find(x => x.km > s.km + 0.5 && offenUm(x.tags, new Date(etaAtKm(x.km))) !== false);
  const rest = (danach ? danach.km : routeKm.at(-1)) - s.km;
  const text = `In ${Math.max(100, Math.round(m / 100) * 100)} Metern tanken: ${s.tags.name || s.tags.brand || 'Tankstelle'}. ` +
    (danach ? `Danach die nächste Tankstelle erst in ${Math.round(rest)} Kilometern.` : 'Danach keine Tankstelle mehr bis zum Ziel.');
  $('navNote').textContent = '⛽ ' + text;
  say(text);
}

// ---- Anzeige im Reiter Roller und „Vollgetankt“
function tankZeigen() {
  const st = tankStand();
  $('tankFull').hidden = !(+roller.tank > 0);
  $('tankHint').textContent = !(+roller.tank > 0) ? 'Für Reichweite und Tankstopps Tankinhalt und Verbrauch eintragen.'
    : !st ? 'Für die Reichweite fehlt noch der Verbrauch.'
    : st.geschaetzt ? `Reichweite mit vollem Tank ≈ ${Math.round(+roller.tank / roller.fuel * 100)} km. Nach dem Tanken „Vollgetankt“ tippen.`
    : `Seit dem Tanken (${new Date(roller.voll).toLocaleDateString('de-DE')}) ${Math.round(st.km)} km · noch ≈ ${lText(st.l)} l · Reichweite ≈ ${Math.round(st.l / roller.fuel * 100)} km` +
      (+roller.reserve > 0 ? `, bis Reserve ≈ ${Math.max(0, Math.round((st.l - roller.reserve) / roller.fuel * 100))} km` : '');
}
function tankVoll() {
  roller.voll = new Date().toISOString();
  // Die laufende Navi-Fahrt zählt erst ab jetzt
  roller.vollAbzug = nav.on ? nav.odo : 0; roller.vollNav = nav.on ? nav.t0 : null;
  saveRoller(); tankZeigen();
  if (routeCoords) tankPlan();
}
$('tankFull').onclick = tankVoll;
// Tankstellen-Popup: „Hier vollgetankt“
map.on('popupopen', e => {
  const b = e.popup.getElement()?.querySelector('[data-tank-voll]');
  if (b) b.onclick = () => { tankVoll(); b.textContent = '✓ Vollgetankt'; b.disabled = true; };
});
tankZeigen();
