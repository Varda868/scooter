// --- POI-Details (Werkstatt-Marken, Kontakt, Zeltplatz) und Start der App ---
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
  return (brands ? `<br>Marken: ${escapeHtml(brands)}` : '') +
    (t['motorcycle:repair'] === 'yes' || t.shop === 'motorcycle_repair' || t.craft ? '<br>🔧 Reparatur' : '');
}
// Ausstattung (Zeltplatz) und Kontakt aus den OSM-Tags; nur was eingetragen ist
function contactInfo(t) {
  const first = (...keys) => keys.map(k => t[k]).find(Boolean);
  const phone = first('phone', 'contact:phone', 'contact:mobile')?.split(';')[0].trim(), mail = first('email', 'contact:email');
  const web = first('website', 'contact:website', 'url'), yes = k => t[k] === 'yes';
  const adr = [[t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' '), [t['addr:postcode'], t['addr:city']].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const camp = t.tourism === 'camp_site' ? [yes('tents') && '⛺ Zelte', yes('caravans') && '🚐 Wohnmobile', yes('cabins') && '🛖 Hütten',
    yes('shower') || t.shower === 'hot' ? '🚿 Dusche' : '', yes('power_supply') && '🔌 Strom', t.dog === 'no' && '🐕 keine Hunde',
    t.reservation === 'required' ? '📅 Reservierung nötig' : t.reservation === 'recommended' ? '📅 Reservierung empfohlen' : '',
    t.stars && '★'.repeat(Math.min(5, +t.stars || 0))].filter(Boolean).join(' · ') : '';
  return (camp ? `<br>${escapeHtml(camp)}` : '') + (t.fee === 'no' ? '<br>kostenlos' : '') +
    (t.operator ? `<br>${escapeHtml(t.operator)}` : '') + (adr ? `<br>${escapeHtml(adr)}` : '') +
    (phone ? `<br>📞 <a href="tel:${escapeHtml(phone.replace(/[^\d+]/g, ''))}">${escapeHtml(phone)}</a>` : '') +
    (mail && /^[^\s@]+@[^\s@]+$/.test(mail) ? `<br>✉️ <a href="mailto:${escapeHtml(mail)}">${escapeHtml(mail)}</a>` : '') +
    (web && /^https?:\/\//.test(web) ? `<br>🔗 <a href="${escapeHtml(web)}" target="_blank" rel="noopener">Website</a>` : '');
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
// Erst rechnen, wenn alle Skripte geladen sind: offline kommt die gespeicherte Route sofort, und showTrip braucht
// Teile aus späteren Dateien (Vektorkarte, Fähren)
const ersteRoute = () => { if (ready()) route(); };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ersteRoute); else ersteRoute();
