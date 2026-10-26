// --- Standort teilen über Talk: nur versiegelt, mit der Gruppe (Gruppen-Passwort) oder direkt an einen Kontakt (NIP-44).
// Flüchtige Nostr-Art 24425 (20000–29999): Relays reichen sie nur live weiter und speichern nichts. Gesendet wird nur,
// solange die App sichtbar ist und GPS läuft (Navi oder „Mein Standort“), im Hintergrund nie. Die anderen sieht man,
// sobald Talk an ist, auch auf der Planungsseite. talk/netz.js bleibt unverändert: eigenes Abo je Leitung, eigene
// Signatur, und die Nachrichten dieser Art werden vor Netz.nachricht abgefangen.
const POS_ART = 24425, POS_NS = 'bcon.plz', POS_ABLAUF_S = 600;
const POS_TAKT_MS = 30000, POS_WEIT_M = 300, POS_NAH_M = 25, POS_HALT_MS = 120000; // alle 30 s ab 25 m, sofort ab 300 m, sonst alle 2 min
const POS_ALT_MS = 5 * 60000, POS_WEG_MS = 30 * 60000;
const posPrefs = Object.assign({ an: '', bis: 0, dauer: 3 }, store.get('standort', {}));
const pos = { secp: null, netz: null, fix: null, gesendet: null, laeuft: false, stand: '', leute: new Map(), ids: new Set(),
  layer: L.layerGroup().addTo(map) };
const posEnc = new TextEncoder(), posDec = new TextDecoder();
const savePos = () => store.set('standort', posPrefs);
const posAktiv = () => !!posPrefs.an && Date.now() < posPrefs.bis;
// Ohne Passwort gibt es keine Gruppe: dann nur an einen Kontakt, nie offen in die Region
const posZiel = () => !posAktiv() ? null : posPrefs.an === 'gruppe' ? (talk.netz?.gruppe ? 'gruppe' : null) : posPrefs.an;

// Von 06-kartenknoepfe und 07-navi bei jedem GPS-Fix
function standortFix(p) {
  pos.fix = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, v: p.coords.speed, k: p.coords.heading, t: p.timestamp || Date.now() };
  haltFix(pos.fix);
}
const posGps = () => (me.watch != null || nav.watch != null) && pos.fix && Date.now() - pos.fix.t < 10 * 60000;

async function posSignieren(tags, inhalt) {
  const n = talk.netz, zeit = Math.floor(Date.now() / 1000);
  const id = talk.mod.hex(new Uint8Array(await crypto.subtle.digest('SHA-256', posEnc.encode(JSON.stringify([0, n.pk, zeit, POS_ART, tags, inhalt])))));
  return { id, pubkey: n.pk, created_at: zeit, kind: POS_ART, tags, content: inhalt, sig: talk.mod.hex(await pos.secp.schnorr.signAsync(talk.mod.unhex(id), n.sk)) };
}
async function posSenden(daten, ziel = posZiel()) {
  const n = talk.netz;
  if (!n || !ziel || !pos.secp) return 0;
  const g = ziel === 'gruppe' && n.gruppe, rg = n.region;
  const tags = [...(g ? [['L', POS_NS], ...Array.from({ length: rg.length - 1 }, (_, i) => ['l', rg.slice(0, i + 2), POS_NS]), ['gruppe', g.kennung]] : [['p', ziel]]),
    ['alt', 'Scooterways-Standort'], ['expiration', String(Math.floor(Date.now() / 1000) + POS_ABLAUF_S)]];
  const ck = g ? g.ck : await talk.mod.unterhaltung(n.sk, ziel);
  const e = await posSignieren(tags, await talk.mod.versiegeln(ck, posEnc.encode(JSON.stringify({ ...daten, n: talkName(), sp: talkSprachen() }))));
  pos.ids.add(e.id);
  return n.raus([e]);
}

