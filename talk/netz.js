// b:con-App, Netz: talk über Nostr-Relays (wss://), ohne Funkgerät oder zusätzlich zum Funk (Zello-Hybrid,
// bcon-talk/docs/NACHTRAG_Themenkanaele_Aufzeichnung_2026-10-16.md §5). Bytegleich zu bcon-core/src/bcon/talk
// (Kopf, Kompaktform, Strom-Signatur "bcon-talk1", Art 4420 in Teilen zu 1600 B) und bcon/region (PLZ-Labels).
// Gleiche Durchsage, gleiche Signatur auf beiden Wegen: Funkgeräte mit Relay (Gateway) hören die App und umgekehrt.
// Private Durchsagen versiegelt mit NIP-44 v2 an einen Schlüssel (["p",…], wie nostr_event mit t.an / bcon/nip44).
// Wird nur geladen, wenn der Netz-Weg an ist (import() aus app.js).
import { schnorr, getSharedSecret } from "./secp256k1.js";

const ART = 4420, TEIL = 1600, NS = "bcon.plz", MAX_SPRACHE = 239, MAX_PAKETE = 250, KOPF_MAX = 63;
export const ALLE = 339681;  // Base40 "ALLE" (talk.h kGruppeAlle)
const enc = new TextEncoder();
export const hex = b => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
export const unhex = s => Uint8Array.from(s.match(/../g) || [], x => parseInt(x, 16));
const sha = async b => new Uint8Array(await crypto.subtle.digest("SHA-256", b));
const zufall = n => crypto.getRandomValues(new Uint8Array(n));
const b64 = b => btoa(String.fromCharCode(...b));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const verbinde = (...t) => { const o = new Uint8Array(t.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of t) o.set(x, i), i += x.length; return o; };

// ---- region (bcon/region): "10115" -> "DE10115"; Labels aller Präfix-Stufen; Personen höchstens 3 PLZ-Stellen
export function region(s, land = "DE") {
  let r = String(s || "").toUpperCase().replace(/[ _-]/g, "");
  if (/^[0-9]/.test(r)) r = land + r;
  return /^[A-Z]{2}[0-9A-Z]{0,10}$/.test(r) ? r : "";
}
const labels = r => [["L", NS], ...Array.from({ length: r.length - 1 }, (_, i) => ["l", r.slice(0, i + 2), NS])];

// ---- Base40 (M17): erstes Zeichen = niedrigste Stelle
const B40 = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/.";
function b40(s, max) {
  s = String(s).toUpperCase();
  if (s.length > max) return null;
  let v = 0n;
  for (let i = s.length; i-- > 0;) { const w = B40.indexOf(s[i]); if (w < 1) return null; v = v * 40n + BigInt(w); }
  return v;
}
function b40aus(v) { let s = ""; for (; v; v /= 40n) s += B40[Number(v % 40n)]; return s; }
export const gruppe = name => { const v = b40(String(name).replace(/^@/, ""), 6); return v ? Number(v) : 0; };
export const gruppeName = id => b40aus(BigInt(id >>> 0));

// ---- Kopf-Nutzlast (talk.h, Typ 1): Codec | Flags | Ziel u32 | Zeit u32 | Name 6 | Schlüssel 32 | Regionlänge | Region | Gruppe u16
function kopfBauen(k) {
  const name = b40(k.name || "", 9), rg = enc.encode(k.region || "");
  if (name === null || (rg.length && region(k.region) !== k.region) || rg.length > 12) return null;
  const p = new Uint8Array(51 + rg.length), d = new DataView(p.buffer);
  p[0] = k.codec, p[1] = k.flags || 0;
  d.setUint32(2, k.ziel ?? ALLE, true); d.setUint32(6, k.zeit >>> 0, true);
  for (let i = 0; i < 6; i++) p[10 + i] = Number((name >> BigInt(8 * i)) & 255n);
  p.set(k.schluessel, 16); p[48] = rg.length; p.set(rg, 49);
  d.setUint16(49 + rg.length, k.gruppe || 0, true);
  return p;
}
function kopfLesen(p) {
  const rl = p[48];
  if (p.length < 49 || rl > 12 || (p.length !== 49 + rl && p.length !== 51 + rl)) return null;
  const d = new DataView(p.buffer, p.byteOffset, p.length);
  let name = 0n;
  for (let i = 0; i < 6; i++) name |= BigInt(p[10 + i]) << BigInt(8 * i);
  if (name >= 262144000000000n) return null;  // mehr als 9 Zeichen
  const rg = String.fromCharCode(...p.subarray(49, 49 + rl));
  if (rl && !/^[A-Z]{2}[0-9A-Z]*$/.test(rg)) return null;
  return { codec: p[0], flags: p[1], prio: (p[1] & 0x60) >> 5, ziel: d.getUint32(2, true), zeit: d.getUint32(6, true),
           name: b40aus(name), schluessel: hex(p.subarray(16, 48)), region: rg, gruppe: p.length === 51 + rl ? d.getUint16(49 + rl, true) : 0 };
}
export const mitPrio = (flags, prio) => { prio = Math.min(2, prio | 0); flags = (flags & ~0x60) | prio << 5; return prio === 2 ? flags | 1 : flags & ~1; };

