// --- Navigation: echte GPS-Position statt Zeitraffer, Bildschirm bleibt an, Sprachansage, Neuberechnung bei Abweichung ---
const OFF_ROUTE_M = 40, REROUTE_PAUSE_MS = 20000;
const nav = { on: false, watch: null, km: 0, off: 0, lastReroute: 0, lock: null, voice: store.get('navVoice', true), said: new Set(), marker: null, done: false };
map.getContainer().appendChild($('nav'));
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

const distText = m => m < 100 ? `${Math.max(0, Math.round(m / 10) * 10)} m` : m < 1000 ? `${Math.round(m / 50) * 50} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`;

// Position auf der Route: zuerst kurz vor bis ein paar km nach dem letzten Stand suchen, damit Rundtouren
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
  Object.assign(nav, { on: true, km: 0, off: 0, said: new Set(), done: false, zoom: 17, manual: null });
  $('nav').hidden = false;
  $('navZoom').hidden = false; $('navZoomAuto').hidden = true;
  $('navArrow').textContent = '📡'; $('navDist').textContent = 'GPS …'; $('navText').textContent = 'Warte auf Standort';
  $('navSpeed').textContent = ''; $('navRest').textContent = '';
  setFull(true);
  keepScreenOn();
  nav.marker = L.marker(routeCoords[0], { interactive: false, zIndexOffset: 1000,
    icon: L.divIcon({ className: '', html: '<div class="nav-dot">➤</div>', iconSize: [30, 30], iconAnchor: [15, 15] }) });
  nav.watch = navigator.geolocation.watchPosition(navFix, err => {
    $('navArrow').textContent = '⚠️'; $('navDist').textContent = 'Kein GPS';
    $('navText').textContent = err.code === 1 ? 'Standortzugriff erlaubt? 💡 In den Browser-Einstellungen für diese Seite freigeben.' : err.message;
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
}

function stopNav() {
  if (!nav.on) return;
  nav.on = false;
  navigator.geolocation?.clearWatch(nav.watch); nav.watch = null;
  nav.lock?.release().catch(() => {}); nav.lock = null;
  window.speechSynthesis?.cancel();
  nav.marker?.remove(); nav.marker = null;
  expSaveRecording();
  $('nav').hidden = true;
  $('navZoom').hidden = true;
  setFull(false);
}

function navFix(pos) {
  if (!nav.on || !routeCoords) return;
  const { latitude: lat, longitude: lon, accuracy, speed, heading } = pos.coords;
  const ll = L.latLng(lat, lon), total = routeKm.at(-1);
  const kmh = speed != null && speed >= 0 ? speed * 3.6 : null;
  nav.marker.setLatLng(ll).addTo(map);
  if ((accuracy || 0) < 50) expRecord(lat, lon);
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

  const dot = nav.marker.getElement()?.firstChild;
  const dir = heading != null && !isNaN(heading) && kmh > 3 ? heading : bearing(L.latLng(pointAtKm(nav.km)), L.latLng(pointAtKm(Math.min(total, nav.km + 0.03))));
  if (dot) dot.style.transform = `rotate(${dir - 90}deg)`;

  const next = routeManeuvers.find(m => m.km > nav.km + 0.01);
  const restM = (total - nav.km) * 1000;
  if (!next || restM < 30) {
    $('navArrow').textContent = '🏁'; $('navDist').textContent = restM < 30 ? 'Ziel erreicht' : distText(restM);
    $('navText').textContent = routeManeuvers.at(-1)?.text || 'Ziel';
    if (restM < 30 && !nav.done) { nav.done = true; say('Sie haben Ihr Ziel erreicht'); }
  } else {
    const m = (next.km - nav.km) * 1000;
    $('navArrow').textContent = TURN_ARROWS[next.type] || '↑';
    $('navDist').textContent = distText(m);
    $('navText').textContent = next.text;
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
  $('navRest').innerHTML = `${stageEnd != null ? `🌙 Etappe ${routeStages.indexOf(stageEnd) + 1}: ` : ''}noch ${distText((goal - nav.km) * 1000)} · <b>${durText(restSec)}</b> · an ${etaText(Date.now() + withBreaks(restSec) * 1000)}`;
  if ($('navNote').textContent === 'Neu berechnen …') $('navNote').textContent = '';
  // Zoom nach Tempo mit Hysterese, damit er um 35 km/h nicht hin- und herspringt
  if (kmh > 40) nav.zoom = 16; else if (kmh != null && kmh < 30) nav.zoom = 17;
  map.setView(ll, nav.manual ?? nav.zoom, { animate: true });
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
$('navStop').onclick = stopNav;
$('navVoice').onclick = () => {
  nav.voice = !nav.voice;
  store.set('navVoice', nav.voice);
  $('navVoice').classList.toggle('off', !nav.voice);
  if (!nav.voice) window.speechSynthesis?.cancel();
};
