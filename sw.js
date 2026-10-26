// Scooterways Service Worker: App-Hülle offline verfügbar, angesehene Kartenkacheln zwischenspeichern.
// Routing, Wetter, POIs usw. gehen immer ans Netz; ihre Offline-Reserve liegt in der App (localStorage).
const VERSION = 'v62';
// Stammadresse wie in js/01-grundlagen.js: Zweitadressen laden POI-Kacheln von dort
const STAMM_ORIGIN = 'https://scooter.thai-klasse.de';
const SHELL = `shell-${VERSION}`, TILES = 'tiles';
const MAX_TILES = 4000; // ca. 60–100 MB
const POIS = 'pois', MAX_POI_TILES = 300; // 1°-Kacheln, je nach Gegend 10–500 kB
const LEAFLET = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/';
const CDN = 'https://cdn.jsdelivr.net/npm/'; // MapLibre, PMTiles, Protomaps-Stile (versioniert, ändern sich nie)
// Reihenfolge der Skripte bestimmt index.html; neue Module hier ergänzen
const APP_FILES = ['css/app.css', 'js/00-logger.js', 'js/01-grundlagen.js', 'js/02-wegpunkte.js', 'js/03-routing.js', 'js/04-vergleich.js', 'js/05-vorschau.js', 'js/06-kartenknoepfe.js', 'js/07-navi.js', 'js/08-verkehr.js', 'js/09-etappen.js', 'js/10-wetter.js', 'js/11-pois.js', 'js/13-poisuche.js', 'js/14-gpx.js', 'js/15-poidetails.js', 'js/17-fahrten.js', 'js/18-roller.js', 'js/19-vektorkarte.js', 'js/20-start.js', 'js/21-oberflaeche.js', 'js/22-talk.js', 'js/23-standort.js', 'js/24-tank.js', 'js/25-faehre.js', 'js/26-profil.js', 'js/27-server.js', 'js/28-kurzlink.js', 'js/29-push.js', 'js/30-panne.js', 'js/31-strassenart.js'];
const SHELL_FILES = ['./', 'manifest.webmanifest', 'icon.svg', 'favicon.svg', 'logo-scw.svg', 'logo-scw-hell.svg', 'icon-192.png', 'badge-96.png', ...APP_FILES];
const CDN_FILES = [LEAFLET + 'leaflet.min.js', LEAFLET + 'leaflet.min.css'];

// CDN-Dateien einzeln und fehlertolerant: ein Aussetzer dort soll die Installation nicht verhindern
// (sie werden sonst beim nächsten Laden über den fetch-Handler nachgeholt)
self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL)
    .then(c => Promise.all([c.addAll(SHELL_FILES.map(u => new Request(u, { cache: 'reload' }))), ...CDN_FILES.map(u => c.add(u).catch(() => {}))]))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('shell-') && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

let puts = 0, poiPuts = 0;
async function trimTiles(cache, max = MAX_TILES) {
  const keys = await cache.keys();
  // Reihenfolge der Schlüssel = Einfügereihenfolge: die ältesten zuerst raus
  await Promise.all(keys.slice(0, Math.max(0, keys.length - max)).map(k => cache.delete(k)));
}

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  // Range-Anfragen (PMTiles-Kartendatei) nicht anfassen: 206-Antworten lassen sich nicht cachen,
  // die Kacheln der Vektorkarte speichert die App selbst in IndexedDB
  if (req.method !== 'GET' || req.headers.has('range') || url.pathname.endsWith('.pmtiles')) return;
  // Server-API und Admin-Bereich nie anfassen: immer live, und die Admin-Seite darf nicht als App-Hülle im Speicher landen.
  // Kurzlinks /t/<id> ebenso: der Server leitet weiter, und eine umgeleitete Antwort darf der SW einer Navigation nicht geben
  if (url.origin === location.origin && (url.pathname.includes('/api/') || /\/t\/[^/]+\/?$/.test(url.pathname))) return;

  // Seite selbst: Netz zuerst (Updates aus Plesk kommen sofort an), offline aus dem Speicher
  if (req.mode === 'navigate' || (url.origin === location.origin && /\/(index\.html)?$/.test(url.pathname))) {
    e.respondWith(fetch(req, { cache: 'no-cache' }).then(res => {
      if (res.ok) caches.open(SHELL).then(c => c.put('./', res.clone()));
      return res;
    }).catch(() => caches.match('./')));
    return;
  }
  // Eigene Skripte und CSS ebenso Netz zuerst, damit nie eine neue Seite mit alten Modulen läuft (talk/ wird erst bei Bedarf geladen)
  // cache: 'no-cache' fragt am Browser-Cache vorbei beim Server nach (sonst kann eine alte Fassung aus dem HTTP-Cache kommen)
  if (url.origin === location.origin && /\/(js|css|talk)\/[^/]+$/.test(url.pathname)) {
    e.respondWith(fetch(req, { cache: 'no-cache' }).then(res => {
      if (res.ok) caches.open(SHELL).then(c => c.put(req, res.clone()));
      return res;
    }).catch(() => caches.match(req)));
    return;
  }

  // Eigene POI-Kacheln: index.json Netz zuerst, Kacheln (URL trägt den Datenstand) Speicher zuerst; offline aus dem Speicher
  if ((url.origin === location.origin || url.origin === STAMM_ORIGIN) && url.pathname.includes('/poi/')) {
    e.respondWith(caches.open(POIS).then(async cache => {
      const index = url.pathname.endsWith('/index.json'), hit = !index && await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok) { cache.put(index ? url.pathname : req, res.clone()); if (!index && ++poiPuts % 50 === 0) trimTiles(cache, MAX_POI_TILES); }
        return res;
      } catch (err) { return (await cache.match(index ? url.pathname : req)) || Promise.reject(err); }
    }));
    return;
  }

  // Kartenkacheln: Speicher zuerst, sonst Netz und merken (nur angesehene Kacheln, kein Vorabladen)
  if (url.hostname === 'tile.openstreetmap.org') {
    e.respondWith(caches.open(TILES).then(async cache => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) { cache.put(req, res.clone()); if (++puts % 200 === 0) trimTiles(cache); }
      return res;
    }));
    return;
  }

  // Übrige App-Dateien (Leaflet, MapLibre, Icons, Manifest) und Schriften/Symbole der Vektorkarte:
  // Speicher zuerst, im Hintergrund auffrischen. Dieser Speicher wird nie gekürzt, ohne Schriften keine Vektorkacheln.
  if (url.origin === location.origin || req.url.startsWith(LEAFLET) || req.url.startsWith(CDN) || url.hostname === 'protomaps.github.io') {
    e.respondWith(caches.open(SHELL).then(async cache => {
      const hit = await cache.match(req);
      const net = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; });
      return hit || net;
    }));
  }
});

