// b:con-App, Sprechfunk: Codec2 (WebAssembly), Mikrofon und Wiedergabe.
// Kodiert und dekodiert wird im Handy; der C3 reicht nur fertige Codec-Rahmen weiter (bcon-talk/src/funk.cpp).
"use strict";

const Sprechfunk = (() => {
  // bcon-Kennung (bcon-core/src/bcon/talk.h) -> Modus in codec2.h, Rahmendauer
  const CODECS = {
    1: { modus: 0, ms: 20, name: "Codec2 3200" },
    2: { modus: 1, ms: 20, name: "Codec2 2400" },
    3: { modus: 2, ms: 40, name: "Codec2 1600" },
    4: { modus: 3, ms: 40, name: "Codec2 1400" },
    5: { modus: 4, ms: 40, name: "Codec2 1300" },
    6: { modus: 5, ms: 40, name: "Codec2 1200" },
    8: { modus: 8, ms: 40, name: "Codec2 700C" },
  };
  const RATE = 8000;
  let modul = null;

  async function laden() {
    if (!modul) modul = await Codec2Modul();
    return modul;
  }

  // Ein Kodierer/Dekodierer je Codec2-Zustand (Dekodierer je Empfangs-Slot, weil Codec2 Zustand hält).
  class Codec {
    constructor(kennung) {
      const c = CODECS[kennung];
      if (!c) throw new Error("Codec " + kennung + " unbekannt");
      this.kennung = kennung;
      this.ms = c.ms;
      this.h = modul._codec2_create(c.modus);
      this.n = modul._codec2_samples_per_frame(this.h);
      this.nb = modul._codec2_bytes_per_frame(this.h);
      this.pcm = modul._malloc(this.n * 2);
      this.bits = modul._malloc(this.nb);
    }
    kodieren(int16) {  // n Abtastwerte -> nb Byte
      modul.HEAP16.set(int16, this.pcm >> 1);
      modul._codec2_encode(this.h, this.bits, this.pcm);
      return modul.HEAPU8.slice(this.bits, this.bits + this.nb);
    }
    dekodieren(bytes) {  // nb Byte -> Float32 (n Werte)
      modul.HEAPU8.set(bytes, this.bits);
      modul._codec2_decode(this.h, this.pcm, this.bits);
      const s = modul.HEAP16.subarray(this.pcm >> 1, (this.pcm >> 1) + this.n);
      const f = new Float32Array(this.n);
      for (let i = 0; i < this.n; i++) f[i] = s[i] / 32768;
      return f;
    }
    frei() {
      if (!this.h) return;
      modul._free(this.pcm); modul._free(this.bits); modul._codec2_destroy(this.h);
      this.h = 0;
    }
  }

  // AudioWorklet: Mikrofon auf 8 kHz bringen (Tiefpass + Ausdünnen), Blöcke zu je "n" Werten melden.
  const WORKLET = `
  class Aufnahme extends AudioWorkletProcessor {
    constructor() {
      super();
      this.schritt = sampleRate / ${RATE};
      this.a = this.schritt > 1.01 ? Math.exp(-2 * Math.PI * 3400 / sampleRate) : 0;
      this.lp1 = 0; this.lp2 = 0; this.pos = 0; this.n = 160; this.buf = new Int16Array(this.n); this.k = 0; this.spitze = 0;
      this.port.onmessage = e => { this.n = e.data; this.buf = new Int16Array(this.n); this.k = 0; };
    }
    process(ein) {
      const x = ein[0] && ein[0][0];
      if (!x) return true;
      for (let i = 0; i < x.length; i++) {
        let v = x[i];
        if (this.a) { this.lp1 = this.lp1 * this.a + v * (1 - this.a); this.lp2 = this.lp2 * this.a + this.lp1 * (1 - this.a); v = this.lp2; }
        this.pos += 1;
        if (this.pos < this.schritt) continue;
        this.pos -= this.schritt;
        v = Math.max(-1, Math.min(1, v));
        this.spitze = Math.max(this.spitze, Math.abs(v));
        this.buf[this.k++] = v * 32767;
        if (this.k === this.n) { this.port.postMessage({ pcm: this.buf, spitze: this.spitze }); this.buf = new Int16Array(this.n); this.k = 0; this.spitze = 0; }
      }
      return true;
    }
  }
  registerProcessor("bcon-aufnahme", Aufnahme);`;

  // Ein Aufbau für alle Aufrufer: wer während addModule() kommt, wartet mit (sonst fehlt „bcon-aufnahme“ noch im Worklet)
  let ctx = null, ctxBereit = null;
  async function audio() {
    if (!ctxBereit) ctxBereit = (async () => {
      let c;
      try { c = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" }); }
      catch (e) { c = new AudioContext(); }
      ctx = c;
      await c.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" })));
      return c;
    })().catch(e => { ctxBereit = null; throw e; });
    const c = await ctxBereit;
    if (c.state === "suspended") await c.resume();
    return c;
  }

  // Mikrofon: bleibt nach dem ersten Drücken offen (sonst kostet jedes Drücken Zeit und eine Abfrage).
  class Mikrofon {
    // agc: automatische Verstärkung des Browsers (bei VOX aus: hebt in Pausen das Rauschen); wirkt beim nächsten Öffnen
    constructor() { this.strom = null; this.knoten = null; this.beiRahmen = null; this.beiPegel = null; this.agc = true; this.kette = Promise.resolve(); }
    // nacheinander: ein zweites Drücken während des ersten Aufbaus öffnet kein zweites Mikrofon
    oeffnen(n) { const p = this.kette.then(() => this.aufbauen(n)); this.kette = p.catch(() => {}); return p; }
    async aufbauen(n) {
      const c = await audio();
      // Android beendet oder stummt die Spur, wenn eine andere App das Mikrofon nimmt (Aufnahme, Anruf, Kamera-Dialog):
      // dann neu öffnen statt dauerhaft Stille zu senden
      const spur = this.strom?.getAudioTracks()[0];
      if (this.strom && (!spur || spur.readyState !== "live" || spur.muted)) this.schliessen();
      if (this.strom && !this.knoten) this.schliessen();  // halber Aufbau (Fehler beim letzten Mal)
      if (!this.strom) {
        this.strom = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: this.agc, channelCount: 1 },
        });
        const quelle = this.quelle = c.createMediaStreamSource(this.strom);
        this.knoten = new AudioWorkletNode(c, "bcon-aufnahme");
        this.knoten.port.onmessage = e => {
          if (this.beiPegel) this.beiPegel(e.data.spitze);
          if (this.beiRahmen) this.beiRahmen(e.data.pcm);
        };
        quelle.connect(this.knoten);
        // Ohne Ausgang läuft der Worklet nicht in jedem Browser: stumm an das Ziel hängen.
        const stumm = c.createGain(); stumm.gain.value = 0;
        this.knoten.connect(stumm).connect(c.destination);
      }
      this.knoten.port.postMessage(n);
    }
    groesse(n) { if (this.knoten) this.knoten.port.postMessage(n); }  // Blockgröße für einen anderen Codec
    get spur() { return this.strom?.getAudioTracks()[0] || null; }
    schliessen() {
      if (this.strom) this.strom.getTracks().forEach(t => t.stop());
      // Eingang trennen und Meldungen abstellen: sonst läuft der alte Worklet weiter und liefert neben dem neuen Blöcke (Stille)
      if (this.quelle) this.quelle.disconnect();
      if (this.knoten) { this.knoten.port.onmessage = null; this.knoten.disconnect(); }
      this.strom = this.knoten = this.quelle = null;
    }
  }

  // Senden: Codec-Rahmen sammeln, je paketMs eine WebSocket-Nachricht 'A' + Rahmen (wie tools/app_test.py).
  // Paketlänge nach Weg: zum Funkgerät im Hotspot kurz (80–160 ms, weniger Verzögerung); für ESP-NOW (400 ms) bündelt das Gerät.
  // Jede Sendung bekommt einen neuen Codec2-Zustand (wie Mumble bResetEncoder): kein Rest der letzten Durchsage.
  class Sender {
    constructor(kennung, senden, paketMs = 120) {
      this.codec = new Codec(kennung);
      this.senden = senden;
      this.je = Math.max(1, Math.round(paketMs / this.codec.ms));
      this.teile = [];
      this.rahmen = 0;
    }
    pcm(int16) {
      this.teile.push(this.codec.kodieren(int16));
      this.rahmen++;
      if (this.teile.length >= this.je) this.raus();
    }
    raus() {
      if (!this.teile.length) return;
      const b = new Uint8Array(1 + this.teile.length * this.codec.nb);
      b[0] = 0x41;  // 'A'
      this.teile.forEach((t, i) => b.set(t, 1 + i * this.codec.nb));
      this.teile = [];
      this.senden(b);
    }
    ende() { this.raus(); this.codec.frei(); }
    get dauer_ms() { return this.rahmen * this.codec.ms; }
  }

  // Empfang: je Slot (Sprecher) ein Dekodierer, ein Abspielkopf und ein eigener Jitter-Puffer. Das Funkgerät liefert die Pakete
  // schon im Takt; dazu kommen Laufzeitschwankungen von WLAN, Relay-Kette oder Netz. Die Marge (Vorlauf) wird je Sprecher
  // gelernt: Unterlauf erhöht sie sofort, gemessener Verzug bestimmt sie, in Ruhe (nach der Durchsage) sinkt sie langsam.
  // Ein-/Ausblenden 10 ms gegen Knacken; Verlust: letzten Rahmen einmal abklingend wiederholen, dann leises Rauschen.
  // Vorrang: die OP-Durchsage (prio 1) unterbricht andere laufende Wiedergaben (stumm, solange sie läuft)
  // und beginnt mit einem eigenen Gong.
  const MARGE_MIN = 0.06, MARGE_MAX = 1.0, BLENDE = 0.01, GONG_S = 0.9;
  class Empfaenger {
    constructor() { this.slots = new Map(); this.beiPegel = null; this.lautstaerke = 1; this.marge = new Map(); this.ende = 0; }
    // Läuft eine Wiedergabe oder endete sie vor weniger als „nach“ Sekunden? (VOX-Sperre gegen Rückkopplung)
    spielt(nach = 0.3) { return this.slots.size > 0 || (!!ctx && ctx.currentTime < this.ende + nach); }
    beginnen(slot, kennung, opt = {}) {
      this.beenden(slot, false);
      const s = { codec: null, kopf: 0, pakete: 0, luecken: 0, kennung, warte: [], prio: opt.prio || 0, sprecher: opt.sprecher || "",
        marge: this.marge.get(opt.sprecher) || (opt.weg === "nostr" ? 0.25 : 0.12), t0: 0, medien: 0, verzug: 0, unterlauf: 0,
        letzter: null, verlust: 0 };
      this.slots.set(slot, s);
      // Pakete, die vor dem Laden von Codec/Audio kommen, warten kurz (sonst fehlt der Anfang).
      return s.bereit = Promise.all([laden(), audio()]).then(([, c]) => {
        if (this.slots.get(slot) !== s) return;
        s.codec = CODECS[kennung] ? new Codec(kennung) : null;
        s.ausgang = c.createGain(); s.ausgang.gain.value = this.lautstaerke; s.ausgang.connect(c.destination);
        s.blende = c.createGain(); s.blende.gain.value = 0; s.blende.connect(s.ausgang);
        if (s.prio === 1) { gong(c, s.ausgang, c.currentTime + 0.02); s.vorlauf = GONG_S; } else klick(c, s.ausgang);
        this.vorrang();
        const w = s.warte; s.warte = null;
        for (const d of w) this.paket(d);
      });
    }
    // Lautstärke je Slot: wer nicht den höchsten Vorrang hat, bleibt stumm, solange eine Durchsage läuft
    vorrang() {
      if (!ctx) return;
      const hoechst = Math.max(0, ...[...this.slots.values()].map(s => s.prio));
      for (const s of this.slots.values()) {
        if (!s.ausgang) continue;
        const ziel = this.lautstaerke * (s.prio < hoechst ? 0 : 1);
        s.ausgang.gain.setTargetAtTime(ziel, ctx.currentTime, 0.05);
      }
    }
    paket(daten) {  // 'P' slot nr dauer_ms(u16 LE) Rahmen...
      if (daten.length < 5) return;
      const slot = daten[1], dauer = daten[3] | (daten[4] << 8);
      const s = this.slots.get(slot);
      if (!s) return;
      if (s.warte) { s.warte.push(daten.slice()); return; }
      const rahmen = daten.subarray(5);
      let f;
      if (!rahmen.length || !s.codec) {
        s.luecken++;
        f = new Float32Array(Math.round(dauer * RATE / 1000));
        let i = 0;
        if (s.letzter && !s.verlust) {  // Codec2 hat keine eigene Verschleierung: letzten Rahmen einmal abklingend wiederholen
          const m = Math.min(f.length, s.letzter.length);
          for (; i < m; i++) f[i] = s.letzter[i] * (1 - i / m);
        }
        for (; i < f.length; i++) f[i] = (Math.random() * 2 - 1) * 0.02;
        s.verlust++;
      } else {
        s.pakete++; s.verlust = 0;
        const nb = s.codec.nb, k = Math.floor(rahmen.length / nb);
        f = new Float32Array(k * s.codec.n);
        for (let i = 0; i < k; i++) f.set(s.codec.dekodieren(rahmen.subarray(i * nb, (i + 1) * nb)), i * s.codec.n);
        if (k) s.letzter = f.slice((k - 1) * s.codec.n);
      }
      if (!f.length) return;
      let spitze = 0;
      for (const v of f) spitze = Math.max(spitze, Math.abs(v));
      if (this.beiPegel) this.beiPegel(spitze);
      const buf = ctx.createBuffer(1, f.length, RATE);
      buf.copyToChannel(f, 0);
      const q = ctx.createBufferSource();
      q.buffer = buf;
      q.connect(s.blende);
      const jetzt = ctx.currentTime, g = s.blende.gain;
      // Verzug messen: wie viel später als im gleichmäßigen Takt kommt dieses Paket an
      if (!s.t0) s.t0 = jetzt;
      s.verzug = Math.max(s.verzug * 0.95, jetzt - s.t0 - s.medien);
      s.medien += buf.duration;
      let t;
      if (s.kopf > jetzt + 0.015) {  // lückenlos anhängen; das schon geplante Ausblenden zurücknehmen
        t = s.kopf;
        g.cancelScheduledValues(t - BLENDE);
        g.setValueAtTime(1, t - BLENDE);
      } else {  // Anfang oder Unterlauf: mit Marge neu ansetzen und einblenden
        if (s.kopf) { s.unterlauf++; s.marge = Math.min(MARGE_MAX, s.marge * 1.5 + 0.02); }
        t = jetzt + Math.max(s.marge, s.kopf ? 0 : s.vorlauf || 0);  // Durchsage: erst der Gong
        g.cancelScheduledValues(t);
        g.setValueAtTime(0, t); g.linearRampToValueAtTime(1, t + BLENDE);
      }
      q.start(t);
      s.kopf = t + buf.duration;
      g.setValueAtTime(1, s.kopf - BLENDE); g.linearRampToValueAtTime(0, s.kopf);  // ausblenden, falls nichts mehr folgt
    }
    beenden(slot, roger = true) {
      const s = this.slots.get(slot);
      if (!s) return null;
      this.slots.delete(slot);
      this.ende = Math.max(this.ende, s.kopf + (roger ? 0.2 : 0));  // Roger-Piep mitzählen
      // Marge für diesen Sprecher merken: nach gemessenem Verzug, ohne Unterlauf langsam kleiner (Nachstellen in Ruhe)
      if (s.sprecher && s.pakete) {
        const ziel = Math.min(MARGE_MAX, Math.max(MARGE_MIN, s.verzug + 0.04));
        this.marge.set(s.sprecher, s.unterlauf ? Math.max(s.marge, ziel) : Math.max(ziel, s.marge * 0.9, MARGE_MIN));
        if (this.marge.size > 200) this.marge.delete(this.marge.keys().next().value);
      }
      if (roger && ctx && s.ausgang) piep(ctx, s.ausgang, Math.max(ctx.currentTime, s.kopf) + 0.05);
      if (s.codec) s.codec.frei();
      this.vorrang();
      return s;
    }
  }

  function klick(c, ziel) {  // Rauschsperre öffnet: kurzer Rauschstoß
    const n = Math.round(c.sampleRate * 0.05), b = c.createBuffer(1, n, c.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * 0.15 * (1 - i / n);
    const q = c.createBufferSource(); q.buffer = b; q.connect(ziel); q.start();
  }
  function gong(c, ziel, t) {  // OP-Durchsage: Zweiklang-Gong (Ding-Dong), klar anders als Roger-Piep und Signaltöne
    for (const [f, ab] of [[784, 0], [523, 0.4]]) {
      const o = c.createOscillator(), g = c.createGain();
      o.frequency.value = f; g.gain.setValueAtTime(0, t + ab);
      g.gain.linearRampToValueAtTime(0.2, t + ab + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t + ab + 0.45);
      o.connect(g).connect(ziel); o.start(t + ab); o.stop(t + ab + 0.5);
    }
  }
  function piep(c, ziel, t) {  // Roger-Piep am Ende einer Übertragung
    const o = c.createOscillator(), g = c.createGain();
    o.frequency.value = 1750; g.gain.value = 0;
    g.gain.setValueAtTime(0.12, t); g.gain.setValueAtTime(0, t + 0.12);
    o.connect(g).connect(ziel); o.start(t); o.stop(t + 0.15);
  }

  // Signaltöne: „frei“ (Drücken) = zwei kurze steigende Töne, „los“ (Loslassen) = zwei fallende, beide anders als der
  // Roger-Piep; „belegt“ = tiefer Brummton
  async function signal(art) {
    const c = await audio(), t = c.currentTime + 0.01;
    const folge = art === "belegt" ? [[400, 0, 0.3]] : art === "los" ? [[1320, 0, 0.05], [880, 0.07, 0.05]] : [[880, 0, 0.06], [1320, 0.08, 0.06]];
    for (const [f, ab, dauer] of folge) {
      const o = c.createOscillator(), g = c.createGain();
      o.type = art === "belegt" ? "square" : "sine"; o.frequency.value = f; g.gain.value = 0;
      g.gain.setValueAtTime(art === "belegt" ? 0.05 : 0.12, t + ab); g.gain.setValueAtTime(0, t + ab + dauer);
      o.connect(g).connect(c.destination); o.start(t + ab); o.stop(t + ab + dauer + 0.02);
    }
  }
  function tonBereit() { return !!ctx && ctx.state === "running"; }
  return { CODECS, laden, audio, signal, tonBereit, Codec, Mikrofon, Sender, Empfaenger };
})();