// Takt: senden, wenn alles passt; jede Bedingung, die fehlt, steht im Hinweis
async function posTakt() {
  const z = posZiel(), n = talk.netz;
  if (posPrefs.an && !posAktiv()) { posStopp(); return; }
  pos.stand = !posPrefs.an ? '' : !talkPrefs.on ? 'Talk ist aus'
    : posPrefs.an === 'gruppe' && !talkPrefs.pw ? 'nur mit Gruppen-Passwort'
    : !talkBereit() ? 'keine Verbindung' : !posGps() ? 'wartet auf GPS (Navi oder ◎)'
    : document.visibilityState !== 'visible' ? 'pausiert' : 'teilt';
  posHinweis();
  if (!z || pos.laeuft || pos.stand !== 'teilt' || !pos.secp) return;
  const f = pos.fix, g = pos.gesendet, jetzt = Date.now();
  const weg = g ? L.latLng(f.lat, f.lon).distanceTo([g.lat, g.lon]) : Infinity, alt = g ? jetzt - g.zeit : Infinity;
  if (!(pos.sofort || g?.ziel !== z || weg >= POS_WEIT_M && alt > 5000 || weg >= POS_NAH_M && alt >= POS_TAKT_MS || alt >= POS_HALT_MS)) return;
  pos.laeuft = true; pos.sofort = false;
  try {
    const k = f.k != null && !isNaN(f.k) && f.v > 1 ? Math.round(f.k) : null, h = halt.gemeldet ? { s: Math.floor(halt.seit / 1000), g: halt.grund } : undefined;
    const tp = gruppe.eigen && Date.now() < gruppe.eigen.bis * 1000 ? gruppe.eigen : undefined;
    const r = await posSenden({ la: +f.lat.toFixed(5), lo: +f.lon.toFixed(5), v: f.v != null && f.v >= 0 ? Math.round(f.v * 3.6) : null, k, t: Math.floor(f.t / 1000), h, tp });
    pos.gesendet = { lat: f.lat, lon: f.lon, zeit: jetzt, ziel: z, relays: r };
  } catch { pos.gesendet = { ...(g || { lat: f.lat, lon: f.lon }), zeit: jetzt, ziel: z, relays: 0 }; }
  pos.laeuft = false;
  posHinweis();
}
// Beim Ausschalten einmal „aus“ schicken, damit der Pfeil bei den anderen sofort verschwindet
function posStopp() {
  const ziel = pos.gesendet?.ziel;
  posPrefs.an = ''; posPrefs.bis = 0; savePos();
  if (ziel) posSenden({ aus: 1 }, ziel).catch(() => {});
  pos.gesendet = null;
  posFormular();
}

