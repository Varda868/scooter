// b:con-App, Sprechfunk: VOX (sprachgesteuertes Senden), Konzept bcon-talk docs/GRUPPENFAHRT_VOX.md §1.
// Rein rechnerisch, ohne Browser: bekommt die 8-kHz-Blöcke aus dem Mikrofon (Mikrofon.beiRahmen) und meldet „start“ und
// „ende“. Senden, Hineinhören, Kollision, Belegt und Antwortfenster bleiben beim bisherigen PTT-Ablauf (app.js).
//   Hochpass ~300 Hz (4. Ordnung) gegen Wind und Motor, nur für die Erkennung; Pegel = RMS des Blocks in dBFS.
//   Rauschboden: folgt in Stille langsam nach oben (STEIGEN dB/s) und sofort nach unten, während Sprache eingefroren.
//   Schwelle = Rauschboden + Empfindlichkeit (dB), mindestens BODEN_MIN. Start erst nach min_ms über der Schwelle
//   (ein Block darf fehlen), Ende nach halt_ms unter Schwelle − HYSTERESE. Vorlauf: Ring der letzten vorlauf_ms als Kopie.
//   node tools/test_vox.mjs
const Vox = (() => {
  const RATE = 8000, STEIGEN = 3, HYSTERESE = 3, BODEN_MIN = -45, STILLE = -90;

  // Hochpass 4. Ordnung (Butterworth) aus zwei Biquads nach dem RBJ-Kochbuch: Wind sitzt unter ~200 Hz und ist laut,
  // 2. Ordnung lässt bei 80 Hz noch zu viel durch
  function biquad(f0, q, rate) {
    const w = 2 * Math.PI * f0 / rate, c = Math.cos(w), a = Math.sin(w) / (2 * q), a0 = 1 + a;
    return { b0: (1 + c) / 2 / a0, b1: -(1 + c) / a0, b2: (1 + c) / 2 / a0, a1: -2 * c / a0, a2: (1 - a) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
  }
  const hochpass = (f0, rate) => [biquad(f0, 0.5412, rate), biquad(f0, 1.3066, rate)];
  function filtern(h, x) {
    const y = h.b0 * x + h.b1 * h.x1 + h.b2 * h.x2 - h.a1 * h.y1 - h.a2 * h.y2;
    h.x2 = h.x1; h.x1 = x; h.y2 = h.y1; h.y1 = y;
    return y;
  }

  class Erkenner {
    constructor(opt = {}) {
      this.empf = opt.empf ?? 12;           // dB über dem Rauschboden
      this.min_ms = opt.min_ms ?? 150;
      this.halt_ms = opt.halt_ms ?? 1000;
      this.vorlauf_ms = opt.vorlauf_ms ?? 300;
      this.wind_db = opt.wind_db ?? 10;     // 0 = Windsperre aus
      this.rate = opt.rate || RATE;
      this.hp = hochpass(opt.hochpass ?? 300, this.rate);
      this.zuruecksetzen(true);
    }
    // nach einer Sendung bzw. Sperre: Zustand neu, Rauschboden bleibt (boden = true: auch den vergessen)
    zuruecksetzen(boden = false) {
      this.aktiv = false; this.ueber = 0; this.fehlt = 0; this.still = 0;
      this.ring = []; this.ring_ms = 0;
      if (boden) this.boden = null;
    }
    get schwelle() { return Math.max(BODEN_MIN, (this.boden ?? BODEN_MIN) + this.empf); }
    pegel(pcm) {  // Int16 oder Float (-1..1) -> dBFS nach dem Hochpass; this.tief = Energie unter dem Hochpass in dB darüber
      const [h1, h2] = this.hp, k = pcm instanceof Int16Array ? 1 / 32768 : 1;
      let s = 0, roh = 0;
      for (let i = 0; i < pcm.length; i++) {
        const x = pcm[i] * k, y = filtern(h2, filtern(h1, x));
        s += y * y; roh += x * x;
      }
      const dbv = e => e > 0 ? Math.max(STILLE, 10 * Math.log10(e / Math.max(1, pcm.length))) : STILLE;
      this.tief = dbv(roh) - dbv(s);
      return dbv(s);
    }
    // Einen Block verarbeiten. Liefert {ereignis: "start"|"ende"|null, db, schwelle, aktiv, wind}
    // Wind: Sprache hat ihre Energie zum großen Teil über 300 Hz, Wind fast ganz darunter. Liegt die Energie unter dem
    // Hochpass mehr als wind_db über der darüber, zählt der Block nicht als Sprache (VOX sperrt, PTT geht immer).
    rahmen(pcm) {
      const ms = pcm.length * 1000 / this.rate;
      let db = this.pegel(pcm);
      const wind = this.wind_db > 0 && this.tief > this.wind_db && db > STILLE + 20;
      if (wind) db = Math.min(db, this.boden ?? db);  // wie Stille behandeln, aber den Rauschboden nicht hochziehen
      // Vorlauf: Kopien der letzten Blöcke, vorlauf_ms vor dem Sprachbeginn plus die min_ms bis zum Start
      // (beim Start holt app.js sie mit vorlauf())
      this.ring.push(pcm.slice()); this.ring_ms += ms;
      const lang = b => b.length * 1000 / this.rate;
      while (this.ring.length > 1 && this.ring_ms - lang(this.ring[0]) >= this.vorlauf_ms + this.min_ms) this.ring_ms -= lang(this.ring.shift());
      if (this.boden == null) this.boden = db;
      const schwelle = this.schwelle;
      let ereignis = null;
      if (!this.aktiv) {
        if (db >= schwelle) { this.ueber += ms; this.fehlt = 0; }
        else if (this.ueber && !this.fehlt) { this.fehlt = 1; }  // ein Block Pause zählt noch mit
        else { this.ueber = 0; this.fehlt = 0; }
        if (this.ueber >= this.min_ms) { this.aktiv = true; this.still = 0; ereignis = "start"; }
        else if (!this.ueber) this.boden = db < this.boden ? db : Math.min(db, this.boden + STEIGEN * ms / 1000);  // nur in Stille nachführen
      } else {
        if (db >= schwelle - HYSTERESE) this.still = 0;
        else if ((this.still += ms) >= this.halt_ms) { this.zuruecksetzen(); ereignis = "ende"; }
      }
      return { ereignis, db, schwelle, aktiv: this.aktiv, wind };
    }
    // Vorlauf beim Start: die gepufferten Blöcke (ältester zuerst), danach ist der Ring leer
    vorlauf() { const r = this.ring; this.ring = []; this.ring_ms = 0; return r; }
  }

  return { Erkenner, RATE };
})();
if (typeof module === "object" && module.exports) module.exports = Vox;
