// --- Push an die Talk-Gruppe über den eigenen Server (api/push.php): Panne/Tanken/Pause, Treffpunkt, Kurznachricht.
// Ende-zu-Ende: Kennung und Schlüssel werden aus dem Gruppen-Passwort abgeleitet (PBKDF2), der Server sieht nur
// die Kennung und verschlüsselte Daten. Der Schlüssel liegt nicht auslesbar in IndexedDB, damit der Service Worker
// die Nachricht auch bei geschlossener App entschlüsseln und anzeigen kann.
const PUSH_DB = 'scooterways-push', PUSH_ITER = 150000;
const pushPrefs = Object.assign({ an: false, halt: true, treff: true, post: true, gruppe: '', postfach: '' }, store.get('push', {}));
const savePush = () => store.set('push', pushPrefs);
const pushEnc = new TextEncoder();
let pushAbo = null, pushSchluessel = null;

function pushDb() {
  return new Promise((ok, fehler) => {
    const r = indexedDB.open(PUSH_DB, 2);
    r.onupgradeneeded = () => pushDbAnlegen(r.result);
    r.onsuccess = () => ok(r.result); r.onerror = () => fehler(r.error);
  });
}
// k: Gruppenschlüssel, post: eingegangene Sprachpost (vom Service Worker), namen: Talk-Kontakte für die Benachrichtigung
function pushDbAnlegen(db) {
  for (const [s, key] of [['k', 'g'], ['post', 'id'], ['namen', 'pk']]) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: key });
}
async function pushDbTx(store, fn) {
  const db = await pushDb();
  try {
    return await new Promise((ok, fehler) => {
      const tx = db.transaction(store, 'readwrite'), os = tx.objectStore(store);
      let erg; const r = fn(os);
      if (r) r.onsuccess = () => { erg = r.result; };
      tx.oncomplete = () => ok(erg); tx.onerror = () => fehler(tx.error);
    });
  } finally { db.close(); }
}
const pushDbSchreiben = (eintrag, leeren) => pushDbTx('k', os => { if (leeren) os.clear(); if (eintrag) os.put(eintrag); });
async function pushAbleiten(pw) {
  const basis = await crypto.subtle.importKey('raw', pushEnc.encode(pw), 'PBKDF2', false, ['deriveBits', 'deriveKey']);
  const p = salz => ({ name: 'PBKDF2', hash: 'SHA-256', iterations: PUSH_ITER, salt: pushEnc.encode(salz) });
  const bits = new Uint8Array(await crypto.subtle.deriveBits(p('scooterways-push-gruppe'), basis, 256));
  const key = await crypto.subtle.deriveKey(p('scooterways-push-schluessel'), basis, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { gruppe: [...bits].map(b => b.toString(16).padStart(2, '0')).join(''), key };
}
const pushB64 = b => btoa(String.fromCharCode(...new Uint8Array(b)));
const pushVapid = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
async function pushApi(daten) {
  const res = await fetch(API_URL + 'push.php', { method: 'POST', body: JSON.stringify(daten) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.fehler || `HTTP ${res.status}`);
  return d;
}
const pushMoeglich = () => 'PushManager' in window && 'serviceWorker' in navigator && isSecureContext;

// Einschalten oder nach Passwortwechsel neu anmelden; Abschalten meldet beim Server ab und löscht den Schlüssel
async function pushEinrichten() {
  if (!pushPrefs.an) return pushAus();
  if (!pushMoeglich()) throw new Error('Dieser Browser kann kein Push');
  if (!serverKonfig?.vapid) throw new Error('eigener Server nicht eingerichtet');
  if (await Notification.requestPermission() !== 'granted') throw new Error('Benachrichtigungen sind im Browser blockiert');
  const reg = await navigator.serviceWorker.ready;
  pushAbo = await reg.pushManager.getSubscription() ||
    await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushVapid(serverKonfig.vapid) });
  // Gruppe nur mit Gruppen-Passwort; die Sprachpost (Postfach) meldet pushPostfach an, sobald Talk läuft
  if (talkPrefs.pw) {
    const { gruppe, key } = await pushAbleiten(talkPrefs.pw);
    await pushApi({ aktion: 'abo', gruppe, abo: pushAbo.toJSON(), name: talkName() });
    await pushDbSchreiben({ g: gruppe.slice(0, 16), key }, true);
    pushSchluessel = key; pushPrefs.gruppe = gruppe;
  } else {
    if (pushPrefs.gruppe) await pushApi({ aktion: 'weg', endpoint: pushAbo.endpoint, gruppe: pushPrefs.gruppe }).catch(() => {});
    await pushDbSchreiben(null, true); pushSchluessel = null; pushPrefs.gruppe = '';
  }
  pushPrefs.postfach = ''; savePush();
  await pushPostfach();
}
async function pushAus() {
  const reg = pushMoeglich() && await navigator.serviceWorker.getRegistration();
  const abo = reg && await reg.pushManager.getSubscription();
  if (abo) { await pushApi({ aktion: 'weg', endpoint: abo.endpoint }).catch(() => {}); await abo.unsubscribe().catch(() => {}); }
  await pushDbSchreiben(null, true).catch(() => {});
  pushAbo = pushSchluessel = null; pushPrefs.gruppe = pushPrefs.postfach = ''; savePush();
}
// Beim Start: Schlüssel und Abo wiederfinden; hat sich das Gruppen-Passwort geändert, neu anmelden
async function pushPruefen() {
  if (!pushPrefs.an || !pushMoeglich()) return pushZeigen();
  try {
    const neu = talkPrefs.pw ? await pushAbleiten(talkPrefs.pw) : { gruppe: '', key: null };
    pushAbo = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    if (neu.gruppe !== pushPrefs.gruppe || !pushAbo) await pushEinrichten(); else pushSchluessel = neu.key;
    pushZeigen();
  } catch (err) { pushZeigen('⚠ ' + err.message); }
}

