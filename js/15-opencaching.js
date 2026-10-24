// --- Opencaching.de (OKAPI, Level 1: nur Consumer Key). Kein CORS dokumentiert, daher JSONP. ---
const OKAPI_URL = 'https://www.opencaching.de/okapi/services/';
Object.assign(oc, store.get('opencaching', {}));
$('ocKey').value = oc.key; $('ocOn').checked = oc.on;
function applyOc() {
  oc.key = $('ocKey').value.trim(); oc.on = $('ocOn').checked;
  store.set('opencaching', { key: oc.key, on: oc.on });
  updateCacheBoxSummary();
}
// Kopfzeile: gewählte Typen und Opencaching-Status
function updateCacheBoxSummary() {
  const on = CACHE_GROUPS.filter(g => cacheTypesOn.has(g.id));
  $('ocSummary').textContent = (on.length === CACHE_GROUPS.length ? 'alle Typen' : on.map(g => g.icon).join('') || 'keine Typen') +
    ' · Opencaching ' + (!oc.key ? 'ohne Schlüssel' : oc.on ? 'live' : 'aus');
}
applyOc();
['ocKey', 'ocOn'].forEach(id => $(id).addEventListener('change', () => { applyOc(); loadOpencaching(); }));

let jsonpCount = 0;
function jsonp(url) {
  return new Promise((resolve, reject) => {
    const cb = `okapiCb${++jsonpCount}`, script = document.createElement('script');
    const done = (err, data) => { clearTimeout(timer); delete window[cb]; script.remove(); err ? reject(err) : resolve(data); };
    const timer = setTimeout(() => done(new Error('Zeitüberschreitung')), 20000);
    window[cb] = data => done(null, data);
    // OKAPI antwortet bei Fehlern (z. B. falscher Schlüssel) mit HTTP 400, das kommt hier nur als onerror an
    script.onerror = () => done(new Error('Abruf fehlgeschlagen, Schlüssel prüfen'));
    script.src = `${url}&format=jsonp&callback=${cb}`;
    document.head.appendChild(script);
  });
}

// Route in Stücke von ~15 km teilen, je Stück eine Bounding Box (plus Umkreis): eine große Box über die ganze
// Tour würde am 500er-Limit hängen bleiben und nach Nähe zur Boxmitte sortieren
function routeBoxes(padM) {
  const boxes = [], total = routeKm[routeKm.length - 1], step = 15;
  for (let from = 0; from < total; from += step) {
    const pts = routeCoords.filter((_, i) => routeKm[i] >= from && routeKm[i] <= from + step);
    if (!pts.length) continue;
    const dLat = padM / 110540, dLon = padM / (111320 * Math.cos(pts[0][0] * Math.PI / 180));
    const lats = pts.map(p => p[0]), lons = pts.map(p => p[1]);
    boxes.push([Math.min(...lats) - dLat, Math.min(...lons) - dLon, Math.max(...lats) + dLat, Math.max(...lons) + dLon]);
  }
  return boxes.slice(0, 12);
}

async function loadOpencaching() {
  const req = ++oc.request;
  caches = caches.filter(c => !c.oc);
  if (!oc.key || !oc.on || !routeCoords) { renderCaches(); return; }
  $('cacheSummary').textContent = 'Lade Opencaching-Caches …';
  try {
    const found = {};
    await Promise.all(routeBoxes(+$('radius').value).map(async b => {
      const params = new URLSearchParams({
        consumer_key: oc.key, wrap: 'false',
        search_method: 'services/caches/search/bbox',
        search_params: JSON.stringify({ bbox: b.map(v => v.toFixed(5)).join('|'), status: 'Available', limit: '500' }),
        retr_method: 'services/caches/geocaches',
        retr_params: JSON.stringify({ fields: 'code|name|location|type|size2|difficulty|terrain|url', langpref: 'de|en' })
      });
      Object.assign(found, await jsonp(`${OKAPI_URL}caches/shortcuts/search_and_retrieve?${params}`));
    }));
    if (req !== oc.request) return;
    caches = caches.filter(c => !c.oc).concat(Object.values(found).map(c => {
      const [lat, lon] = c.location.split('|').map(Number);
      return { oc: true, isCache: true, lat, lon, code: c.code, title: c.name, type: c.type, url: c.url,
        difficulty: String(c.difficulty), terrain: String(c.terrain), container: c.size2 };
    }));
  } catch (err) {
    if (req === oc.request) { renderCaches(); $('cacheSummary').textContent = '⚠️ Opencaching: ' + err.message; }
    return;
  }
  renderCaches();
}

// Schmale Stecknadel in der Typfarbe (angelehnt an die Geocaching-Farben), Spitze auf dem Cache
function cachePin(c) {
  const color = CACHE_GROUPS.find(g => g.id === cacheGroup(c)).color;
  return L.divIcon({ className: '', iconSize: [12, 22], iconAnchor: [6, 22], popupAnchor: [0, -20],
    html: `<svg width="12" height="22" viewBox="0 0 12 22"><path d="M6 21.5 L1.6 9.5 A5 5 0 1 1 10.4 9.5 Z" fill="${color}" stroke="#fff" stroke-width="1.2"/><circle cx="6" cy="6" r="1.8" fill="#fff"/></svg>` });
}

