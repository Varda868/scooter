// --- Talk: Sprechfunk für Gruppenfahrten über Nostr-Relays (wss), mit Taste oder VOX, ohne Funkgerät.
// Codec2, Wiedergabe, VOX und Netz stammen unverändert aus der bcon-app (talk/, AGPL-3.0, Herkunft talk/QUELLE.md);
// der Ablauf hier ist eine schlanke Fassung von bcon-app app.js (talk/APP_AUSZUG.js). Geladen wird erst, wenn Talk an ist.
// Jede Durchsage geht als Ganzes (signiert, Kompaktform, Art 4420) an die Relays: Verzögerung etwa die Sprechdauer.
const TALK_RELAYS = ['wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.mom'];
const TALK_CODEC = 3, TALK_MAX_MS = 30000, TALK_ABLAUF_S = 3600; // Codec2 1600 wie der allgemeine Kanal; Relays löschen nach 1 h
const talkPrefs = Object.assign({ on: false, name: '', plz: '', pw: '', mode: 'ptt', empf: 12, halt: 1000, relays: TALK_RELAYS.join(' ') }, store.get('talk', {}));
const talk = { mod: null, netz: null, lauf: 0, mic: null, empf: null, vox: null, tx: null, warte: [], spielt: false, slot: 0,
  schon: new Set(), sperreBis: 0, voxLetzt: null, micFehler: '', hoert: '' };
const saveTalk = () => store.set('talk', talkPrefs);
const talkName = () => { const n = talkPrefs.name.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 9); return n.length >= 3 ? n : ''; };
const talkBereit = () => !!talk.netz && talk.netz.verbunden > 0;

let talkLibs = null;
const talkScript = src => new Promise((ok, fail) => {
  const s = document.createElement('script');
  s.src = src; s.onload = ok; s.onerror = () => fail(new Error(src + ' nicht gefunden'));
  document.head.append(s);
});
function talkLaden() {
  return talkLibs ||= (async () => {
    for (const f of ['codec2.js', 'sprechfunk.js', 'vox.js']) await talkScript('talk/' + f);
    talk.mod = await import(new URL('talk/netz.js', document.baseURI).href);
    talk.empf = new Sprechfunk.Empfaenger();
    talk.mic = new Sprechfunk.Mikrofon();
    talk.mic.beiRahmen = talkRahmen;
    talk.vox = new Vox.Erkenner({ empf: talkPrefs.empf, halt_ms: talkPrefs.halt });
    await Sprechfunk.laden();
  })().catch(e => { talkLibs = null; throw e; });
}
// Eigener Schlüssel dieser App, bleibt im Browser
function talkSk() {
  let sk = null;
  try { sk = localStorage.getItem('scooterways.talkSk'); } catch {}
  if (!/^[0-9a-f]{64}$/.test(sk || '')) {
    sk = Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem('scooterways.talkSk', sk); } catch {}
  }
  return sk;
}

// Jeder Start bekommt eine Nummer; ein älterer, der noch auf Laden oder Passwort-Ableitung wartet, gibt danach auf
async function talkStart() {
  const lauf = ++talk.lauf;
  talkLoslassen();
  talk.netz?.stoppen(); talk.netz = null;
  talkZeigen();
  if (!talkPrefs.on) { talk.mic?.schliessen(); return; }
  if (!talk.mod) $('talkStatus').textContent = 'Lade Talk …';
  try { await talkLaden(); } catch (e) { $('talkStatus').textContent = '⚠️ Talk lädt nicht: ' + e.message; return; }
  if (lauf !== talk.lauf) return;
  const rg = talk.mod.region(talkPrefs.plz).slice(0, 5);
  if (!rg) { $('talkStatus').textContent = '⚠️ Bitte PLZ-Region eintragen (gleiche für alle in der Gruppe).'; return; }
  const gruppe = talkPrefs.pw ? await talk.mod.gruppeSchluessel(talkPrefs.pw) : null;
  if (lauf !== talk.lauf || !talkPrefs.on) return;
  const relays = talkPrefs.relays.split(/\s+/).filter(u => /^wss:\/\/\S+$/.test(u));
  talk.netz = new talk.mod.Netz({ relays, sk: talk.mod.unhex(talkSk()), region: rg, gruppe, ablaufS: TALK_ABLAUF_S,
    beiDurchsage: talkEinreihen, beiStand: talkZeigen });
  talk.netz.stand();
  talkVoxEinstellen();
}

