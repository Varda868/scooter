// Offline-Start: Service Worker hält App und angesehene Kacheln vor (nur über HTTPS bzw. localhost)
if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});

// Beim Öffnen den eigenen Standort als Start vorschlagen
if (navigator.geolocation) navigator.geolocation.getCurrentPosition(pos => {
  if (waypoints[0].latlng) return;
  const ll = L.latLng(pos.coords.latitude, pos.coords.longitude);
  waypoints[0] = { latlng: ll, text: 'Mein Standort' };
  renderWaypoints();
  map.setView(ll, 13);
}, () => {}, { timeout: 10000, maximumAge: 300000 });
