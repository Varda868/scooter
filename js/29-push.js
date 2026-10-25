// --- Push an die Talk-Gruppe über den eigenen Server (api/push.php): Panne/Tanken/Pause, Treffpunkt, Kurznachricht.
// Ende-zu-Ende: Kennung und Schlüssel werden aus dem Gruppen-Passwort abgeleitet (PBKDF2), der Server sieht nur
// die Kennung und verschlüsselte Daten. Der Schlüssel liegt nicht auslesbar in IndexedDB, damit der Service Worker
// die Nachricht auch bei geschlossener App entschlüsseln und anzeigen kann.
const PUSH_DB = 'scooterways-push', PUSH_ITER = 150000;
const pushPrefs = Object.assign({ an: false, halt: true, treff: true, gruppe: '' }, store.get('push', {}));
const savePush = () => store.set('push', pushPrefs);
const pushEnc = new TextEncoder();
let pushAbo = null, pushSchluessel = null;

function pushDb() {
  return new Promise((ok, fehler) => {
    const r = indexedDB.open(PUSH_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('k', { keyPath: 'g' });
    r.onsuccess = () => ok(r.result); r.onerror = () => fehler(r.error);
  });
}
async function pushDbSchreiben(eintrag, leeren) {
  const db = await pushDb();
  await new Promise((ok, fehler) => {
    const tx = db.transaction('k', 'readwrite');
    if (leeren) tx.objectStore('k').clear();
    if (eintrag) tx.objectStore('k').put(eintrag);
    tx.oncomplete = ok; tx.onerror = () => fehler(tx.error);
  });
  db.close();
}
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
  if (!talkPrefs.pw) throw new Error('erst ein Gruppen-Passwort bei Talk setzen');
  if (await Notification.requestPermission() !== 'granted') throw new Error('Benachrichtigungen sind im Browser blockiert');
  const reg = await navigator.serviceWorker.ready;
  const { gruppe, key } = await pushAbleiten(talkPrefs.pw);
  pushAbo = await reg.pushManager.getSubscription() ||
    await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushVapid(serverKonfig.vapid) });
  await pushApi({ aktion: 'abo', gruppe, abo: pushAbo.toJSON(), name: talkName() });
  await pushDbSchreiben({ g: gruppe.slice(0, 16), key }, true);
  pushSchluessel = key; pushPrefs.gruppe = gruppe; savePush();
}
async function pushAus() {
  const reg = pushMoeglich() && await navigator.serviceWorker.getRegistration();
  const abo = reg && await reg.pushManager.getSubscription();
  if (abo) { await pushApi({ aktion: 'weg', endpoint: abo.endpoint }).catch(() => {}); await abo.unsubscribe().catch(() => {}); }
  await pushDbSchreiben(null, true).catch(() => {});
  pushAbo = pushSchluessel = null; pushPrefs.gruppe = ''; savePush();
}
// Beim Start: Schlüssel und Abo wiederfinden; hat sich das Gruppen-Passwort geändert, neu anmelden
async function pushPruefen() {
  if (!pushPrefs.an || !talkPrefs.pw || !pushMoeglich()) return pushZeigen();
  try {
    const { gruppe, key } = await pushAbleiten(talkPrefs.pw);
    pushAbo = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    if (gruppe !== pushPrefs.gruppe || !pushAbo) await pushEinrichten(); else pushSchluessel = key;
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
  $('pushHint').textContent = meldung || (!talkPrefs.pw ? 'braucht ein Gruppen-Passwort bei Talk' : pushPrefs.an ? (pushSchluessel ? 'an · Gruppe ' + pushPrefs.gruppe.slice(0, 6) : 'wird eingerichtet …') : '');
  $('pushSummary').textContent = pushPrefs.an && pushSchluessel ? 'an' : '';
}
$('pushHalt').checked = pushPrefs.halt; $('pushTreff').checked = pushPrefs.treff;
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