// --- Push an die Talk-Gruppe (js/29-push.js): Inhalt ist mit dem Gruppenschlüssel aus IndexedDB verschlüsselt
const PUSH_HALT = { panne: '🔧 hat eine Panne', tanken: '⛽ hält zum Tanken', pause: '☕ macht Pause' };
// Gleiche Datenbank wie js/29-push.js: k = Gruppenschlüssel, post = Sprachpost, namen = Talk-Kontakte
function pushDbSw(store, modus, fn) {
  return new Promise(ok => {
    const r = indexedDB.open('scooterways-push', 2);
    r.onupgradeneeded = () => { for (const [s, key] of [['k', 'g'], ['post', 'id'], ['namen', 'pk']]) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: key }); };
    r.onerror = () => ok(null);
    r.onsuccess = () => {
      const tx = r.result.transaction(store, modus), q = fn(tx.objectStore(store));
      tx.oncomplete = () => { ok(q?.result ?? null); r.result.close(); }; tx.onerror = () => { ok(null); r.result.close(); };
    };
  });
}
const pushSchluessel = async g => (await pushDbSw('k', 'readonly', os => os.get(g)))?.key || null;
const pushBytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function pushLesen(e) {
  const p = e.data?.json();
  const key = p?.g && await pushSchluessel(p.g);
  if (!key) return null;
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: pushBytes(p.iv) }, key, pushBytes(p.ct))));
}
// Sprachpost: nur ablegen und melden, öffnen kann sie erst die App (NIP-44 mit dem Talk-Schlüssel)
async function pushSprachpost(p) {
  if (!/^[0-9a-f]{64}$/.test(p.von || '') || typeof p.ct !== 'string') return;
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await pushDbSw('post', 'readwrite', os => os.put({ id, von: p.von, ct: p.ct, t: Date.now() }));
  const name = (await pushDbSw('namen', 'readonly', os => os.get(p.von)))?.name || p.von.slice(0, 8);
  const fenster = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  fenster.forEach(f => f.postMessage({ post: id }));
  // App im Vordergrund: dort erscheint sie in der Liste, keine Benachrichtigung nötig
  if (fenster.some(f => f.focused && f.visibilityState === 'visible')) return;
  await self.registration.showNotification(`🎙 Sprachpost von ${name}`, { body: 'Tippen zum Abhören', icon: 'icon-192.png', badge: 'badge-96.png',
    tag: 'post-' + p.von, renotify: true, data: { post: id } });
}
self.addEventListener('push', e => e.waitUntil((async () => {
  let p = null;
  try { p = e.data?.json(); } catch {}
  if (p?.dm) return pushSprachpost(p);
  let n = null;
  try { n = await pushLesen(e); } catch {}
  const name = String(n?.n || '').slice(0, 9);
  const zeit = n?.bis ? new Date(n.bis * 1000).toTimeString().slice(0, 5) : '';
  const [titel, text] = !n ? ['🛵 Scooterways', 'Neue Nachricht aus der Gruppe'] :
    n.a === 'halt' ? [`${name} ${PUSH_HALT[n.g] || 'steht'}`, n.la != null ? 'Tippen zeigt den Ort' : ''] :
    n.a === 'treff' ? [`🤝 Treffpunkt von ${name}`, String(n.t || '').slice(0, 80) + (zeit ? ` · bis ${zeit}` : '')] :
    [`💬 ${name}`, String(n.t || '').slice(0, 200)];
  await self.registration.showNotification(titel, { body: text, icon: 'icon-192.png', badge: 'badge-96.png', tag: n ? `${n.a}-${name}` : 'gruppe',
    renotify: true, requireInteraction: n?.g === 'panne', data: n && Number.isFinite(n.la) && Number.isFinite(n.lo) ? { ort: [n.la, n.lo] } : {} });
})()));
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const ort = e.notification.data?.ort, post = e.notification.data?.post;
  e.waitUntil((async () => {
    const fenster = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (fenster[0]) { await fenster[0].focus(); if (ort) fenster[0].postMessage({ ort }); if (post) fenster[0].postMessage({ post, spielen: true }); return; }
    await clients.openWindow(post ? `./?post=${post}` : ort ? `./?ort=${ort.join(',')}` : './');
  })());
});
