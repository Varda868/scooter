// Fähren auf der Route: Valhalla meldet Ein- und Ausschiffen als Manöver (28/29, travel_type "ferry"),
// Betreiber, Dauer und Link holen wir aus OSM (route=ferry). Fahrpläne und Preise gibt es dort nicht.
const FAEHRE_EIN = 28, FAEHRE_AUS = 29, FAEHRE_R = 300;
const faehreCache = new Map(); // "lat,lon" → Promise mit OSM-Tags der Linie oder null
let faehreReq = 0;

// Fährstücke der Route: [{ km, bisKm, lat, lon, zLat, zLon, s, name }]
function faehrenDerRoute(trip) {
  const out = [];
  let off = 0, cur = null;
  for (const l of trip.legs) {
    for (const m of l.maneuvers) {
      const i = off + m.begin_shape_index, p = routeCoords[i];
      if (m.type === FAEHRE_EIN && p) cur = { km: routeKm[i] ?? 0, lat: p[0], lon: p[1], s: 0, name: m.street_names?.[0] || '' };
      else if (cur && m.travel_type === 'ferry') { cur.s += m.time || 0; cur.name ||= m.street_names?.[0] || ''; }
      if (m.type === FAEHRE_AUS && cur && p) { Object.assign(cur, { bisKm: routeKm[i] ?? cur.km, zLat: p[0], zLon: p[1] }); out.push(cur); cur = null; }
    }
    off += decode(l.shape).length - 1;
  }
  return out;
}

// Linie am Anleger suchen; die mit passendem Namen gewinnt, sonst die erste
function faehreLinie(f) {
  const key = `${f.lat.toFixed(4)},${f.lon.toFixed(4)}`;
  if (!faehreCache.has(key)) {
    const um = `(around:${FAEHRE_R},${f.lat.toFixed(5)},${f.lon.toFixed(5)})`;
    faehreCache.set(key, overpassFetch(`[out:json][timeout:25];(way[route=ferry]${um};relation[route=ferry]${um};);out tags;`)
      .then(d => {
        const els = (d?.elements || []).filter(e => e.tags);
        const n = f.name.toLowerCase();
        const el = els.find(e => n && (e.tags.name || '').toLowerCase() === n) ||
          els.find(e => e.type === 'relation') || els[0];
        return el ? { ...el.tags, '@osm': `${el.type}/${el.id}` } : null;
      })
      .catch(err => { faehreCache.delete(key); throw err; }));
  }
  return faehreCache.get(key);
}

// OSM-Dauer "01:45" oder "105" → Sekunden
function faehreDauer(d) {
  const m = /^(\d+):(\d\d)/.exec(d || '');
  return m ? (+m[1] * 60 + +m[2]) * 60 : /^\d+$/.test(d || '') ? +d * 60 : 0;
}

// Darf ein 50er mit? yes bei moped/motorcycle/motor_vehicle/motorcar/vehicle, no nur bei ausdrücklichem Verbot
function faehreMitnahme(t) {
  const ja = ['moped', 'mofa', 'motorcycle', 'motor_vehicle', 'motorcar', 'vehicle'].find(k => t[k] === 'yes');
  if (ja) return '🛵 Fahrzeuge ja';
  if (['moped', 'motorcycle', 'motor_vehicle', 'vehicle'].some(k => t[k] === 'no')) return '⚠ laut OSM keine Fahrzeuge';
  return 'Mitnahme unklar';
}

function faehreText(f, t) {
  const name = t?.name || f.name || 'Fähre';
  const dauer = faehreDauer(t?.duration) || f.s;
  const web = t && (t.website || t['contact:website'] || t.url);
  const such = `https://duckduckgo.com/?q=${encodeURIComponent([t?.operator, name, 'Fähre Fahrplan'].filter(Boolean).join(' '))}`;
  return `⛴ km ${f.km.toFixed(0)} · ${escapeHtml(name)}` + (t?.operator ? ` · ${escapeHtml(t.operator)}` : '') +
    (dauer ? ` · ca. ${durText(dauer)}` : '') + (t ? ` · ${faehreMitnahme(t)}` : '') +
    (web && /^https?:\/\//.test(web) ? ` · <a href="${escapeHtml(web)}" target="_blank" rel="noopener">Betreiber ↗</a>`
      : ` · <a href="${such}" target="_blank" rel="noopener">suchen ↗</a>`) +
    (t?.['@osm'] ? ` · <a href="https://www.openstreetmap.org/${t['@osm']}" target="_blank" rel="noopener">OSM</a>` : '');
}

async function faehrenZeigen(trip) {
  const req = ++faehreReq, box = $('faehreInfo');
  const fs = trip ? faehrenDerRoute(trip) : [];
  box.innerHTML = fs.map(f => `<div>${faehreText(f, null)}</div>`).join('');
  if (!fs.length) return;
  const tags = await Promise.all(fs.map(f => faehreLinie(f).catch(() => null)));
  if (req !== faehreReq) return;
  box.innerHTML = fs.map((f, i) => `<div>${faehreText(f, tags[i])}</div>`).join('');
}