const stromHash = (kopf, pakete) => sha(verbinde(enc.encode("bcon-talk1"), kopf, ...pakete.map((d, i) => verbinde([i + 1, d.length], d))));

// Eine Durchsage (Taste drücken bis loslassen) in Sprachpakete wie Sender::rahmen (feste Codec2-Rahmen, ≤ 239 B je
// Paket, Paketdauer 10 Rahmen). Am Ende Kompaktform: 1 | Kopflänge | Kopf | n | n × (Länge | Daten) | Signatur 64
export class Aufnahme {
  constructor(sk, k, nb) {
    this.sk = sk; this.nb = nb; this.je = Math.min(10, Math.floor(MAX_SPRACHE / nb));
    this.kopf = kopfBauen({ ...k, schluessel: schnorr.getPublicKey(sk) });
    if (!this.kopf) throw new Error("Kopf ungültig (Name oder Region)");
    this.pakete = []; this.sammel = [];
  }
  rahmen(bytes) {  // ein oder mehrere Codec-Rahmen hintereinander (wie 'A' an das Funkgerät)
    for (let i = 0; i + this.nb <= bytes.length && this.pakete.length < MAX_PAKETE; i += this.nb) {
      this.sammel.push(bytes.slice(i, i + this.nb));
      if (this.sammel.length === this.je) this.raus();
    }
  }
  raus() { if (this.sammel.length && this.pakete.length < MAX_PAKETE) this.pakete.push(verbinde(...this.sammel)); this.sammel = []; }
  async fertig(aux = zufall(32)) {
    this.raus();
    if (!this.pakete.length) return null;
    const sig = await schnorr.signAsync(await stromHash(this.kopf, this.pakete), this.sk, aux);
    return verbinde([1, this.kopf.length], this.kopf, [this.pakete.length], ...this.pakete.map(d => verbinde([d.length], d)), sig);
  }
}

// Kompaktform lesen (kompakt_lesen): Kopf, Pakete (leere = fehlend), Signatur des Sprechers geprüft
export async function kompaktLesen(p) {
  if (p.length < 3 || p[0] !== 1 || p[1] > KOPF_MAX) return null;
  let o = 2 + p[1];
  if (o + 1 > p.length) return null;
  const kopfRoh = p.subarray(2, o), n = p[o++], pakete = [];
  if (n > MAX_PAKETE) return null;
  for (let i = 0; i < n; i++) {
    if (o + 1 > p.length || o + 1 + p[o] > p.length) return null;
    pakete.push(p.subarray(o + 1, o + 1 + p[o])); o += 1 + p[o];
  }
  if (o + 64 !== p.length) return null;
  const kopf = kopfLesen(kopfRoh);
  if (!kopf) return null;
  const fehlend = pakete.filter(d => !d.length).length;
  const signatur = !fehlend && await schnorr.verifyAsync(p.subarray(o), await stromHash(kopfRoh, pakete), unhex(kopf.schluessel)).catch(() => false);
  return { kopf, pakete, fehlend, signatur };
}

export const kennung = async kompakt => hex((await sha(kompakt)).subarray(0, 8));

// ---- NIP-44 v2 (bcon/nip44): Unterhaltungsschlüssel = HKDF-Extract("nip44-v2", ECDH-x), je Nachricht
// HKDF-Expand(ck, Nonce, 76) -> ChaCha20-Schlüssel 32 | ChaCha-Nonce 12 | HMAC-Schlüssel 32
const hmac = async (k, ...d) => new Uint8Array(await crypto.subtle.sign("HMAC",
  await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), verbinde(...d)));
