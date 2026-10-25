// --- Navigation: echte GPS-Position statt Zeitraffer, Bildschirm bleibt an, Sprachansage, Neuberechnung bei Abweichung ---
const OFF_ROUTE_M = 40, REROUTE_PAUSE_MS = 20000, ARRIVE_M = 80, ARRIVE_MS = 90000;
const nav = { on: false, watch: null, km: 0, off: 0, lastReroute: 0, lock: null, voice: store.get('navVoice', true), said: new Set(), marker: null, done: false };
map.getContainer().appendChild($('nav'));
map.getContainer().appendChild($('arrive'));
L.DomEvent.disableClickPropagation($('nav'));
$('navVoice').classList.toggle('off', !nav.voice);

async function keepScreenOn() {
  if (!nav.on) return;
  try { nav.lock = await navigator.wakeLock.request('screen'); $('navNote').textContent = ''; }
  catch { $('navNote').textContent = 'Bildschirm-an wird von diesem Browser nicht unterstützt (braucht HTTPS). Displayzeit in den Handy-Einstellungen hochsetzen.'; }
}
// Die Sperre fällt beim Wechsel in eine andere App weg; beim Zurückkommen neu anfordern
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && nav.on) keepScreenOn(); });

function say(text) {
  if (!nav.voice || !window.speechSynthesis) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'de-DE';
    speechSynthesis.speak(u);
  } catch {}
}

// Spuren vor der Kreuzung (Valhalla turn_lanes): hell = beste Spur, halb = geht auch, grau = falsch
const LANE_PFEILE = [[16, '↖'], [8, '←'], [4, '↙'], [2, '↑'], [32, '↗'], [64, '→'], [128, '↘'], [256, '↶'], [512, '⇠'], [1024, '⇢']];
const laneHtml = lanes => (lanes || []).map(l => `<span class="${l.active ? 'on' : l.valid ? 'ok' : ''}">${LANE_PFEILE.filter(([b]) => l.directions & b).map(([, c]) => c).join('') || '↑'}</span>`).join('');
const LANE_M = 600;

const distText = m => m < 100 ? `${Math.max(0, Math.round(m / 10) * 10)} m` : m < 1000 ? `${Math.round(m / 50) * 50} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`;

// Position auf der Route: zuerst kurz vor bis ein paar km nach dem letzten Stand suchen, damit Touren mit Start = Ziel
// und Kreuzungen der eigenen Strecke nicht auf den falschen Abschnitt springen
function navLocate(lat, lon) {
  const i0 = Math.max(0, routeKm.findIndex(k => k >= nav.km - 0.3) - 1);
  let i1 = routeKm.findIndex(k => k > nav.km + 3);
  if (i1 < 0) i1 = routeKm.length - 1;
  const near = locateOnRoute(lat, lon, routeCoords.slice(i0, i1 + 1), routeKm.slice(i0, i1 + 1));
  return near.dist <= OFF_ROUTE_M ? near : locateOnRoute(lat, lon);
}

