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

// --- Orte und Adressen beim Tippen (ab 3 Zeichen, 300 ms Pause): zuerst der eigene Ortsindex (poi/o/, auch Dörfer und
// Weiler, geht offline), darunter Photon für Straßen und Adressen. Nähe zur Kartenmitte zuerst. Nominatim nur beim Bestätigen.
const ORT_ART = { c: 'Stadt', t: 'Kleinstadt', v: 'Dorf', h: 'Weiler' }, ORT_RANG = { c: 0, t: 1, v: 2, h: 3 };
const ortKacheln = new Map();
const ortNorm = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss');
async function orteSuchen(q, um) {
  const ix = await poiTileIndex();
  if (!ix?.placeTiles) return [];
  const set = new Set(ix.placeTiles), keys = [];
  for (let a = Math.floor(um.lat) - 1; a <= Math.floor(um.lat) + 1; a++)
    for (let o = Math.floor(um.lng) - 1; o <= Math.floor(um.lng) + 1; o++) if (set.has(`${a}_${o}`)) keys.push(`${a}_${o}`);
  const tiles = await Promise.all(keys.map(k => {
    const url = `${POI_TILE_URL}o/${k}.json?v=${ix.date}`;
    if (!ortKacheln.has(url)) ortKacheln.set(url, fetch(url, { signal: AbortSignal.timeout(15000) }).then(r => r.ok ? r.json() : [])
      .catch(() => { ortKacheln.delete(url); return []; }));
    return ortKacheln.get(url);
  }));
  const n = ortNorm(q), out = [];
  for (const [name, lat, lon, art, de, bei] of tiles.flat()) {
    const anzeige = de || name, s = ortNorm(anzeige), s2 = de ? ortNorm(name) : '';
    const vorn = s.startsWith(n) || s2.startsWith(n);
    if (!vorn && !s.includes(n) && !s2.includes(n)) continue;
    const km = um.distanceTo([lat, lon]) / 1000;
    out.push({ icon: art === 'c' || art === 't' ? '🏙' : '🏡', name: anzeige, lat, lon, km, gr: art === 'c' ? 0 : art === 't' ? 1 : 2,
      info: [ORT_ART[art], bei && `bei ${bei}`, `${Math.round(km)} km`].filter(Boolean).join(' · '),
      rang: (vorn ? 0 : 10) + ORT_RANG[art] * 0.5 + km / 50 });
  }
  return out.sort((a, b) => a.rang - b.rang).slice(0, 8);
}
const PHOTON_ART = { house: '🏠', street: '🛣', city: '🏙', town: '🏙', village: '🏡', locality: '📍', district: '📍' };
async function photonSuchen(q, um, nurStaedte = false) {
  // Ohne zoom gewichtet Photon nur die Nähe („Oslo“ in Kiel → Osloring). Orte weiträumig (zoom 5), mit Hausnummer
  // eher örtlich (Kartenzoom), damit „Bahnhofstr. 3“ in der Nähe bleibt
  const zoom = /\d/.test(q) ? Math.min(14, Math.max(8, Math.round(map.getZoom()))) : 5;
  const r = await fetch(`${PHOTON_URL}?q=${encodeURIComponent(q)}&lang=de&limit=${nurStaedte ? 3 : 8}&lat=${um.lat.toFixed(4)}&lon=${um.lng.toFixed(4)}&zoom=${zoom}` +
    (nurStaedte ? '&osm_tag=place:city&osm_tag=place:town' : ''),
    { signal: AbortSignal.timeout(6000) });
  if (!r.ok) return [];
  return ((await r.json()).features || []).map(f => {
    const p = f.properties, [lon, lat] = f.geometry.coordinates;
    // Gleichnamiges in Übersee (Athens in Georgia) weglassen, Roller fahren in Europa
    if (um.distanceTo([lat, lon]) > 4000e3) return null;
    const strasse = p.street ? `${p.street}${p.housenumber ? ' ' + p.housenumber : ''}` : '';
    const name = p.type === 'house' || (!p.name && strasse) ? strasse || p.name : p.name || strasse;
    const ort = [p.postcode, p.city || p.town || p.village].filter(Boolean).join(' ');
    // Größe aus place=*: Photon nennt Städte und Dörfer gleichermaßen type „city“
    const gr = p.osm_key === 'place' ? ({ city: 0, town: 1, village: 2 }[p.osm_value] ?? 3) : 3;
    return name && { icon: gr <= 1 ? '🏙' : gr === 2 ? '🏡' : PHOTON_ART[p.type] || '📍', gr, name: ort && !name.includes(ort) ? `${name}, ${ort}` : name, lat, lon,
      info: [p.type === 'house' || p.type === 'street' ? '' : p.state, p.country !== 'Deutschland' && p.country, `${Math.round(um.distanceTo([lat, lon]) / 1000)} km`].filter(Boolean).join(' · ') };
  }).filter(Boolean);
}
// Ortsindex und Photon gemeinsam ordnen: Name beginnt mit dem Gesuchten, dann Städte vor Dörfern (city, town, village),
// erst dann der genau gleiche Name, sonst wie geliefert. „Prag“ → Prag vor Pragsdorf, „Palma“ → Palma vor la Palma
// de Cervelló, „Höchstädt“ → Höchstädt an der Donau vor dem Dorf Hochstadt (ortNorm macht beide gleich)
function ortRang(q, items) {
  const n = ortNorm(q), kopf = it => it.name.split(',')[0].trim();
  const schluessel = it => [ortNorm(kopf(it)).startsWith(n) ? 0 : 1, it.icon === '🏙' ? 0 : 1, it.gr ?? 3, kopf(it).toLowerCase() === q.trim().toLowerCase() ? 0 : 1];
  return items.map((it, k) => [...schluessel(it), k, it]).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3] || a[4] - b[4]).map(x => x[5]);
}
let ortTimer = 0, ortReq = 0;
function showSuggestions(input) {
  input.closest('li').querySelector('.suggest')?.remove();
  const q = input.value.trim(), req = ++ortReq;
  clearTimeout(ortTimer);
  if (q.length >= 3 && !isCoordText(q)) ortTimer = setTimeout(async () => {
    // Doppelte nur weglassen, wenn der Name gleich ist und der Ort keine 15 km entfernt (Photon liefert Stadt und
    // Gemeinde oft getrennt); sonst verdrängt das Dorf Bastia aus dem Ortsindex das korsische Bastia aus Photon
    const um = map.getCenter(), lokal = suggestionsFor(input.value), kopf = x => x.name.split(',')[0].trim().toLowerCase();
    const schon = [...lokal];
    const dazu = it => { if (schon.some(o => kopf(o) === kopf(it) && (o.lat == null || it.lat == null || map.distance([o.lat, o.lon], [it.lat, it.lon]) < 15000))) return false; schon.push(it); return true; };
    const orte = (await orteSuchen(q, um).catch(() => [])).filter(dazu);
    if (req !== ortReq || document.activeElement !== input) return;
    zeigeVorschlaege(input, [...lokal, ...orte], true);
    let web = await photonSuchen(q, um).catch(() => []);
    // Nur Dörfer dieses Namens, keine Stadt? Einmal nur nach Städten fragen: bei „Bastia“ füllen sonst italienische
    // Dörfer alle Plätze, und das korsische Bastia kommt gar nicht erst mit
    const gleich = it => it.gr != null && ortNorm(it.name.split(',')[0].trim()) === ortNorm(q), alle = [...orte, ...web];
    if (!/\d/.test(q) && alle.some(it => gleich(it) && it.gr === 2) && !alle.some(it => gleich(it) && it.gr <= 1)) web = [...(await photonSuchen(q, um, true).catch(() => [])), ...web];
    if (req !== ortReq || document.activeElement !== input) return;
    web = web.filter(it => dazu(it) && !orte.some(o => map.distance([o.lat, o.lon], [it.lat, it.lon]) < 5000 && o.name.split(',')[0] === it.name.split(',')[0]));
    if (req !== ortReq || document.activeElement !== input) return;
    zeigeVorschlaege(input, [...lokal, ...ortRang(q, [...orte, ...web])], false);
  }, 300);
  zeigeVorschlaege(input, suggestionsFor(input.value), q.length >= 3);
}
function zeigeVorschlaege(input, items, laedt) {
  input.closest('li').querySelector('.suggest')?.remove();
  if (!items.length && !laedt) return;
  const box = document.createElement('div');
  box.className = 'suggest';
  box.innerHTML = items.map((it, k) => `<div data-k="${k}">${it.icon} ${escapeHtml(it.name)}${it.info ? ` <span class="hint">${escapeHtml(it.info)}</span>` : ''}</div>`).join('') +
    (laedt ? '<div class="hint suggest-laedt">… suche Orte und Adressen</div>' : '');
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
  routeLayer = routeCoords = routeKm = null; routeFaehren = [];
  $('summary').textContent = '';
  $('steps').innerHTML = '';
  // Höhenprofil samt Steigungsschildern weg; eine noch laufende Höhenanfrage verfällt
  $('elevation').innerHTML = ''; eleData = null; elevationRequest++; gradeSignLayer.clearLayers();
  renderIncidents([]);
  wxRouteRequest++; wxRouteLayer.clearLayers(); $('wxRouteSummary').textContent = ''; $('wxWarnSummary').textContent = ''; routeWarnungen = [];
  wxShelter = false;
  routeStages = []; routeStageNights = []; currentTrip = null; tripClimb = null; stageLayer.clearLayers(); $('stageSummary').textContent = '';
  tankPlan();
  faehrenZeigen(null);
  loadPois();
}

async function geocode(q) {
  const m = q.match(/^\s*(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)\s*$/);
  if (m) return L.latLng(+m[1], +m[3]);
  const res = await fetch(`${NOMINATIM_URL}?format=json&limit=1&q=${encodeURIComponent(q)}`);
  const data = await res.json();
  if (!data.length) throw new Error(`Nicht gefunden: ${q}`);
  return L.latLng(+data[0].lat, +data[0].lon);
}