// ---- Empfang: Abo je offener Leitung, Nachrichten der Art 24425 vor Netz.nachricht abfangen
function posNetz() {
  const n = talk.netz;
  if (n !== pos.netz) {
    pos.netz = n;
    if (!n) { pos.leute.clear(); pos.layer.clearLayers(); }
    else {
      const orig = n.nachricht.bind(n);
      n.nachricht = (l, m) => m[0] === 'EVENT' && m[2]?.kind === POS_ART ? posEmpfangen(m[2]) : orig(l, m);
    }
  }
  if (!n) return;
  for (const l of n.leitungen) {
    if (!l.offen || !l.ws || l.posWs === l.ws) continue;
    l.posWs = l.ws;
    const seit = Math.floor(Date.now() / 1000) - 60;
    try {
      l.ws.send(JSON.stringify(['REQ', 'pos', { kinds: [POS_ART], '#p': [n.pk], since: seit },
        ...(n.gruppe ? [{ kinds: [POS_ART], '#L': [POS_NS], '#l': [n.region], since: seit }] : [])]));
    } catch {}
  }
}
async function posEmpfangen(e) {
  const n = talk.netz;
  if (!n || pos.ids.has(e.id) || e.pubkey === n.pk || !/^[0-9a-f]{64}$/.test(e.pubkey || '')) return;
  if (pos.ids.size > 2000) pos.ids.clear();
  pos.ids.add(e.id);
  const jetzt = Date.now() / 1000, ab = e.tags?.find?.(t => t[0] === 'expiration');
  if (ab && +ab[1] < jetzt || Math.abs(jetzt - e.created_at) > POS_ABLAUF_S) return;
  const p = e.tags.find(t => t[0] === 'p'), g = !p && e.tags.find(t => t[0] === 'gruppe');
  let ck = null;
  if (p) { if (p[1] !== n.pk) return; ck = await talk.mod.unterhaltung(n.sk, e.pubkey); }
  else if (g && n.gruppe && g[1] === n.gruppe.kennung) ck = n.gruppe.ck;
  if (!ck || !await talk.mod.eventPruefen(e)) return;
  let d;
  try { d = JSON.parse(posDec.decode(await talk.mod.oeffnen(ck, e.content))); } catch { return; }
  const alt = pos.leute.get(e.pubkey);
  if (alt && alt.zeit > e.created_at) return;
  if (d?.aus) { alt?.marker.remove(); pos.leute.delete(e.pubkey); gruppeZeigen(); return; }
  if (!(Math.abs(d?.la) <= 90 && Math.abs(d?.lo) <= 180)) return;
  const name = String(d.n || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 9) || e.pubkey.slice(0, 8);
  const x = alt || { marker: L.marker([d.la, d.lo], { zIndexOffset: 900 }).bindPopup(() => posPopup(e.pubkey), { minWidth: 180 }).addTo(pos.layer) };
  const h = Number.isFinite(d.h?.s) ? { s: d.h.s, g: HALT_GRUENDE[d.h.g] ? d.h.g : '' } : null;
  Object.assign(x, { lat: d.la, lon: d.lo, v: Number.isFinite(d.v) ? d.v : null, k: Number.isFinite(d.k) ? d.k : null, name, privat: !!p,
    sp: Array.isArray(d.sp) ? d.sp.filter(s => /^[a-z]{2}$/.test(s)).slice(0, 4) : [],
    zeit: e.created_at, fix: Number.isFinite(d.t) ? d.t : e.created_at, haltAlt: x.halt, halt: h });
  x.marker.setLatLng([d.la, d.lo]);
  pos.leute.set(e.pubkey, x);
  talkKontaktMerken(e.pubkey, name, x.sp);
  posPfeil(x);
  haltEmpfangen(x);
  if (d.tp) treffEmpfangen(d.tp, name);
}
const posAlter = s => { const m = Math.round((Date.now() / 1000 - s) / 60); return m < 1 ? 'gerade' : m < 60 ? `vor ${m} min` : `vor ${Math.floor(m / 60)} h`; };
function posPfeil(x) {
  const grau = Date.now() / 1000 - x.fix > POS_ALT_MS / 1000;
  const html = x.halt ? `<div class="pos-pfeil halt${grau ? ' alt' : ''}">${HALT_GRUENDE[x.halt.g]?.[0] || '⏸'}</div>` :
      `<div class="pos-pfeil${grau ? ' alt' : ''}${x.privat ? ' privat' : ''}"><span style="transform:rotate(${x.k != null ? x.k - 90 : -90}deg)">${x.k != null ? '➤' : '●'}</span></div>` +
      `<div class="pos-name${grau ? ' alt' : ''}">${escapeHtml(x.name)}</div>`;
  if (html !== x.html) x.marker.setIcon(L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -12], html: x.html = html }));
}
function posPopup(pk) {
  const x = pos.leute.get(pk), box = document.createElement('div');
  if (!x) return box;
  const ich = pos.fix && posGps() ? L.latLng(pos.fix.lat, pos.fix.lon) : me.dot._map ? me.dot.getLatLng() : null;
  const m = ich ? ich.distanceTo([x.lat, x.lon]) : null;
  box.innerHTML = `<b>${x.privat ? '🔒 ' : ''}${escapeHtml(x.name)}</b>${x.sp?.length ? ` <span class="hint">spricht ${x.sp.join(' ')}</span>` : ''}<br>${posAlter(x.fix)}${x.v != null ? ` · ${x.v} km/h` : ''}` +
    (x.halt ? `<br>${haltText(x)}` : '') +
    (m != null ? `<br>${m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(1).replace('.', ',') + ' km'} Luftlinie von dir` : '');
  box.append(menuBox([['via', 'Als Zwischenziel'], ['end', 'Hinfahren (Ziel)']], act => {
    const ll = L.latLng(x.lat, x.lon);
    changeWaypoints(() => {
      if (act === 'end') setEnd(waypoints.length - 1, ll); else insertVia(ll);
      waypoints.find(w => w.latlng === ll).text = '📍 ' + x.name;
    });
  }, 'end'));
  return box;
}
// Alte Pfeile grau, nach 30 min weg
function posAufraeumen() {
  const jetzt = Date.now() / 1000;
  for (const [pk, x] of pos.leute) {
    if (jetzt - x.fix > POS_WEG_MS / 1000) { x.marker.remove(); pos.leute.delete(pk); } else posPfeil(x);
  }
  gruppeZeigen();
}

