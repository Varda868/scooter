// --- Wettersonden (SondeHub): aktive Sonden im Umkreis, vorhergesagte Landepunkte und bereits geborgene.
// Öffentliche API ohne Schlüssel; nur im Minutentakt abfragen, solange "Live laden" an ist.
const SONDEHUB = 'https://api.v2.sondehub.org';
const sondeLayer = L.layerGroup().addTo(map);
const sondePrefs = { on: false, radius: 100, ...store.get('sondes', {}) };
let sondeTimer = null, sondeRequest = 0, sondeMoved = 0;

const agoText = ts => { const m = Math.round((Date.now() - ts) / 60000); return m < 1 ? 'gerade eben' : m < 60 ? `vor ${m} min` : `vor ${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} h`; };
// Landepunkt aus der Tawhiri-Bahn (letzter Punkt), sonst die Felder der Vorhersage
function landingOf(pred) {
  try {
    const path = typeof pred.data === 'string' ? JSON.parse(pred.data) : pred.data;
    const last = Array.isArray(path) ? path.at(-1) : null;
    if (last && last.lat != null) return { lat: +last.lat, lon: ((+last.lon + 540) % 360) - 180, time: Date.parse(last.time) || (last.time > 1e9 ? last.time * 1000 : null) };
  } catch {}
  return pred.latitude != null ? { lat: +pred.latitude, lon: +pred.longitude, time: Date.parse(pred.time) || null } : null;
}