export const unterhaltung = (sk, pkHex) => hmac(enc.encode("nip44-v2"), getSharedSecret(sk, unhex("02" + pkHex)).subarray(1));
async function schluessel76(ck, nonce) {
  let t = new Uint8Array(0), o = [];
  for (let i = 1; o.length < 76; i++) o.push(...(t = await hmac(ck, t, nonce, [i])));
  return Uint8Array.from(o.slice(0, 76));
}
function chacha20(key, nonce, d) {  // RFC 8439, Zähler ab 0
  const k = new Uint32Array(key.slice().buffer), n = new Uint32Array(nonce.slice().buffer), o = new Uint8Array(d.length);
  const s = new Uint32Array(16), x = new Uint32Array(16), x8 = new Uint8Array(x.buffer);
  const q = (a, b, c, e) => {
    x[a] += x[b]; x[e] = (x[e] ^ x[a]) << 16 | (x[e] ^ x[a]) >>> 16; x[c] += x[e]; x[b] = (x[b] ^ x[c]) << 12 | (x[b] ^ x[c]) >>> 20;
    x[a] += x[b]; x[e] = (x[e] ^ x[a]) << 8 | (x[e] ^ x[a]) >>> 24; x[c] += x[e]; x[b] = (x[b] ^ x[c]) << 7 | (x[b] ^ x[c]) >>> 25;
  };
  s.set([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574, ...k, 0, ...n]);
  for (let p = 0; p < d.length; p += 64, s[12]++) {
    x.set(s);
    for (let r = 0; r < 10; r++) q(0, 4, 8, 12), q(1, 5, 9, 13), q(2, 6, 10, 14), q(3, 7, 11, 15), q(0, 5, 10, 15), q(1, 6, 11, 12), q(2, 7, 8, 13), q(3, 4, 9, 14);
    for (let i = 0; i < 16; i++) x[i] += s[i];
    for (let i = 0; i < 64 && p + i < d.length; i++) o[p + i] = d[p + i] ^ x8[i];
  }
  return o;
}
const aufgefuellt = n => { if (n <= 32) return 32; const z = 2 ** Math.ceil(Math.log2(n)), st = z <= 256 ? 32 : z / 8; return st * (Math.floor((n - 1) / st) + 1); };
export async function versiegeln(ck, pt, nonce = zufall(32)) {
  const m = await schluessel76(ck, nonce), roh = new Uint8Array(2 + aufgefuellt(pt.length));
  roh[0] = pt.length >> 8; roh[1] = pt.length & 255; roh.set(pt, 2);
  const ct = chacha20(m.subarray(0, 32), m.subarray(32, 44), roh);
  return b64(verbinde([2], nonce, ct, await hmac(m.subarray(44), nonce, ct)));
}
export async function oeffnen(ck, nutzlast) {  // null bei falscher Form, Version, Prüfsumme oder Auffüllung
  if (nutzlast.length < 132 || nutzlast.length > 87472 || nutzlast[0] === "#") return null;
  let d;
  try { d = unb64(nutzlast); } catch (e) { return null; }
  if (d.length < 99 || d.length > 65603 || d[0] !== 2) return null;
  const nonce = d.subarray(1, 33), ct = d.subarray(33, d.length - 32), m = await schluessel76(ck, nonce);
  const soll = await hmac(m.subarray(44), nonce, ct), ist = d.subarray(d.length - 32);
  if (soll.reduce((a, x, i) => a | x ^ ist[i], 0)) return null;
  const roh = chacha20(m.subarray(0, 32), m.subarray(32, 44), ct), n = roh[0] << 8 | roh[1];
  return n >= 1 && ct.length === 2 + aufgefuellt(n) ? roh.slice(2, 2 + n) : null;
}