// ---- Halt: wer länger als 90 s steht (nicht an einem geplanten Halt), meldet das mit; Grund per Schnellknopf.
// Weiterfahren (30 m weg) hebt den Hinweis von selbst auf. Kein Abstandhalten, nur der Hinweis für die anderen.
const HALT_MS = 90000, HALT_KREUZUNG_MS = 180000, HALT_M = 30;
const HALT_GRUENDE = { panne: ['🔧', 'Panne'], tanken: ['⛽', 'Tanken'], pause: ['☕', 'Pause'], '': ['⏸', 'steht'] };
const halt = { anker: null, ankerT: 0, seit: 0, grund: '', gemeldet: false };
function haltFix(f) {
  const ll = L.latLng(f.lat, f.lon);
  if (!halt.anker || ll.distanceTo(halt.anker) > HALT_M) {
    halt.anker = ll; halt.ankerT = f.t;
    if (halt.gemeldet) haltWeiter();
    return;
  }
  if (halt.gemeldet || !posZiel()) return;
  // Geplanter Halt (Zwischenziel, Start, Ziel) zählt nicht; an Kreuzungen im Navi erst nach 3 min (Ampel, Schranke)
  if (waypoints.some(w => w.latlng && !w.shaping && w.latlng.distanceTo(ll) < 150)) return;
  const kreuzung = nav.on && routeManeuvers.some(m => Math.abs(m.km - nav.km) < 0.05);
  if (f.t - halt.ankerT < (kreuzung ? HALT_KREUZUNG_MS : HALT_MS)) return;
  haltMelden('', halt.ankerT);
}
function haltMelden(grund, seit = Date.now()) {
  if (!halt.gemeldet) halt.seit = seit;
  halt.grund = grund; halt.gemeldet = true; pos.sofort = true;
  haltLeiste();
  pushHalt(grund);
}
function haltWeiter() {
  halt.gemeldet = false; halt.grund = ''; halt.seit = 0; pos.sofort = true;
  halt.anker = pos.fix ? L.latLng(pos.fix.lat, pos.fix.lon) : null; halt.ankerT = Date.now();
  haltLeiste();
}
function haltLeiste() {
  const an = !!posZiel();
  $('haltBar').hidden = !an;
  $('haltBar').innerHTML = halt.gemeldet
    ? `<span>${HALT_GRUENDE[halt.grund][0]} ${halt.grund ? HALT_GRUENDE[halt.grund][1] : 'Du stehst'} · gemeldet</span>` +
      Object.entries(HALT_GRUENDE).filter(([k]) => k && k !== halt.grund).map(([k, [i, t]]) => `<button data-halt="${k}" title="${t}">${i}</button>`).join('') +
      '<button data-halt="weiter" title="Weiterfahren, Hinweis aufheben">▶ weiter</button>'
    : Object.entries(HALT_GRUENDE).filter(([k]) => k).map(([k, [i, t]]) => `<button data-halt="${k}" title="${t} melden">${i}</button>`).join('') +
      '<button data-halt="treff" title="Treffpunkt 5–10 km voraus vorschlagen">🤝</button>';
}
$('haltBar').onclick = e => {
  const k = e.target.closest('[data-halt]')?.dataset.halt;
  if (k === 'weiter') haltWeiter(); else if (k === 'treff') treffVorschlagen(); else if (k in HALT_GRUENDE) haltMelden(k);
  if (k === 'panne') panneOeffnen();
};
const haltText = x => {
  const [i, t] = HALT_GRUENDE[x.halt.g], min = Math.max(1, Math.round((Date.now() / 1000 - x.halt.s) / 60));
  let wo = '';
  if (routeCoords) {
    const at = locateOnRoute(x.lat, x.lon);
    if (at.dist < 300) {
      const ich = nav.on ? nav.km : pos.fix ? locateOnRoute(pos.fix.lat, pos.fix.lon) : null;
      const d = ich == null ? null : at.km - (typeof ich === 'number' ? ich : ich.dist < 300 ? ich.km : NaN);
      wo = ` · bei km ${at.km.toFixed(0)}` + (Number.isFinite(d) && Math.abs(d) >= 0.2 ? ` (${Math.abs(d).toFixed(1).replace('.', ',')} km ${d < 0 ? 'hinter' : 'vor'} dir)` : '');
    }
  }
  return `${i} ${x.halt.g ? t : 'steht'} seit ${min} min${wo}`;
};
// Neue Halte oder neuer Grund: im Navi ansagen, Panne immer
function haltEmpfangen(x) {
  const neu = x.halt && (!x.haltAlt || x.haltAlt.g !== x.halt.g);
  if (neu && (nav.on || x.halt.g === 'panne')) say(`${x.name} ${x.halt.g === 'panne' ? 'hat eine Panne' : x.halt.g === 'tanken' ? 'hält zum Tanken' : x.halt.g === 'pause' ? 'macht Pause' : 'steht'}`);
  if (neu) x.haltZu = false;
  gruppeZeigen();
}