// Nachricht verschlüsseln und an die Gruppe; still, wenn Push aus ist
async function pushSenden(n, eilig = false) {
  if (!pushPrefs.an || !pushSchluessel || !pushAbo || !serverAn()) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, pushSchluessel, pushEnc.encode(JSON.stringify({ ...n, n: talkName() || '?', z: Math.floor(Date.now() / 1000) })));
  return pushApi({ aktion: 'senden', gruppe: pushPrefs.gruppe, daten: { iv: pushB64(iv), ct: pushB64(ct) }, ich: pushAbo.endpoint, eilig });
}
// Aufrufe aus 23-standort
function pushHalt(grund) {
  if (!pushPrefs.halt || !grund) return;
  pushSenden({ a: 'halt', g: grund, la: pos.fix && +pos.fix.lat.toFixed(5), lo: pos.fix && +pos.fix.lon.toFixed(5) }, grund === 'panne').catch(() => {});
}
function pushTreff(tp) {
  if (!pushPrefs.treff || !tp) return;
  pushSenden({ a: 'treff', t: tp.n, la: tp.la, lo: tp.lo, bis: tp.bis }).catch(() => {});
}

function pushZeigen(meldung) {
  const ok = !!serverKonfig?.vapid && pushMoeglich();
  $('pushBox').hidden = !ok;
  $('pushAn').checked = pushPrefs.an;
  $('pushSenden').disabled = !pushPrefs.an || !pushSchluessel;
  $('pushHint').textContent = meldung || (!pushPrefs.an ? '' : [pushSchluessel ? 'Gruppe ' + pushPrefs.gruppe.slice(0, 6) : talkPrefs.pw ? 'wird eingerichtet …' : 'Gruppe: braucht ein Gruppen-Passwort bei Talk',
    pushPrefs.postfach ? 'Sprachpost an' : pushPrefs.post ? 'Sprachpost: sobald Talk läuft' : ''].filter(Boolean).join(' · '));
  $('pushSummary').textContent = pushPrefs.an && (pushSchluessel || pushPrefs.postfach) ? 'an' : '';
}
$('pushHalt').checked = pushPrefs.halt; $('pushTreff').checked = pushPrefs.treff; $('pushPost').checked = pushPrefs.post;
$('pushPost').onchange = async () => {
  pushPrefs.post = $('pushPost').checked; savePush();
  if (!pushPrefs.post && pushPrefs.postfach && pushAbo) { await pushApi({ aktion: 'weg', endpoint: pushAbo.endpoint, gruppe: pushPrefs.postfach }).catch(() => {}); pushPrefs.postfach = ''; savePush(); }
  pushPostfach().catch(() => {}); pushZeigen();
};
$('pushHalt').onchange = () => { pushPrefs.halt = $('pushHalt').checked; savePush(); };
$('pushTreff').onchange = () => { pushPrefs.treff = $('pushTreff').checked; savePush(); };
$('pushAn').onchange = async () => {
  pushPrefs.an = $('pushAn').checked; savePush(); pushZeigen(pushPrefs.an ? 'wird eingerichtet …' : '');
  try { await pushEinrichten(); pushZeigen(); }
  catch (err) { pushPrefs.an = false; savePush(); pushZeigen('⚠ ' + err.message); }
};
$('pushSenden').onclick = async () => {
  const t = $('pushText').value.trim().slice(0, 200);
  if (!t) return;
  $('pushSenden').disabled = true;
  try { const r = await pushSenden({ a: 'text', t }); $('pushText').value = ''; pushZeigen(`gesendet an ${r?.an ?? 0} von ${r?.von ?? 0} Geräten`); }
  catch (err) { pushZeigen('⚠ ' + err.message); }
  finally { $('pushSenden').disabled = false; }
};
$('pushSchnell').onclick = e => { const t = e.target.closest('[data-t]')?.dataset.t; if (t) { $('pushText').value = t; $('pushSenden').click(); } };
$('talkPw').addEventListener('change', () => pushPruefen());
document.addEventListener('serverkonfig', () => pushZeigen());
// Klick auf eine Benachrichtigung bei offener App: Ort zeigen
navigator.serviceWorker?.addEventListener('message', e => { if (e.data?.ort) map.setView(e.data.ort, Math.max(map.getZoom(), 14)); });
const pushOrt = new URLSearchParams(location.search).get('ort')?.split(',').map(Number);
if (pushOrt?.length === 2 && pushOrt.every(Number.isFinite)) { map.setView(pushOrt, 14); history.replaceState(null, '', location.pathname + location.hash); }
pushZeigen();
pushPruefen();

