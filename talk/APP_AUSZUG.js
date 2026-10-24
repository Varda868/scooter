// APP_AUSZUG.js – NUR ZUM NACHLESEN, wird nicht eingebunden und läuft so nicht.
// Wörtliche Auszüge aus bcon-app app.js, Branch vox, Commit 78eab3986d593d3b2ff2dceab59a4c251bd27f25
// (Repo codeberg.org/bcongrid/bcon-app, Copyright b:con / b:congrid, AGPL-3.0, siehe LICENSE-AGPL-3.0.txt).
// Jeder Abschnitt nennt seine Zeilen im Original. Ausgewählt für den reinen Netzbetrieb (Nostr) mit VOX:
// Einstellungen, Verbindungsstand, Nachrichten/Anzeige (rx/ende), PTT druecken/loslassen, VOX, Netz (netzStarten,
// netzAufnahme, netzSenden, netzHoeren, Warteschlange, netzSk), Relay-/Region-/Gruppen-Einstellungen, Chat übers Netz,
// Ton freischalten, Wachhalten, Start. Funkgerät-Teile (ws, Kabel, Seriell) sind mit drin, wo sie verwoben sind.

// ===== app.js Zeilen 1–8 =====
// b:con-App: Verbindung zum Sprechfunk-Server auf dem Funkgerät (bcon-talk, C3 oder S3), Funk (PTT), Chat, Modus.
// Protokoll: Kopf von bcon-talk/src/funk.cpp. Text = JSON, Binär = Ton ('A' hin, 'P' zurück).
"use strict";
const APP_STAND = 65;  // bei jeder neuen Fassung erhöhen, gleich STAND in sw.js ("bcon-app-65")
if (typeof Aussehen === "undefined") window.Aussehen = { starten() {}, t: s => s, ort: () => "de-DE" };  // ältere Firmware ohne aussehen.js
Aussehen.starten();
const $ = id => document.getElementById(id);


// ===== app.js Zeilen 122–149 =====
// ---------- Einstellungen (nur Bequemlichkeit, bleibt im Handy)
// https-App: wss:// zum Funkgerät (Gerätezertifikat einmal bestätigen); vom Gerät per http ausgeliefert: ws:// dorthin
const LOKAL = /^(192\.168|10|172\.(1[6-9]|2\d|3[01]))\./;
const STANDARD = LOKAL.test(location.hostname) ? (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/"
  : location.protocol === "https:" ? "wss://192.168.4.13/" : "ws://192.168.4.13/";
// Feste Geräte-IP im Hotspot: 192.168.4.13 (ältere Firmware: 192.168.4.1). Schlägt der erste Aufbau fehl, die andere probieren.
const GERAET_IP = "192.168.4.13", GERAET_IP_ALT = "192.168.4.1";
function andereIp(url) {
  const m = url.match(/^(wss?:\/\/)(192\.168\.4\.(?:13|1))(\/.*)?$/);
  return m ? m[1] + (m[2] === GERAET_IP ? GERAET_IP_ALT : GERAET_IP) + (m[3] || "/") : null;
}
const E = { adresse: STANDARD, rufname: "" };
try { Object.assign(E, JSON.parse(localStorage.getItem("bcon-app") || "{}")); } catch (e) {}
if (location.protocol === "https:" && /^ws:\/\/192\.168\.4\.1\/$/.test(E.adresse)) E.adresse = STANDARD;  // alter Standard aus 0.5
function merken() { try { localStorage.setItem("bcon-app", JSON.stringify(E)); } catch (e) {} }
// Rufname: freier Kurzname, kein Amateurfunk-Rufzeichen. Länge 3–9, oder was das Gerät in info.name_min/name_max meldet
let RUF_MIN = 3, RUF_MAX = 9;
const rufOk = r => !!r && r.length >= RUF_MIN;  // zu kurz: ohne Rufname senden (Gerät nimmt seinen Namen)
const KEIN_AFU = "Bitte keine Amateurfunk-Rufzeichen verwenden. b:con-Sprechfunk ist kein Amateurfunk.";
// sieht aus wie ein AFu-Rufzeichen (Präfix, Ziffer, 1–4 Buchstaben), z. B. DL1ABC, K1AB, 9A1AA, HS0ZAA
const wieAfu = r => /^([A-Z]{1,2}|[0-9][A-Z]|[A-Z][0-9])[0-9][A-Z]{1,4}$/.test(r);
function rufPruefen() {
  const r = $("rufname").value;
  $("ruf-warnung").textContent = r && r.length < RUF_MIN ? "Zu kurz: mindestens " + RUF_MIN + " Zeichen. Bis dahin sendet das Funkgerät unter seinem eigenen Namen."
    : wieAfu(r) ? "„" + r + "“ sieht aus wie ein Amateurfunk-Rufzeichen. " + KEIN_AFU : "";
}
function rufname(s) { return String(s || "").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, RUF_MAX); }


// ===== app.js Zeilen 280–610 =====
// ---------- Zähler
const Z = { gesendet: 0, sende_ms: 0, empfangen: 0, pakete: 0, luecken: 0, chat_raus: 0, chat_rein: 0, getrennt: 0 };
function zaehler() {
  $("zaehler").textContent = Object.entries(Z).map(([k, v]) => k.padEnd(10) + " " + v).join("\n");
}

