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
  const e = await posSignieren(tags, await talk.mod.versiegeln(ck, posEnc.encode(JSON.stringify({ ...daten, n: talkName() }))));
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
  if (!(g?.ziel !== z || weg >= POS_WEIT_M && alt > 5000 || weg >= POS_NAH_M && alt >= POS_TAKT_MS || alt >= POS_HALT_MS)) return;
  pos.laeuft = true;
  try {
    const k = f.k != null && !isNaN(f.k) && f.v > 1 ? Math.round(f.k) : null;
    const r = await posSenden({ la: +f.lat.toFixed(5), lo: +f.lon.toFixed(5), v: f.v != null && f.v >= 0 ? Math.round(f.v * 3.6) : null, k, t: Math.floor(f.t / 1000) });
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
  if (d?.aus) { alt?.marker.remove(); pos.leute.delete(e.pubkey); return; }
  if (!(Math.abs(d?.la) <= 90 && Math.abs(d?.lo) <= 180)) return;
  const name = String(d.n || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 9) || e.pubkey.slice(0, 8);
  const x = alt || { marker: L.marker([d.la, d.lo], { zIndexOffset: 900 }).bindPopup(() => posPopup(e.pubkey), { minWidth: 180 }).addTo(pos.layer) };
  Object.assign(x, { lat: d.la, lon: d.lo, v: Number.isFinite(d.v) ? d.v : null, k: Number.isFinite(d.k) ? d.k : null, name, privat: !!p,
    zeit: e.created_at, fix: Number.isFinite(d.t) ? d.t : e.created_at });
  x.marker.setLatLng([d.la, d.lo]);
  pos.leute.set(e.pubkey, x);
  talkKontaktMerken(e.pubkey, name);
  posPfeil(x);
}
const posAlter = s => { const m = Math.round((Date.now() / 1000 - s) / 60); return m < 1 ? 'gerade' : m < 60 ? `vor ${m} min` : `vor ${Math.floor(m / 60)} h`; };
function posPfeil(x) {
  const grau = Date.now() / 1000 - x.fix > POS_ALT_MS / 1000;
  const html = `<div class="pos-pfeil${grau ? ' alt' : ''}${x.privat ? ' privat' : ''}"><span style="transform:rotate(${x.k != null ? x.k - 90 : -90}deg)">${x.k != null ? '➤' : '●'}</span></div>` +
      `<div class="pos-name${grau ? ' alt' : ''}">${escapeHtml(x.name)}</div>`;
  if (html !== x.html) x.marker.setIcon(L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -12], html: x.html = html }));
}
function posPopup(pk) {
  const x = pos.leute.get(pk), box = document.createElement('div');
  if (!x) return box;
  const ich = pos.fix && posGps() ? L.latLng(pos.fix.lat, pos.fix.lon) : me.dot._map ? me.dot.getLatLng() : null;
  const m = ich ? ich.distanceTo([x.lat, x.lon]) : null;
  box.innerHTML = `<b>${x.privat ? '🔒 ' : ''}${escapeHtml(x.name)}</b><br>${posAlter(x.fix)}${x.v != null ? ` · ${x.v} km/h` : ''}` +
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
}

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