// ---- Sprachpost: private Durchsagen an einen Kontakt zusätzlich als kurze Codec2-1200-Nachricht per Push.
// Das Postfach ist der Hash des eigenen Talk-Schlüssels; der Inhalt ist mit NIP-44 zwischen beiden versiegelt,
// öffnen kann ihn nur die App des Empfängers (der Service Worker legt ihn nur ab und meldet ihn).
const POST_CODEC = 6, POST_MAX_S = 14, POST_TAGE = 7, POST_RATE = 8000;
const postfachVon = async pk => [...new Uint8Array(await crypto.subtle.digest('SHA-256', pushEnc.encode('scooterways-dm|' + pk)))].map(b => b.toString(16).padStart(2, '0')).join('');
const postAn = () => pushPrefs.an && pushPrefs.post && !!pushAbo && serverAn();
async function pushPostfach() {
  const pk = talk.netz?.pk;
  if (!postAn() || !pk) return;
  const pf = await postfachVon(pk);
  if (pf === pushPrefs.postfach) return;
  await pushApi({ aktion: 'abo', art: 'post', gruppe: pf, abo: pushAbo.toJSON(), name: talkName() });
  pushPrefs.postfach = pf; savePush(); pushZeigen();
}
// Aus 22-talk beim Loslassen einer privaten Durchsage: 8-kHz-Blöcke des Mikrofons
async function pushSprache(an, bloecke) {
  if (!postAn() || !talk.netz?.pk) return;
  try {
    const codec = new Sprechfunk.Codec(POST_CODEC), n = codec.n;
    const alle = new Int16Array(Math.min(bloecke.reduce((s, b) => s + b.length, 0), POST_MAX_S * POST_RATE));
    let o = 0; for (const b of bloecke) { if (o >= alle.length) break; alle.set(b.subarray(0, alle.length - o), o); o += b.length; }
    const rahmen = Math.floor(alle.length / n), roh = new Uint8Array(2 + rahmen * codec.nb);
    roh[0] = 1; roh[1] = POST_CODEC;
    for (let i = 0; i < rahmen; i++) roh.set(codec.kodieren(alle.subarray(i * n, (i + 1) * n)), 2 + i * codec.nb);
    codec.frei();
    const ct = await talk.mod.versiegeln(await talk.mod.unterhaltung(talk.netz.sk, an), roh);
    const r = await pushApi({ aktion: 'senden', art: 'dm', gruppe: await postfachVon(an), von: talk.netz.pk, daten: { ct }, ich: pushAbo.endpoint });
    const wer = talkKontakte.find(k => k.pk === an)?.name || an.slice(0, 8);
    talkLog(r.von ? `📮 Sprachpost an ${wer} (${(rahmen * codec.ms / 1000).toFixed(0)} s) per Push` : `📮 ${wer} hat keine Sprachpost eingeschaltet`);
  } catch (err) { talkLog('⚠️ Sprachpost: ' + err.message); }
}
// Live gehörte private Durchsagen: kommt dieselbe Nachricht danach als Sprachpost, gilt sie als gehört
const postLive = new Map();
function pushLiveGehoert(pk) { postLive.set(pk, Date.now()); }