function renderCaches() {
  cacheLayer.clearLayers();
  $('caches').innerHTML = '';
  if (!caches.length) { $('cacheSummary').textContent = ''; return; }
  const radius = +$('radius').value;
  const filter = $('cachesNearRoute').checked && routeCoords;
  const shown = caches.map(c => ({ ...c, ...(routeCoords ? locateOnRoute(c.lat, c.lon) : {}) }))
    .filter(c => (!filter || c.dist <= radius) && cacheTypesOn.has(cacheGroup(c)))
    .sort((a, b) => (a.km ?? 0) - (b.km ?? 0));

  for (const c of shown) {
    const dt = c.difficulty ? `<br>D ${escapeHtml(c.difficulty)} / T ${escapeHtml(c.terrain)}` + (c.container ? ` · ${escapeHtml(c.container)}` : '') : '';
    const pos = c.km != null ? `<br>km ${c.km.toFixed(1)} · ${Math.round(c.dist)} m neben der Route` : '';
    const link = /^https?:\/\//.test(c.url) ? `<br><a href="${escapeHtml(c.url)}" target="_blank" rel="noopener">Cache-Seite</a>` : '';
    const box = document.createElement('div');
    box.innerHTML = `<b>${escapeHtml(c.title)}</b><br>${escapeHtml(c.code)}${c.type ? ' · ' + escapeHtml(c.type) : ''}${dt}${pos}${link}`;
    // Cache direkt anfahren: als Zwischenziel (minimaler Umweg) oder als Ziel
    box.append(menuBox([['via', 'Als Zwischenziel'], ['end', 'Als Ziel']], act => {
      const ll = L.latLng(c.lat, c.lon), text = `${c.code} ${c.title !== c.code ? c.title : ''}`.trim();
      changeWaypoints(() => {
        if (act === 'end') setEnd(waypoints.length - 1, ll); else insertVia(ll);
        waypoints.find(w => w.latlng === ll).text = text;
      });
    }, 'via'));
    c.marker = L.marker([c.lat, c.lon], { icon: cachePin(c), title: c.title })
      .bindPopup(box, { minWidth: 200 }).addTo(cacheLayer);
  }
  const label = caches.some(c => c.isCache) ? 'Geocaches' : 'Wegpunkte';
  $('cacheSummary').textContent = filter
    ? `${shown.length} von ${caches.length} ${label} im Umkreis von ${radius} m`
    : `${caches.length} ${label} geladen` + (caches.length && !routeCoords ? ' (für den Routenfilter erst Route berechnen oder Track laden)' : '');
  $('caches').innerHTML = shown.map((c, i) =>
    `<li data-i="${i}">${cacheIcon(c.type, c.isCache)} ${c.km != null ? `km ${c.km.toFixed(1)} · ` : ''}${escapeHtml(c.code)} ${escapeHtml(c.title !== c.code ? c.title : '')}</li>`).join('');
  $('caches').onclick = e => {
    const c = shown[e.target.closest('li')?.dataset.i];
    if (c) { map.setView([c.lat, c.lon], 16); c.marker.openPopup(); }
  };
}

// Hersteller stehen in OSM uneinheitlich (brand, brands, motorcycle:…, name, description): in allen Tags suchen
function brandMatch(tags) {
  const words = [...$('brands').querySelectorAll('input:checked')].map(i => i.value.toLowerCase())
    .concat($('brand').value.toLowerCase().split(/[,;\s]+/).filter(Boolean));
  const all = Object.entries(tags).map(([k, v]) => `${k}=${v}`).join(' ').toLowerCase();
  // Ganze Wörter, damit z. B. "Rex" oder "Beta" nicht in anderen Namen trifft
  const has = w => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(all);
  // Vespa ist eine Piaggio-Marke
  return !words.length || words.some(w => has(w) || (w === 'vespa' && has('piaggio')));
}
function workshopInfo(p) {
  if (p.type.id !== 'workshop') return '';
  const t = p.tags;
  const brands = t.brand || t.brands || t['motorcycle:brands'] ||
    Object.keys(t).filter(k => /^(motorcycle|scooter):(?!repair|sales|parts|rental|clothes|tyres|type)/.test(k) && t[k] === 'yes').map(k => k.split(':')[1]).join(', ');
  const web = t.website || t['contact:website'], phone = t.phone || t['contact:phone'];
  return (brands ? `<br>Marken: ${escapeHtml(brands)}` : '') +
    (t['motorcycle:repair'] === 'yes' || t.shop === 'motorcycle_repair' || t.craft ? '<br>🔧 Reparatur' : '') +
    (phone ? `<br>📞 <a href="tel:${escapeHtml(phone.replace(/[^\d+]/g, ''))}">${escapeHtml(phone)}</a>` : '') +
    (web && /^https?:\/\//.test(web) ? `<br><a href="${escapeHtml(web)}" target="_blank" rel="noopener">Website</a>` : '');
}

// Ordnet ein Overpass-Ergebnis seinem Filter zu, z. B. "[amenity=shelter][shelter_type!=public_transport]"
function matches(tags, filter) {
  return [...filter.matchAll(/\[(\w+)(!?=)([^\]]+)\]/g)].every(([, k, op, v]) =>
    op === '=' ? tags[k] === v : tags[k] !== v);
}

$('go').onclick = () => {
  // Noch nicht bestätigte Eingaben übernehmen
  $('wpList').querySelectorAll('input').forEach((inp, i) => {
    if (inp.value.trim() !== waypoints[i].text) waypoints[i] = { latlng: null, text: inp.value.trim() };
  });
  route();
};
renderWaypoints();
renderMyPois();
if (ready()) route();
