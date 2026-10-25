// --- Talk: Sprechfunk für Gruppenfahrten über Nostr-Relays (wss), mit Taste oder VOX, ohne Funkgerät.
// Codec2, Wiedergabe, VOX und Netz stammen unverändert aus der bcon-app (talk/, AGPL-3.0, Herkunft talk/QUELLE.md);
// der Ablauf hier ist eine schlanke Fassung von bcon-app app.js (talk/APP_AUSZUG.js). Geladen wird erst, wenn Talk an ist.
// Jede Durchsage geht als Ganzes (signiert, Kompaktform, Art 4420) an die Relays: Verzögerung etwa die Sprechdauer.
// Halbduplex wie Sprechfunk: VOX ist nur ein anderer Auslöser der Taste und sperrt, solange etwas abgespielt wird.
// Startwert für den ersten Start und ohne Server; ist der eigene Server erreichbar, gilt seine Liste (Admin-Bereich „Relays“)
const TALK_RELAYS = ['wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.mom'];
// Übers Netz Opus (WebCodecs, Breitband) mit Kennung 0x20 wie bcon-core talk.h: Rahmen variabler Länge, im Sprachpaket
// je Rahmen Länge (1 Byte) + Bytes, höchstens 239 B je Paket und 250 Pakete. 12 kbit/s mit 20-ms-Rahmen passt für 30 s.
// Ohne DTX, sonst fehlen beim Abspielen die Pausen. Ohne WebCodecs Codec2 3200. Empfangen wird beides, auch Codec2 1600 aus der bcon-app.
const TALK_CODEC = 1, TALK_OPUS = 0x20, TALK_MAX_MS = 30000, TALK_ABLAUF_S = 3600; // Relays löschen nach 1 h
const OPUS_CFG = { codec: 'opus', numberOfChannels: 1, bitrate: 12000,
  opus: { frameDuration: 20000, complexity: 8, usedtx: false, application: 'voip', signal: 'voice' } };
const PAKET_MAX = 239, PAKETE_MAX = 250;
const talkPrefs = Object.assign({ on: false, name: '', plz: '', pw: '', mode: 'ptt', empf: 12, halt: 1000, relays: TALK_RELAYS.join(' ') }, store.get('talk', {}));
const talk = { mod: null, netz: null, lauf: 0, mic: null, empf: null, vox: null, tx: null, warte: [], spielt: false, slot: 0,
  sperreBis: 0, fenster: false, fensterFrei: null, voxLetzt: null, micFehler: '', hoert: '', opus: false, leser: null, spieltBis: 0 };
