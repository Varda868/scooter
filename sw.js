// Scooterways Service Worker: App-Hülle offline verfügbar, angesehene Kartenkacheln zwischenspeichern.
// Routing, Wetter, POIs usw. gehen immer ans Netz; ihre Offline-Reserve liegt in der App (localStorage).
const VERSION = 'v25';
const SHELL = `shell-${VERSION}`, TILES = 'tiles';
const MAX_TILES = 4000; // ca. 60–100 MB
const POIS = 'pois', MAX_POI_TILES = 300; // 1°-Kacheln, je nach Gegend 10–500 kB
const LEAFLET = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/';
const CDN = 'https://cdn.jsdelivr.net/npm/'; // MapLibre, PMTiles, Protomaps-Stile (versioniert, ändern sich nie)
// Reihenfolge der Skripte bestimmt index.html; neue Module hier ergänzen
const APP_FILES = ['css/app.css', 'js/01-grundlagen.js', 'js/02-wegpunkte.js', 'js/03-routing.js', 'js/04-vergleich.js', 'js/05-vorschau.js', 'js/06-kartenknoepfe.js', 'js/07-navi.js', 'js/08-verkehr.js', 'js/09-etappen.js', 'js/10-wetter.js', 'js/11-pois.js', 'js/13-poisuche.js', 'js/14-gpx.js', 'js/15-opencaching.js', 'js/16-sonden.js', 'js/17-entdecker.js', 'js/18-roller.js', 'js/19-vektorkarte.js', 'js/20-start.js', 'js/21-oberflaeche.js', 'js/22-talk.js', 'js/23-standort.js', 'js/24-tank.js', 'js/25-faehre.js', 'js/27-server.js'];
const SHELL_FILES = ['./', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', ...APP_FILES];
const CDN_FILES = [LEAFLET + 'leaflet.min.js', LEAFLET + 'leaflet.min.css'];

// CDN-Dateien einzeln und fehlertolerant: ein Aussetzer dort soll die Installation nicht verhindern
// (sie werden sonst beim nächsten Laden über den fetch-Handler nachgeholt)
self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL)
    .then(c => Promise.all([c.addAll(SHELL_FILES), ...CDN_FILES.map(u => c.add(u).catch(() => {}))]))
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
  // Server-API und Admin-Bereich nie anfassen: immer live, und die Admin-Seite darf nicht als App-Hülle im Speicher landen
  if (url.origin === location.origin && url.pathname.includes('/api/')) return;

  // Seite selbst: Netz zuerst (Updates aus Plesk kommen sofort an), offline aus dem Speicher
  if (req.mode === 'navigate' || (url.origin === location.origin && /\/(index\.html)?$/.test(url.pathname))) {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) caches.open(SHELL).then(c => c.put('./', res.clone()));
      return res;
    }).catch(() => caches.match('./')));
    return;
  }
  // Eigene Skripte und CSS ebenso Netz zuerst, damit nie eine neue Seite mit alten Modulen läuft (talk/ wird erst bei Bedarf geladen)
  if (url.origin === location.origin && /\/(js|css|talk)\/[^/]+$/.test(url.pathname)) {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) caches.open(SHELL).then(c => c.put(req, res.clone()));
      return res;
    }).catch(() => caches.match(req)));
    return;
  }

  // Eigene POI-Kacheln: index.json Netz zuerst, Kacheln (URL trägt den Datenstand) Speicher zuerst; offline aus dem Speicher
  if (url.origin === location.origin && url.pathname.includes('/poi/')) {
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