// ---- Treffpunkt: 5–10 km voraus auf der eigenen Route, lieber Rastplatz oder Parkplatz, sonst Tankstelle, sonst km-Punkt
const TREFF_VON = 5, TREFF_BIS = 10, TREFF_MS = 3 * 3600000;
const gruppe = { eigen: null, tp: null, layer: L.layerGroup().addTo(map), vorschlaege: [], i: 0 };
async function treffVorschlagen() {
  if (!routeCoords) { $('gruppeInfo').innerHTML = '<span>🤝 Erst eine Route planen</span>'; return; }
  const total = routeKm.at(-1), ich = nav.on ? nav.km : pos.fix ? locateOnRoute(pos.fix.lat, pos.fix.lon).km : 0;
  const von = Math.min(total, ich + TREFF_VON), bis = Math.min(total, ich + TREFF_BIS), mitte = (von + bis) / 2;
  const abschnitt = routeCoords.filter((_, i) => routeKm[i] >= von - 0.2 && routeKm[i] <= bis + 0.2);
  let els = [];
  if (abschnitt.length > 1) {
    const q = `[out:json][timeout:15];(nwr[highway~"^(rest_area|services)$"](around:250,${simplify(abschnitt, 50).map(([a, b]) => `${a.toFixed(5)},${b.toFixed(5)}`).join(',')});` +
      `nwr[amenity~"^(parking|fuel)$"](around:250,${simplify(abschnitt, 50).map(([a, b]) => `${a.toFixed(5)},${b.toFixed(5)}`).join(',')}););out center tags;`;
    $('gruppeInfo').innerHTML = '<span>🤝 Suche Treffpunkt …</span>';
    els = (await overpassFetch(q, () => {}, () => false).catch(() => null))?.elements || [];
  }
  const rang = t => t.highway === 'rest_area' || t.highway === 'services' ? 0 : t.amenity === 'parking' ? 1 : 2;
  gruppe.vorschlaege = els.map(el => ({ la: el.lat ?? el.center?.lat, lo: el.lon ?? el.center?.lon, t: el.tags || {} })).filter(v => v.la != null)
    .map(v => ({ ...v, km: locateOnRoute(v.la, v.lo).km })).filter(v => v.km >= von - 0.3 && v.km <= bis + 0.3)
    .sort((a, b) => rang(a.t) - rang(b.t) || Math.abs(a.km - mitte) - Math.abs(b.km - mitte))
    .map(v => ({ la: +v.la.toFixed(5), lo: +v.lo.toFixed(5), n: v.t.name || (rang(v.t) === 0 ? 'Rastplatz' : rang(v.t) === 1 ? 'Parkplatz' : v.t.brand || 'Tankstelle') }));
  const p = pointAtKm(mitte), pl = Array.isArray(p) ? p : [p.lat, p.lng];
  gruppe.vorschlaege.push({ la: +pl[0].toFixed(5), lo: +pl[1].toFixed(5), n: 'Punkt an der Route' });
  gruppe.i = 0;
  treffZeigenVorschlag();
}
function treffZeigenVorschlag() {
  const v = gruppe.vorschlaege[gruppe.i];
  if (!v) return;
  const box = document.createElement('div');
  box.innerHTML = `<b>🤝 Treffpunkt?</b><br>${escapeHtml(v.n)}${treffWann(v)}`;
  box.append(menuBox([['senden', 'An die Gruppe senden'], ...(gruppe.i < gruppe.vorschlaege.length - 1 ? [['weiter', 'Anderer Vorschlag']] : [])], act => {
    if (act === 'weiter') { gruppe.i++; treffZeigenVorschlag(); return; }
    gruppe.eigen = { ...v, bis: Math.floor((Date.now() + TREFF_MS) / 1000) };
    treffEmpfangen(gruppe.eigen, talkName() || 'ich');
    pos.sofort = true;
    pushTreff(gruppe.eigen);
  }, 'senden'));
  L.popup({ minWidth: 200 }).setLatLng([v.la, v.lo]).setContent(box).openOn(map);
  $('gruppeInfo').innerHTML = '';
}
// Fahrzeit bis zum Treffpunkt: auf der eigenen Route ab der eigenen Position, sonst Luftlinie
function treffWann(v) {
  if (!routeCoords) return '';
  const at = locateOnRoute(v.la, v.lo), ich = nav.on ? nav.km : pos.fix ? locateOnRoute(pos.fix.lat, pos.fix.lon).km : 0;
  if (at.dist > 300 || at.km < ich) return pos.fix ? ` · ${(L.latLng(pos.fix.lat, pos.fix.lon).distanceTo([v.la, v.lo]) / 1000).toFixed(1).replace('.', ',')} km Luftlinie` : '';
  return ` · km ${at.km.toFixed(0)} · ca. ${durText((at.km - ich) / (routeKmh || 35) * 3600)}`;
}
function treffEmpfangen(tp, von) {
  if (!(Math.abs(tp?.la) <= 90 && Math.abs(tp?.lo) <= 180) || !(tp.bis * 1000 > Date.now())) return;
  if (gruppe.tp && gruppe.tp.la === tp.la && gruppe.tp.lo === tp.lo) return;
  gruppe.tp = { la: tp.la, lo: tp.lo, n: String(tp.n || 'Treffpunkt').slice(0, 60), bis: tp.bis, von };
  gruppe.layer.clearLayers();
  const ll = L.latLng(gruppe.tp.la, gruppe.tp.lo);
  L.marker(ll, { zIndexOffset: 800, icon: L.divIcon({ className: 'poi-icon treff', html: '🤝', iconSize: [28, 28] }) })
    .bindPopup(() => {
      const box = document.createElement('div');
      box.innerHTML = `<b>🤝 ${escapeHtml(gruppe.tp.n)}</b><br>Treffpunkt von ${escapeHtml(gruppe.tp.von)}${treffWann(gruppe.tp)}`;
      box.append(menuBox([['via', 'Als Halt übernehmen'], ['weg', 'Ausblenden']], act => {
        if (act === 'weg') { gruppe.tp = null; gruppe.layer.clearLayers(); gruppeZeigen(); return; }
        changeWaypoints(() => { insertVia(ll); waypoints.find(w => w.latlng === ll).text = '🤝 ' + gruppe.tp.n; });
      }, 'via'));
      return box;
    }, { minWidth: 200 }).addTo(gruppe.layer);
  if (nav.on) say(`Treffpunkt: ${gruppe.tp.n}`);
  gruppeZeigen();
}
// Hinweise über der Sprechtaste: wer steht, und der Treffpunkt mit Fahrzeit; antippen zeigt den Ort
function gruppeZeigen() {
  if (gruppe.tp && (gruppe.tp.bis * 1000 < Date.now() || pos.fix && L.latLng(pos.fix.lat, pos.fix.lon).distanceTo([gruppe.tp.la, gruppe.tp.lo]) < 100 && !nav.peek)) {
    if (gruppe.tp.bis * 1000 < Date.now()) { gruppe.tp = null; gruppe.layer.clearLayers(); }
  }
  const zeilen = [...pos.leute].filter(([, x]) => x.halt && !x.haltZu)
    .map(([pk, x]) => `<span class="halt-${x.halt.g || 'steht'}" data-pk="${pk}"><b>${escapeHtml(x.name)}</b>${x.sp?.length ? ` <small>${x.sp.join(' ')}</small>` : ''} ${haltText(x)}${x.halt.g === 'panne' ? `<button data-panne="${pk}" title="Werkstätten am Pannenort">🔧</button>` : ''}<button data-zu="${pk}" title="Ausblenden">✕</button></span>`);
  if (gruppe.tp) zeilen.push(`<span data-treff>🤝 ${escapeHtml(gruppe.tp.n)}${treffWann(gruppe.tp)}</span>`);
  $('gruppeInfo').innerHTML = zeilen.join('');
}
$('gruppeInfo').onclick = e => {
  const zu = e.target.closest('[data-zu]')?.dataset.zu;
  if (zu) { const x = pos.leute.get(zu); if (x) x.haltZu = true; gruppeZeigen(); return; }
  const pa = pos.leute.get(e.target.closest('[data-panne]')?.dataset.panne);
  if (pa) { panneOeffnen([pa.lat, pa.lon, ''], pa.name); return; }
  const pk = e.target.closest('[data-pk]')?.dataset.pk, x = pk && pos.leute.get(pk);
  if (x) { map.setView([x.lat, x.lon], Math.max(map.getZoom(), 14)); x.marker.openPopup(); return; }
  if (e.target.closest('[data-treff]') && gruppe.tp) { map.setView([gruppe.tp.la, gruppe.tp.lo], Math.max(map.getZoom(), 14)); gruppe.layer.eachLayer(m => m.openPopup()); }
};
$('talkPtt').prepend($('gruppeInfo'), $('haltBar'));