async function postListe() {
  const alle = (await pushDbTx('post', os => os.getAll()).catch(() => [])) || [];
  const alt = Date.now() - POST_TAGE * 86400000;
  for (const p of alle.filter(p => p.t < alt)) await pushDbTx('post', os => os.delete(p.id)).catch(() => {});
  return alle.filter(p => p.t >= alt).sort((a, b) => b.t - a.t);
}
async function postZeigen(neu) {
  const liste = await postListe();
  for (const p of liste) if (!p.gehoert && postLive.get(p.von) > p.t - 120000) { p.gehoert = true; await pushDbTx('post', os => os.put(p)).catch(() => {}); }
  $('postBox').hidden = !liste.length;
  $('postListe').innerHTML = liste.map(p => `<li class="${p.gehoert ? '' : 'neu'}${p.id === neu ? ' jetzt' : ''}">` +
    `<button data-spiel="${p.id}" title="Abhören">▶</button> ${escapeHtml(talkKontakte.find(k => k.pk === p.von)?.name || p.von.slice(0, 8))}` +
    ` <span class="hint">${new Date(p.t).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>` +
    `<button data-weg="${p.id}" class="secondary" title="Löschen">✕</button></li>`).join('');
  const offen = liste.filter(p => !p.gehoert).length;
  $('postZahl').textContent = offen ? ` (${offen} neu)` : '';
}
async function postSpielen(id) {
  const p = (await postListe()).find(x => x.id === id);
  if (!p) return;
  try {
    await talkLaden();
    const sk = talk.netz?.sk || talk.mod.unhex(talkSk());
    const roh = await talk.mod.oeffnen(await talk.mod.unterhaltung(sk, p.von), p.ct);
    if (!roh || roh[0] !== 1 || !Sprechfunk.CODECS[roh[1]]) throw new Error('nicht lesbar');
    const codec = new Sprechfunk.Codec(roh[1]), nb = codec.nb, rahmen = Math.floor((roh.length - 2) / nb);
    const pcm = new Float32Array(rahmen * codec.n);
    for (let i = 0; i < rahmen; i++) pcm.set(codec.dekodieren(roh.subarray(2 + i * nb, 2 + (i + 1) * nb)), i * codec.n);
    codec.frei();
    // Ohne Berührung (frisch aus der Benachrichtigung geöffnet) startet der Ton nicht: dann auf den ▶-Tipp warten
    const c = await Promise.race([Sprechfunk.audio(), new Promise(ok => setTimeout(ok, 800))]);
    if (c?.state !== 'running') { $('postZahl').textContent = ' · ▶ tippen zum Abhören'; return; }
    const buf = c.createBuffer(1, pcm.length, POST_RATE);
    buf.copyToChannel(pcm, 0);
    const q = c.createBufferSource(); q.buffer = buf; q.connect(c.destination);
    talk.spieltBis = Date.now() + buf.duration * 1000 + 450; // VOX sperren, solange es läuft
    q.start();
    p.gehoert = true; await pushDbTx('post', os => os.put(p));
    talkKontaktMerken(p.von, talkKontakte.find(k => k.pk === p.von)?.name || p.von.slice(0, 8));
    postZeigen();
  } catch (err) { talkLog('⚠️ Sprachpost: ' + err.message); }
}
$('postListe').onclick = async e => {
  const s = e.target.closest('[data-spiel]')?.dataset.spiel, w = e.target.closest('[data-weg]')?.dataset.weg;
  if (s) postSpielen(s);
  if (w) { await pushDbTx('post', os => os.delete(w)).catch(() => {}); postZeigen(); }
};
// Namen der Kontakte für die Benachrichtigungen im Service Worker
let postNamenStand = '';
function postNamen() {
  const s = JSON.stringify(talkKontakte);
  if (s === postNamenStand) return;
  postNamenStand = s;
  pushDbTx('namen', os => { os.clear(); for (const k of talkKontakte) os.put(k); }).catch(() => {});
}
setInterval(() => { postNamen(); pushPostfach().catch(() => {}); }, 10000);
navigator.serviceWorker?.addEventListener('message', e => { if (e.data?.post) postZeigen(e.data.post).then(() => e.data.spielen && postSpielen(e.data.post)); });
const postParam = new URLSearchParams(location.search).get('post');
if (postParam) { history.replaceState(null, '', location.pathname + location.hash); postZeigen(postParam).then(() => postSpielen(postParam)); }
else postZeigen();
postNamen();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') postZeigen(); });