// ---- Senden: Taste halten, tippen (an/aus) oder VOX. Höchstens 30 s je Durchsage.
async function talkDruecken(vonVox = false) {
  if (talk.tx || !talkBereit()) return;
  const t = talk.tx = { vox: vonVox, ms: 0, vorlauf: null };
  talkZeigen();
  try {
    const codec = new Sprechfunk.Codec(TALK_CODEC);
    await talk.mic.oeffnen(codec.n);
    if (talk.tx !== t) { codec.frei(); return; }
    t.a = new talk.mod.Aufnahme(talk.netz.sk, { codec: TALK_CODEC, flags: 0, ziel: talk.mod.ALLE, zeit: Math.floor(Date.now() / 1000),
      name: talkName(), region: talk.netz.region, gruppe: 0 }, codec.nb);
    t.codec = codec;
    // VOX: Wortanfang aus dem Vorlauf nachschieben (Blöcke haben schon die Größe dieses Codecs)
    for (const b of t.vorlauf || []) if (b.length === codec.n) { t.a.rahmen(codec.kodieren(b)); t.ms += codec.ms; }
    t.vorlauf = null;
    t.bis = setTimeout(talkLoslassen, TALK_MAX_MS);
    t.uhr = setInterval(talkZeigen, 1000);
    talkZeigen();
  } catch (e) {
    talk.tx = null;
    talk.micFehler = e.name === 'NotAllowedError' ? 'Mikrofon nicht erlaubt' : 'Mikrofon: ' + e.message;
    talkZeigen();
  }
}
function talkLoslassen() {
  const t = talk.tx;
  if (!t) return;
  talk.tx = null;
  clearTimeout(t.bis); clearInterval(t.uhr);
  if (t.codec) { t.codec.frei(); if (t.ms >= 300) talkSenden(t.a, t.ms); }
  talk.vox?.zuruecksetzen();
  talk.sperreBis = Date.now() + 500;
  talkZeigen();
}
async function talkSenden(a, ms) {
  try {
    const k = await a.fertig();
    if (!k || !talk.netz) return;
    const n = await talk.netz.senden(k, Math.floor(Date.now() / 1000));
    talkLog(n ? `ich · ${(ms / 1000).toFixed(1).replace('.', ',')} s · an ${n} Relays` : '⚠️ von keinem Relay angenommen');
  } catch (e) { talkLog('⚠️ Senden: ' + e.message); }
}

// Ein Empfänger für alle Mikrofon-Blöcke: laufende Sendung kodieren, sonst VOX hören lassen
function talkRahmen(pcm) {
  const t = talk.tx;
  if (t?.codec) { t.a.rahmen(t.codec.kodieren(pcm)); t.ms += t.codec.ms; }
  else if (t?.vox) { (t.vorlauf ||= []).push(pcm.slice()); }
  if (talkPrefs.mode !== 'vox') return;
  // Gesperrt, solange etwas abgespielt wird (Lautsprecher/Headset käme ins Mikrofon) und kurz nach dem eigenen Ende
  if (t && !t.vox || !t && (Date.now() < talk.sperreBis || talk.empf.spielt() || !talkBereit())) { talk.vox.zuruecksetzen(); return; }
  const r = talk.voxLetzt = talk.vox.rahmen(pcm);
  if (r.ereignis === 'start' && !t) {
    const vor = talk.vox.vorlauf();
    talkDruecken(true);
    if (talk.tx) talk.tx.vorlauf = vor;
  } else if (r.ereignis === 'ende' && t?.vox) talkLoslassen();
}
// Für VOX bleibt das Mikrofon offen; ohne automatische Verstärkung (die hebt in Pausen das Rauschen)
function talkVoxEinstellen() {
  if (!talk.vox) return;
  talk.vox.empf = talkPrefs.empf; talk.vox.halt_ms = talkPrefs.halt;
  const agc = talkPrefs.mode !== 'vox';
  if (talk.mic.agc !== agc && !talk.tx) { talk.mic.agc = agc; talk.mic.schliessen(); }
  talk.vox.zuruecksetzen(true); talk.micFehler = '';
  talkMikro();
}
async function talkMikro() {
  if (!talkPrefs.on || talkPrefs.mode !== 'vox' || !talk.mic || talk.tx || talk.micFehler || !Sprechfunk.tonBereit()) return;
  const spur = talk.mic.spur;
  if (spur && spur.readyState === 'live' && !spur.muted) return;
  try { const c = new Sprechfunk.Codec(TALK_CODEC), n = c.n; c.frei(); await talk.mic.oeffnen(n); }
  catch (e) { talk.micFehler = e.name === 'NotAllowedError' ? 'Mikrofon nicht erlaubt' : 'Mikrofon: ' + e.message; }
  talkZeigen();
}