// ---- Anzeige: Auswahl im Talk-Kasten, dezenter Hinweis auf der Karte über der Sprechtaste
function posZielText() {
  if (posPrefs.an === 'gruppe') return 'Gruppe';
  return talkKontakte.find(k => k.pk === posPrefs.an)?.name || posPrefs.an.slice(0, 8);
}
function posHinweis() {
  const an = posAktiv(), s = pos.stand, bis = new Date(posPrefs.bis).toTimeString().slice(0, 5);
  $('posChip').hidden = !an || !talkPrefs.on;
  $('posChip').textContent = `📍 ${s === 'teilt' ? `geteilt · ${posZielText()}` : s}`;
  $('posChip').classList.toggle('aus', s !== 'teilt');
  if ($('haltBar').hidden === !!posZiel()) haltLeiste();
  $('posChip').title = `Standort an ${posZielText()} bis ${bis} · tippen zum Beenden`;
  $('posStatus').textContent = !an ? 'Nur mit der Gruppe (Gruppen-Passwort) oder direkt an einen Kontakt, nie offen in die Region.'
    : `${s === 'teilt' ? 'Teilt' : s[0].toUpperCase() + s.slice(1)} · bis ${bis}${pos.gesendet ? ` · zuletzt ${new Date(pos.gesendet.zeit).toTimeString().slice(0, 5)}, an ${pos.gesendet.relays} Relays` : ''}`;
}
function posFormular() {
  const sel = $('posAn'), pw = !!talkPrefs.pw;
  const kont = talkKontakte.some(k => k.pk === posPrefs.an) || !/^[0-9a-f]{64}$/.test(posPrefs.an) ? talkKontakte
    : [{ pk: posPrefs.an, name: posPrefs.an.slice(0, 8) }, ...talkKontakte];
  sel.innerHTML = `<option value="">aus</option><option value="gruppe"${pw ? '' : ' disabled'}>🔒 mit der Gruppe${pw ? '' : ' (braucht Passwort)'}</option>` +
    kont.map(k => `<option value="${k.pk}">🔒 nur an ${escapeHtml(k.name)}</option>`).join('');
  sel.value = posAktiv() ? posPrefs.an : '';
  $('posDauer').value = String(posPrefs.dauer);
  posHinweis();
}
$('posAn').onfocus = posFormular;
$('posAn').onchange = () => {
  if (!$('posAn').value) { posStopp(); return; }
  posPrefs.an = $('posAn').value; posPrefs.bis = Date.now() + posPrefs.dauer * 3600000; savePos();
  pos.gesendet = null; posTakt();
};
$('posDauer').onchange = () => {
  posPrefs.dauer = +$('posDauer').value;
  if (posAktiv()) posPrefs.bis = Date.now() + posPrefs.dauer * 3600000;
  savePos(); posHinweis();
};
$('posChip').onclick = () => { if (confirm('Standort nicht mehr teilen?')) posStopp(); };
$('talkPtt').prepend($('posChip'));
// Beim Zurückkommen in die App gleich senden, damit die anderen nicht bis zum nächsten Takt warten
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { pos.gesendet &&= { ...pos.gesendet, zeit: 0 }; posTakt(); } });

setInterval(() => {
  if (!talkPrefs.on || !talk.mod) { if (pos.netz) { pos.netz = null; pos.leute.clear(); pos.layer.clearLayers(); } posHinweis(); return; }
  if (!pos.secp) import(new URL('talk/secp256k1.js', document.baseURI).href).then(m => pos.secp = m).catch(() => {});
  posNetz();
  posTakt();
}, 1000);
setInterval(posAufraeumen, 15000);
posFormular();