// ---------- Verbindung
function zertHinweis() {
  const h = $("funk-hinweis"); h.textContent = "";
  if (location.protocol === "https:" && E.adresse.startsWith("ws:")) {
    h.textContent = "Keine Verbindung: Chrome lässt von https-Seiten kein ws:// ins lokale Netz zu. Adresse auf wss://192.168.4.13/ stellen.";
    return;
  }
  if (!E.adresse.startsWith("wss:")) { h.textContent = "Keine Verbindung. Ist das Handy im WLAN des Funkgeräts? Android fragt, ob das WLAN ohne Internet verbunden bleiben soll: „Ja“."; return; }
  const ziel = "https://" + E.adresse.replace(/^wss:\/\//, "").replace(/\/.*$/, "") + "/";
  h.append("Keine Verbindung. Im WLAN des Funkgeräts? (Android fragt, ob das WLAN ohne Internet verbunden bleiben soll: „Ja“.) Beim ersten Mal muss das Gerätezertifikat bestätigt werden: ");
  const a = document.createElement("a"); a.href = ziel; a.target = "_blank"; a.rel = "noopener";
  a.textContent = "Zertifikat bestätigen"; h.append(a);
  h.append(" (Warnung → Erweitert → Weiter zu " + ziel.slice(8, -1) + "), dann hierher zurück.");
}
let ws = null, info = {}, wiederAn = null, gewollt = true, fehlVersuche = 0;
function stand(text, art) {
  $("v-text").textContent = text;
  $("punkt").className = "punkt " + (art || "");
}
function tx(o) { if (ws && ws.readyState === 1) { ws.send(typeof o === "string" || o instanceof Uint8Array ? o : JSON.stringify(o)); return true; } return false; }

async function verbinden(geraet) {
  clearTimeout(wiederAn);
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  gewollt = true;
  let url = E.adresse.trim();
  const kabel = url === "kabel", seriell = url === "seriell";
  if (!kabel && !seriell && !/^wss?:\/\//.test(url)) url = "ws://" + url.replace(/^https?:\/\//, "");
  stand(suchtNur() ? "kein Funkgerät" : "verbinde …", suchtNur() ? "" : "halb");
  $("funk-hinweis").textContent = "";
  try {
    if (kabel) {
      if (!Kabel.geht()) throw new Error("Dieser Browser kann kein WebUSB (Chrome nehmen).");
      geraet = geraet || await Kabel.bekannt().catch(() => null);
      if (!geraet) { stand("Kabel: kein Gerät"); $("funk-hinweis").textContent = "Funkgerät per USB anstecken, dann unter Einstellungen „Per Kabel verbinden“."; wiederAn = setTimeout(verbinden, 3000); return; }
      ws = new KabelLeitung(geraet);
    } else if (seriell) {
      if (!Seriell.geht()) throw new Error("Dieser Browser kann kein Web Serial (Chrome oder Edge am PC nehmen).");
      geraet = geraet || await Seriell.bekannt().catch(() => null);
      if (!geraet) { stand("Seriell: kein Gerät"); $("funk-hinweis").textContent = "Funkgerät an die COM-Buchse anstecken, dann unter Einstellungen „Seriell (PC)“."; wiederAn = setTimeout(verbinden, 3000); return; }
      ws = new SerielleLeitung(geraet);
    } else ws = new WebSocket(url);
  } catch (e) {
    stand("nicht erlaubt");
    $("funk-hinweis").textContent = location.protocol === "https:" && url.startsWith("ws:")
      ? "Der Browser lässt von dieser https-Seite keine ws://-Verbindung zu (" + e.name + "). Siehe Einstellungen → Hinweis."
      : "Verbindung nicht möglich: " + e.message;
    return;
  }
  ws.binaryType = "arraybuffer";
  const meins = ws;
  // Hängt der Aufbau (Handy schlief, wss-Handshake bleibt stehen), nicht auf onclose warten: Leitung wegwerfen
  const offenBis = setTimeout(() => { if (ws === meins && ws.readyState !== 1) abreissen(meins, 1006); }, 6000);
  ws.onopen = () => {
    clearTimeout(offenBis); lebt = Date.now(); stand("verbunden", "an"); $("ptt").disabled = false;
    meins.offen = true; fehlVersuche = 0; merken();  // gefundene IP behalten
    tx({ t: "zeit", unix: Math.floor(Date.now() / 1000) });  // im Hotspot gibt es kein NTP: Uhr vom Handy
    wachHalten(true);
  };
  ws.onmessage = e => {
    lebt = Date.now();
    if (typeof e.data === "string") { try { nachricht(JSON.parse(e.data)); } catch (x) { console.warn(x); } return; }
    const d = new Uint8Array(e.data);
    if (d[0] === 0x50) { empfaenger.paket(d); Z.empfangen++; zaehler(); }  // 'P'
  };
  ws.onclose = e => { clearTimeout(offenBis); abreissen(meins, e.code); };
}
// Leitung aufgeben (onclose, Zeitüberschreitung oder tote Leitung nach dem Aufwachen) und neu verbinden
function abreissen(l, code) {
  if (l !== ws) return;
  l.onopen = l.onmessage = l.onclose = null;
  try { l.close(); } catch (x) {}
  ws = null;
  pttFrei();
  // Nur eine Sendung übers Funkgerät endet mit der Leitung; eine reine Netz-Sendung läuft weiter
  // (ohne Funkgerät scheitert die Suche alle paar Sekunden und riss sonst das Sprechen ab)
  if (taste && taste.geraet) loslassen();
  Z.getrennt++; zaehler();
  if (!l.offen && !["kabel", "seriell"].includes(E.adresse)) {  // nie verbunden: feste IP und alte IP abwechselnd probieren
    const alt = andereIp(E.adresse);
    if (alt) { fehlVersuche++; E.adresse = alt; $("adresse").value = alt; }
  } else fehlVersuche = 0;
  stand(Date.now() - kanalWechsel < 20000 ? "Kanal wird gewechselt …" : suchtNur() ? "kein Funkgerät"
    : "getrennt" + (gewollt ? " – neuer Versuch …" : ""));
  // Zertifikatshinweis nur, wenn man offenbar ein Funkgerät erwartet (kein Netz aktiv)
  if (code === 1006 && !info.version && !netzBereit() && (!andereIp(E.adresse) || fehlVersuche >= 2)) zertHinweis();
  info = {};
  clearTimeout(wiederAn);
  // Kein Funkgerät gefunden (beide IPs probiert): ruhig im Hintergrund weitersuchen, alle 15 s
  if (gewollt) wiederAn = setTimeout(verbinden, suchtNur() ? 15000 : document.visibilityState === "visible" ? 1500 : 3000);
}
let lebt = 0, letztesZiel = "ALLE", kanalWechsel = 0;
// Zurück in der App: hängende Leitung sofort neu, offene Leitung mit info anpingen, ohne Antwort neu
function aufwachen() {
  if (document.visibilityState !== "visible" || !gewollt) return;
  if (!ws) { clearTimeout(wiederAn); verbinden(); return; }
  if (ws.readyState !== 1) { abreissen(ws, 1006); return; }
  wachHalten(true);
  const l = ws, vorher = Date.now();
  tx({ t: "info" });
  setTimeout(() => { if (ws === l && lebt < vorher) abreissen(l, 1006); }, 3000);
}

const MODI = { espnow: "ESP-NOW", lr: "ESP-NOW Long Range", v2: "ESP-NOW v2", v2lr: "ESP-NOW v2 Long Range" };
function lage() {
  $("hotspot-zeile").hidden = typeof info.hotspot !== "boolean";
  // info.papagei: bool, info.papagei_art: "lokal" | "funk"
  $("papagei-zeile").hidden = false;
  const hell = info.led_hell ?? info.led?.hell; if (hell != null) $("led-hell").value = hell;  // nur im Testmodus sichtbar (.dev); info.papagei noch nicht überall gemeldet
  $("papagei").value = typeof info.papagei === "string" ? (["lokal", "funk"].includes(info.papagei) ? info.papagei : "aus")
    : info.papagei ? (info.papagei_art === "funk" ? "funk" : "lokal") : "aus";
  gruppeZeigen();
  $("kanal-zeile").hidden = !info.kanal_max;
  if (info.kanal_max) {
    const von = Math.max(1, info.kanal_min || 1);  // alle b:con-Geräte (Relay, Box, talk) auf Kanal 1, Entscheidung 18.10.
    if ($("kanal").options.length !== info.kanal_max - von + 1)
      $("kanal").replaceChildren(...Array.from({ length: info.kanal_max - von + 1 }, (_, i) => new Option(String(von + i) + (von + i === 1 ? " ★" : ""), von + i)));
    if (info.kanal != null) $("kanal").value = info.kanal;
  }
  $("routing-zeile").hidden = info.bake_min == null;
  if (info.bake_min != null) {
    if (document.activeElement !== $("bake-min")) $("bake-min").value = info.bake_min;
    if (info.mpr_modus) $("mpr-modus").value = info.mpr_modus;
    $("routing-stand").textContent = "aktiv: " + (info.flut === "mpr" ? "MPR" : "Managed Flooding") +
      (info.nachbarn != null ? " · " + info.nachbarn + (info.nachbarn === 1 ? " Nachbar" : " Nachbarn") : "") + (info.mpr ? " · ich bin Weiterleiter" : "");
  }
  $("ttl-zeile").hidden = info.ttl == null;
  if (info.ttl != null) { $("ttl").max = info.ttl_max || 7; if (document.activeElement !== $("ttl")) $("ttl").value = info.ttl; }
  if (typeof info.papagei_ignoriert === "boolean") $("papagei-ignorieren").checked = info.papagei_ignoriert;
  $("hotspot").checked = !!info.hotspot;
  $("l-geraet").textContent = (info.name || "–") + (info.version ? " · " + info.version : "");
  $("l-modus").textContent = (MODI[info.modus] || info.modus || "–") + (info.allhoeren ? " · hört alle Arten" : "");
  $("l-kanal").textContent = info.kanal != null ? info.kanal : "–";
  if (info.modus) $("modus").value = info.modus;
  if (info.folgen != null) $("folgen").checked = !!info.folgen;
  if (info.suchlauf_auto != null) $("such-auto").checked = !!info.suchlauf_auto;
  if (info.stille_s) $("stille").value = info.stille_s;
  chatLaenge();
  fwAnzeige();
  aufzeichnungZeigen();
  prioAnzeigen();
  $("fassung").textContent = "App " + APP_STAND + " · Protokoll 0.2 · Codec2 als WebAssembly";
}

// ---------- Nachrichten vom Funkgerät
let rxSlot = null;

// ---------- Gehörte Teilnehmer (für private Nachrichten: Ziel ist der Geräteschlüssel)
const leute = new Map();  // schluessel -> {name, geraet}
function teilnehmer(d) {
  if (!d.schluessel || d.eigen || d.schluessel === info.schluessel) return;
  buchMerken(d);
  const neu = !leute.has(d.schluessel);
  leute.set(d.schluessel, { name: d.von || d.geraet, geraet: d.geraet, netz: d.weg === "nostr" && !d.geraet });
  if (neu) zielListen();
}
// Gleicher Rufname bei verschiedenen Geräten: Gerätename dazuschreiben (Absender ist eindeutig über den Schlüssel)
function wer(d) {
  const al = d.schluessel && E.buch?.[d.schluessel]?.alias;
  if (al) return al + (d.von && d.von !== al ? " (" + d.von + ")" : "");
  const n = d.von || d.geraet || "?";
  const doppelt = [...leute].some(([k, v]) => !k.startsWith("@") && k !== d.schluessel && v.name === n)
    || (n === E.rufname && d.schluessel && d.schluessel !== info.schluessel);
  return doppelt && d.geraet && d.geraet !== n ? n + " (" + d.geraet + ")" : n;
}
function namePruefen(d) {
  if (!E.rufname || !d.schluessel || d.schluessel === info.schluessel || d.eigen) return;
  if ((d.von || "") === E.rufname) $("funk-hinweis").textContent = "Achtung: „" + E.rufname + "“ benutzt noch jemand (Gerät " + (d.geraet || "?") + "). Bitte einen anderen Rufnamen wählen, sonst landet @" + E.rufname + " womöglich beim Falschen.";
}
function zielListen() {
  for (const [id, alle] of [["funk-ziel", "Alle (live)"], ["chat-ziel", "Alle"]]) {
    const sel = $(id), war = sel.value;
    sel.replaceChildren(new Option(alle, "ALLE"));
    const vor = id === "funk-ziel" ? "Dialog: " : "";
    for (const [k, v] of leute) sel.append(new Option(vor + (k.startsWith("@") ? k : (E.buch[k]?.alias || v.name) + " · " + (v.geraet || k.slice(0, 8))), k));
    sel.append(new Option(vor + "@Rufname eingeben …", "@?"));
    sel.value = [...sel.options].some(o => o.value === war) ? war : "ALLE";
  }
  // zweite PTT-Taste: festes Ziel aus Kontakten und Gehörten (ohne „@Rufname eingeben“)
  const z2 = $("ptt2-ziel");
  z2.replaceChildren(new Option(Aussehen.t("Alle"), "ALLE"), ...[...leute].filter(([k]) => !k.startsWith("@")).map(([k, v]) => new Option((E.buch[k]?.alias || v.name) + " · " + (v.geraet || k.slice(0, 8)), k)),
    ...Object.values(E.kontakte || {}).filter(c => c.app && !leute.has(c.app) && !leute.has(c.geraet)).map(c => new Option(c.name + " · Kontakt", c.geraet || c.app)));
  if (E.ptt_ziel2 && ![...z2.options].some(o => o.value === E.ptt_ziel2)) z2.append(new Option(E.ptt_ziel2.slice(0, 8) + " …", E.ptt_ziel2));
  z2.value = E.ptt_ziel2 || "ALLE";
  angebotZiele();
}
function nachricht(d) {
  switch (d.t) {
    case "info": info = Object.assign(info, d); if (d.name_max > 0) { RUF_MAX = d.name_max; $("rufname").maxLength = RUF_MAX; } if (d.name_min > 0) RUF_MIN = d.name_min; rufPruefen(); lage(); break;
    case "modus":
      if (d.modus) { info.modus = d.modus; lage(); }
      if (d.folgen != null) { info.folgen = d.folgen; $("folgen").checked = !!d.folgen; }
      if (d.modus && wechselZiel === d.modus) $("wechsel").hidden = true;
      if (d.ansage) $("modus-text").textContent = "Ansage an die anderen läuft, dann wird umgeschaltet …";
      else if (d.text || d.neustart) $("modus-text").textContent = (d.text || "") + (d.neustart ? " Das Funkgerät startet neu, die App verbindet sich danach wieder." : "");
      break;
    case "ptt":  // neue Firmware: erst hineinhören, dann frei oder abgelehnt
      if (d.status === "frei") freigegeben(d.codec);
      else if (d.status === "abgelehnt") abgelehnt(d.grund, d.von);
      break;
    case "trace": traceErgebnis(d); break;
    case "ping": pingErgebnis(d); break;
    case "kanal": kanalWechsel = Date.now(); $("modus-text").textContent = "Kanal wird gewechselt …"; break;
    case "antwortfenster":
      $("funk-hinweis").textContent = "Antwortfenster " + (d.ms / 1000).toLocaleString(Aussehen.ort()) + " s";
      clearTimeout(fensterUhr); fensterUhr = setTimeout(() => { $("funk-hinweis").textContent = ""; }, d.ms || 2500);
      voxSperre(d.ms || 2500, "antwortfenster");
      break;
    case "belegt":
      if (taste) {
        $("ptt").classList.add("belegt"); $("ptt-text").textContent = "Kanal belegt";
        if (taste.vox) voxSperre(2000, "belegt"); else Sprechfunk.signal("belegt").catch(() => {});
        abbrechen();
      }
      break;
    case "gesendet":
      eintrag("gesendet: " + d.pakete + " Pakete" + (d.box ? (d.live || letztesZiel === "ALLE" ? ", live und im öffentlichen Postfach" : ", ins Postfach") : "") + (d.nostr ? ", auch über Nostr" : "") + (d.voll ? " (30 s voll)" : ""));
      break;
    case "fehler": $("funk-hinweis").textContent = "Funkgerät meldet Fehler: " + (d.grund || "?"); if (taste) abbrechen(); break;
    case "rx":
      teilnehmer(d); wegMerken(d);
      rxSlot = d.slot;
      $("empfang").hidden = false;
      namePruefen(d);
      if (d.durchsage) navigator.vibrate?.([150, 80, 150]);
      $("e-von").textContent = (d.durchsage ? PRIO_MARKE[1] : "") + (d.gruppe ? "G" + d.gruppe + " · " : "") + wer(d) + (d.weg === "box" ? " (Postfach)" : d.ziel === "Gruppe" ? " (Gruppe)" : d.ziel && d.ziel !== "ALLE" ? " (an dich)" : "");
      $("e-weg").textContent = ({ funk: "live", espnow: "live", box: "Postfach", nostr: "Nostr", papagei: "Papagei" }[d.weg] || d.weg || "") + (d.papagei && d.weg !== "papagei" ? " · Papagei" : "") + (Sprechfunk.CODECS[d.codec] ? " · " + Sprechfunk.CODECS[d.codec].name : " · Codec " + d.codec) + (d.aufzeichnung ? " · ● wird aufgezeichnet" : "");
      $("e-stand").textContent = "empfange …";
      if (dialogMit(d)) dialogAktiv();
      dialogAngebot = d.schluessel && d.schluessel !== info.schluessel && !d.eigen && d.weg !== "papagei" && !dialogMit(d) ? d : null;
      $("b-dialog").hidden = !dialogAngebot;
      empfaenger.beginnen(d.slot, d.codec, { prio: d.durchsage ? 1 : 0, sprecher: d.schluessel || d.von || "", weg: d.weg });
      break;
    case "ende": {
      const s = empfaenger.beenden(d.slot);
      Z.pakete += d.pakete || 0; Z.luecken += d.fehlend || 0; zaehler();
      const txt = (d.pakete || 0) + " Pakete, " + (d.fehlend || 0) + " fehlend" + (d.signatur === false ? ", Signatur falsch" : d.signatur ? ", signiert" : "");
      $("e-stand").textContent = txt;
      eintrag("von " + $("e-von").textContent + ": " + txt);
      if (d.slot === rxSlot) setTimeout(() => { if (rxSlot === d.slot) $("empfang").hidden = true; }, 2500);
      break;
    }
    case "chat":
      if (typeof d.text === "string" && d.text.startsWith(KK)) {  // Schlüsselangebot über Funk, nicht im Chat zeigen
        if (!d.eigen) angebotKommt({ app: ausB64url(d.text.slice(KK.length, KK.length + 43)), geraet: d.schluessel || "", name: d.von || "", notiz: d.text.slice(KK.length + 44), weg: "funk" });
        break;
      }
      teilnehmer(d); chatZeile(d); papageiText(d); break;
    case "papagei_bericht": bericht(d, true); break;
    case "papagei_log": for (const m of d.eintraege || []) bericht(m, false); break;
    case "modus_ankuendigung": case "modus_wechsel": if (!d.eigen) { teilnehmer(d); modusWechsel(d); } break;
    case "teilnehmer": teilnehmerListe(d.liste || []); break;
    case "suchlauf": suchlauf(d); break;
    case "gefunden": {  // live je Fund während des Suchlaufs
      teilnehmer(d);
      const li = document.createElement("li");
      li.textContent = (d.von || d.geraet || "?") + " in " + (MODI[d.modus] || d.modus) + (d.rssi != null ? ", " + d.rssi + " dBm" : "");
      $("such-ergebnis").append(li);
      break;
    }
    case "box_liste": boxListe(d); break;
    case "box_neu": boxNeu(d); break;
    case "box_ok": if (!d.ok) $("box-leer").textContent = "Das Funkgerät hat das nicht ausgeführt."; if (seite === "box") boxLaden(); break;
    case "chat_gesendet": if (!d.ok) chatSystem("Nicht gesendet" + (d.grund || d.text ? ": " + (d.grund || d.text) : "")); break;
  }
}

function eintrag(t) {
  const li = document.createElement("li");
  li.textContent = new Date().toLocaleTimeString(Aussehen.ort()) + "  " + Aussehen.t(t);
  $("verlauf").prepend(li);
  while ($("verlauf").children.length > 50) $("verlauf").lastChild.remove();
}

// Dialogmodus: privates Ziel im Funk, auf demselben Kanal 1 (getrennt per Kennung wie CTCSS); nach E.dialog_min Minuten Stille zurück auf „Alle“.
let dialogBis = 0;
const dialogMs = () => (E.dialog_min || 5) * 60000;
const dialogMit = d => { const z = $("funk-ziel").value; return z !== "ALLE" && (z === d.schluessel || z === "@" + d.von); };
function dialogZeigen() {
  const z = $("funk-ziel").value, an = z !== "ALLE" && z !== "@?";
  $("dialog").hidden = !an;
  if (!an) { dialogBis = 0; return; }
  if (!dialogBis) dialogBis = Date.now() + dialogMs();
  const o = $("funk-ziel").selectedOptions[0], rest = Math.max(1, Math.ceil((dialogBis - Date.now()) / 60000));
  $("dialog-text").textContent = "Dialog mit " + (o ? o.textContent.replace(/^Dialog: /, "") : z) + " · zurück auf Alle nach " + rest + " min Stille";
}
function dialogAktiv() { if ($("funk-ziel").value !== "ALLE") { dialogBis = Date.now() + dialogMs(); dialogZeigen(); } }
function dialogEnde(warum) {
  $("funk-ziel").value = "ALLE"; dialogBis = 0; dialogZeigen();
  if (warum) { $("funk-hinweis").textContent = warum; eintrag(warum); Sprechfunk.signal("frei").catch(() => {}); }
}
setInterval(() => { if (!dialogBis) return; if (Date.now() > dialogBis) dialogEnde("Dialog beendet (Stille), zurück auf Alle."); else dialogZeigen(); }, 10000);
$("b-dialog-ende").onclick = () => dialogEnde();
let dialogAngebot = null;

// Gruppen wie CTCSS: 0 = offen (hört alles); sonst gibt das Funkgerät nur die eigene Gruppe und OP-Durchsagen weiter
function gruppeZeigen() {
  $("gruppe-zeile").hidden = !info.gruppe_max; $("box-alle-zeile").hidden = !info.gruppe_max;
  if (!info.gruppe_max) return;
  $("gruppe").max = info.gruppe_max;
  if (document.activeElement !== $("gruppe")) $("gruppe").value = info.gruppe || 0;
  $("gruppe-hinweis").textContent = info.gruppe ? "hört nur Gruppe " + info.gruppe + " und OP-Durchsagen" : "offen, hört alles";
}
$("gruppe").onchange = () => {
  const n = Math.max(0, Math.min(info.gruppe_max || 65535, Math.round(Number($("gruppe").value) || 0)));
  $("gruppe").value = n;
  if (!tx({ t: "gruppe", setzen: n })) $("funk-hinweis").textContent = "Nicht verbunden.";
};
$("box-alle").onchange = () => boxLaden();
$("b-dialog").onclick = () => {
  const d = dialogAngebot; if (!d) return;
  teilnehmer(d); zielListen(); $("funk-ziel").value = d.schluessel; dialogBis = 0; dialogZeigen(); $("b-dialog").hidden = true;
};
for (const id of ["funk-ziel", "chat-ziel"]) $(id).addEventListener("change", () => {
  const sel = $(id);
  if (sel.value !== "@?") return;
  const n = rufname(prompt("Rufname des Empfängers (" + RUF_MIN + " bis " + RUF_MAX + " Zeichen):") || "");
  if (!rufOk(n)) { sel.value = "ALLE"; return; }
  leute.set("@" + n, { name: "@" + n });
  zielListen();
  sel.value = "@" + n;
});
$("funk-ziel").addEventListener("change", () => { dialogBis = 0; dialogZeigen(); });
zielListen();


// ===== app.js Zeilen 611–1095 =====
// ---------- Senden (PTT)
const mikro = new Sprechfunk.Mikrofon();
const empfaenger = new Sprechfunk.Empfaenger();
empfaenger.beiPegel = p => { $("e-pegel").value = p; };
const pegelZeigen = p => { $("pegel").value = taste || voxAn() ? p : 0; };  // mit VOX auch in Ruhe (zum Einstellen)
mikro.beiPegel = pegelZeigen;
// Ein Empfänger für alle Mikrofon-Blöcke: VOX hört immer mit (wenn an), die laufende Sendung bekommt sie über „senke“
let senke = null;
mikro.beiRahmen = pcm => { if (voxAn()) voxRahmen(pcm); if (senke) senke(pcm); };
let taste = null, tasteBis = null, tasteUhr = null, fensterUhr = null;
// Vorrang: 0 normal, 1 OP-Durchsage (nur diese Sendung). Die Durchsage darf nur ein OP senden (das Funkgerät meldet
// info.op, wenn sein Schlüssel auf der OP-Liste steht, sonst lehnt es mit „kein_op“ ab). Empfangene Durchsagen tragen
// "durchsage":true; sie unterbrechen laufende Wiedergaben und kommen mit eigenem Gong.
const PRIO_MARKE = ["", "DURCHSAGE · "];
const istOp = () => info.op === true;
const neuesProtokoll = () => info.antwortfenster_ms != null;  // Firmware meldet frei/abgelehnt
function prioWert() { const p = Number($("prio").value) || 0; return p === 1 && istOp() ? 1 : 0; }
function prioAnzeigen() {
  const op = istOp(), opt = $("prio").querySelector('option[value="1"]');
  if (opt) opt.hidden = opt.disabled = !op;
  if (!op && $("prio").value === "1") $("prio").value = "0";
  const d = $("prio").value === "1";
  $("prio").classList.toggle("durchsage", d); $("ptt").classList.toggle("durchsage", d);
  if (!taste) $("ptt-text").textContent = Aussehen.t(d ? "DURCHSAGE: drücken und sprechen" : "Drücken und sprechen");
}
$("prio").onchange = prioAnzeigen;
prioAnzeigen();
// Bedienung: „einfach“ zeigt nur Funken, Chat, Postfach und Rufname; „experte“ alles (Klasse .experte)
function bedienung(art) { document.body.classList.toggle("experte", art === "experte"); $("bedienung").value = art; }
$("bedienung").onchange = () => { E.bedienung = $("bedienung").value; merken(); bedienung(E.bedienung); };
bedienung(E.bedienung || "einfach");
$("kanal").onchange = () => {
  const n = Number($("kanal").value);
  if (!confirm("Auf Kanal " + n + " wechseln? Wer auf dem alten Kanal bleibt, ist dann nicht mehr zu hören.")) { $("kanal").value = info.kanal; return; }
  if (!tx({ t: "kanal", setzen: n })) { $("kanal").value = info.kanal; $("modus-text").textContent = "Nicht verbunden."; return; }
  kanalWechsel = Date.now(); $("modus-text").textContent = "Kanal wird gewechselt …";  // Hotspot wechselt mit, die App verbindet sich neu
};
function routingSetzen() {
  const n = Math.max(0, Math.min(60, Number($("bake-min").value) || 0));
  $("bake-min").value = n;
  if (!tx({ t: "routing", bake_min: n, mpr: $("mpr-modus").value })) $("modus-text").textContent = "Nicht verbunden.";
}
$("bake-min").onchange = routingSetzen; $("mpr-modus").onchange = routingSetzen;
$("ttl").onchange = () => {
  const n = Math.max(1, Math.min(Number($("ttl").max) || 7, Math.round(Number($("ttl").value) || 7)));
  $("ttl").value = n;
  if (!tx({ t: "ttl", setzen: n })) $("modus-text").textContent = "Nicht verbunden.";
};
// Android verweigert Berechtigungsfragen, solange eine andere App etwas über den Bildschirm legt (Schutz vor Tapjacking)
const UEBERLAGERT = " Hat Android „darf nicht nach deiner Berechtigung fragen“ gemeldet: schwebende Fenster, Blasen, Blaulichtfilter oder Bildschirmaufnahme schließen und noch einmal versuchen.";
const SENDE_MAX = 30000;  // Firmware: höchstens 250 Pakete je Sendung (talk.h kMaxPakete)

// Codec-Stufe (Entscheidung 18.10.): allgemeiner Kanal (Alle, Gruppen) immer 1600; Dialog nach Einstellung, sonst nach
// dem schwächsten Weg zum Gegenüber (nur Netz/Hotspot 3200, Funk 1600, Funk Long Range 700C). Nie zwei Stufen parallel:
// ein Kodierer für Funk und Netz. Das Funkgerät kennt die Wege besser und darf die Stufe beim Freigeben setzen
// ({"t":"ptt","status":"frei","codec":n}); mit codec_fest im Kopf gilt die Einstellung des Nutzers.
const wege = new Map();  // schluessel -> {modus, weg}: wie wir das Gegenüber zuletzt gehört haben
function wegMerken(d) { if (d.schluessel && !d.eigen) wege.set(d.schluessel, { modus: d.modus || wege.get(d.schluessel)?.modus, weg: d.weg }); }
const LANG = m => m === "lr" || m === "v2lr";
function codecWahl(ziel, geraet) {
  if (ziel === "ALLE") return { codec: 3, fest: false };
  const fest = Number(E.codec_dialog);
  if (Sprechfunk.CODECS[fest]) return { codec: fest, fest: true };
  const kt = kontaktVon(ziel), w = wege.get(kt?.geraet || ziel) || wege.get(kt?.app || ziel);
  if (!geraet || (w ? w.weg === "nostr" : leute.get(ziel)?.netz)) return { codec: 1, fest: false };  // nur übers Netz
  return { codec: LANG(w?.modus || info.modus) ? 8 : 3, fest: false };
}
// Paketlänge zum Funkgerät: kurz (Vorgabe 120 ms, das Gerät darf info.paket_ms melden); ESP-NOW bündelt das Gerät selbst
const paketMs = () => Math.max(40, Math.min(400, Number(info.paket_ms) || 120));
const toene = () => E.toene !== false;
// Aufzeichnung sichtbar machen (Datenschutz): Durchsagen an Alle und Gruppen landen im öffentlichen Postfach des Funkgeräts
// (info.aufzeichnung = false schaltet den Hinweis ab, eine Liste nennt die aufgezeichneten Gruppen) und bleiben auf Relays
// bis zum Ablauf (Netz).
function aufzeichnungZeigen() {
  const z = $("funk-ziel").value, alle = z === "ALLE", gr = Number($("gruppe").value) || 0, teile = [];
  const a = info.aufzeichnung, geraet = !!ws && ws.readyState === 1;
  if (geraet && alle && (Array.isArray(a) ? a.includes(gr) : a ?? info.box_oeffentlich_max > 0))
    teile.push(gr ? "Gruppe " + gr + " wird im Funkgerät aufgezeichnet" : "Durchsagen an Alle werden im öffentlichen Postfach aufgezeichnet");
  if (netzBereit()) teile.push("Netz: " + (alle ? "Durchsagen" : "private Sendungen") + " bleiben " + (E.netz_ablauf_h ?? 24) + " h auf den Relays");
  $("aufzeichnung").hidden = !teile.length;
  $("aufzeichnung").textContent = "● " + teile.join(" · ");
}
$("funk-ziel").addEventListener("change", aufzeichnungZeigen);
$("gruppe").addEventListener("change", aufzeichnungZeigen);

async function druecken(zielWahl, vonVox = false) {
  const geraet = !!ws && ws.readyState === 1;
  if (taste || (!geraet && !netzBereit())) return;
  $("funk-hinweis").textContent = "";
  $("ptt").classList.remove("stumm");
  const ziel = zielWahl || $("funk-ziel").value;
  const { codec, fest } = codecWahl(ziel, geraet);
  taste = { start: Date.now(), geraet, ziel, codec, vox: vonVox };
  const t = taste;
  $("ptt").classList.add("sendet");
  $("ptt-text").textContent = "Mikrofon …";
  try {
    await Sprechfunk.laden();
    const probe = new Sprechfunk.Codec(codec), n = probe.n; probe.frei();
    await mikro.oeffnen(n);
    if (taste !== t) return;  // schon wieder losgelassen
    t.bereit = true;
    t.prio = t.vox ? 0 : prioWert();  // Durchsagen nie per VOX
    t.kontakt = kontaktVon(ziel);  // Kontakt: Funk an den Geräte-, Netz an den App-Schlüssel
    const kopf = { t: "ptt", ziel: t.kontakt?.geraet || ziel, codec, prio: t.prio, box: ziel !== "ALLE" };
    if (fest) kopf.codec_fest = true;
    letztesZiel = ziel; if (!zielWahl) dialogAktiv();
    if (rufOk(E.rufname)) kopf.name = E.rufname;
    if (geraet) { tx(kopf); t.kopf = true; }
    if (t.prio) $("prio").value = "0", prioAnzeigen();  // die Durchsage gilt nur für diese Sendung
    if (geraet && neuesProtokoll()) {  // Funkgerät hört erst hinein; ohne Antwort nach 1 s wie bisher weiter
      $("ptt-text").textContent = "Kanal prüfen …";
      t.warte = setTimeout(freigegeben, 1000);
    } else freigegeben();
  } catch (e) {
    $("funk-hinweis").textContent = e.name === "NotAllowedError" ? "Mikrofon nicht erlaubt." + UEBERLAGERT : "Mikrofon: " + e.message;
    abbrechen();
  }
}
// Freigabe: erst jetzt steht die Codec-Stufe fest (das Funkgerät kann sie mitschicken); ein Kodierer für Funk und Netz
function freigegeben(codecVomGeraet) {
  const t = taste;
  if (!t || !t.bereit || t.frei) return;
  clearTimeout(t.warte); t.frei = true;
  const kennung = Sprechfunk.CODECS[codecVomGeraet] ? codecVomGeraet : t.codec;
  const netzA = { a: null };  // Netz-Aufnahme bekommt dieselben Codec-Rahmen wie das Funkgerät
  t.sender = new Sprechfunk.Sender(kennung, b => { if (t.geraet) tx(b); if (netzA.a) netzA.a.rahmen(b.subarray(1)); }, paketMs());
  mikro.groesse(t.sender.codec.n);
  t.netz = netzA.a = netzAufnahme(kennung, t.sender.codec.nb, t.kontakt?.app || t.ziel, t.prio);
  $("ptt-text").textContent = t.vox ? "VOX sendet …" : "Sende …";
  const ton = toene() && !t.vox;  // bei VOX kein Ton: er käme ins Headset-Mikrofon und mitten ins erste Wort
  if (ton) Sprechfunk.signal("frei").catch(() => {});
  const ab = Date.now() + (ton ? 180 : 0);  // Bestätigungston nicht mitsenden
  if (t.vorlauf) { voxNachschieben(t.vorlauf, t.sender); t.vorlauf = null; }  // VOX: Wortanfang bis zur Freigabe
  senke = pcm => { if (taste === t && Date.now() >= ab) t.sender.pcm(pcm); };
  // „Du sendest, aber das Mikrofon ist stumm“: gesperrte oder stummgeschaltete Spur sofort melden, sonst Stille-Wächter
  const spur = mikro.spur;
  const stumm = () => {
    if (taste !== t) return;
    $("ptt").classList.add("stumm"); navigator.vibrate?.([80, 60, 80]);
    $("funk-hinweis").textContent = "Du sendest, aber das Mikrofon ist stumm oder gesperrt. Nutzt eine andere App das Mikrofon (Aufnahme, Notiz, Bildschirmaufnahme, Anruf)? Diese beenden und neu drücken.";
  };
  if (spur && (spur.muted || !spur.enabled || spur.readyState !== "live")) stumm();
  if (spur) spur.onmute = stumm;
  let spitze = 0;
  mikro.beiPegel = p => { pegelZeigen(p); spitze = Math.max(spitze, p); };
  setTimeout(() => {
    if (taste === t && spitze < 0.002) { stumm(); mikro.schliessen(); }  // nächstes Drücken öffnet es neu
  }, 2000);
  tasteBis = setTimeout(loslassen, SENDE_MAX);  // das Funkgerät nimmt höchstens 30 s
  const los = Date.now();
  tasteUhr = setInterval(() => {  // mitzählen, die letzten 5 s rückwärts (Vibration statt Ton: der Ton käme ins Mikrofon)
    const s = Math.floor((Date.now() - los) / 1000), rest = Math.ceil((SENDE_MAX - (Date.now() - los)) / 1000);
    if (rest <= 5) { $("ptt-text").textContent = "noch " + rest + " s"; $("ptt").classList.add("knapp"); navigator.vibrate?.(40); }
    else $("ptt-text").textContent = (festGestellt ? "Festgestellt, tippen = Ende " : t.vox ? "VOX sendet … " : "Sende … ") + s + " s";
  }, 1000);
}
function abgelehnt(grund, von) {
  if (!taste) return;
  $("ptt").classList.add("belegt");
  $("ptt-text").textContent = grund === "antwortfenster" ? "Erst die anderen antworten lassen"
    : grund === "kollision" ? "Gleichzeitig gedrückt" : grund === "kein_op" ? "Durchsage nur für OPs" : "Kanal belegt";
  if (von) $("funk-hinweis").textContent = (grund === "kollision" ? "Vorrang hat " : "Es spricht ") + von;
  if (taste.vox) voxSperre(2000, grund);  // nicht bei jedem Ansatz neu brummen
  else Sprechfunk.signal("belegt").catch(() => {});
  abbrechen();
}
function loslassen() {
  clearTimeout(tasteBis); clearInterval(tasteUhr);
  festGestellt = false; $("ptt").classList.remove("fest");
  if (!taste) return;
  const t = taste; taste = null; clearTimeout(t.warte);
  senke = null;
  if (mikro.spur) mikro.spur.onmute = null;
  if (t.sender) {
    t.sender.ende();
    if (t.netz) netzSenden(t.netz);
    Z.gesendet++; Z.sende_ms += t.sender.dauer_ms; zaehler();
    eintrag((t.vox ? "VOX " : "") + "gesprochen: " + (t.sender.dauer_ms / 1000).toFixed(1) + " s");
    if (toene() && !t.vox) Sprechfunk.signal("los").catch(() => {});
  }
  if (t.kopf) tx({ t: "los" });
  voxNachSendung(t);
  zuruecksetzen();
}
function abbrechen() {  // belegt/Fehler: nichts mehr schicken, aber den Server freigeben
  clearTimeout(tasteBis); clearInterval(tasteUhr);
  festGestellt = false; $("ptt").classList.remove("fest");
  if (taste) clearTimeout(taste.warte);
  if (taste && taste.sender) { taste.sender.teile = []; taste.sender.codec.frei(); }
  if (taste && taste.kopf) tx({ t: "los" });
  const t = taste;
  taste = null; senke = null;
  if (t) voxNachSendung(t);
  setTimeout(zuruecksetzen, 1200);
}
function zuruecksetzen() {
  if (taste) return;
  $("ptt").classList.remove("sendet", "belegt", "knapp", "stumm");
  $("ptt-text").textContent = $("prio").value === "1" ? "DURCHSAGE: drücken und sprechen" : "Drücken und sprechen";
  $("pegel").value = 0;
}
// Bedienung der Taste (Knopf, Tastatur, Fußtaster, Gamepad): halten = senden. Doppeldruck (zweimal kurz) stellt fest,
// dann beendet der nächste Druck; „Umschalten“ für Knöpfe, die man nicht halten kann: jeder Druck schaltet. 30 s Grenze bleibt.
const KURZ_MS = 350, DOPPEL_MS = 450;
let festGestellt = false, kurzBis = 0;
function pttRunter(ziel) {
  if (taste && taste.vox) { taste.vox = false; vox.zuruecksetzen(); voxStand(); return; }  // Taste übernimmt die VOX-Sendung: loslassen beendet
  if (taste && (festGestellt || E.ptt_umschalten)) { loslassen(); return; }
  if (taste) return;
  const doppel = Date.now() < kurzBis; kurzBis = 0;
  druecken(ziel);
  if (doppel && taste) { festGestellt = true; $("ptt").classList.add("fest"); navigator.vibrate?.([30, 50, 30]); }
}
function pttHoch() {
  if (!taste || festGestellt || E.ptt_umschalten) return;
  if (Date.now() - taste.start < KURZ_MS) kurzBis = Date.now() + DOPPEL_MS;
  loslassen();
}
const ptt = $("ptt");
ptt.addEventListener("pointerdown", e => { e.preventDefault(); ptt.setPointerCapture(e.pointerId); pttRunter(); });
ptt.addEventListener("pointerup", pttHoch);
ptt.addEventListener("pointercancel", pttHoch);
ptt.addEventListener("contextmenu", e => e.preventDefault());
// Hardware-PTT: frei wählbare Taste (Tastatur, Fußtaster, Taster, die als Tastatur auftreten) oder Gamepad-Knopf.
// Leertaste nur auf der Funk-Seite (sonst stört sie Knöpfe und Eingaben), eine gelernte Taste überall außer beim Tippen.
// Zweite Taste mit festem Ziel (wie Mumble-Flüstern): Taste 1 = Ziel aus „An“, Taste 2 = z. B. immer „Alle“ oder ein Kontakt.
let lernen = 0, padAn = false;
const padWar = [false, false, false];
const pttTaste = n => n === 2 ? E.ptt_taste2 || null : E.ptt_taste || { code: "Space" };
const tasteCode = e => e.code || e.key;
const imFeld = () => { const a = document.activeElement; return !!a && (/^(TEXTAREA|SELECT)$/.test(a.tagName) || (a.tagName === "INPUT" && !/^(checkbox|radio|button|range)$/.test(a.type))); };
const tastenName = t => !t ? "keine" : t.pad != null ? "Gamepad-Knopf " + t.pad : t.code === "Space" ? "Leertaste" : t.code;
function pttTasteZeigen() {
  $("ptt-taste-name").textContent = lernen === 1 ? "Taste oder Knopf drücken … (Esc = abbrechen)" : tastenName(pttTaste(1));
  $("ptt-taste2-name").textContent = lernen === 2 ? "Taste oder Knopf drücken … (Esc = abbrechen)" : tastenName(pttTaste(2));
  $("b-ptt2-weg").hidden = !E.ptt_taste2;
  $("ptt-umschalten").checked = !!E.ptt_umschalten;
  $("toene").checked = toene();
}
function gelernt(t) { const n = lernen; lernen = 0; if (t) E[n === 2 ? "ptt_taste2" : "ptt_taste"] = t; merken(); pttTasteZeigen(); }
const ziel2 = () => E.ptt_ziel2 || "ALLE";
function tasteRunter(n) { if (n === 2) { if (!taste || taste.ziel === ziel2()) pttRunter(ziel2()); } else pttRunter(); }
const tastePasst = (e, n) => { const t = pttTaste(n); return !!t && t.pad == null && tasteCode(e) === t.code && !imFeld() && (t.code !== "Space" || seite === "funk"); };
const welcheTaste = e => tastePasst(e, 1) ? 1 : tastePasst(e, 2) ? 2 : 0;
document.addEventListener("keydown", e => {
  if (lernen) { e.preventDefault(); return gelernt(e.key === "Escape" ? null : { code: tasteCode(e) }); }
  const n = welcheTaste(e);
  if (n) { e.preventDefault(); if (!e.repeat) tasteRunter(n); }
});
document.addEventListener("keyup", e => { if (welcheTaste(e)) { e.preventDefault(); pttHoch(); } });
function padSchleife() {
  const pads = [...(navigator.getGamepads?.() || [])].filter(Boolean);
  if (!pads.length) { padAn = false; return; }
  if (lernen) {
    for (const p of pads) { const i = p.buttons.findIndex(b => b.pressed); if (i >= 0) { padWar[lernen] = true; gelernt({ pad: i }); break; } }
  } else for (const n of [1, 2]) {
    const t = pttTaste(n), an = t?.pad != null && pads.some(p => p.buttons[t.pad]?.pressed);
    if (an !== padWar[n]) { padWar[n] = an; if (an) tasteRunter(n); else pttHoch(); }
  }
  requestAnimationFrame(padSchleife);
}
function padStarten() { if (!padAn && navigator.getGamepads?.().some(Boolean)) { padAn = true; requestAnimationFrame(padSchleife); } }
addEventListener("gamepadconnected", () => { if (!padAn) { padAn = true; requestAnimationFrame(padSchleife); } });
$("b-ptt-lernen").onclick = e => { e.currentTarget.blur(); lernen = 1; pttTasteZeigen(); padStarten(); };
$("b-ptt2-lernen").onclick = e => { e.currentTarget.blur(); lernen = 2; pttTasteZeigen(); padStarten(); };
$("b-ptt2-weg").onclick = () => { delete E.ptt_taste2; merken(); pttTasteZeigen(); };
$("ptt2-ziel").onchange = () => { E.ptt_ziel2 = $("ptt2-ziel").value; merken(); };
$("ptt-umschalten").onchange = () => { E.ptt_umschalten = $("ptt-umschalten").checked; merken(); };
$("toene").onchange = () => { E.toene = $("toene").checked; merken(); };
pttTasteZeigen();

// ---------- VOX: sprachgesteuert senden (talk/vox.js, Konzept bcon-talk docs/GRUPPENFAHRT_VOX.md §1)
// Startet und beendet über druecken/loslassen, also mit Hineinhören, Kollision, Belegt, Antwortfenster und 30 s wie die
// Taste. Die Taste hat Vorrang (drücken während VOX sendet = Taste übernimmt). Gesperrt, solange etwas abgespielt wird
// (Lautsprecher oder Headset würde VOX auslösen), im eigenen Antwortfenster und 2 s nach einer Ablehnung. Durchsagen nie
// per VOX. Vorlauf: die Blöcke vor dem Start und bis zur Freigabe des Funkgeräts werden nachgeschoben.
const vox = new Vox.Erkenner();
let voxSperreBis = 0, voxGrund = "", voxFehler = "", voxLetzt = null;
function voxAn() { return E.sprechen === "vox"; }
function voxEinstellen() {
  vox.empf = Number(E.vox_empf) || 12;
  vox.halt_ms = Number(E.vox_halt) || 1000;
  $("sprechen").value = voxAn() ? "vox" : "ptt";
  $("vox-empf").value = vox.empf; $("vox-empf-text").textContent = vox.empf + " dB";
  $("vox-halt").value = String(vox.halt_ms);
  $("vox-agc").checked = E.vox_agc === true;
  $("vox-einst").hidden = !voxAn();
  const agc = !voxAn() || E.vox_agc === true;
  if (mikro.agc !== agc && !taste) { mikro.agc = agc; mikro.schliessen(); }  // neu öffnen mit der neuen Einstellung
  vox.zuruecksetzen(true); voxFehler = "";
  voxMikro();
}
function voxSperre(ms, grund) { voxSperreBis = Math.max(voxSperreBis, Date.now() + ms); voxGrund = grund; vox.zuruecksetzen(); }
function voxNachSendung(t) {
  vox.zuruecksetzen();
  // eigenes Antwortfenster (Firmware wartet nach dem eigenen Ende), sonst kurz Ruhe; dann Mikrofon wieder sicherstellen
  if (t.vox || voxAn()) voxSperre(t.kopf && neuesProtokoll() ? Number(info.antwortfenster_ms) || 2500 : 300, "antwortfenster");
  setTimeout(voxMikro, 1300);
}
// Mikrofon für VOX offen halten (die Taste öffnet es sonst erst beim Drücken)
async function voxMikro() {
  // erst nach einer Berührung (Autoplay-Regel): sonst wartet das Öffnen auf den Ton und hält auch die Taste auf
  if (!voxAn() || taste || voxFehler || !Sprechfunk.tonBereit()) return voxStand();
  const spur = mikro.spur;
  if (spur && spur.readyState === "live" && !spur.muted) return voxStand();
  try {
    await Sprechfunk.laden();
    const probe = new Sprechfunk.Codec(3), n = probe.n; probe.frei();  // Blöcke wie Codec2 1600 (40 ms)
    if (!taste) await mikro.oeffnen(n);
  }
  catch (e) { voxFehler = e.name === "NotAllowedError" ? "Mikrofon nicht erlaubt" : "Mikrofon: " + e.message; }
  voxStand();
}
function voxRahmen(pcm) {
  const t = taste;
  if (t && t.vox && !t.frei && t.vorlauf) { t.vorlauf.push(pcm.slice()); if (t.vorlauf.length > 100) t.vorlauf.shift(); }  // bis zur Freigabe (höchstens 4 s)
  if (t && !t.vox) { vox.zuruecksetzen(); return voxStand(); }  // Taste sendet
  if (!t && (Date.now() < voxSperreBis || empfaenger.spielt() || $("ptt").disabled)) { vox.zuruecksetzen(); return voxStand(); }
  const r = vox.rahmen(pcm);
  voxLetzt = r;
  if (r.ereignis === "start" && !t) {
    druecken(null, true);
    if (taste && taste.vox) taste.vorlauf = vox.vorlauf();
    else vox.zuruecksetzen();  // kein Weg (weder Funkgerät noch Netz)
  } else if (r.ereignis === "ende" && t && t.vox) loslassen();
  voxStand();
}
// Vorlauf in die Blockgröße des Codecs der Sendung umpacken (das Mikrofon lief evtl. mit einer anderen)
function voxNachschieben(bloecke, sender) {
  const n = sender.codec.n, alle = new Int16Array(bloecke.reduce((s, b) => s + b.length, 0));
  let p = 0; for (const b of bloecke) { alle.set(b, p); p += b.length; }
  for (let i = 0; i + n <= alle.length; i += n) sender.pcm(alle.subarray(i, i + n));
}
let voxText = "";
function voxStand() {
  const el = $("vox-stand");
  el.hidden = !voxAn();
  if (!voxAn()) return;
  const t = taste, gesperrt = !t && Date.now() < voxSperreBis;
  const text = voxFehler ? "VOX: " + voxFehler
    : $("ptt").disabled ? "VOX: nicht verbunden"
    : !Sprechfunk.tonBereit() ? "VOX: einmal tippen zum Starten"
    : t && t.vox ? "VOX sendet"
    : t ? "Taste sendet"
    : empfaenger.spielt() ? "VOX gesperrt: Empfang läuft"
    : gesperrt ? (voxGrund === "antwortfenster" ? "VOX gesperrt: Antwortfenster" : "VOX gesperrt: Kanal belegt")
    : voxLetzt?.wind ? "VOX hört … (Wind, gesperrt)"
    : "VOX hört …";
  if (text !== voxText) { voxText = text; el.textContent = text; el.classList.toggle("sendet", !!(t && t.vox)); }
}
$("sprechen").onchange = () => { E.sprechen = $("sprechen").value; merken(); voxEinstellen(); };
$("vox-empf").oninput = () => { E.vox_empf = Number($("vox-empf").value); merken(); vox.empf = E.vox_empf; $("vox-empf-text").textContent = vox.empf + " dB"; };
$("vox-halt").onchange = () => { E.vox_halt = Number($("vox-halt").value); merken(); vox.halt_ms = E.vox_halt; };
$("vox-agc").onchange = () => { E.vox_agc = $("vox-agc").checked; merken(); voxEinstellen(); };
// Wache: Stand und Messwerte zeigen, Mikrofon nach Unterbrechungen (Anruf, andere App, Hintergrund) neu öffnen
setInterval(() => {
  if (!voxAn()) return;
  voxStand();
  if (!taste) voxMikro();
  if (voxLetzt && !$("vox-einst").hidden) $("vox-mess").textContent = "Pegel " + Math.round(voxLetzt.db) + " dB · Schwelle " + Math.round(voxLetzt.schwelle) + " dB";
}, 1000);
document.addEventListener("pointerdown", () => { if (voxAn()) setTimeout(voxMikro, 50); }, { capture: true });  // Ton und Mikrofon brauchen eine Berührung
voxEinstellen();

// ---------- Netz: talk über Nostr-Relays (nostr/netz.js, wird erst geladen, wenn das Netz an ist)
// Öffentliche Durchsagen an „Alle“ gehen zusätzlich als Art 4420 mit PLZ-Labels an die Relays; gehört wird die eigene
// Region. Eigener Schlüssel der App (bleibt im Handy), Sprecher-Signatur wie im Funk.
let netz = null, netzMod = null, netzSlot = 0, netzWarte = [], netzSpielt = false;
// Warteschlange begrenzt: höchstens 5 Durchsagen oder 60 s, je Sprecher eine wartende. Übers Netz gibt es keine
// OP-Durchsage (kein OP-Nachweis): gesendet und gehört wird dort immer mit Vorrang 0.
const netzDauer = d => d.pakete.length * 10 * (Sprechfunk.CODECS[d.kopf.codec]?.ms || 40);  // obere Schätzung
const netzSchon = new Set();  // Kennungen gehörter Durchsagen und Chat-Events, auf allen Relays zusammen
function netzNeu(k) {
  if (netzSchon.has(k)) return false;
  if (netzSchon.size > 2000) netzSchon.clear();
  netzSchon.add(k); return true;
}
function netzEinreihen(d) {
  if (!netzNeu("t" + d.kennung)) return;
  if (netzWarte.some(x => x.kopf.schluessel === d.kopf.schluessel)) return;
  else if (netzWarte.length >= 5 || netzWarte.reduce((s, x) => s + netzDauer(x), netzDauer(d)) > 60000) return eintrag("Netz: Durchsage verworfen, Warteschlange voll");
  else netzWarte.push(d);
  netzWeiter();
}
async function netzWeiter() {
  if (netzSpielt) return;
  netzSpielt = true;
  while (netzWarte.length) await netzHoeren(netzWarte.shift()).catch(() => {});
  netzSpielt = false;
}
const netzBereit = () => !!netz && netz.verbunden > 0;
function netzSk() {
  let sk = null;
  try { sk = localStorage.getItem("bcon-netz-sk"); } catch (e) {}
  if (!/^[0-9a-f]{64}$/.test(sk || "")) {
    sk = Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2, "0")).join("");
    try { localStorage.setItem("bcon-netz-sk", sk); } catch (e) {}
  }
  return sk;
}
// Kopfzeile: neben dem Funkgerät auch die Relay-Verbindungen („Netz 3/3“), damit „getrennt“ nicht nach gar nichts aussieht
function netzKopf() {
  const v = $("v-netz"), n = netz ? netz.leitungen.length : 0, an = netz ? netz.verbunden : 0;
  v.hidden = !n; v.textContent = "· Netz " + an + "/" + n; v.className = "v-netz" + (an ? " an" : "");
}
// Chat-Länge: über Funk bestimmt das Funkgerät (Modus), übers Netz bis 500 Zeichen
function chatLaenge() { $("chat-text").maxLength = netzBereit() ? 500 : info.chat_max || 120; }
function pttFrei() { if (!taste) $("ptt").disabled = !(ws && ws.readyState === 1) && !netzBereit(); }
// Jeder Aufruf bekommt eine Nummer; ein älterer, der noch auf import() oder die Passwort-Ableitung wartet, gibt danach
// auf. Sonst liefen nach schnellem Umstellen (Relays aus der Liste wählen) zwei oder drei Netze und jede Nachricht kam mehrfach.
let netzLauf = 0;
async function netzStarten() {
  const lauf = ++netzLauf;
  if (netz) netz.stoppen();
  netz = null; pttFrei(); netzKopf();
  $("netz-stand").textContent = "";
  if (!E.netz_an) return;
  try { netzMod = netzMod || await import("./nostr/netz.js"); }
  catch (e) { $("netz-stand").textContent = "Netz-Teil nicht geladen: " + e.message; return; }
  if (lauf !== netzLauf) return;
  const relays = (E.netz_relays || "").split(/\s+/).filter(u => /^wss?:\/\/\S+$/.test(u));
  const r = netzMod.region(E.netz_region), rg = r.slice(0, 5);  // Personen: Land + höchstens 3 PLZ-Stellen (bcon/region)
  // Gruppen-Passwort: offene Durchsagen nur für die Gruppe lesbar; Ablauf (NIP-40): Relays löschen eigene Durchsagen danach
  const gruppe = E.netz_gruppe_pw ? await netzMod.gruppeSchluessel(E.netz_gruppe_pw) : null;
  if (!E.netz_an || lauf !== netzLauf) return;  // während der Schlüsselableitung ausgeschaltet oder neu gestartet
  netz = new netzMod.Netz({ relays, sk: netzMod.unhex(netzSk()), region: rg, gruppe, ablaufS: (E.netz_ablauf_h ?? 24) * 3600,
    beiDurchsage: netzEinreihen,
    beiChat: netzChat,
    angebotSeit: E.angebot_seit || 0,
    beiAngebot: a => { E.angebot_seit = Math.max(E.angebot_seit || 0, a.zeit + 1); merken(); angebotKommt({ ...a, weg: "netz" }); },
    beiStand: t => {
      $("netz-stand").textContent = t + (rg ? " · Region " + rg : " · ohne Region: nur senden, kein Hören");
      $("freischaltung").hidden = !(netz && netz.gesperrt);
      pttFrei(); netzKopf(); chatLaenge(); aufzeichnungZeigen();
    } });
  $("netz-pk").textContent = netzMod.npub(netz.pk);
  netz.stand();
  if (!relays.length) $("netz-stand").textContent = "Kein Relay eingetragen.";
}
// Ziel „Alle“: offen mit PLZ-Labels; Ziel mit Schlüssel (Dialog): versiegelt an ihn (NIP-44), im Kopf wie im Funk
// kZielGeraet mit den ersten 4 Byte des Schlüssels. „@Rufname“ ohne Schlüssel geht nur über das Funkgerät.
function netzAufnahme(kennung, nb, ziel, prio) {
  const an = /^[0-9a-f]{64}$/.test(ziel) ? ziel : null;
  if (!netzBereit() || (ziel !== "ALLE" && !an)) return null;
  try {
    const a = new netzMod.Aufnahme(netz.sk, { codec: kennung, flags: netzMod.mitPrio(an ? 0x04 : 0, 0),
      ziel: an ? new DataView(netzMod.unhex(an).buffer).getUint32(0, true) : netzMod.ALLE,
      zeit: Math.floor(Date.now() / 1000), name: rufOk(E.rufname) ? E.rufname : "", region: an ? "" : netz.region,
      gruppe: Number($("gruppe").value) || 0 }, nb);
    a.an = an;
    return a;
  } catch (e) { $("funk-hinweis").textContent = "Netz: " + e.message; return null; }
}
async function netzSenden(a) {
  try {
    const k = await a.fertig();
    if (!k || !netz) return;
    const n = await netz.senden(k, Math.floor(Date.now() / 1000), a.an);
    eintrag(n ? "über Netz gesendet" + (a.an ? " (privat)" : netz.gruppe ? " (Gruppe)" : "") + ": " + n + " Relays"
      : netz.gesperrt ? "über Netz nicht angenommen: nicht freigeschaltet (Einstellungen → Freischaltung anfragen)" : "über Netz nicht angenommen");
  } catch (e) { eintrag("Netz: " + e.message); }
}
// Ganze Durchsage aus dem Netz abspielen (nacheinander, nie zwei gleichzeitig); Anzeige wie beim Funkempfang
async function netzHoeren(d) {
  const k = d.kopf, c = Sprechfunk.CODECS[k.codec], meine = Number($("gruppe").value) || 0;
  if (!c || (!d.signatur && !d.fehlend)) return;  // unbekannter Codec, gefälschte Durchsage
  if (meine && k.gruppe && k.gruppe !== meine) return;  // Gruppe wie CTCSS
  // Rufname nur, wenn der Kopf geprüft ist: Strom-Signatur gültig, oder (bei Lücken) das Event stammt vom Sprecher selbst.
  // Sonst könnte jeder mit eigenem Schlüssel und einem leeren Paket unter fremdem Namen sprechen.
  const echt = d.signatur || d.absender === k.schluessel;
  const slot = 200 + (netzSlot++ % 50);
  nachricht({ t: "rx", slot, von: echt ? k.name || k.schluessel.slice(0, 8) : k.schluessel.slice(0, 8), schluessel: k.schluessel,
              codec: k.codec, weg: echt ? "nostr" : "Nostr · ungeprüft", prio: 0, gruppe: k.gruppe, ziel: d.privat ? "privat" : d.gruppe ? "Gruppe" : "ALLE", relay: d.relay });
  await empfaenger.slots.get(slot)?.bereit;
  const nb = empfaenger.slots.get(slot)?.codec?.nb || 8;
  let ms = 0;
  d.pakete.forEach((p, i) => {
    const dauer = (p.length ? p.length / nb : 10) * c.ms, b = new Uint8Array(5 + p.length);
    b.set([0x50, slot, i + 1, dauer & 255, dauer >> 8]); b.set(p, 5);
    empfaenger.paket(b); ms += dauer;
  });
  await new Promise(r => setTimeout(r, ms + 300));
  nachricht({ t: "ende", slot, pakete: d.pakete.length - d.fehlend, fehlend: d.fehlend, signatur: d.signatur });
}

