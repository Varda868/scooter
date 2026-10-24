// Scooterways Service Worker: App-Hülle offline verfügbar, angesehene Kartenkacheln zwischenspeichern.
// Routing, Wetter, POIs usw. gehen immer ans Netz; ihre Offline-Reserve liegt in der App (localStorage).
const VERSION = 'v2';
const SHELL = `shell-${VERSION}`, TILES = 'tiles';
const MAX_TILES = 4000; // ca. 60–100 MB
const LEAFLET = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/';
const CDN = 'https://cdn.jsdelivr.net/npm/'; // MapLibre, PMTiles, Protomaps-Stile (versioniert, ändern sich nie)
const SHELL_FILES = ['./', 'manifest.webmanifest', 'icon.svg', 'icon-192.png'];
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

let puts = 0;
async function trimTiles(cache) {
  const keys = await cache.keys();
  // Reihenfolge der Schlüssel = Einfügereihenfolge: die ältesten zuerst raus
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_TILES)).map(k => cache.delete(k)));
}

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  // Range-Anfragen (PMTiles-Kartendatei) nicht anfassen: 206-Antworten lassen sich nicht cachen,
  // die Kacheln der Vektorkarte speichert die App selbst in IndexedDB
  if (req.method !== 'GET' || req.headers.has('range') || url.pathname.endsWith('.pmtiles')) return;

  // Seite selbst: Netz zuerst (Updates aus Plesk kommen sofort an), offline aus dem Speicher
  if (req.mode === 'navigate' || (url.origin === location.origin && /\/(index\.html)?$/.test(url.pathname))) {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) caches.open(SHELL).then(c => c.put('./', res.clone()));
      return res;
    }).catch(() => caches.match('./')));
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