const saveTalk = () => store.set('talk', talkPrefs);
const talkName = () => { const n = talkPrefs.name.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 9); return n.length >= 3 ? n : ''; };
const talkBereit = () => !!talk.netz && talk.netz.verbunden > 0;
// Schon gehörte Durchsagen (Kennung -> Zeit), auch über ein Neuladen hinweg: Relays liefern nach dem Verbinden
// die letzten 2 Minuten noch einmal aus
const TALK_GEHOERT_MS = 15 * 60000;
function talkSchonGehoert(kennung) {
  const jetzt = Date.now(), alt = store.get('talkGehoert', {}), neu = {};
  for (const k in alt) if (jetzt - alt[k] < TALK_GEHOERT_MS) neu[k] = alt[k];
  const schon = kennung in neu;
  neu[kennung] = jetzt;
  store.set('talkGehoert', neu);
  return schon;
}
// Nur ein Fenster je Gerät hört und sendet, sonst kommt jede Durchsage doppelt (zweiter Tab, App und Browser).
// Die anderen warten auf die Sperre und übernehmen, sobald das erste Fenster zugeht oder Talk ausschaltet.
let talkSperre = null;
function talkFenster() {
  if (!navigator.locks) return Promise.resolve();
  return talkSperre ||= new Promise(hat => navigator.locks.request('scooterways-talk', () => {
    talk.fenster = true; hat();
    return new Promise(frei => talk.fensterFrei = frei);
  }));
}
function talkFensterFreigeben() {
  talk.fensterFrei?.(); talk.fensterFrei = null; talk.fenster = false; talkSperre = null;
}

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
    const fehlt = ['AudioEncoder', 'AudioDecoder', 'AudioData', 'AudioWorkletNode'].filter(k => !window[k]);
    talk.opusGrund = fehlt.length ? 'fehlt ' + fehlt.join(', ')
      : (await AudioEncoder.isConfigSupported({ ...OPUS_CFG, sampleRate: 48000 }).catch(() => null))?.supported ? '' : 'Opus-Kodierer nicht unterstützt';
    talk.opus = !talk.opusGrund;
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
  if (!talkPrefs.on) { talk.mic?.schliessen(); talkFensterFreigeben(); return; }
  if (navigator.locks && !talk.fenster) {
    $('talkStatus').textContent = 'Talk läuft schon in einem anderen Tab oder Fenster. Dieses übernimmt, sobald das andere zugeht.';
    await talkFenster();
    if (lauf !== talk.lauf || !talkPrefs.on) return;
  }
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
const talkKopf = codec => ({ codec, flags: 0, ziel: talk.mod.ALLE, zeit: Math.floor(Date.now() / 1000), name: talkName(), region: talk.netz.region, gruppe: 0 });
async function talkDruecken(vonVox = false) {
  if (talk.tx || !talkBereit()) return;
  const t = talk.tx = { vox: vonVox, ms: 0, vorlauf: null, an: talkAn };
  talkZeigen();
  try {
    const probe = new Sprechfunk.Codec(TALK_CODEC), n = probe.n; probe.frei();
    await talk.mic.oeffnen(n);
    if (talk.tx !== t) return;
    if (talk.opus && await talkOpusBereit() && talk.tx === t && talkLeser()) { talkOpusStart(t); return; }
    if (talk.tx !== t) return;
    const codec = new Sprechfunk.Codec(TALK_CODEC);
    t.a = new talk.mod.Aufnahme(talk.netz.sk, talkKopf(TALK_CODEC), codec.nb);
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
  if (t.codec) { t.codec.frei(); if (t.ms >= 300) talkSenden(t.a, t.ms, t.an); }
  if (t.enc) talkOpusEnde(t);
  if (t.post?.length * t.post[0].length >= 0.3 * 8000) pushSprache(t.an, t.post);
  talk.vox?.zuruecksetzen();
  talk.sperreBis = Date.now() + 500;
  talkZeigen();
}
async function talkSenden(a, ms, an) {
  try {
    const k = await a.fertig();
    if (!k || !talk.netz) return;
    const n = await talk.netz.senden(k, Math.floor(Date.now() / 1000), an || undefined);
    const wen = an ? ` → 🔒 ${talkKontakte.find(x => x.pk === an)?.name || an.slice(0, 8)}` : '';
    talkLog(n ? `ich${wen} · ${(ms / 1000).toFixed(1).replace('.', ',')} s · ${talk.opus ? 'Opus' : 'Codec2'} · an ${n} Relays` : '⚠️ von keinem Relay angenommen');
  } catch (e) { talkLog('⚠️ Senden: ' + e.message); }
}

// ---- Opus: eigener Worklet am Mikrofon-Eingang von Sprechfunk.Mikrofon, in der Rate des AudioContext (meist 48 kHz),
// Blöcke zu 20 ms als AudioData. Sprechfunk.Mikrofon selbst liefert nur 8 kHz und bleibt für VOX zuständig.
// Bei VOX laufen die letzten 600 ms als Vorlauf mit, damit der Wortanfang nicht fehlt.
const LESER_WORKLET = `class Leser extends AudioWorkletProcessor {
  constructor() { super(); this.n = Math.round(sampleRate / 50); this.buf = new Float32Array(this.n); this.i = 0; }
  process(ein) {
    const x = ein[0] && ein[0][0];
    if (x) for (let k = 0; k < x.length; k++) {
      this.buf[this.i++] = x[k];
      if (this.i === this.n) { this.port.postMessage(this.buf, [this.buf.buffer]); this.buf = new Float32Array(this.n); this.i = 0; }
    }
    return true;
  }
}
registerProcessor('scooter-leser', Leser);`;
// Einmal je AudioContext: Worklet laden und prüfen, ob der Kodierer diese Rate kann (sonst Codec2)
async function talkOpusBereit() {
  try {
    const c = await Sprechfunk.audio();
    if (talk.leserCtx === c) return talk.opus;
    talk.leserLaden ||= c.audioWorklet.addModule(URL.createObjectURL(new Blob([LESER_WORKLET], { type: 'application/javascript' })));
    await talk.leserLaden;
    if (!(await AudioEncoder.isConfigSupported({ ...OPUS_CFG, sampleRate: c.sampleRate }))?.supported) {
      talk.opus = false; talk.opusGrund = `Opus-Kodierer kann ${c.sampleRate} Hz nicht`;
    }
    talk.leserCtx = c;
  } catch (e) { talk.opus = false; talk.opusGrund = 'Opus-Aufnahme: ' + e.message; }
  return talk.opus;
}
function talkLeser() {
  const q = talk.mic?.quelle, c = talk.leserCtx;
  if (!q || !c || !talk.opus) return null;
  if (talk.leser?.quelle === q) return talk.leser;
  talk.leser?.stop();
  const node = new AudioWorkletNode(c, 'scooter-leser'), stumm = c.createGain();
  stumm.gain.value = 0;
  q.connect(node); node.connect(stumm).connect(c.destination); // ohne Ausgang läuft der Worklet nicht überall
  let ts = 0;
  const l = talk.leser = { quelle: q, ring: [], ringUs: 0,
    stop() { node.port.onmessage = null; try { q.disconnect(node); } catch {} node.disconnect(); this.ring.forEach(a => a.close()); this.ring = []; } };
  node.port.onmessage = e => {
    if (talk.mic.quelle !== q) { l.stop(); if (talk.leser === l) talk.leser = null; return; } // Mikrofon neu geöffnet
    const a = new AudioData({ format: 'f32-planar', sampleRate: c.sampleRate, numberOfFrames: e.data.length, numberOfChannels: 1, timestamp: ts, data: e.data });
    ts += e.data.length / c.sampleRate * 1e6;
    const t = talk.tx;
    if (t?.enc && t.enc.state === 'configured') { t.enc.encode(a); a.close(); }
    else if (talkPrefs.mode === 'vox') {
      l.ring.push(a); l.ringUs += a.duration;
      while (l.ring.length > 1 && l.ringUs > 600000) { const o = l.ring.shift(); l.ringUs -= o.duration; o.close(); }
    } else a.close();
  };
  return l;
}
function talkOpusStart(t) {
  const l = talk.leser;
  t.a = new talk.mod.Aufnahme(talk.netz.sk, talkKopf(TALK_OPUS), 1);
  t.teil = []; t.teilB = 0;
  t.enc = new AudioEncoder({
    output: chunk => {
      const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b);
      t.ms += (chunk.duration || 20000) / 1000;
      talkOpusPacken(t, b);
    },
    error: e => { talkLog('⚠️ Opus: ' + e.message); if (talk.tx === t) talkLoslassen(); }
  });
  t.enc.configure({ ...OPUS_CFG, sampleRate: talk.leserCtx.sampleRate });
  // Vorlauf (nur VOX) zuerst, danach kommen die neuen Blöcke direkt aus dem Leser
  if (t.vox) for (const a of l.ring) { t.enc.encode(a); a.close(); }
  l.ring = []; l.ringUs = 0;
  t.bis = setTimeout(talkLoslassen, TALK_MAX_MS);
  t.uhr = setInterval(talkZeigen, 1000);
  talkZeigen();
}
// Rahmen ins Sprachpaket: Länge + Bytes, bis 239 B; bei 250 Paketen ist die Durchsage voll
function talkOpusPacken(t, b) {
  if (!b.length || b.length >= PAKET_MAX) return;
  if (t.teilB + 1 + b.length > PAKET_MAX) talkOpusPaket(t);
  t.teil.push(Uint8Array.of(b.length), b); t.teilB += 1 + b.length;
  if (t.a.pakete.length >= PAKETE_MAX - 1 && talk.tx === t) talkLoslassen();
}
function talkOpusPaket(t) {
  if (!t.teilB || t.a.pakete.length >= PAKETE_MAX) return;
  const p = new Uint8Array(t.teilB);
  let o = 0; for (const x of t.teil) { p.set(x, o); o += x.length; }
  t.a.pakete.push(p); t.teil = []; t.teilB = 0;
}
async function talkOpusEnde(t) {
  try { await t.enc.flush(); } catch {}
  try { t.enc.close(); } catch {}
  talkOpusPaket(t);
  if (t.ms >= 300) talkSenden(t.a, t.ms, t.an);
}

