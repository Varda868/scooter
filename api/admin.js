// Relay-Prüfung im Browser des Admins: Verbindung, Lesetest (REQ bis EOSE) und Schreibtest mit einem flüchtigen,
// signierten Event (Art 20000–29999 speichern Relays nicht). Ein Wegwerf-Schlüssel, nie der Talk-Schlüssel.
// Ergebnisse gehen in den Verlauf des Dashboards. Signieren mit derselben secp256k1-Datei wie die App (talk/).
const knopf = document.getElementById('browserPruefen');
const ZEIT_MS = 8000, ART = 29473;
const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const unhex = s => Uint8Array.from(s.match(/../g), x => parseInt(x, 16));

async function event(schnorr, sk) {
  const pubkey = hex(schnorr.getPublicKey(sk)), created_at = Math.floor(Date.now() / 1000), tags = [], content = 'scooterways relay test';
  const id = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([0, pubkey, created_at, ART, tags, content])))));
  return { id, pubkey, created_at, kind: ART, tags, content, sig: hex(await schnorr.signAsync(unhex(id), sk)) };
}

function pruefen(url, ev) {
  return new Promise(fertig => {
    const r = { url, ok: false, ms_verb: null, ms_eose: null, schreiben: null, fehler: null };
    const t0 = performance.now(), sub = 'swb' + Math.random().toString(36).slice(2, 8);
    let ws, tEose, tSend, echo = false, okMeldung = null;
    const ende = fehler => {
      if (fehler && !r.fehler) r.fehler = fehler;
      // geschrieben = Relay bestätigt mit OK true, oder liefert das Event an unser Abo zurück
      if (tSend != null) r.schreiben = okMeldung === true || echo;
      clearTimeout(uhr); try { ws.close(); } catch {}
      fertig(r);
    };
    const uhr = setTimeout(() => ende(r.ms_eose == null ? 'kein EOSE in 8 s' : null), ZEIT_MS);
    try { ws = new WebSocket(url); } catch (e) { return ende('ungültige Adresse'); }
    ws.onerror = () => ende(r.ms_verb == null ? 'keine Verbindung' : 'Verbindungsfehler');
    ws.onclose = () => ende(r.ms_verb == null ? 'keine Verbindung' : null);
    ws.onopen = () => {
      r.ms_verb = Math.round(performance.now() - t0);
      tEose = performance.now();
      // Abo auf das eigene Test-Event: kommt es zurück, sind Schreiben und Weiterleiten belegt
      ws.send(JSON.stringify(['REQ', sub, { kinds: [ART], authors: [ev.pubkey], since: ev.created_at - 5 }]));
    };
    ws.onmessage = m => {
      let j; try { j = JSON.parse(m.data); } catch { return; }
      if (j[0] === 'EOSE' && j[1] === sub && r.ms_eose == null) {
        r.ms_eose = Math.round(performance.now() - tEose); r.ok = true;
        tSend = performance.now();
        ws.send(JSON.stringify(['EVENT', ev]));
      } else if (j[0] === 'OK' && j[1] === ev.id) {
        okMeldung = j[2] === true;
        if (!okMeldung) r.fehler = 'schreiben abgelehnt: ' + String(j[3] || '').slice(0, 120);
        if (!okMeldung || echo) ende();
      } else if (j[0] === 'EVENT' && j[1] === sub && j[2]?.id === ev.id) {
        echo = true;
        if (okMeldung !== null) ende();
      } else if (j[0] === 'CLOSED' && j[1] === sub) ende('CLOSED: ' + String(j[2] || '').slice(0, 120));
      else if (j[0] === 'AUTH') r.fehler = 'Relay verlangt Anmeldung (NIP-42)';
    };
  });
}

knopf?.addEventListener('click', async () => {
  const status = document.getElementById('browserStatus');
  knopf.disabled = true; status.textContent = 'Prüfe …';
  try {
    const { schnorr } = await import(new URL('../talk/secp256k1.js', location.href).href);
    const sk = crypto.getRandomValues(new Uint8Array(32));
    const zeilen = [...document.querySelectorAll('#relayZustand tr[data-url]')];
    const ergebnisse = await Promise.all(zeilen.map(async tr => {
      const r = await pruefen(tr.dataset.url, await event(schnorr, sk));
      const z = tr.querySelector('.browser');
      z.textContent = r.ok ? `✅ ${r.ms_verb} ms, EOSE ${r.ms_eose} ms` + (r.schreiben == null ? '' : r.schreiben ? ' · ✍️ schreiben ok' : ' · ⚠️ schreiben nicht') : '❌ ' + r.fehler;
      if (r.ok && r.fehler) z.append(Object.assign(document.createElement('div'), { className: 'leise', textContent: r.fehler }));
      return r;
    }));
    const daten = new URLSearchParams({ csrf: knopf.dataset.csrf, aktion: 'browser', daten: JSON.stringify(ergebnisse) });
    const res = await fetch('admin.php?s=relays', { method: 'POST', body: daten, credentials: 'same-origin' });
    status.textContent = res.ok ? 'Im Browser geprüft und gespeichert.' : 'Geprüft, aber nicht gespeichert (Sitzung abgelaufen?).';
  } catch (e) {
    status.textContent = 'Browser-Prüfung fehlgeschlagen: ' + e.message;
  }
  knopf.disabled = false;
});