function startNav() {
  if (!routeCoords) return;
  if (!navigator.geolocation) { $('summary').textContent = '⚠️ Standort wird von diesem Browser nicht unterstützt. 💡 Anderen Browser verwenden.'; return; }
  stopSim();
  if (me.follow) $('centerBtn').click();
  Object.assign(nav, { on: true, km: 0, off: 0, said: new Set(), done: false, zoom: 17, manual: null, peek: null, overview: false, lastPos: null,
    t0: Date.now(), odo: 0, moveSec: 0, prevFix: null, home: { ...waypoints.find(w => w.latlng) } });
  clearTimeout(nav.arriveTimer); nav.arriveTimer = null;
  $('arrive').hidden = true;
  $('nav').hidden = false;
  $('navZoom').hidden = false; $('navZoomAuto').hidden = true;
  $('navArrow').textContent = '📡'; $('navDist').textContent = 'GPS …'; $('navText').textContent = 'Warte auf Standort';
  $('navSpeed').textContent = ''; $('navRest').textContent = ''; $('navLanes').innerHTML = '';
  setFull(true);
  keepScreenOn();
  nav.marker = L.marker(routeCoords[0], { interactive: false, zIndexOffset: 1000,
    icon: L.divIcon({ className: '', html: '<div class="nav-dot">➤</div>', iconSize: [30, 30], iconAnchor: [15, 15] }) });
  nav.akkuAuto = false; nav.fixAt = null; nav.karteBis = 0;
  document.body.classList.toggle('nav-pfeil', nav.pfeil);
  $('navPfeil').classList.toggle('active', nav.pfeil);
  if (nav.pfeil) navPfeilSetzen(true);
  nav.watch = navigator.geolocation.watchPosition(navFix, navGpsFehler, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  navAkku();
}
function navGpsFehler(err) {
  if (nav.peek != null) return; // Vorschau nicht überschreiben; der nächste Fehler oder Fix zeigt den Stand
  $('navArrow').textContent = '⚠️'; $('navDist').textContent = 'Kein GPS';
  $('navText').textContent = err.code === 1 ? 'Standortzugriff erlaubt? 💡 In den Browser-Einstellungen für diese Seite freigeben.' : err.message;
}

// keepRec: die Ankunftskarte entscheidet, ob die mitgeschriebene Fahrt gespeichert wird
function stopNav(keepRec = false) {
  if (!nav.on) return;
  nav.on = false;
  navPeekEnd(); navOverviewEnd(false);
  clearTimeout(nav.arriveTimer); nav.arriveTimer = null;
  navigator.geolocation?.clearWatch(nav.watch); nav.watch = null;
  clearTimeout(nav.sparTimer); clearInterval(nav.schaetzTimer); clearTimeout(nav.karteTimer); nav.sparTimer = nav.schaetzTimer = null;
  document.body.classList.remove('nav-pfeil');
  if (nav.voxVorher) { nav.voxVorher = false; talkPrefs.mode = 'vox'; talkVoxEinstellen(); talkZeigen(); }
  { const warten = [...nav.pausiert.values()]; nav.pausiert.clear(); warten.forEach(fn => fn()); }
  nav.lock?.release().catch(() => {}); nav.lock = null;
  window.speechSynthesis?.cancel();
  nav.marker?.remove(); nav.marker = null;
  if (keepRec !== true) expSaveRecording();
  $('nav').hidden = true;
  $('navZoom').hidden = true;
  setFull(false);
}

function navFix(pos) {
  if (!nav.on || !routeCoords) return;
  // Geschätzte Fixes (Pfeil-Modus zwischen zwei GPS-Abfragen) zählen nicht für Standort-Teilen, Fahrtenbuch und km-Zähler
  const echt = !pos.geschaetzt;
  if (echt) { nav.lastPos = pos; standortFix(pos); }
  const { latitude: lat, longitude: lon, accuracy, speed, heading } = pos.coords;
  const ll = L.latLng(lat, lon), total = routeKm.at(-1);
  const kmh = speed != null && speed >= 0 ? speed * 3.6 : null;
  nav.marker.setLatLng(ll).addTo(map);
  if (echt && (accuracy || 0) < 50) { expRecord(lat, lon); navOdo(ll, pos.timestamp); }
  const loc = navLocate(lat, lon);

  // Abweichung: mehrere Fixes nacheinander deutlich neben der Route (bei guter Genauigkeit) → ab hier neu rechnen
  if (loc.dist > OFF_ROUTE_M + Math.min(accuracy || 0, 30)) nav.off++; else nav.off = 0;
  if (nav.off >= 3 && Date.now() - nav.lastReroute > REROUTE_PAUSE_MS && !nav.done) {
    nav.lastReroute = Date.now(); nav.off = 0;
    $('navNote').textContent = 'Neu berechnen …';
    say('Route wird neu berechnet');
    const passedKm = nav.km;
    changeWaypoints(() => {
      const located = waypoints.filter(w => w.latlng);
      // Bereits passierte Zwischenziele fallen weg, Start = aktuelle Position
      const ahead = located.slice(1, -1).filter(w => locateOnRoute(w.latlng.lat, w.latlng.lng).km > passedKm + 0.05);
      waypoints = [{ latlng: ll, text: 'Mein Standort' }, ...ahead, located.at(-1)];
    });
    nav.km = 0; nav.said = new Set();
    return;
  }
  if (loc.dist <= OFF_ROUTE_M) nav.km = Math.max(nav.km - 0.05, loc.km);
  if (echt) nav.fixAt = { km: nav.km, t: Date.now(), v: speed != null && speed >= 0 ? speed : null };

  const dot = nav.marker.getElement()?.firstChild;
  const dir = heading != null && !isNaN(heading) && kmh > 3 ? heading : bearing(L.latLng(pointAtKm(nav.km)), L.latLng(pointAtKm(Math.min(total, nav.km + 0.03))));
  if (dot) dot.style.transform = `rotate(${dir - 90}deg)`;

  const next = routeManeuvers.find(m => m.km > nav.km + 0.01);
  const restM = (total - nav.km) * 1000;
  if (restM < 30 && !nav.done) { nav.done = true; say('Sie haben Ihr Ziel erreicht'); }
  navArriveWatch(ll);
  tankNavi(nav.km);
  if (nav.overview) { $('navSpeed').textContent = kmh != null ? `${Math.round(kmh)} km/h` : ''; return; }
  if (nav.peek != null) {
    // Vorschau läuft: Anzeige und Karte gehören ihr; ist das angezeigte Manöver schon erreicht, zurück zur Fahrt
    if (nav.peekKm <= nav.km + 0.01) navPeekEnd(); else { $('navSpeed').textContent = kmh != null ? `${Math.round(kmh)} km/h` : ''; return; }
  }
  if (!next || restM < 30) {
    $('navArrow').textContent = '🏁'; $('navDist').textContent = restM < 30 ? 'Ziel erreicht' : distText(restM);
    $('navText').textContent = routeManeuvers.at(-1)?.text || 'Ziel';
    $('navLanes').innerHTML = '';
  } else {
    const m = (next.km - nav.km) * 1000;
    $('navArrow').innerHTML = turnIcon(next);
    $('navDist').textContent = (echt ? '' : '≈ ') + distText(m);
    $('navText').textContent = next.text;
    $('navLanes').innerHTML = m < LANE_M ? laneHtml(next.lanes) : '';
    // Ansage je Manöver einmal pro Stufe; die weite Stufe hängt vom Tempo ab
    const far = (kmh || 30) > 35 ? 400 : 250;
    const key = `${next.km}`;
    if (m < 40 && !nav.said.has(key + 'now')) { nav.said.add(key + 'now'); nav.said.add(key + 'far'); say(next.verbal || next.text); }
    else if (m < far && !nav.said.has(key + 'far')) { nav.said.add(key + 'far'); say(`In ${Math.round(m / 50) * 50} Metern: ${next.verbal || next.text}`); }
  }
  $('navSpeed').textContent = kmh != null ? `${Math.round(kmh)} km/h` : '';
  // Mehrtagestour: Ziel des heutigen Tages ist das nächste Etappenende
  const stageEnd = routeStages.find(e => e > nav.km + 0.05), goal = stageEnd ?? total;
  const restSec = (goal - nav.km) / (routeKmh || 35) * 3600;
  $('navRest').innerHTML = `${stageEnd != null ? `🌙 Tag ${1 + nightsBefore(routeStages.indexOf(stageEnd))}: ` : ''}noch ${distText((goal - nav.km) * 1000)} · <b>${durText(restSec)}</b> · an ${etaText(Date.now() + withBreaks(restSec) * 1000)}`;
  if ($('navNote').textContent === 'Neu berechnen …') $('navNote').textContent = '';
  // Zoom nach Tempo mit Hysterese, damit er um 35 km/h nicht hin- und herspringt
  if (kmh > 40) nav.zoom = 16; else if (kmh != null && kmh < 30) nav.zoom = 17;
  pfeilGps(next ? (next.km - nav.km) * 1000 : restM);
  if (navOhneKarte()) return; // Pfeil-Modus: Karte bleibt stehen, keine Kacheln
  map.setView(ll, nav.manual ?? nav.zoom, { animate: true });
}

// --- Pfeil-Modus: schwarzer Bildschirm mit großem Pfeil, ohne Karte. Spart Display, Kacheln und GPS.
// GPS nach Abstand: weiter als PFEIL_WEIT_M bis zum nächsten Manöver nur alle PFEIL_TAKT_MS ein Fix, dazwischen wird
// mit dem letzten Tempo entlang der Route weitergerechnet; näher als PFEIL_NAH_M oder neben der Route wieder durchgehend.
// Wetter, Verkehr, POIs und Geocaches warten, Talk nur per Sprechtaste. Ein Tipp zeigt die Karte für PFEIL_KARTE_MS.
const PFEIL_WEIT_M = 1000, PFEIL_NAH_M = 500, PFEIL_TAKT_MS = 12000, PFEIL_KARTE_MS = 20000, PFEIL_AKKU = 0.2;
nav.pfeil = store.get('navPfeil', false);
nav.pausiert = new Map();
const navOhneKarte = () => nav.on && nav.pfeil && !(Date.now() < nav.karteBis);
// Nebendienste fragen hier, ob sie warten sollen; was wartet, läuft beim Verlassen des Pfeil-Modus nach
function navPause(key, fn) {
  if (!(nav.on && nav.pfeil)) return false;
  nav.pausiert.set(key, fn);
  return true;
}
function pfeilWatch() {
  if (nav.watch != null || !nav.on) return;
  clearTimeout(nav.sparTimer); clearInterval(nav.schaetzTimer); nav.sparTimer = nav.schaetzTimer = null;
  nav.watch = navigator.geolocation.watchPosition(navFix, navGpsFehler, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
}
function pfeilGps(m) {
  if (!nav.on) return;
  if (!nav.pfeil || nav.done || nav.off || m < PFEIL_NAH_M) { pfeilWatch(); return; }
  if (m < PFEIL_WEIT_M || nav.watch == null) return; // Zwischenbereich: bleibt, wie es ist
  navigator.geolocation.clearWatch(nav.watch); nav.watch = null;
  const einzeln = () => navigator.geolocation.getCurrentPosition(p => { if (nav.on && nav.watch == null) { navFix(p); if (nav.watch == null) nav.sparTimer = setTimeout(einzeln, PFEIL_TAKT_MS); } },
    () => { if (nav.on && nav.watch == null) nav.sparTimer = setTimeout(einzeln, PFEIL_TAKT_MS); }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  nav.sparTimer = setTimeout(einzeln, PFEIL_TAKT_MS);
  // Zwischen den Fixes: Position entlang der Route weiterrechnen (höchstens 20 s ab dem letzten echten Fix)
  nav.schaetzTimer = setInterval(() => {
    const f = nav.fixAt;
    if (!f || f.v == null || f.v < 1 || nav.peek != null || nav.overview) return;
    const km = Math.min(routeKm.at(-1), f.km + f.v * Math.min(20, (Date.now() - f.t) / 1000) / 1000);
    if (km <= nav.km) return;
    const [la, lo] = pointAtKm(km);
    navFix({ geschaetzt: true, timestamp: Date.now(), coords: { latitude: la, longitude: lo, accuracy: 20, speed: f.v, heading: null } });
  }, 1000);
}
function navPfeilSetzen(an) {
  nav.pfeil = an; store.set('navPfeil', an);
  document.body.classList.toggle('nav-pfeil', an && nav.on);
  $('navPfeil').classList.toggle('active', an);
  nav.karteBis = 0;
  // Talk: VOX hält das Mikrofon offen, im Pfeil-Modus nur Sprechtaste
  if (an && nav.on && talkPrefs.mode === 'vox') { nav.voxVorher = true; talkPrefs.mode = 'ptt'; talkLoslassen(); talkVoxEinstellen(); talk.mic?.schliessen?.(); talkZeigen(); }
  if (!an && nav.voxVorher) { nav.voxVorher = false; talkPrefs.mode = 'vox'; talkVoxEinstellen(); talkZeigen(); }
  if (!an) { pfeilWatch(); const warten = [...nav.pausiert.values()]; nav.pausiert.clear(); warten.forEach(fn => fn()); }
  if (nav.lastPos) navFix(nav.lastPos);
}
$('navPfeil').onclick = e => { e.stopPropagation(); navPfeilSetzen(!nav.pfeil); };
// Tipp auf den schwarzen Bildschirm: Karte für 20 s
$('nav').addEventListener('click', e => {
  if (!nav.pfeil || e.target.closest('button')) return;
  e.stopImmediatePropagation();
  nav.karteBis = Date.now() + PFEIL_KARTE_MS;
  document.body.classList.remove('nav-pfeil');
  clearTimeout(nav.karteTimer);
  nav.karteTimer = setTimeout(() => { nav.karteBis = 0; if (nav.on && nav.pfeil) document.body.classList.add('nav-pfeil'); }, PFEIL_KARTE_MS);
  if (nav.lastPos) navFix(nav.lastPos);
}, true);
// Akku unter 20 % und nicht am Laden: einmal je Fahrt von selbst in den Pfeil-Modus
function navAkku() {
  navigator.getBattery?.().then(b => {
    const pruefen = () => {
      if (!nav.on || nav.pfeil || nav.akkuAuto || b.charging || b.level > PFEIL_AKKU) return;
      nav.akkuAuto = true; navPfeilSetzen(true); say('Akku unter 20 Prozent. Pfeilmodus an.');
    };
    b.onlevelchange = b.onchargingchange = pruefen; pruefen();
  }).catch(() => {});
}

// Tipp auf die Abbiegeanzeige: nächste Manöver der Reihe nach ansehen, die Karte springt jeweils hin.
// Nach 10 s ohne Tipp (oder nach dem letzten Manöver) geht es zurück zur Fahrtansicht.
const PEEK_MS = 10000;
function navPeek() {
  if (!nav.on || !routeManeuvers.length) return;
  const ahead = routeManeuvers.filter(m => m.km > nav.km + 0.01);
  const i = nav.peek == null ? 0 : nav.peek + 1;
  if (i >= ahead.length) { navPeekEnd(); return; }
  const m = ahead[i];
  nav.peek = i; nav.peekKm = m.km;
  $('nav').classList.add('peek');
  $('navArrow').innerHTML = turnIcon(m, i === ahead.length - 1 ? '🏁' : '↑');
  $('navDist').textContent = `${i + 1}/${ahead.length} · ${distText((m.km - nav.km) * 1000)}`;
  $('navText').textContent = m.text;
  $('navLanes').innerHTML = laneHtml(m.lanes);
  $('navNote').textContent = 'Vorschau · Tippen: nächstes Manöver';
  const at = pointAtKm(m.km);
  (nav.peekMark ||= L.circleMarker(at, { radius: 14, color: '#1d3557', weight: 4, fillColor: '#fff', fillOpacity: .6, interactive: false })).setLatLng(at).addTo(map);
  map.setView(at, Math.max(nav.manual ?? nav.zoom, 17), { animate: true });
  clearTimeout(nav.peekTimer);
  nav.peekTimer = setTimeout(navPeekEnd, PEEK_MS);
}
function navPeekEnd() {
  clearTimeout(nav.peekTimer);
  if (nav.peek == null) return;
  nav.peek = null;
  nav.peekMark?.remove();
  $('nav').classList.remove('peek');
  $('navNote').textContent = '';
  if (nav.lastPos) navFix(nav.lastPos);
}
document.querySelector('#nav .nav-turn').onclick = () => { navOverviewEnd(false); navPeek(); };

// Knopf „ganze Strecke“ im Navi: Übersicht für PEEK_MS, danach (oder beim zweiten Tipp) zurück zur Fahrt
function navOverview() {
  if (nav.overview) { navOverviewEnd(); return; }
  navPeekEnd();
  nav.overview = true;
  $('fitBtn').classList.add('active');
  $('navNote').textContent = 'Übersicht · ⤢ tippen: zurück';
  fitRoute();
  clearTimeout(nav.overviewTimer);
  nav.overviewTimer = setTimeout(navOverviewEnd, PEEK_MS);
}
function navOverviewEnd(refresh = true) {
  clearTimeout(nav.overviewTimer);
  if (!nav.overview) return;
  nav.overview = false;
  $('fitBtn').classList.remove('active');
  $('navNote').textContent = '';
  if (refresh && nav.lastPos) navFix(nav.lastPos);
}

// Handzoom im Navi: große Knöpfe und Tasten einer Bluetooth-Lenkerfernbedienung. Lautstärketasten erreichen
// Webseiten auf Android/iOS normalerweise nicht; kommen sie doch an (manche Fernbedienungen), zählen sie mit.
// Die Stufe bleibt, bis "Auto" getippt wird.
function navZoom(step) {
  nav.manual = step ? Math.max(12, Math.min(19, Math.round(nav.manual ?? map.getZoom()) + step)) : null;
  // Läuft noch eine Zoom-Animation vom letzten GPS-Fix, würde sie den Handzoom am Ende überschreiben
  const apply = () => map.setZoom(nav.manual ?? nav.zoom, { animate: false });
  if (map._animatingZoom) map.once('zoomend', apply); else apply();
  $('navZoomAuto').hidden = nav.manual == null;
}
map.getContainer().appendChild($('navZoom'));
L.DomEvent.disableClickPropagation($('navZoom'));
$('navZoom').onclick = e => { const z = e.target.closest('button')?.dataset.z; if (z != null) navZoom(+z); };
const NAV_KEYS = { '+': 1, '=': 1, ArrowUp: 1, PageUp: 1, AudioVolumeUp: 1, VolumeUp: 1,
  '-': -1, ArrowDown: -1, PageDown: -1, AudioVolumeDown: -1, VolumeDown: -1 };
document.addEventListener('keydown', e => {
  if (!nav.on || !(e.key in NAV_KEYS) || e.target.closest?.('input, textarea, select')) return;
  e.preventDefault();
  navZoom(NAV_KEYS[e.key]);
});

$('navStart').onclick = startNav;
// ✕ nach dem Ziel zeigt ebenfalls die Ankunftskarte
$('navStop').onclick = () => nav.done ? navArrive() : stopNav();

// --- Ankunft: Gefahrene km und Fahrzeit mitzählen; nach ARRIVE_MS am Ziel endet das Navi von selbst ---
function navOdo(ll, t) {
  const p = nav.prevFix;
  if (!p) { nav.prevFix = { ll, t }; return; }
  const d = map.distance(p.ll, ll), dt = (t - p.t) / 1000;
  if (d < 10) return; // Stehen und GPS-Zittern zählen nicht
  nav.odo += d / 1000;
  if (dt > 0 && dt < 120 && d / dt > 1.5) nav.moveSec += dt;
  nav.prevFix = { ll, t };
}
function navArriveWatch(ll) {
  const near = nav.done && ll.distanceTo(L.latLng(routeCoords.at(-1))) < ARRIVE_M;
  if (near && !nav.arriveTimer) {
    nav.arriveTimer = setTimeout(navArrive, ARRIVE_MS);
    $('navNote').textContent = 'Angekommen · Navi endet gleich von selbst';
  } else if (!near && nav.arriveTimer) {
    clearTimeout(nav.arriveTimer); nav.arriveTimer = null;
    $('navNote').textContent = '';
  }
}
let arrival = null;
function navArrive() {
  if (!nav.on) return;
  const here = nav.lastPos ? L.latLng(nav.lastPos.coords.latitude, nav.lastPos.coords.longitude) : L.latLng(routeCoords.at(-1));
  const ride = exp.rec.length > 1 ? exp.rec.slice() : null;
  arrival = { here, home: nav.home, coords: ride || routeCoords.slice() };
  const kmh = nav.moveSec > 60 ? nav.odo / nav.moveSec * 3600 : null;
  const tiles = ride && exp.tiles.size ? newTilesOf(ride).size : null;
  stopNav(true);
  say('Navigation beendet');
  $('arriveStats').innerHTML = [`<b>${nav.odo.toFixed(1).replace('.', ',')} km</b>`, `${durText(nav.moveSec)} Fahrzeit`,
    kmh ? `Ø ${Math.round(kmh)} km/h` : '', tiles != null ? `🧭 ${tiles} neue Kacheln` : ''].filter(Boolean).join(' · ');
  const canBack = !!arrival.home?.latlng && here.distanceTo(arrival.home.latlng) > BACK_HOME_M;
  $('arriveBack').hidden = $('arriveBackDiff').hidden = !canBack;
  $('arriveSave').hidden = $('arriveDrop').hidden = !ride;
  $('arrive').hidden = false;
}
// Schließen ohne Wahl speichert die Fahrt, wie bisher beim Beenden
function arriveClose(save = true) {
  $('arrive').hidden = true;
  if (save) expSaveRecording(); else exp.rec = [];
}
function arriveBack(diff) {
  const { here, home, coords } = arrival;
  arriveClose();
  backOf = diff ? { from: here, to: home.latlng, coords } : null;
  showTab('tour');
  changeWaypoints(() => { waypoints = [{ latlng: here, text: 'Mein Standort' }, { latlng: home.latlng, text: home.text || 'Start' }]; });
}
L.DomEvent.disableClickPropagation($('arrive'));
$('arriveBack').onclick = () => arriveBack(false);
$('arriveBackDiff').onclick = () => arriveBack(true);
$('arriveSave').onclick = () => arriveClose(true);
$('arriveDrop').onclick = () => arriveClose(false);
$('arriveClose').onclick = () => arriveClose(true);
$('navVoice').onclick = () => {
  nav.voice = !nav.voice;
  store.set('navVoice', nav.voice);
  $('navVoice').classList.toggle('off', !nav.voice);
  if (!nav.voice) window.speechSynthesis?.cancel();
};