// ===== app.js Zeilen 1355–1439 =====
const OEFFENTLICH = [["wss://nos.lol", 1], ["wss://relay.primal.net", 1], ["wss://nostr.mom", 1], ["wss://relay.snort.social"],
  ["wss://offchain.pub"], ["wss://relay.nostr.net"], ["wss://nostr.oxtr.dev"]];
if (E.netz_relays === undefined) E.netz_relays = OEFFENTLICH.filter(r => r[1]).map(r => r[0]).join(" ");
function oeffentlichListe() {
  const drin = (E.netz_relays || "").split(/\s+/);
  $("netz-oeffentlich").replaceChildren(new Option("Öffentliches Relay hinzufügen …", ""),
    ...OEFFENTLICH.map(([u, fav]) => new Option((fav ? "★ " : "") + ohneWss(u) + (drin.includes(u) ? " ✓" : ""), u)));
}
$("netz-oeffentlich").onchange = () => {
  const u = $("netz-oeffentlich").value, liste = (E.netz_relays || "").split(/\s+/).filter(Boolean);
  $("netz-oeffentlich").value = "";
  if (!u) return;
  E.netz_relays = (liste.includes(u) ? liste.filter(x => x !== u) : [...liste, u]).join(" ");  // nochmal wählen = entfernen
  $("netz-relays").value = E.netz_relays; merken(); oeffentlichListe(); netzStarten();
};
oeffentlichListe();
$("netz-relays").addEventListener("change", oeffentlichListe);
$("netz-an").checked = !!E.netz_an; $("netz-relays").value = E.netz_relays || ""; $("netz-region").value = E.netz_region || "";
$("netz-an").onchange = () => { E.netz_an = $("netz-an").checked; merken(); netzStarten(); };
$("netz-relays").onchange = () => { E.netz_relays = $("netz-relays").value.trim(); merken(); netzStarten(); };
$("netz-ablauf").value = String(E.netz_ablauf_h ?? 24); $("netz-gruppe-pw").value = E.netz_gruppe_pw || "";
$("netz-ablauf").onchange = () => { E.netz_ablauf_h = Number($("netz-ablauf").value); merken(); netzStarten(); };
$("netz-gruppe-pw").onchange = () => { E.netz_gruppe_pw = $("netz-gruppe-pw").value; merken(); netzStarten(); };
$("netz-region").onchange = () => { E.netz_region = $("netz-region").value.trim().toUpperCase(); $("netz-region").value = E.netz_region; merken(); netzStarten(); };
netzStarten();

