// --- Verkehr: TomTom Traffic API (Meldungen v5, Fluss-Kacheln v4). Schlüssel nur im Browser, nie im Repo. ---
const TOMTOM_URL = 'https://api.tomtom.com/traffic';
const INCIDENT_ICONS = { 0: '❔', 1: '💥', 2: '🌫️', 3: '⚠️', 4: '🌧️', 5: '🧊', 6: '🚗', 7: '🚧', 8: '⛔', 9: '🚧', 10: '💨', 11: '🌊', 14: '🛻' };
const DELAY_WORDS = ['', 'leicht', 'mittel', 'stark', ''];
const tt = { key: '', avoid: true, flow: false, ...store.get('tomtom', {}) };
const incidentLayer = L.layerGroup().addTo(map);
const TT_FLOW_DIREKT = `${TOMTOM_URL}/map/4/tile/flow/relative0/{z}/{x}/{y}.png?key={key}`;
const TT_FLOW_SERVER = 'api/proxy.php?d=tomtom-flow&z={z}&x={x}&y={y}';
const flowLayer = L.tileLayer(TT_FLOW_DIREKT, { key: tt.key, maxZoom: 19, opacity: 0.8, attribution: 'Verkehr © TomTom' });
// Liegt ein Schlüssel auf dem eigenen Server (js/27-server.js setzt das), geht TomTom über dessen Proxy
let ttServer = false;
const ttKeyDa = () => !!tt.key || ttServer;
$('ttKey').value = tt.key; $('ttAvoid').checked = tt.avoid; $('ttFlow').checked = tt.flow;

function applyTraffic() {
  tt.key = $('ttKey').value.trim(); tt.avoid = $('ttAvoid').checked; tt.flow = $('ttFlow').checked;
  store.set('tomtom', tt);
  flowLayer.options.key = tt.key;
  flowLayer.setUrl(ttServer ? TT_FLOW_SERVER : TT_FLOW_DIREKT, true);
  if (ttKeyDa() && tt.flow) flowLayer.addTo(map).redraw(); else flowLayer.remove();
  $('trafficSummary').textContent = !ttKeyDa() ? 'kein Schlüssel' : [ttServer ? 'Schlüssel vom Server' : '', tt.avoid ? 'Sperrungen umfahren' : 'nur anzeigen', tt.flow ? 'Fluss an' : ''].filter(Boolean).join(' · ');
}
applyTraffic();
['ttKey', 'ttAvoid', 'ttFlow'].forEach(id => $(id).addEventListener('change', () => { applyTraffic(); if (ready()) route(); }));

// Kurzzeit-Cache, damit Ziehen an der Route nicht jedes Mal eine Abfrage verbraucht
const incidentCache = new Map();
async function loadIncidents(coords) {
  const lats = coords.map(c => c[0]), lons = coords.map(c => c[1]);
  // Auf 0,02° nach außen runden: mindestens 1 km Rand, und kleine Änderungen treffen denselben Cache-Eintrag
  const lo = v => (Math.floor((v - 0.01) * 50) / 50).toFixed(2), hi = v => (Math.ceil((v + 0.01) * 50) / 50).toFixed(2);
  const bbox = [lo(Math.min(...lons)), lo(Math.min(...lats)), hi(Math.max(...lons)), hi(Math.max(...lats))];
  const km2 = (bbox[2] - bbox[0]) * 111.32 * Math.cos(bbox[1] * Math.PI / 180) * (bbox[3] - bbox[1]) * 110.54;
  if (km2 > 10000) throw new Error('Route zu weiträumig für Verkehrsmeldungen');
  const key = bbox.join(), hit = incidentCache.get(key);
  if (hit && Date.now() - hit.at < 120000) return hit.incidents;
  const fields = '{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description},from,to,delay,length,endTime}}}';
  const res = await fetch(`${TOMTOM_URL}/services/5/incidentDetails?key=${encodeURIComponent(tt.key)}&bbox=${key}` +
    `&fields=${encodeURIComponent(fields)}&language=de-DE&timeValidityFilter=present`);
  if (res.status === 403) throw new Error('Schlüssel ungültig oder Tageskontingent aufgebraucht');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const incidents = ((await res.json()).incidents || []).filter(i => i?.geometry);
  incidentCache.set(key, { at: Date.now(), incidents });
  return incidents;
}

// TomTom liefert [lon, lat]
const incidentPoints = i => (i.geometry.type === 'Point' ? [i.geometry.coordinates] : i.geometry.coordinates).map(([lon, lat]) => [lat, lon]);
// Bei einer gesperrten Strecke Punkte bei 25/50/75 % meiden, nicht die Enden an Kreuzungen
function closurePoints(i) {
  const pts = incidentPoints(i);
  const picks = pts.length < 3 ? [pts[Math.floor(pts.length / 2)]] : [0.25, 0.5, 0.75].map(f => pts[Math.round(f * (pts.length - 1))]);
  return [...new Set(picks)].map(([lat, lon]) => ({ lat, lon }));
}

function renderIncidents(incidents) {
  incidentLayer.clearLayers();
  $('incidents').innerHTML = '';
  $('incidentSummary').textContent = '';
  if (!routeCoords || !incidents.length) return;
  const near = incidents.map(i => {
    const hits = incidentPoints(i).map(([lat, lon]) => locateOnRoute(lat, lon));
    const best = hits.reduce((a, b) => b.dist < a.dist ? b : a);
    return { i, ...best };
  }).filter(x => x.dist < 150).sort((a, b) => a.km - b.km);
  for (const { i } of near) {
    const p = i.properties, icon = INCIDENT_ICONS[p.iconCategory] || '⚠️';
    const text = [p.events?.map(e => e.description).join(', '), p.from && p.to ? `${p.from} → ${p.to}` : '',
      p.delay ? `+${Math.round(p.delay / 60)} min` : DELAY_WORDS[p.magnitudeOfDelay] ? `Verzögerung ${DELAY_WORDS[p.magnitudeOfDelay]}` : '',
      p.endTime ? `bis ${new Date(p.endTime).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}` : ''].filter(Boolean).join(' · ');
    const pts = incidentPoints(i);
    if (pts.length > 1) L.polyline(pts, { color: p.iconCategory === 8 ? '#b00020' : '#ff8c00', weight: 8, opacity: 0.7, dashArray: '6 6', interactive: false }).addTo(incidentLayer);
    L.marker(pts[Math.floor(pts.length / 2)], { icon: L.divIcon({ className: 'poi-icon', html: icon, iconSize: [24, 24] }) })
      .bindPopup(`<b>${icon} ${escapeHtml(text)}</b>`).addTo(incidentLayer);
  }
  const closures = near.filter(x => x.i.properties.iconCategory === 8).length;
  $('incidentSummary').textContent = near.length ? `🚦 ${near.length} Verkehrsmeldung${near.length > 1 ? 'en' : ''} an der Route` + (closures ? ` (${closures} Sperrung${closures > 1 ? 'en' : ''})` : '') : '';
  $('incidents').innerHTML = near.map(({ i, km }, n) => {
    const p = i.properties;
    return `<li data-n="${n}">km ${km.toFixed(1)} ${INCIDENT_ICONS[p.iconCategory] || '⚠️'} ${escapeHtml(p.events?.[0]?.description || '')}${p.from ? ` <span class="hint">${escapeHtml(p.from)}</span>` : ''}</li>`;
  }).join('');
  $('incidents').onclick = e => {
    const li = e.target.closest('li'); if (!li) return;
    const pts = incidentPoints(near[+li.dataset.n].i);
    map.setView(pts[Math.floor(pts.length / 2)], 15);
  };
}
