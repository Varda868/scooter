// --- Dev-Logger: sammelt Fehler und Warnungen, zum Kopieren in einen Fehlerbericht.
// Einschalten mit ?dev=1 in der Adresse (bleibt gespeichert), ausschalten mit ?dev=0. Läuft als erstes Skript,
// damit auch Fehler beim Laden der anderen ankommen. Ohne Dev-Modus wird nur im Speicher mitgeschrieben, nichts angezeigt.
const devLog = (() => {
  const KEY = 'scooterways.devlog', MAX = 300;
  const q = new URLSearchParams(location.search).get('dev');
  try { if (q === '1') localStorage.setItem('scooterways.dev', '1'); if (q === '0') localStorage.removeItem('scooterways.dev'); } catch {}
  let an = false;
  try { an = localStorage.getItem('scooterways.dev') === '1'; } catch {}
  let liste = [];
  if (an) try { liste = JSON.parse(localStorage.getItem(KEY)) || []; } catch {}
  let merken = 0, zeigen = null;
  const text = a => a instanceof Error ? `${a.message}${a.stack ? '\n' + a.stack.split('\n').slice(1, 4).join('\n') : ''}`
    : typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })();
  function add(stufe, ...args) {
    liste.push({ t: Date.now(), s: stufe, m: args.map(text).join(' ').slice(0, 2000) });
    if (liste.length > MAX) liste = liste.slice(-MAX);
    if (!an) return;
    // Gesammelt speichern, damit ein Fehlersturm nicht jedes Mal localStorage schreibt
    clearTimeout(merken); merken = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(liste.slice(-200))); } catch {} }, 1000);
    // Anzeige im nächsten Takt und nie rekursiv: ein Fehler in der Anzeige darf keine Endlosschleife auslösen
    if (zeigen && !add.laeuft) { add.laeuft = true; queueMicrotask(() => { try { zeigen(); } catch {} add.laeuft = false; }); }
  }
  for (const s of ['error', 'warn']) {
    const orig = console[s].bind(console);
    console[s] = (...a) => { add(s === 'error' ? 'F' : 'W', ...a); orig(...a); };
  }
  addEventListener('error', e => add('F', e.error || `${e.message} (${e.filename?.split('/').pop()}:${e.lineno}:${e.colno})`));
  addEventListener('unhandledrejection', e => add('F', 'Promise:', e.reason ?? '(ohne Grund)'));
  // Im Dev-Modus auch fehlgeschlagene Abrufe (Valhalla, Overpass, Kacheln …), die die App sonst still abfängt
  if (an && self.fetch) {
    const f = fetch.bind(self);
    self.fetch = (u, o) => f(u, o).then(r => { if (!r.ok) add('W', `HTTP ${r.status} ${o?.method || 'GET'} ${String(u.url || u).slice(0, 200)}`); return r; },
      err => { if (err?.name !== 'AbortError') add('W', `Abruf fehlgeschlagen ${String(u.url || u).slice(0, 200)}: ${err?.message || err}`); throw err; });
  }
  return { an, add, liste: () => liste, leeren() { liste = []; try { localStorage.removeItem(KEY); } catch {} zeigen?.(); },
    beiNeuem(fn) { zeigen = fn; } };
})();

if (devLog.an) addEventListener('DOMContentLoaded', () => {
  const knopf = document.createElement('button'), feld = document.createElement('dialog');
  knopf.className = 'dev-knopf'; knopf.title = 'Dev-Log';
  feld.className = 'dev-log';
  feld.innerHTML = '<div class="dev-kopf"><b>🐞 Dev-Log</b><button data-dev="kopieren">Kopieren</button><button data-dev="leeren" class="secondary">Leeren</button>' +
    '<button data-dev="senden" hidden>An Server senden</button><button data-dev="zu" class="secondary">✕</button></div><pre></pre><p class="hint">Ausschalten: Adresse mit ?dev=0 öffnen.</p>';
  document.body.append(knopf, feld);
  const uhr = t => new Date(t).toLocaleTimeString('de-DE');
  async function bericht() {
    let ver = '?';
    try { ver = (await caches.keys()).find(k => k.startsWith('shell-'))?.slice(6) || '?'; } catch {}
    return `Scooterways ${ver} · ${navigator.userAgent}\n${location.href}\n\n` +
      devLog.liste().map(e => `${uhr(e.t)} ${e.s === 'F' ? 'FEHLER' : 'Warnung'} ${e.m}`).join('\n');
  }
  const neu = () => {
    const l = devLog.liste(), f = l.filter(e => e.s === 'F').length;
    knopf.textContent = `🐞 ${l.length}`; knopf.classList.toggle('fehler', f > 0);
    if (feld.open) bericht().then(t => { feld.querySelector('pre').textContent = t; });
  };
  devLog.beiNeuem(neu); neu();
  // Senden nur, wenn der eigene Server eingerichtet ist (27-server.js); landet im Admin-Bereich unter Fehlerberichte
  knopf.onclick = () => { feld.querySelector('[data-dev=senden]').hidden = !(typeof serverAn === 'function' && serverAn()); feld.showModal(); neu(); };
  feld.onclick = async e => {
    const a = e.target.dataset?.dev;
    if (a === 'zu') feld.close();
    if (a === 'leeren') devLog.leeren();
    if (a === 'senden') {
      const b = e.target;
      b.disabled = true; b.textContent = 'sende …';
      try {
        const text = await bericht(), ver = text.match(/^Scooterways (\S+)/)?.[1] || '?';
        const res = await fetch(API_URL + 'fehler.php', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: text.slice(0, 60000), version: ver }) });
        const j = await res.json().catch(() => ({}));
        b.textContent = res.ok ? `✓ gesendet (#${j.id})` : '⚠️ ' + (j.fehler || res.status);
      } catch { b.textContent = '⚠️ nicht erreichbar'; }
      setTimeout(() => { b.textContent = 'An Server senden'; b.disabled = false; }, 4000);
    }
    if (a === 'kopieren') {
      const t = await bericht();
      try { await navigator.clipboard.writeText(t); e.target.textContent = '✓ kopiert'; }
      catch { const r = document.createRange(); r.selectNodeContents(feld.querySelector('pre')); getSelection().removeAllRanges(); getSelection().addRange(r); e.target.textContent = 'markiert'; }
      setTimeout(() => { e.target.textContent = 'Kopieren'; }, 2000);
    }
  };
});