// ---------- Chat
function chatZeile(d) {
  const li = document.createElement("li");
  if (d.eigen) li.className = "eigen";
  const kopf = document.createElement("div");
  kopf.className = "kopf";
  namePruefen(d);
  if (d.durchsage) li.classList.add("durchsage");
  kopf.textContent = (d.durchsage ? PRIO_MARKE[1] : "") + (d.gruppe ? "G" + d.gruppe + " · " : "") + (d.eigen ? "ich" : wer(d)) + " · " + new Date().toLocaleTimeString(Aussehen.ort(), { hour: "2-digit", minute: "2-digit" }) + (d.rssi != null ? " · " + d.rssi + " dBm" : "");
  const t = document.createElement("div");
  t.className = "roh"; t.textContent = d.text;
  if (d.an || d.privat) kopf.textContent += " · privat";
  else if (d.netzGruppe) kopf.textContent += " · Gruppe";
  if (d.weg === "nostr" || d.weg === "netz") kopf.textContent += " · Netz";
  li.append(kopf, t);
  $("chat").append(li);
  if (d.eigen) Z.chat_raus++; else Z.chat_rein++;
  zaehler();
  if (seite === "chat") li.scrollIntoView(); else if (!d.eigen) $("chat-neu").hidden = false;
}
function chatSystem(text) {
  const li = document.createElement("li"); li.className = "system"; li.textContent = text; $("chat").append(li);
}
$("chat-form").onsubmit = e => {
  e.preventDefault();
  const text = $("chat-text").value.trim();
  if (!text) return;
  const max = info.chat_max || 120;
  if (new TextEncoder().encode(text).length > max && !netzBereit()) return chatSystem("Zu lang: höchstens " + max + " Byte in diesem Modus.");
  if (text.length > 500) return chatSystem("Zu lang: höchstens 500 Zeichen.");
  const o = { t: "chat", text };
  if (prioWert()) { o.prio = prioWert(); $("prio").value = "0"; prioAnzeigen(); }
  if (rufOk(E.rufname)) o.name = E.rufname;
  // Wege wie beim Funken: Funkgerät (Geräteschlüssel oder @Rufname) und Netz (App-Schlüssel des Kontakts bzw. des
  // im Netz gehörten Sprechers); „Alle“ geht auf beiden Wegen
  const ziel = $("chat-ziel").value, kt = kontaktVon(ziel), nurNetz = !!leute.get(ziel)?.netz;
  const zuLang = new TextEncoder().encode(text).length > max;
  const funkAn = ziel === "ALLE" ? null : kt?.geraet || (nurNetz ? null : ziel);
  const netzAn = ziel === "ALLE" ? null : kt?.app || (nurNetz ? ziel : null);
  if (funkAn) o.an = funkAn;
  const perFunk = !zuLang && (ziel === "ALLE" || funkAn) && tx(o);
  const perNetz = netzBereit() && (ziel === "ALLE" || netzAn);
  if (!perFunk && !perNetz) return chatSystem(zuLang ? "Zu lang: höchstens " + max + " Byte über Funk, übers Netz bis 500 Zeichen." : "Nicht verbunden.");
  $("chat-text").value = "";
  if (!perNetz) return;
  if (!perFunk) chatZeile({ eigen: true, text, an: netzAn, weg: "netz" });  // sonst zeigt das Funkgerät das Echo
  netz.chat(text, { an: netzAn, name: o.name, prio: 0 }).then(n => {
    if (!n) chatSystem(netz?.gesperrt ? "Übers Netz nicht angenommen: nicht freigeschaltet." : "Übers Netz nicht angenommen.");
  }).catch(e => chatSystem("Netz: " + e.message));
};
// Chat aus dem Netz (nostr/netz.js chatLesen): Absender ist der App-Schlüssel, der Rufname nur Selbstangabe
function netzChat(c) {
  if (!netzNeu("c" + c.von + c.zeit + c.text)) return;
  const kt = kontaktVon(c.von);
  const d = { t: "chat", von: kt ? kt.name : c.name || c.von.slice(0, 8), schluessel: c.von, text: c.text, prio: 0,
              privat: c.privat, weg: "nostr", netzGruppe: !!c.gruppe, relay: c.relay };
  teilnehmer(d); chatZeile(d);
}