// ---- Nostr-Events (nostr_event / nostr_teil_lesen)
async function signieren(sk, pk, art, tags, inhalt, zeit, aux = zufall(32)) {
  const id = hex(await sha(enc.encode(JSON.stringify([0, pk, zeit, art, tags, inhalt]))));
  return { id, pubkey: pk, created_at: zeit, kind: art, tags, content: inhalt, sig: hex(await schnorr.signAsync(unhex(id), sk, aux)) };
}
// Gruppen-Passwort (17.10.2026): offene Durchsagen einer Gruppe mit NIP-44 v2 versiegelt, Unterhaltungsschlüssel aus dem
// Passwort (PBKDF2-SHA-256, 200 000 Runden, Salz „bcon-gruppe1“). Tag ["gruppe", Kennung] = 16 hex aus dem Schlüssel; die
// PLZ-Labels bleiben, damit das Abo der Region die Events findet. Wer das Passwort nicht hat, sieht nur Rauschen.
export async function gruppeSchluessel(passwort) {
  const roh = await crypto.subtle.importKey("raw", enc.encode(String(passwort).normalize("NFC")), "PBKDF2", false, ["deriveBits"]);
  const ck = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode("bcon-gruppe1"), iterations: 200000 }, roh, 256));
  return { ck, kennung: hex((await sha(verbinde(enc.encode("bcon-gruppe-kennung"), ck))).subarray(0, 8)) };
}
// offen mit PLZ-Labels (rg) oder versiegelt an den Schlüssel an (64 hex, dann ohne Labels). aux: nur für Tests fest.
// opt.ablauf: Unixzeit für NIP-40 ["expiration"] (Relays löschen danach); opt.gruppe: {ck, kennung} aus gruppeSchluessel
export async function events(kompakt, sk, zeit, rg, aux, an, opt = {}) {
  const pk = hex(schnorr.getPublicKey(sk)), anzahl = Math.ceil(kompakt.length / TEIL), kenn = await kennung(kompakt);
  if (!anzahl || anzahl > 64) return [];
  const ck = an && await unterhaltung(sk, an), r = [];
  for (let t = 0; t < anzahl; t++) {
    const teil = kompakt.subarray(t * TEIL, (t + 1) * TEIL);
    const g = !an && opt.gruppe;
    const tags = [["talk", kenn, String(t), String(anzahl)], ["alt", "b:con-Sprechfunk"], ...(an ? [["p", an]] : rg ? labels(rg) : []),
                  ...(g ? [["gruppe", g.kennung]] : []), ...(opt.ablauf ? [["expiration", String(opt.ablauf)]] : [])];
    r.push(await signieren(sk, pk, ART, tags, an ? await versiegeln(ck, teil, aux) : g ? await versiegeln(g.ck, teil, aux) : b64(teil), zeit, aux));
  }
  return r;
}
export async function eventPruefen(e) {
  try {
    const id = hex(await sha(enc.encode(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))));
    return id === e.id && await schnorr.verifyAsync(unhex(e.sig), unhex(e.id), unhex(e.pubkey));
  } catch (x) { return false; }
}
// Teil lesen; versiegelte nur mit dem eigenen Schlüssel (sk), wenn ["p"] auf uns zeigt; Gruppe nur mit passendem
// Gruppenschlüssel (gruppen: Map Kennung -> {ck})
export async function teilLesen(e, sk, gruppen) {
  if (e.kind !== ART || typeof e.content !== "string" || !Array.isArray(e.tags)) return null;
  const t = e.tags.find(t => t.length === 4 && t[0] === "talk" && /^[0-9a-f]{16}$/.test(t[1])), p = e.tags.find(t => t[0] === "p");
  if (!t || !/^\d+$/.test(t[2]) || !/^\d+$/.test(t[3])) return null;
  const teil = +t[2], anzahl = +t[3], i = { kennung: t[1], teil, anzahl, versiegelt: !!p };
  if (!anzahl || anzahl > 64 || teil >= anzahl) return null;
  const g = !p && e.tags.find(t => t[0] === "gruppe");
  if (g) {
    const gr = gruppen?.get(g[1]);
    const daten = gr && await oeffnen(gr.ck, e.content).catch(() => null);
    return daten ? { ...i, daten, gruppe: g[1] } : null;
  }
  if (!p) { try { return { ...i, daten: unb64(e.content) }; } catch (x) { return null; } }
  if (!sk || p[1] !== hex(schnorr.getPublicKey(sk)) || !/^[0-9a-f]{64}$/.test(e.pubkey)) return null;
  const daten = await oeffnen(await unterhaltung(sk, e.pubkey).catch(() => null), e.content).catch(() => null);
  return daten && { ...i, daten };
}
// Teile wieder zusammensetzen (NostrSammler), Reihenfolge beliebig; mehrere Durchsagen gleichzeitig
export class Sammler {
  constructor() { this.offen = new Map(); }
  async teil(i) {
    const jetzt = Date.now();
    for (const [k, v] of this.offen) if (jetzt - v.t > 120000) this.offen.delete(k);
    let s = this.offen.get(i.kennung);
    if (!s || s.anzahl !== i.anzahl) this.offen.set(i.kennung, s = { anzahl: i.anzahl, teile: [], t: jetzt });
    const letzter = i.teil === i.anzahl - 1;
    if (letzter ? !i.daten.length || i.daten.length > TEIL : i.daten.length !== TEIL) return null;
    s.teile[i.teil] = i.daten;
    if (s.teile.filter(Boolean).length !== s.anzahl) return null;
    this.offen.delete(i.kennung);
    const k = verbinde(...s.teile);
    return await kennung(k) === i.kennung ? k : null;
  }
}