// Ein Empfänger für alle Mikrofon-Blöcke: laufende Sendung kodieren, sonst VOX hören lassen
function talkRahmen(pcm) {
  const t = talk.tx;
  if (t?.an && postAn()) (t.post ||= []).push(pcm.slice()); // Kopie für die Sprachpost (29-push)
  if (t?.codec) { t.a.rahmen(t.codec.kodieren(pcm)); t.ms += t.codec.ms; }
  else if (t?.vox && !t.enc) { (t.vorlauf ||= []).push(pcm.slice()); }
  if (talkPrefs.mode !== 'vox') return;
  // Gesperrt, solange etwas abgespielt wird (Lautsprecher/Headset käme ins Mikrofon) und kurz nach dem eigenen Ende
  if (t && !t.vox || !t && (Date.now() < talk.sperreBis || talkSpielt() || !talkBereit())) { talk.vox.zuruecksetzen(); return; }
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
const talkSpielt = () => talk.empf.spielt() || Date.now() < talk.spieltBis;
const talkDauer = d => d.kopf.codec === TALK_OPUS ? d.pakete.length * 140 : d.pakete.length * 10 * (Sprechfunk.CODECS[d.kopf.codec]?.ms || 40);
function talkEinreihen(d) {
  if (talkSchonGehoert(d.kennung)) return;
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
  const k = d.kopf, c = Sprechfunk.CODECS[k.codec], opus = k.codec === TALK_OPUS && !!window.AudioDecoder;
  if (!c && !opus || (!d.signatur && !d.fehlend)) return; // unbekannter Codec oder gefälschte Durchsage
  // Rufname nur, wenn der Kopf geprüft ist; sonst die ersten Stellen des Schlüssels
  const wer = (d.signatur || d.absender === k.schluessel) && k.name || k.schluessel.slice(0, 8);
  if (d.absender) talkKontaktMerken(d.absender, wer);
  if (d.privat && d.absender) pushLiveGehoert(d.absender);
  talk.hoert = (d.privat ? '🔒 ' : '') + wer; talkZeigen();
  if (opus) {
    const ms = await talkOpusHoeren(d.pakete).catch(() => 0);
    talk.hoert = '';
    talkLog(`${d.privat ? '🔒 ' : ''}${wer} · ${(ms / 1000).toFixed(1).replace('.', ',')} s · Opus${d.fehlend ? ` · ${d.fehlend} Lücken` : ''}`);
    talkZeigen();
    return;
  }
  const slot = 200 + (talk.slot++ % 50);
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
  talkLog(`${d.privat ? '🔒 ' : ''}${wer} · ${(ms / 1000).toFixed(1).replace('.', ',')} s${d.fehlend ? ` · ${d.fehlend} Lücken` : ''}`);
  talkZeigen();
}

// Opus-Durchsage dekodieren und als Ganzes abspielen; fehlende Pakete (Lücken) fallen weg
async function talkOpusHoeren(pakete) {
  const teile = [];
  let rate = 48000;
  const dec = new AudioDecoder({ output: a => {
    rate = a.sampleRate;
    const f = new Float32Array(a.numberOfFrames);
    a.copyTo(f, { planeIndex: 0, format: 'f32-planar' });
    teile.push(f); a.close();
  }, error: () => {} });
  dec.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
  let ts = 0;
  for (const p of pakete)
    for (let i = 0; i < p.length && i + 1 + p[i] <= p.length; i += 1 + p[i]) {
      if (p[i]) dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: ts, data: p.subarray(i + 1, i + 1 + p[i]) }));
      ts += 20000;
    }
  await dec.flush(); dec.close();
  const n = teile.reduce((s, f) => s + f.length, 0);
  if (!n) return 0;
  const c = await Sprechfunk.audio(), buf = c.createBuffer(1, n, rate);
  let o = 0; for (const f of teile) { buf.copyToChannel(f, 0, o); o += f.length; }
  const q = c.createBufferSource(), g = c.createGain();
  q.buffer = buf; q.connect(g).connect(c.destination);
  const t0 = c.currentTime + 0.05; // kurz einblenden gegen Knacken
  g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(1, t0 + 0.01);
  talk.spieltBis = Date.now() + buf.duration * 1000 + 450;
  q.start(t0);
  await new Promise(r => { q.onended = r; });
  Sprechfunk.signal('los').catch(() => {}); // Roger-Piep
  return buf.duration * 1000;
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
    : `${netzText} verbunden · ${talk.opus ? 'Opus' : `Codec2 3200${talk.opusGrund ? ` (kein Opus: ${talk.opusGrund})` : ''}`} · Region ${n.region}${talkPrefs.pw ? ' · Gruppe 🔒' : ' · offen (ohne Passwort hört die ganze Region)'}` +
      (n.gesperrt ? ` · ${n.gesperrt} Relay(s) lehnen ab` : '');
  $('talkSummary').textContent = on ? [talkName(), n ? netzText : 'startet …'].filter(Boolean).join(' · ') : 'aus';
  $('talkNameHint').textContent = talkName() ? `Andere sehen dich als ${talkName()}.` : 'Ohne Rufname sehen andere nur die ersten Stellen deines Schlüssels.';
  const sek = t?.codec || t?.enc ? Math.floor(t.ms / 1000) : 0;
  const chip = t ? (t.codec || t.enc ? `${t.vox ? 'VOX ' : ''}sendet ${sek} s${sek >= 25 ? ` · noch ${30 - sek}` : ''}` : 'Mikrofon …')
    : talk.hoert ? `🔊 ${talk.hoert}`
    : !talkBereit() ? (n ? 'keine Verbindung' : 'startet …')
    : talk.micFehler ? '⚠️ ' + talk.micFehler
    : talkPrefs.mode === 'vox' ? (!Sprechfunk.tonBereit() ? 'VOX: einmal tippen' : talkSpielt() ? 'VOX gesperrt: Empfang'
      : talk.voxLetzt?.wind ? 'VOX hört (Wind)' : 'VOX hört …')
    : talkPrefs.mode === 'tap' ? 'Tippen: sprechen' : 'Halten: sprechen';
  $('talkChip').textContent = chip;
  $('talkBtn').classList.toggle('sendet', !!(t?.codec || t?.enc));
  $('talkBtn').classList.toggle('hoert', !!talk.hoert);
  $('talkBtn').disabled = !talkBereit();
  if (talk.voxLetzt && talkPrefs.mode === 'vox') $('talkVoxMess').textContent = `Pegel ${Math.round(talk.voxLetzt.db)} dB · Schwelle ${Math.round(talk.voxLetzt.schwelle)} dB`;
}