// ===== app.js Zeilen 1551–1626 =====
// ---------- Einstellungen
$("adresse").value = E.adresse;
$("rufname").value = E.rufname;
if (E.codec_dialog == null) E.codec_dialog = [1, 8].includes(Number(E.codec)) ? String(E.codec) : "auto";  // alte Einstellung übernehmen
$("codec-dialog").value = String(E.codec_dialog);
$("rufname").oninput = () => { const r = rufname($("rufname").value); $("rufname").value = r; E.rufname = r; merken(); rufPruefen(); };
rufPruefen();
if (!E.afu_hinweis) { E.afu_hinweis = 1; merken(); alert(KEIN_AFU); }  // einmal beim ersten Start
$("codec-dialog").onchange = () => { E.codec_dialog = $("codec-dialog").value; merken(); };
$("b-kabel").hidden = !Kabel.geht();
$("led-hell").onchange = () => tx({ t: "led", hell: +$("led-hell").value });  // 0 = aus
$("papagei-ignorieren").onchange = () => {
  if (!tx({ t: "papagei_ignorieren", an: $("papagei-ignorieren").checked })) { $("papagei-ignorieren").checked = !$("papagei-ignorieren").checked; $("modus-text").textContent = "Nicht verbunden."; }
};
$("papagei").onchange = () => { const a = $("papagei").value; tx(a === "aus" ? { t: "papagei", an: false } : { t: "papagei", an: true, art: a }); };
$("hotspot").onchange = () => {
  const an = $("hotspot").checked;
  if (!an && !["kabel", "seriell"].includes(E.adresse) && !confirm("Du bist über den Hotspot verbunden. Ohne Hotspot erreichst du das Gerät nur noch per Kabel. Trotzdem ausschalten?")) { $("hotspot").checked = true; return; }
  if (!confirm("Das Funkgerät startet dafür neu. Weiter?")) { $("hotspot").checked = !an; return; }
  tx({ t: "hotspot", an });
};
$("b-usb-alle").hidden = !Kabel.geht();
$("b-usb-alle").onclick = async () => {
  let g; try { g = await Kabel.alle(); } catch (e) { $("funk-hinweis").textContent = "Kein USB-Gerät gewählt."; return; }
  const text = Kabel.beschreiben(g);
  const passt = g.vendorId === 0x303a && (g.configuration || g.configurations?.[0])?.interfaces?.some(i => i.alternate.interfaceClass === 0xff);
  $("funk-hinweis").textContent = "USB: " + text + (passt ? " → bcon-Kabel erkannt, verbinde …" :
    g.vendorId === 0x1a86 || g.vendorId === 0x10c4 ? " → das ist der Seriell-Wandler (Buchse „COM“). Bitte die Buchse „USB“ am S3 nehmen." :
    g.vendorId === 0x303a ? " → Espressif, aber ohne bcon-Interface (läuft die Firmware mit WebUSB?)" : " → kein bcon-Gerät");
  zeige("funk");
  if (passt) { E.adresse = "kabel"; $("adresse").value = "kabel"; merken(); verbinden(g); }
};
$("b-kabel").onclick = async () => {
  let g; try { g = await Kabel.waehlen(); } catch (e) {
    $("funk-hinweis").textContent = "Kein passendes Gerät gefunden. Steckt das Kabel an der Buchse „USB“ (nicht „COM“) des S3? Unter Einstellungen zeigt „Alle USB-Geräte zeigen“, was das Handy sieht."; zeige("funk"); return; }
  E.adresse = "kabel"; $("adresse").value = "kabel"; merken(); verbinden(g); zeige("funk");
};
$("b-seriell").hidden = !Seriell.geht();
$("b-seriell").onclick = async () => {
  let p; try { p = await Seriell.waehlen(); } catch (e) {
    $("funk-hinweis").textContent = "Keine serielle Schnittstelle gewählt. Steckt das Kabel an der COM-Buchse? Ist der serielle Monitor (PlatformIO, Arduino) geschlossen?"; zeige("funk"); return; }
  E.adresse = "seriell"; $("adresse").value = "seriell"; merken(); verbinden(p); zeige("funk");
};
// Nach je einem Fehlversuch auf beiden IPs gilt: kein Funkgerät da (z. B. nur Netz); dann leise weitersuchen
function suchtNur() { return fehlVersuche >= 2 && !["kabel", "seriell"].includes(E.adresse); }
// Adressknöpfe: ein Tipp verbindet direkt
for (const b of document.querySelectorAll("[data-adresse]")) b.onclick = () => {
  E.adresse = b.dataset.adresse; $("adresse").value = E.adresse; merken(); verbinden(); zeige("funk");
};
$("b-verbinden").onclick = () => { E.adresse = $("adresse").value.trim(); merken(); verbinden(); zeige("funk"); };
$("folgen").onchange = () => {
  if (!tx({ t: "modus", folgen: $("folgen").checked })) { $("folgen").checked = !$("folgen").checked; $("modus-text").textContent = "Nicht verbunden."; }
};
$("b-modus").onclick = () => {
  const v = $("modus").value;
  if (!confirm("ESP-NOW-Modus auf „" + MODI[v] + "“ setzen? Die anderen Geräte bekommen vorher eine Ansage und können folgen.")) return;
  $("modus-text").textContent = tx({ t: "modus", setzen: v }) ? "gesendet …" : "Nicht verbunden.";
};