// ---- npub (NIP-19, bech32) zum Freischalten am Relay
const B32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l", GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
export function npub(pkHex) {
  const d = [];
  let acc = 0, bits = 0;
  for (const x of unhex(pkHex)) { acc = (acc << 8 | x) & 0xfff; bits += 8; while (bits >= 5) d.push(acc >> (bits -= 5) & 31); }
  if (bits) d.push(acc << (5 - bits) & 31);
  let c = 1;
  for (const x of [3, 3, 3, 3, 0, 14, 16, 21, 2, ...d, 0, 0, 0, 0, 0, 0]) {  // hrp "npub" erweitert
    const b = c >> 25; c = (c & 0x1ffffff) << 5 ^ x;
    for (let i = 0; i < 5; i++) if (b >> i & 1) c ^= GEN[i];
  }
  c ^= 1;
  return "npub1" + [...d, ...[0, 1, 2, 3, 4, 5].map(i => c >> 5 * (5 - i) & 31)].map(x => B32[x]).join("");
}

// ---- Schlüsselangebot (Art 4421): an einen Schlüssel versiegelt (NIP-44), Inhalt JSON {n: Name, t: Notiz, g: Gerät}.
// Die App unterschreibt das Event und bürgt damit für ihren Gerät-Schlüssel; Relay sieht nur Absender und Empfänger.
export const ANGEBOT = 4421;
export async function angebotEvent(sk, an, { name, notiz, geraet }, zeit) {
  const inhalt = enc.encode(JSON.stringify({ n: name || "", t: String(notiz || "").slice(0, 200), ...(geraet ? { g: geraet } : {}) }));
  return signieren(sk, hex(schnorr.getPublicKey(sk)), ANGEBOT, [["p", an], ["alt", "b:con-Schlüsselangebot"]],
    await versiegeln(await unterhaltung(sk, an), inhalt), zeit);
}
export async function angebotLesen(e, sk) {
  if (e.kind !== ANGEBOT || !e.tags?.some(t => t[0] === "p" && t[1] === hex(schnorr.getPublicKey(sk))) || !await eventPruefen(e)) return null;
  try {
    const j = JSON.parse(new TextDecoder().decode(await oeffnen(await unterhaltung(sk, e.pubkey), e.content)));
    return { app: e.pubkey, name: String(j.n || "").slice(0, 9), notiz: String(j.t || "").slice(0, 200),
             geraet: /^[0-9a-f]{64}$/.test(j.g) ? j.g : "", zeit: e.created_at };
  } catch (x) { return null; }
}
// Zeile für Whitelists (bcon-relay whitelist.txt, Stick, C3 „wl add <hex>“ nehmen den Hex-Teil, # = Kommentar)
export const schluesselZeile = (pk, name) => pk + " # " + (name || "") + " " + npub(pk);
export const oeffentlich = sk => hex(schnorr.getPublicKey(sk));

// ---- Chat übers Netz (Art 4423, 17.10.2026): Inhalt JSON {n: Rufname, t: Text, p: Priorität}. Offen mit PLZ-Labels,
// mit Gruppen-Passwort versiegelt für die Gruppe (["gruppe", Kennung]) oder privat an einen Schlüssel (["p"], NIP-44).
// Ablauf wie bei Durchsagen (NIP-40). Der Rufname ist Selbstangabe; geprüft ist nur der Schlüssel des Events.
export const CHAT = 4423, CHAT_MAX = 500;
export async function chatEvent(sk, text, { zeit = Math.floor(Date.now() / 1000), region: rg, an, name, prio = 0, ablauf = 0, gruppe } = {}) {
  text = String(text || "").slice(0, CHAT_MAX);
  if (!text) throw new Error("leer");
  const roh = enc.encode(JSON.stringify({ n: String(name || "").slice(0, 9), t: text, ...(prio ? { p: Math.min(2, prio | 0) } : {}) }));
  const g = !an && gruppe;
  const tags = [["alt", "b:con-Chat"], ...(an ? [["p", an]] : rg ? labels(rg) : []), ...(g ? [["gruppe", g.kennung]] : []),
                ...(ablauf ? [["expiration", String(ablauf)]] : [])];
  const inhalt = an ? await versiegeln(await unterhaltung(sk, an), roh) : g ? await versiegeln(g.ck, roh) : new TextDecoder().decode(roh);
  return signieren(sk, hex(schnorr.getPublicKey(sk)), CHAT, tags, inhalt, zeit);
}
// Liefert {von, name, text, prio, privat, gruppe, zeit} oder null (fremde Gruppe, nicht an uns, kaputt). Signatur prüft der Aufrufer.
export async function chatLesen(e, sk, gruppen) {
  if (e.kind !== CHAT || typeof e.content !== "string" || !Array.isArray(e.tags) || !/^[0-9a-f]{64}$/.test(e.pubkey)) return null;
  const p = e.tags.find(t => t[0] === "p"), g = !p && e.tags.find(t => t[0] === "gruppe");
  let roh;
  try {
    if (p) {
      if (!sk || p[1] !== hex(schnorr.getPublicKey(sk))) return null;
      roh = await oeffnen(await unterhaltung(sk, e.pubkey), e.content);
    } else if (g) {
      const gr = gruppen?.get(g[1]);
      roh = gr && await oeffnen(gr.ck, e.content);
    } else roh = enc.encode(e.content);
    if (!roh) return null;
    const j = JSON.parse(new TextDecoder().decode(roh));
    if (typeof j.t !== "string" || !j.t) return null;
    return { von: e.pubkey, name: typeof j.n === "string" ? j.n.slice(0, 9) : "", text: j.t.slice(0, CHAT_MAX),
             prio: Math.min(2, Math.max(0, j.p | 0)), privat: !!p, gruppe: g ? g[1] : "", zeit: e.created_at };
  } catch (x) { return null; }
}