// Direkt an einen: knappes Klappmenü über der Sprechtaste. Kontakte sind die zuletzt Gehörten (höchstens 8),
// die Durchsage geht dann versiegelt nur an deren Schlüssel. Nach dem Start spricht die Taste wieder an alle.
const TALK_KONTAKTE_MAX = 8;
let talkKontakte = store.get('talkKontakte', []), talkAn = null;
function talkKontaktMerken(pk, name) {
  if (!/^[0-9a-f]{64}$/.test(pk)) return;
  const alt = talkKontakte.find(k => k.pk === pk);
  if (alt?.name === name && talkKontakte[0] === alt) return;
  talkKontakte = [{ pk, name }, ...talkKontakte.filter(k => k.pk !== pk)].slice(0, TALK_KONTAKTE_MAX);
  store.set('talkKontakte', talkKontakte);
  talkAnZeigen();
}
function talkAnZeigen() {
  const k = talkKontakte.find(x => x.pk === talkAn);
  $('talkAn').textContent = k ? `🔒 an ${k.name} ▾` : 'an alle ▾';
  $('talkAn').classList.toggle('privat', !!k);
  $('talkAn').hidden = !talkKontakte.length;
  $('talkAnMenu').innerHTML = [`<button data-pk="">📢 an alle</button>`, ...talkKontakte.map(k => `<button data-pk="${k.pk}">🔒 ${escapeHtml(k.name)}</button>`)].join('');
  $('talkAnMenu').querySelector(`[data-pk="${talkAn || ''}"]`)?.classList.add('on');
}
$('talkAn').onclick = () => { $('talkAnMenu').hidden = !$('talkAnMenu').hidden; };
$('talkAnMenu').onclick = e => {
  const b = e.target.closest('[data-pk]');
  if (!b) return;
  talkAn = b.dataset.pk || null;
  $('talkAnMenu').hidden = true;
  talkAnZeigen();
};
talkAnZeigen();

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
setInterval(() => { if (talkPrefs.on && talk.mod) { talkZeigen(); talkMikro(); if (talk.opus && talkPrefs.mode === 'vox' && Sprechfunk.tonBereit()) talkOpusBereit().then(talkLeser); } }, 1000);