// ---------- Ton freischalten: Browser spielen erst nach einer Berührung ab (Autoplay-Regel)
function tonFrei() { Sprechfunk.audio().then(() => { $("ton-hinweis").hidden = Sprechfunk.tonBereit(); }).catch(() => {}); }
document.addEventListener("pointerdown", tonFrei, { capture: true });
document.addEventListener("keydown", tonFrei, { capture: true });

// ---------- Bildschirm wach halten, solange verbunden (Funkgerät-Gefühl)
let sperre = null;
async function wachHalten(an) {
  try {
    if (an && "wakeLock" in navigator && !sperre) { sperre = await navigator.wakeLock.request("screen"); sperre.onrelease = () => { sperre = null; }; }
  } catch (e) {}
}
document.addEventListener("visibilitychange", aufwachen);
setInterval(() => tx({ t: "info" }), 20000);  // Lebenszeichen: Firmware räumt stille App-Plätze nach 60 s ab
addEventListener("pageshow", aufwachen);
addEventListener("online", aufwachen);


// ===== app.js Zeilen 1733–1741 =====
// ---------- Start
$("app-stand").textContent = String(APP_STAND);
if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
lage(); zaehler();
if (!window.isSecureContext)  // App vom Funkgerät per http (C3): Mikrofon nur mit Chrome-Ausnahme
  $("funk-hinweis").textContent = "Senden geht hier nur mit einer Chrome-Ausnahme: chrome://flags → „Insecure origins treated as secure“ → " + location.origin + " eintragen, aktivieren, Chrome neu starten. Empfang und Chat gehen auch so.";
Sprechfunk.laden().catch(e => { $("funk-hinweis").textContent = "Codec2 lädt nicht: " + e.message; });
verbinden();

