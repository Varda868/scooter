// Zwischenziele werden durchnummeriert, Formpunkte (shaping) bekommen keine Nummer
const wpLabel = i => {
  if (i === 0) return 'A';
  if (i === waypoints.length - 1) return 'B';
  if (waypoints[i].shaping) return '◆';
  return String(waypoints.slice(1, i + 1).filter(w => !w.shaping).length);
};
const wpClass = i => isEnd(i) ? '' : waypoints[i].shaping ? ' shape' : ' via';
const ready = () => waypoints.filter(w => w.latlng).length >= 2 && waypoints.every(w => w.latlng || !w.text.trim());

// Jede Änderung an den Wegpunkten läuft hierüber, damit Rückgängig funktioniert.
function changeWaypoints(fn, recalc = true) {
  undoStack.push(JSON.stringify({ waypoints, excluded }));
  if (undoStack.length > 30) undoStack.shift();
  fn();
  renderWaypoints();
  savePlan();
  if (recalc && ready()) route();
}

function renderWaypoints() {
  const last = waypoints.length - 1;
  $('wpList').innerHTML = waypoints.map((w, i) => `<li data-i="${i}"><div class="wp-row">
    <span class="wp-badge${wpClass(i)}">${isEnd(i) || !w.shaping ? wpLabel(i) : ''}</span>
    <span class="wp-input"><input type="text" value="${escapeHtml(w.text)}" placeholder="${i === 0 ? 'Start' : i === last ? 'Ziel' : w.shaping ? 'Formpunkt' : 'Zwischenziel'}: Adresse oder Karte"><button class="wp-clear" type="button" title="Text löschen" tabindex="-1">✕</button></span>
    <button class="icon-btn" data-act="up" title="Nach oben" ${i ? '' : 'disabled'}>↑</button>
    <button class="icon-btn" data-act="down" title="Nach unten" ${i < last ? '' : 'disabled'}>↓</button>
    ${i && w.dur && !w.shaping ? `<span class="wx" title="Ankunft ca. ${etaText(w.eta)}">⏱ ${durText(w.dur)}</span>` : ''}
    ${w.wx ? `<span class="wx" data-act="wx" title="${escapeHtml(w.wx.title)}">${w.wx.icon} ${w.wx.temp}°</span>` : ''}
    ${i && i < last && !w.shaping ? `<button class="icon-btn${w.night ? ' has-night' : ' night-off'}" data-act="night" title="Feste Übernachtung hier (nochmal tippen: Ruhetag)">🌙${w.night > 1 ? '²' : ''}</button>` : ''}
    <button class="icon-btn${w.note ? ' has-note' : ''}" data-act="note" title="Notiz">📝</button>
    <button class="icon-btn" data-act="del" title="Entfernen">✕</button></div>
    ${w.noteOpen || w.note ? `<textarea rows="2" placeholder="Notiz, z. B. Pause, Tanken, Treffpunkt …">${escapeHtml(w.note || '')}</textarea>` : ''}</li>`).join('');
  $('undo').disabled = !undoStack.length;
  $('reverse').disabled = waypoints.length < 2;
  $('optimize').disabled = !canOptimize();

  wpLayer.clearLayers();
  waypoints.forEach((w, i) => {
    if (!w.latlng) return;
    L.marker(w.latlng, {
      draggable: true, title: wpLabel(i),
      icon: w.shaping && !isEnd(i)
        ? L.divIcon({ className: '', html: '<div class="wp-marker shape"></div>', iconSize: [16, 16], iconAnchor: [8, 8] })
        : L.divIcon({ className: '', html: `<div class="wp-marker${wpClass(i)}">${wpLabel(i)}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] })
    }).addTo(wpLayer)
      .on('dragend', e => changeWaypoints(() => { const ll = e.target.getLatLng(); waypoints[i] = { ...waypoints[i], latlng: ll, text: coordText(ll) }; }))
      .bindPopup(() => {
        const btn = document.createElement('button');
        btn.textContent = w.shaping && !isEnd(i) ? 'Formpunkt entfernen' : `${wpLabel(i)} entfernen`;
        btn.onclick = () => { map.closePopup(); removeWaypoint(i); };
        const box = document.createElement('div');
        if (w.note) box.insertAdjacentHTML('beforeend', `<div class="note">${escapeHtml(w.note)}</div>`);
        box.append(btn);
        return box;
      }, { className: 'map-menu' });
  });

  exclLayer.clearLayers();
  excluded.forEach((ll, i) => L.marker(ll, {
    icon: L.divIcon({ className: 'poi-icon', html: '⛔', iconSize: [22, 22] }), title: 'Gesperrt'
  }).addTo(exclLayer).bindPopup(() => menuBox([['unblock', 'Sperre aufheben']], () => {
    changeWaypoints(() => excluded.splice(i, 1));
  }), { className: 'map-menu' }));
}

// Kleines Button-Menü für Popups; onPick bekommt die gewählte Aktion
function menuBox(items, onPick, primary) {
  const box = document.createElement('div');
  box.innerHTML = items.map(([act, text]) => `<button data-act="${act}" class="${!primary || act === primary ? '' : 'secondary'}">${text}</button>`).join('');
  box.onclick = ev => {
    const act = ev.target.dataset.act;
    if (!act) return;
    map.closePopup();
    onPick(act);
  };
  return box;
}

// Start/Ziel werden geleert statt gelöscht, damit immer mindestens zwei Felder bleiben.
function removeWaypoint(i) {
  changeWaypoints(() => {
    if (waypoints.length > 2) waypoints.splice(i, 1);
    else waypoints[i] = { latlng: null, text: '' };
  }, waypoints.length > 2);
  if (waypoints.filter(w => w.latlng).length < 2) clearRoute();
}

// Neues Zwischenziel in den Abschnitt einsortieren, der dadurch am wenigsten Umweg bekommt (Luftlinie).
function insertVia(ll, shaping = false) {
  const pts = waypoints.filter(w => w.latlng);
  let best = waypoints.length - 1, bestCost = Infinity;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i].latlng, b = waypoints[i + 1].latlng;
    if (!a || !b) continue;
    const cost = map.distance(a, ll) + map.distance(ll, b) - map.distance(a, b);
    if (cost < bestCost) { bestCost = cost; best = i + 1; }
  }
  waypoints.splice(pts.length >= 2 ? best : waypoints.length - 1, 0, { latlng: ll, text: coordText(ll), shaping });
}

function setEnd(i, ll) {
  waypoints[i] = { ...waypoints[i], latlng: ll, text: coordText(ll), shaping: false };
}

const mapMenu = L.popup({ className: 'map-menu', minWidth: 170 });
map.on('click', e => {
  const ll = e.latlng, last = waypoints.length - 1;
  const hasStart = !!waypoints[0].latlng, hasEnd = !!waypoints[last].latlng;
  const items = [
    ['start', hasStart ? 'Start hierher verlegen' : 'Start hier'],
    ['end', hasEnd ? 'Ziel hierher verlegen' : 'Ziel hier'],
    ...(hasStart && hasEnd ? [['via', 'Zwischenziel hier']] : []),
    ['mypoi', '⭐ Eigenen POI hier']
  ];
  // Der wahrscheinlichste nächste Schritt steht oben und ist hervorgehoben.
  const primary = !hasStart ? 'start' : !hasEnd ? 'end' : 'via';
  items.sort((a, b) => (b[0] === primary) - (a[0] === primary));
  const box = menuBox(items, act => act === 'mypoi' ? openPoiForm(ll) :
    changeWaypoints(() => act === 'start' ? setEnd(0, ll) : act === 'end' ? setEnd(waypoints.length - 1, ll) : insertVia(ll)), primary);
  mapMenu.setLatLng(ll).setContent(box).openOn(map);
});

$('wpList').onclick = e => {
  const act = e.target.dataset.act, i = +e.target.closest('li')?.dataset.i;
  if (!act) return;
  if (act === 'del') return removeWaypoint(i);
  // Am Handy gibt es keinen Tooltip: Wetterdetails als Popup am Wegpunkt
  if (act === 'wx') return L.popup({ className: 'map-menu' }).setLatLng(waypoints[i].latlng).setContent(escapeHtml(waypoints[i].wx.title)).openOn(map);
  // Feste Übernachtung: aus → 1 Nacht → 2 Nächte (Ruhetag) → aus; Route bleibt gleich, nur Etappen neu
  if (act === 'night') {
    changeWaypoints(() => { const w = waypoints[i]; w.night = ((w.night || 0) + 1) % 3 || undefined; }, false);
    return replanTimes();
  }
  if (act === 'note') {
    const w = waypoints[i];
    // Leere offene Notiz schließt sich wieder, sonst öffnen
    w.noteOpen = !(w.noteOpen && !w.note);
    renderWaypoints();
    $('wpList').querySelector(`li[data-i="${i}"] textarea`)?.focus();
    return;
  }
  const j = act === 'up' ? i - 1 : i + 1;
  changeWaypoints(() => { [waypoints[i], waypoints[j]] = [waypoints[j], waypoints[i]]; });
};
// Eingetippte Adresse: beim Verlassen des Felds bzw. Enter auflösen
// Notizen ändern weder Route noch Rückgängig-Verlauf
$('wpList').oninput = e => {
  if (e.target.tagName !== 'TEXTAREA') return;
  const w = waypoints[+e.target.closest('li').dataset.i];
  w.note = e.target.value;
  e.target.closest('li').querySelector('[data-act=note]').classList.toggle('has-note', !!w.note.trim());
  savePlan();
};
$('wpList').onchange = async e => {
  if (e.target.tagName !== 'INPUT' || !e.target.isConnected) return;
  const i = +e.target.closest('li').dataset.i, text = e.target.value.trim();
  if (text === waypoints[i].text) return;
  try {
    const ll = text ? await geocode(text) : null;
    if (ll) rememberPlace(text, ll);
    changeWaypoints(() => { waypoints[i] = { ...waypoints[i], latlng: ll, text }; });
    if (ll && !ready()) map.setView(ll, 13);
  } catch (err) {
    $('summary').textContent = '⚠️ ' + err.message;
  }
};
// --- Vorschläge beim Antippen eines Adressfelds: eigener Standort, letzte Ziele, eigene POIs ---
let recentPlaces = store.get('recent', []);
const OWN_LOCATION = 'Mein Standort';
const isCoordText = t => /^\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*$/.test(t);

function rememberPlace(name, ll) {
  name = name.trim();
  if (!name || name === OWN_LOCATION || isCoordText(name)) return;
  recentPlaces = [{ name, lat: ll.lat, lon: ll.lng }, ...recentPlaces.filter(p => p.name !== name)].slice(0, 8);
  store.set('recent', recentPlaces);
}

function suggestionsFor(text) {
  const q = text.trim().toLowerCase();
  const match = name => !q || name.toLowerCase().includes(q);
  return [
    ...(navigator.geolocation && match(OWN_LOCATION) ? [{ icon: '📍', name: OWN_LOCATION, gps: true }] : []),
    ...recentPlaces.filter(p => match(p.name)).map(p => ({ icon: '🕘', ...p })),
    ...myPois.filter(p => match(p.name)).slice(0, 5).map(p => ({ icon: p.icon, name: p.name, lat: p.lat, lon: p.lon }))
  ];
}

function showSuggestions(input) {
  input.closest('li').querySelector('.suggest')?.remove();
  const items = suggestionsFor(input.value);
  if (!items.length) return;
  const box = document.createElement('div');
  box.className = 'suggest';
  box.innerHTML = items.map((it, k) => `<div data-k="${k}">${it.icon} ${escapeHtml(it.name)}</div>`).join('');
  // mousedown statt click: das Feld behält den Fokus, sonst löst blur vorher eine Suche mit dem Teiltext aus
  box.onmousedown = ev => {
    ev.preventDefault();
    const it = items[ev.target.closest('[data-k]')?.dataset.k];
    if (!it) return;
    // Erst den Feldtext setzen, damit ein nachträgliches change-Event (Feld wird neu gerendert) nichts überschreibt
    input.value = it.name;
    pickSuggestion(+input.closest('li').dataset.i, it);
  };
  input.closest('li').append(box);
}

function pickSuggestion(i, it) {
  const apply = ll => {
    if (!it.gps) rememberPlace(it.name, ll);
    changeWaypoints(() => { waypoints[i] = { ...waypoints[i], latlng: ll, text: it.name }; });
    if (!ready()) map.setView(ll, 13);
  };
  if (!it.gps) return apply(L.latLng(it.lat, it.lon));
  $('summary').textContent = 'Bestimme Standort …';
  navigator.geolocation.getCurrentPosition(
    pos => { $('summary').textContent = ''; apply(L.latLng(pos.coords.latitude, pos.coords.longitude)); },
    err => { $('summary').textContent = '⚠️ Standort nicht verfügbar: ' + err.message; },
    { timeout: 10000, maximumAge: 60000 });
}

// Kreuz im Adressfeld: nur den Text leeren und Feld fokussiert lassen (Vorschläge erscheinen),
// pointerdown statt click, damit das Feld nicht erst den Fokus verliert und die Eingabe übernimmt
$('wpList').addEventListener('pointerdown', e => {
  if (!e.target.matches('.wp-clear')) return;
  e.preventDefault();
  const input = e.target.previousElementSibling;
  input.value = '';
  input.focus();
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
$('wpList').addEventListener('focusin', e => { if (e.target.matches('.wp-row input')) showSuggestions(e.target); });
$('wpList').addEventListener('input', e => { if (e.target.matches('.wp-row input')) showSuggestions(e.target); });
$('wpList').addEventListener('focusout', e => {
  if (e.target.matches('.wp-row input')) setTimeout(() => e.target.closest('li')?.querySelector('.suggest')?.remove(), 150);
});
$('wpList').addEventListener('keydown', e => { if (e.key === 'Escape') e.target.closest('li')?.querySelector('.suggest')?.remove(); });

$('addVia').onclick = () => changeWaypoints(() => waypoints.splice(waypoints.length - 1, 0, { latlng: null, text: '' }), false);
$('reverse').onclick = () => changeWaypoints(() => waypoints.reverse());
// Reihenfolge optimieren (Valhalla /optimized_route): Start und Ziel bleiben, die Zwischenziele werden umsortiert.
// Nur ohne Formpunkte, die gehören zu ihrem Abschnitt und lassen sich nicht sinnvoll mitsortieren.
const canOptimize = () => { const l = waypoints.filter(w => w.latlng); return l.length >= 4 && !l.some(w => w.shaping); };
$('optimize').onclick = async () => {
  if (!canOptimize()) return;
  const located = waypoints.filter(w => w.latlng);
  $('optimize').disabled = true;
  $('summary').textContent = 'Reihenfolge wird optimiert …';
  try {
    let res;
    try { res = await fetch(VALHALLA_URL.replace(/\/route$/, '/optimized_route'), { method: 'POST', body: JSON.stringify(routeBody(located)) }); }
    catch { throw new Error('Keine Verbindung zum Routing-Server. 💡 Internetverbindung prüfen.'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(valhallaError(res.status, data));
    const order = (data.trip?.locations || []).map(l => l.original_index);
    if (order.length !== located.length || new Set(order).size !== order.length) throw new Error('Unerwartete Antwort vom Routing-Server.');
    summaryNote += order.every((o, i) => o === i) ? ' · ⚡ Reihenfolge war schon die kürzeste' : ' · ⚡ Reihenfolge optimiert';
    changeWaypoints(() => { waypoints = order.map(i => located[i]); });
  } catch (e) { $('summary').textContent = '⚠️ ' + e.message; renderWaypoints(); }
};
// Hin und zurück: Start als neues Ziel anhängen, das bisherige Ziel wird zum Halt
$('backHome').onclick = () => {
  const start = waypoints[0], end = waypoints.at(-1);
  if (!start?.latlng || !end?.latlng || start.latlng.distanceTo(end.latlng) < BACK_HOME_M) return;
  changeWaypoints(() => waypoints.push({ latlng: start.latlng, text: start.text }));
};
$('backDiff').checked = !!settings.backDiff;
$('backDiff').onchange = () => { settings.backDiff = $('backDiff').checked; store.set('settings', settings); if (ready()) route(); };
$('undo').onclick = () => {
  if (!undoStack.length) return;
  const state = JSON.parse(undoStack.pop());
  waypoints = state.waypoints.map(w => ({ ...w, latlng: w.latlng && L.latLng(w.latlng) }));
  excluded = state.excluded.map(ll => L.latLng(ll));
  renderWaypoints();
  if (ready()) route(); else clearRoute();
};

function clearRoute() {
  if (routeLayer) map.removeLayer(routeLayer);
  altLayer.clearLayers();
  stopSim();
  $('play').hidden = true;
  $('navStart').hidden = true;
  $('gpxTour').hidden = true;
  $('mapSave').hidden = true; $('mapSaveInfo').textContent = '';
  routeLayer = routeCoords = routeKm = null;
  queueMicrotask(expRouteChanged);
  $('summary').textContent = '';
  $('steps').innerHTML = '';
  $('elevation').innerHTML = '';
  renderIncidents([]);
  wxRouteRequest++; wxRouteLayer.clearLayers(); $('wxRouteSummary').textContent = '';
  wxShelter = false;
  routeStages = []; routeStageNights = []; currentTrip = null; tripClimb = null; stageLayer.clearLayers(); $('stageSummary').textContent = '';
  tankPlan();
  faehrenZeigen(null);
  loadPois();
  oc.request++;
  caches = caches.filter(c => !c.oc);
  renderCaches();
}

async function geocode(q) {
  const m = q.match(/^\s*(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)\s*$/);
  if (m) return L.latLng(+m[1], +m[3]);
  const res = await fetch(`${NOMINATIM_URL}?format=json&limit=1&q=${encodeURIComponent(q)}`);
  const data = await res.json();
  if (!data.length) throw new Error(`Nicht gefunden: ${q}`);
  return L.latLng(+data[0].lat, +data[0].lon);
}