async function loadSondes() {
  const req = ++sondeRequest;
  sondeMoved = Date.now();
  sondeLayer.clearLayers();
  if (!sondePrefs.on) { $('sondeSummary').textContent = 'aus'; $('sondes').innerHTML = ''; mapBusy('sonde', null); return; }
  const c = map.getCenter(), dist = sondePrefs.radius * 1000;
  const q = `lat=${c.lat.toFixed(4)}&lon=${c.lng.toFixed(4)}&distance=${dist}`;
  $('sondeSummary').textContent = 'lade …';
  mapBusy('sonde', '🎈 Wettersonden laden …');
  try {
    const get = url => fetch(url).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
    const [live, preds, rec] = await Promise.all([
      get(`${SONDEHUB}/sondes?${q}&last=10800`),
      get(`${SONDEHUB}/predictions?vehicles=&${q.replace(/distance=\d+/, `distance=${Math.min(dist, 100000)}`)}`).catch(() => []),
      get(`${SONDEHUB}/recovered?${q}&last=259200`).catch(() => [])
    ]);
    if (req !== sondeRequest) return;
    const recovered = new Map((Array.isArray(rec) ? rec : []).filter(r => r.recovered).map(r => [r.serial, r]));
    const landing = new Map((Array.isArray(preds) ? preds : []).map(p => [p.vehicle, landingOf(p)]).filter(([, l]) => l));
    const sondes = Object.entries(live || {}).map(([serial, t]) => {
      // Je Seriennummer entweder direkt das letzte Telegramm oder ein Objekt {Zeit: Telegramm}
      const tel = t && t.lat != null ? t : Object.values(t || {}).sort((a, b) => Date.parse(b.datetime) - Date.parse(a.datetime))[0];
      return tel && tel.lat != null ? { serial, tel, ts: Date.parse(tel.datetime), land: landing.get(serial), rec: recovered.get(serial) } : null;
    }).filter(Boolean);
    for (const sd of sondes) {
      const { tel } = sd, alt = Math.round(tel.alt), vv = tel.vel_v;
      // Ohne Meldung seit 20 min und tief: vermutlich gelandet
      sd.down = !sd.rec && (Date.now() - sd.ts > 20 * 60000) && alt < 2500;
      sd.icon = sd.rec ? '✓' : sd.down ? '📍' : vv < -1 ? '🪂' : '🎈';
      const target = sd.land && !sd.down ? sd.land : { lat: tel.lat, lon: tel.lon };
      sd.target = target;
      sd.km = map.distance(c, [target.lat, target.lon]) / 1000;
      const info = `<b>${escapeHtml(sd.serial)}</b> · ${escapeHtml(tel.type || '')}${tel.subtype ? ' ' + escapeHtml(tel.subtype) : ''}<br>` +
        `${alt.toLocaleString('de-DE')} m${vv != null ? ` · ${vv > 0 ? '↑' : '↓'} ${Math.abs(vv).toFixed(1)} m/s` : ''} · ${agoText(sd.ts)}` +
        (tel.frequency ? `<br>${(+tel.frequency).toFixed(3)} MHz` : '') +
        (sd.land && !sd.down ? `<br>🎯 Landung ${sd.land.time ? 'gegen ' + new Date(sd.land.time).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : 'vorhergesagt'}` : '') +
        (sd.rec ? `<br>✓ geborgen${sd.rec.recovered_by ? ' von ' + escapeHtml(sd.rec.recovered_by) : ''}` : '') +
        `<br><a href="https://sondehub.org/${encodeURIComponent(sd.serial)}" target="_blank" rel="noopener">auf SondeHub</a>`;
      const box = document.createElement('div');
      box.innerHTML = info;
      box.append(menuBox([['end', sd.land && !sd.down ? 'Landepunkt als Ziel' : 'Als Ziel']], () => {
        const ll = L.latLng(target.lat, target.lon);
        changeWaypoints(() => { setEnd(waypoints.length - 1, ll); waypoints.find(w => w.latlng === ll).text = `Sonde ${sd.serial}`; });
      }));
      sd.marker = L.marker([tel.lat, tel.lon], { icon: L.divIcon({ className: 'sonde-pin' + (sd.rec || sd.down ? ' old' : ''), html: sd.icon, iconSize: [24, 24] }), title: sd.serial })
        .bindPopup(box, { className: 'map-menu', minWidth: 200 }).addTo(sondeLayer);
      if (sd.land && !sd.down && !sd.rec) {
        L.polyline([[tel.lat, tel.lon], [sd.land.lat, sd.land.lon]], { color: '#7b2cbf', weight: 2, dashArray: '4 6', interactive: false }).addTo(sondeLayer);
        L.marker([sd.land.lat, sd.land.lon], { icon: L.divIcon({ className: 'sonde-pin', html: '🎯', iconSize: [24, 24] }), title: `Landung ${sd.serial}` })
          .on('click', () => sd.marker.openPopup()).addTo(sondeLayer);
      }
    }
    sondes.sort((a, b) => (!!a.rec - !!b.rec) || a.km - b.km);
    const flying = sondes.filter(sd => !sd.down && !sd.rec).length;
    mapBusy('sonde', null);
    $('sondeSummary').textContent = sondes.length ? `${flying} in der Luft · ${sondes.length - flying} gelandet/geborgen` : `keine im Umkreis von ${sondePrefs.radius} km`;
    $('sondes').innerHTML = sondes.map((sd, i) => `<li data-i="${i}">${sd.icon} ${escapeHtml(sd.serial)} · ${Math.round(sd.tel.alt).toLocaleString('de-DE')} m · ` +
      `${sd.land && !sd.down && !sd.rec ? '🎯 ' : ''}${sd.km.toFixed(0)} km${sd.rec ? ' · geborgen' : ''} · ${agoText(sd.ts)}</li>`).join('');
    $('sondes').onclick = e => { const sd = sondes[e.target.closest('li')?.dataset.i]; if (sd) { map.setView(sd.marker.getLatLng(), Math.max(map.getZoom(), 11)); sd.marker.openPopup(); } };
  } catch (err) {
    if (req === sondeRequest) { $('sondeSummary').textContent = '⚠️ SondeHub nicht erreichbar: ' + err.message; mapBusy('sonde', '⚠️ Wettersonden: SondeHub nicht erreichbar', 6000); }
  }
}
function sondeSchedule() {
  clearInterval(sondeTimer); sondeTimer = null;
  if (sondePrefs.on) sondeTimer = setInterval(() => { if (!document.hidden) loadSondes(); }, 60000);
  loadSondes();
}
$('sondeOn').checked = sondePrefs.on;
$('sondeRadius').value = String(sondePrefs.radius);
$('sondeOn').onchange = () => { sondePrefs.on = $('sondeOn').checked; store.set('sondes', sondePrefs); sondeSchedule(); };
$('sondeRadius').onchange = () => { sondePrefs.radius = +$('sondeRadius').value; store.set('sondes', sondePrefs); loadSondes(); };
// Karte verschoben: neu laden (höchstens alle 15 s)
map.on('moveend', () => { if (sondePrefs.on && Date.now() - sondeMoved > 15000) { sondeMoved = Date.now(); loadSondes(); } });
sondeSchedule();
