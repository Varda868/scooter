// --- Kartenknöpfe: Vollbild und Zentrieren/Mitführen auf den eigenen Standort ---
const me = { watch: null, follow: false, dot: L.circleMarker([0, 0], { radius: 7, color: '#fff', weight: 2, fillColor: '#2e86e4', fillOpacity: 1, interactive: false }),
  ring: L.circle([0, 0], { radius: 1, color: '#2e86e4', weight: 1, fillOpacity: 0.1, interactive: false }) };
const MapButtons = L.Control.extend({
  options: { position: 'topleft' },
  onAdd() {
    const bar = L.DomUtil.create('div', 'leaflet-bar');
    bar.innerHTML = '<a href="#" id="fullBtn" class="map-btn" title="Vollbild" role="button">⛶</a>' +
      '<a href="#" id="centerBtn" class="map-btn" title="Auf meinen Standort zentrieren und mitführen" role="button">◎</a>';
    L.DomEvent.disableClickPropagation(bar);
    return bar;
  }
});
map.addControl(new MapButtons());

function setFull(on) {
  document.body.classList.toggle('map-full', on);
  $('fullBtn').classList.toggle('active', on);
  $('fullBtn').title = on ? 'Vollbild beenden' : 'Vollbild';
  // Fullscreen-API wo vorhanden (blendet auch die Browserleiste aus); iPhone-Safari kann das nicht, dort reicht die CSS-Variante
  const fsOn = !!document.fullscreenElement;
  if (on && !fsOn) document.documentElement.requestFullscreen?.().catch(() => {});
  if (!on && fsOn) document.exitFullscreen?.().catch(() => {});
  setTimeout(() => map.invalidateSize(), 100);
}
$('fullBtn').onclick = e => { e.preventDefault(); setFull(!document.body.classList.contains('map-full')); };
// Esc oder Zurück-Geste beendet das echte Vollbild, dann auch das Layout zurücksetzen
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && document.body.classList.contains('map-full')) setFull(false); });

function setFollow(on) {
  me.follow = on;
  $('centerBtn').classList.toggle('active', on);
}
$('centerBtn').onclick = e => {
  e.preventDefault();
  if (me.follow) { // zweiter Tipp: Mitführen beenden, Standortpunkt aus
    setFollow(false);
    navigator.geolocation?.clearWatch(me.watch); me.watch = null;
    me.dot.remove(); me.ring.remove();
    return;
  }
  if (!navigator.geolocation) { $('summary').textContent = '⚠️ Standort wird von diesem Browser nicht unterstützt.'; return; }
  setFollow(true);
  if (me.watch != null) { if (me.dot._map) map.setView(me.dot.getLatLng(), Math.max(map.getZoom(), 15)); return; }
  let first = true;
  me.watch = navigator.geolocation.watchPosition(pos => {
    const ll = L.latLng(pos.coords.latitude, pos.coords.longitude);
    me.dot.setLatLng(ll).addTo(map);
    me.ring.setLatLng(ll).setRadius(pos.coords.accuracy).addTo(map);
    if (me.follow) map.setView(ll, first ? Math.max(map.getZoom(), 15) : map.getZoom(), { animate: !first });
    first = false;
  }, err => {
    setFollow(false); me.watch = null;
    $('summary').textContent = '⚠️ Standort nicht verfügbar: ' + err.message;
  }, { enableHighAccuracy: true, maximumAge: 5000 });
};
// Karte von Hand verschieben beendet das Mitführen, der Standortpunkt bleibt
map.on('dragstart', () => me.follow && setFollow(false));