// ---- Empfang: ganze Durchsagen nacheinander abspielen; Warteschlange höchstens 5 Durchsagen oder 60 s
const talkDauer = d => d.pakete.length * 10 * (Sprechfunk.CODECS[d.kopf.codec]?.ms || 40);
function talkEinreihen(d) {
  if (talk.schon.has(d.kennung)) return;
  if (talk.schon.size > 2000) talk.schon.clear();
  talk.schon.add(d.kennung);
  if (talk.warte.some(x => x.kopf.schluessel === d.kopf.schluessel)) return;
  if (talk.warte.length >= 5 || talk.warte.reduce((s, x) => s + talkDauer(x), talkDauer(d)) > 60000) return talkLog('Durchsage verworfen, Warteschlange voll');
  talk.warte.push(d);
  talkWeiter();
}
async function talkWeiter() {
  if (talk.spielt) return;
  talk.spielt = true;
  while (talk.warte.length) await talkHoeren(talk.warte.shift()).catch(() => {});
  talk.spielt = false;
}
async function talkHoeren(d) {
  const k = d.kopf, c = Sprechfunk.CODECS[k.codec];
  if (!c || (!d.signatur && !d.fehlend)) return; // unbekannter Codec oder gefälschte Durchsage
  // Rufname nur, wenn der Kopf geprüft ist; sonst die ersten Stellen des Schlüssels
  const wer = (d.signatur || d.absender === k.schluessel) && k.name || k.schluessel.slice(0, 8);
  const slot = 200 + (talk.slot++ % 50);
  talk.hoert = wer; talkZeigen();
  talk.empf.beginnen(slot, k.codec, { sprecher: k.schluessel, weg: 'nostr' });
  await talk.empf.slots.get(slot)?.bereit;
  const nb = talk.empf.slots.get(slot)?.codec?.nb || 8;
  let ms = 0;
  d.pakete.forEach((p, i) => {
    const dauer = (p.length ? p.length / nb : 10) * c.ms, b = new Uint8Array(5 + p.length);
    b.set([0x50, slot, i + 1, dauer & 255, dauer >> 8]); b.set(p, 5);
    talk.empf.paket(b); ms += dauer;
  });
  await new Promise(r => setTimeout(r, ms + 300));
  talk.empf.beenden(slot);
  talk.hoert = '';
  talkLog(`${wer} · ${(ms / 1000).toFixed(1).replace('.', ',')} s${d.fehlend ? ` · ${d.fehlend} Lücken` : ''}`);
  talkZeigen();
}

// ---- Anzeige: Knopf auf der Karte (auch im Navi), Stand im Reiter Unterwegs
function talkLog(text) {
  const li = document.createElement('li');
  li.textContent = `${new Date().toTimeString().slice(0, 5)} ${text}`;
  $('talkLog').prepend(li);
  while ($('talkLog').children.length > 12) $('talkLog').lastChild.remove();
}
function talkZeigen() {
  const on = talkPrefs.on, t = talk.tx, n = talk.netz;
  $('talkPtt').hidden = !on;
  $('talkVoxBox').hidden = talkPrefs.mode !== 'vox';
  const netzText = n ? `${n.verbunden}/${n.leitungen.length} Relays` : '';
  $('talkStatus').textContent = !on ? '' : !n ? $('talkStatus').textContent
    : `${netzText} verbunden · Region ${n.region}${talkPrefs.pw ? ' · Gruppe 🔒' : ' · offen (ohne Passwort hört die ganze Region)'}` +
      (n.gesperrt ? ` · ${n.gesperrt} Relay(s) lehnen ab` : '');
  $('talkSummary').textContent = on ? (n ? netzText : 'startet …') : 'aus';
  const sek = t?.codec ? Math.floor(t.ms / 1000) : 0;
  const chip = t ? (t.codec ? `${t.vox ? 'VOX ' : ''}sendet ${sek} s${sek >= 25 ? ` · noch ${30 - sek}` : ''}` : 'Mikrofon …')
    : talk.hoert ? `🔊 ${talk.hoert}`
    : !talkBereit() ? (n ? 'keine Verbindung' : 'startet …')
    : talk.micFehler ? '⚠️ ' + talk.micFehler
    : talkPrefs.mode === 'vox' ? (!Sprechfunk.tonBereit() ? 'VOX: einmal tippen' : talk.empf.spielt() ? 'VOX gesperrt: Empfang'
      : talk.voxLetzt?.wind ? 'VOX hört (Wind)' : 'VOX hört …')
    : talkPrefs.mode === 'tap' ? 'Tippen: sprechen' : 'Halten: sprechen';
  $('talkChip').textContent = chip;
  $('talkBtn').classList.toggle('sendet', !!t?.codec);
  $('talkBtn').classList.toggle('hoert', !!talk.hoert);
  $('talkBtn').disabled = !talkBereit();
  if (talk.voxLetzt && talkPrefs.mode === 'vox') $('talkVoxMess').textContent = `Pegel ${Math.round(talk.voxLetzt.db)} dB · Schwelle ${Math.round(talk.voxLetzt.schwelle)} dB`;
}