// ---- Relays: je URL eine Leitung; Abo der Region (#L/#l wie bcon-talk/src/nostr.cpp), NIP-42-AUTH, Senden mit OK
export class Netz {
  // ablaufS: Lebensdauer eigener Durchsagen am Relay (NIP-40, 0 = unbegrenzt); gruppe: {ck, kennung} oder null
  constructor({ relays, sk, region: rg, beiDurchsage, beiStand, beiAngebot, angebotSeit, beiChat, ablaufS = 0, gruppe = null }) {
    this.sk = sk; this.pk = hex(schnorr.getPublicKey(sk)); this.region = rg; this.ablaufS = ablaufS; this.gruppe = gruppe;
    this.gruppen = new Map(gruppe ? [[gruppe.kennung, gruppe]] : []);
    this.beiDurchsage = beiDurchsage; this.beiStand = beiStand || (() => {});
    this.beiAngebot = beiAngebot || (() => {}); this.angebotSeit = angebotSeit || 0;
    this.beiChat = beiChat || (() => {}); this.chatSeit = Math.floor(Date.now() / 1000) - 3600;  // die letzte Stunde nachholen
    this.sammler = new Sammler(); this.gesehen = new Set(); this.gehoert = new Set(); this.aus = false;
    this.leitungen = relays.map(url => ({ url, ws: null, offen: false, pause: 2000, warte: new Map(), auth: null }));
    this.leitungen.forEach(l => this.oeffnen(l));
  }
  get verbunden() { return this.leitungen.filter(l => l.offen).length; }
  get gesperrt() { return this.leitungen.filter(l => l.gesperrt).length; }  // Relays, die diese App (noch) nicht schreiben lassen
  stand() { this.beiStand(this.verbunden + " von " + this.leitungen.length + " Relays verbunden" + (this.gesperrt ? " · bei " + this.gesperrt + " nicht freigeschaltet" : "")); }
  oeffnen(l) {
    if (this.aus) return;
    let ws;
    try { ws = l.ws = new WebSocket(l.url); } catch (e) { return this.spaeter(l); }
    ws.onopen = () => {
      l.offen = true; l.pause = 2000; this.stand();
      const seit = Math.floor(Date.now() / 1000) - 120, an = { kinds: [ART], "#p": [this.pk], since: seit };  // wie bcon-talk/src/nostr.cpp
      ws.send(JSON.stringify(["REQ", "talk", an, ...(this.region ? [{ kinds: [ART], "#L": [NS], "#l": [this.region], since: seit }] : [])]));
      // Angebote auch nachholen (seit dem letzten gesehenen), damit keins verloren geht, wenn die App zu war
      ws.send(JSON.stringify(["REQ", "angebot", { kinds: [ANGEBOT], "#p": [this.pk], since: this.angebotSeit }]));
      ws.send(JSON.stringify(["REQ", "chat", { kinds: [CHAT], "#p": [this.pk], since: this.chatSeit },
        ...(this.region ? [{ kinds: [CHAT], "#L": [NS], "#l": [this.region], since: this.chatSeit }] : [])]));
    };
    ws.onmessage = m => { try { this.nachricht(l, JSON.parse(m.data)); } catch (x) {} };
    ws.onclose = () => {
      l.offen = false; l.auth = null; this.stand();
      for (const w of l.warte.values()) w({ ok: false, msg: "getrennt" });
      l.warte.clear();
      this.spaeter(l);
    };
  }
  spaeter(l) { if (!this.aus) setTimeout(() => this.oeffnen(l), l.pause), l.pause = Math.min(60000, l.pause * 2); }
  async nachricht(l, m) {
    if (m[0] === "OK") { const w = l.warte.get(m[1]); if (w) l.warte.delete(m[1]), w({ ok: m[2] === true, msg: String(m[3] || "") }); return; }
    if (m[0] === "AUTH" && typeof m[1] === "string") {
      const a = await signieren(this.sk, this.pk, 22242, [["relay", l.url], ["challenge", m[1]]], "", Math.floor(Date.now() / 1000));
      l.auth = new Promise(r => l.warte.set(a.id, r));
      l.ws.send(JSON.stringify(["AUTH", a]));
      return;
    }
    if (typeof m[1] === "string" && m[1].startsWith("box") && l.abruf?.id === m[1]) {  // Postfach-Abruf, nie live abspielen
      if (m[0] === "EVENT" && m[2]) l.abruf.evs.push(m[2]);
      else if (m[0] === "EOSE" || m[0] === "CLOSED") l.abruf.fertig();
      return;
    }
    if (m[0] !== "EVENT" || !m[2] || this.gesehen.has(m[2].id)) return;
    const e = m[2];
    if (this.gesehen.size > 2000) this.gesehen.clear();
    this.gesehen.add(e.id);
    if (e.pubkey === this.pk) return;  // eigenes Echo
    const ab = e.tags?.find?.(t => t[0] === "expiration");
    if (ab && Number(ab[1]) < Date.now() / 1000) return;  // NIP-40: abgelaufen, auch wenn das Relay es noch liefert
    if (e.kind === ANGEBOT) {
      const a = await angebotLesen(e, this.sk);
      if (a) this.angebotSeit = Math.max(this.angebotSeit, e.created_at + 1), this.beiAngebot(a);
      return;
    }
    if (e.kind === CHAT) {
      const c = await eventPruefen(e) && await chatLesen(e, this.sk, this.gruppen);
      if (c) this.chatSeit = Math.max(this.chatSeit, e.created_at + 1), this.beiChat({ ...c, relay: l.url });
      return;
    }
    if (this.gehoert.has(e.tags?.find?.(t => t[0] === "talk")?.[1]) || !await eventPruefen(e)) return;
    const t = await teilLesen(e, this.sk, this.gruppen);
    if (!t) return;
    const k = await this.sammler.teil(t);
    if (!k) return;
    if (this.gehoert.size > 2000) this.gehoert.clear();
    this.gehoert.add(t.kennung);
    const d = await kompaktLesen(k);
    // absender = Schlüssel des Events (Sprecher selbst oder Gateway); bei Lücken ist nur er geprüft, nicht der Kopf
    if (d) this.beiDurchsage({ ...d, kennung: t.kennung, privat: t.versiegelt, gruppe: t.gruppe || "", absender: e.pubkey, relay: l.url });
  }
  // Kompaktform veröffentlichen (an = Schlüssel des Empfängers: versiegelt); liefert die Zahl der Relays, die alle
  // Teile angenommen haben
  async senden(kompakt, zeit, an) {
    const evs = await events(kompakt, this.sk, zeit, this.region, undefined, an,
      { ablauf: this.ablaufS ? zeit + this.ablaufS : 0, gruppe: this.gruppe });
    if (this.gehoert.size > 2000) this.gehoert.clear();
    this.gehoert.add(await kennung(kompakt));
    return this.raus(evs);
  }
  // Chat-Text veröffentlichen (an: Schlüssel, dann privat); liefert die Zahl der Relays, die ihn angenommen haben
  async chat(text, { an, name, prio } = {}) {
    const zeit = Math.floor(Date.now() / 1000);
    return this.raus([await chatEvent(this.sk, text, { zeit, region: this.region, an, name, prio,
      ablauf: this.ablaufS ? zeit + this.ablaufS : 0, gruppe: this.gruppe })]);
  }
  async anbieten(an, angaben) { return this.raus([await angebotEvent(this.sk, an, angaben, Math.floor(Date.now() / 1000))]); }
  // Event an ein Relay, Antwort {ok, msg} (OK des Relays, Trennung oder Zeitüberschreitung)
  async antwort(l, e) {
    if (l.auth) await Promise.race([l.auth, new Promise(r => setTimeout(r, 3000))]);
    const a = await new Promise(r => { l.warte.set(e.id, r); l.ws.send(JSON.stringify(["EVENT", e])); setTimeout(() => r({ ok: false, msg: "keine Antwort" }), 5000); });
    l.warte.delete(e.id);
    return a;
  }
  async raus(evs) {
    const je = await Promise.all(this.leitungen.filter(l => l.offen).map(async l => {
      for (const e of evs) {
        const a = await this.antwort(l, e);
        if (!a.ok) { if (a.msg.startsWith("restricted")) l.gesperrt = true, this.stand(); return false; }
      }
      if (l.gesperrt) l.gesperrt = false, this.stand();
      return true;
    }));
    return je.filter(Boolean).length;
  }
  // Freischaltung anfragen (Art 4422, Inhalt = Notiz, Tag name) bei den Relays, die abgelehnt haben (sonst bei allen).
  // Das b:con-Relay legt sie auf die Warteliste des OP, speichert und verteilt sie nicht. Ergebnis je Relay.
  async freischaltung(name, notiz) {
    const e = await signieren(this.sk, this.pk, 4422, [["name", name || ""], ["alt", "b:con-Freischaltung"]], String(notiz || "").slice(0, 200), Math.floor(Date.now() / 1000));
    const ziel = this.leitungen.filter(l => l.offen && l.gesperrt);
    return Promise.all((ziel.length ? ziel : this.leitungen.filter(l => l.offen)).map(async l => ({ url: l.url, ...await this.antwort(l, e) })));
  }
  // ---- Postfach übers Netz: liegende Events abrufen (eigenes Abo je Relay bis EOSE, höchstens warten ms), prüfen,
  // zusammensetzen. art "privat": an uns versiegelt, alle Relays (wenig Daten); "oeffentlich": nur mit Region, die neuesten
  // hoechst der letzten tage, Relays nacheinander (jedes liefert dieselben Events: erst das nächste fragen, wenn noch
  // Einträge fehlen). Mit Gruppen-Passwort öffentlich nur Gruppen-Einträge. Liefert [{typ: "sprache"|"text", von, zeit, …}].
  async postfach(art, { tage = 7, hoechst = 50, warten = 6000 } = {}) {
    const jetzt = Math.floor(Date.now() / 1000);
    if (art === "oeffentlich" && !this.region) return [];
    const f = art === "privat" ? { kinds: [ART, CHAT], "#p": [this.pk], since: jetzt - tage * 86400, limit: 300 }
                               : { kinds: [ART, CHAT], "#L": [NS], "#l": [this.region], since: jetzt - tage * 86400, limit: 300 };
    const id = "box" + Math.random().toString(36).slice(2, 8);
    const holen = l => new Promise(fertig => {
      const ab = l.abruf = { id, evs: [], fertig: () => { clearTimeout(t); if (l.abruf === ab) l.abruf = null; try { l.ws.send(JSON.stringify(["CLOSE", id])); } catch (x) {} fertig(ab.evs); } };
      const t = setTimeout(ab.fertig, warten);
      try { l.ws.send(JSON.stringify(["REQ", id, f])); } catch (x) { ab.fertig(); }
    });
    const schon = new Set(), sammler = new Sammler(), r = [];
    const verarbeiten = async roh => {
      for (const e of roh.sort((a, b) => a.created_at - b.created_at)) {
        if (!e || schon.has(e.id) || e.pubkey === this.pk) continue;
        schon.add(e.id);
        const ab = e.tags?.find?.(t => t[0] === "expiration");
        if (ab && Number(ab[1]) < jetzt) continue;
        const gr = e.tags?.find?.(t => t[0] === "gruppe")?.[1] || "";
        const privat = e.tags?.some?.(t => t[0] === "p");
        if (art === "oeffentlich" && this.gruppe && gr !== this.gruppe.kennung) continue;
        if (!await eventPruefen(e)) continue;
        if (e.kind === CHAT) {
          const c = await chatLesen(e, this.sk, this.gruppen);
          if (c) r.push({ typ: "text", ...c });
          continue;
        }
        const t = await teilLesen(e, this.sk, this.gruppen);
        const k = t && await sammler.teil(t);
        const d = k && await kompaktLesen(k);
        if (d && !r.some(x => x.kennung === t.kennung))
          r.push({ typ: "sprache", ...d, kennung: t.kennung, privat, gruppe: t.gruppe || "", absender: e.pubkey, von: d.kopf.schluessel, zeit: e.created_at });
      }
    };
    const offen = this.leitungen.filter(l => l.offen);
    if (art === "privat") await verarbeiten((await Promise.all(offen.map(holen))).flat());
    else for (const l of offen) { await verarbeiten(await holen(l)); if (r.length >= hoechst) break; }
    this.abgerufen = schon.size;
    return r.sort((a, b) => b.zeit - a.zeit).slice(0, art === "privat" ? 300 : hoechst);
  }
  stoppen() { this.aus = true; for (const l of this.leitungen) if (l.ws) l.ws.onclose = null, l.ws.close(); }
}