$('talkOn').checked = talkPrefs.on;
$('talkName').value = talkPrefs.name; $('talkPlz').value = talkPrefs.plz; $('talkPw').value = talkPrefs.pw;
$('talkMode').value = talkPrefs.mode; $('talkEmpf').value = talkPrefs.empf; $('talkEmpfVal').textContent = talkPrefs.empf + ' dB';
$('talkHalt').value = String(talkPrefs.halt); $('talkRelays').value = talkPrefs.relays;
$('talkOn').onchange = () => { talkPrefs.on = $('talkOn').checked; saveTalk(); talkStart(); };
$('talkName').onchange = () => { talkPrefs.name = $('talkName').value; talkPrefs.name = $('talkName').value = talkName(); saveTalk(); talkZeigen(); };
for (const [id, key] of [['talkPlz', 'plz'], ['talkPw', 'pw'], ['talkRelays', 'relays']])
  $(id).onchange = () => { talkPrefs[key] = $(id).value.trim(); saveTalk(); if (talkPrefs.on) talkStart(); };
// Serverliste übernehmen (auch über eine eigene Liste hinweg); das Feld zeigt sie dann nur an
function talkRelaysVomServer() {
  const liste = typeof serverAn === 'function' && serverAn() && Array.isArray(serverKonfig?.relays) && serverKonfig.relays.filter(u => /^wss:\/\/\S+$/.test(u));
  $('talkRelays').readOnly = !!liste?.length;
  $('talkRelaysHint').hidden = !liste?.length;
  if (!liste?.length) return;
  const neu = liste.join(' ');
  if (neu === talkPrefs.relays) return;
  talkPrefs.relays = $('talkRelays').value = neu; saveTalk();
  if (talkPrefs.on && talk.netz) talkStart();
}
document.addEventListener('serverkonfig', talkRelaysVomServer);
$('talkMode').onchange = () => { talkPrefs.mode = $('talkMode').value; saveTalk(); talkLoslassen(); talkVoxEinstellen(); talkZeigen(); };
$('talkEmpf').oninput = () => { talkPrefs.empf = +$('talkEmpf').value; $('talkEmpfVal').textContent = talkPrefs.empf + ' dB'; saveTalk(); if (talk.vox) talk.vox.empf = talkPrefs.empf; };
$('talkHalt').onchange = () => { talkPrefs.halt = +$('talkHalt').value; saveTalk(); if (talk.vox) talk.vox.halt_ms = talkPrefs.halt; };
talkZeigen();
if (talkPrefs.on) talkStart();