map.getContainer().appendChild($('talkPtt'));
L.DomEvent.disableClickPropagation($('talkPtt'));
// Taste: halten = senden; im Modus „tippen“ schaltet jeder Tipp; während VOX sendet, übernimmt die Taste nicht
$('talkBtn').addEventListener('pointerdown', e => {
  e.preventDefault();
  if (talkPrefs.mode === 'tap') { talk.tx ? talkLoslassen() : talkDruecken(); return; }
  if (!talk.tx) talkDruecken();
});
for (const ev of ['pointerup', 'pointercancel', 'pointerleave'])
  $('talkBtn').addEventListener(ev, () => { if (talkPrefs.mode !== 'tap' && talk.tx && !talk.tx.vox) talkLoslassen(); });
$('talkBtn').oncontextmenu = e => e.preventDefault();
// Browser spielen erst nach einer Berührung ab; VOX braucht danach das offene Mikrofon
document.addEventListener('pointerdown', () => {
  if (!talkPrefs.on || !window.Sprechfunk) return;
  Sprechfunk.audio().then(() => setTimeout(talkMikro, 50)).catch(() => {});
}, { capture: true });
// Wache: Anzeige und Mikrofon nach Unterbrechungen (Anruf, andere App) neu öffnen
setInterval(() => { if (talkPrefs.on && talk.mod) { talkZeigen(); talkMikro(); } }, 1000);

$('talkOn').checked = talkPrefs.on;
$('talkName').value = talkPrefs.name; $('talkPlz').value = talkPrefs.plz; $('talkPw').value = talkPrefs.pw;
$('talkMode').value = talkPrefs.mode; $('talkEmpf').value = talkPrefs.empf; $('talkEmpfVal').textContent = talkPrefs.empf + ' dB';
$('talkHalt').value = String(talkPrefs.halt); $('talkRelays').value = talkPrefs.relays;
$('talkOn').onchange = () => { talkPrefs.on = $('talkOn').checked; saveTalk(); talkStart(); };
$('talkName').onchange = () => { talkPrefs.name = $('talkName').value = talkName(); saveTalk(); };
for (const [id, key] of [['talkPlz', 'plz'], ['talkPw', 'pw'], ['talkRelays', 'relays']])
  $(id).onchange = () => { talkPrefs[key] = $(id).value.trim(); saveTalk(); if (talkPrefs.on) talkStart(); };
$('talkMode').onchange = () => { talkPrefs.mode = $('talkMode').value; saveTalk(); talkLoslassen(); talkVoxEinstellen(); talkZeigen(); };
$('talkEmpf').oninput = () => { talkPrefs.empf = +$('talkEmpf').value; $('talkEmpfVal').textContent = talkPrefs.empf + ' dB'; saveTalk(); if (talk.vox) talk.vox.empf = talkPrefs.empf; };
$('talkHalt').onchange = () => { talkPrefs.halt = +$('talkHalt').value; saveTalk(); if (talk.vox) talk.vox.halt_ms = talkPrefs.halt; };
talkZeigen();
if (talkPrefs.on) talkStart();
