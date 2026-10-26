// Datenkarte für die Werkstatt: [Feld, deutsch, englisch (versteht fast jede Werkstatt), Beispiel]
const ROLLER_TECHNIK = [
  ['tyreF', 'Reifen vorn', 'Front tyre', '110/70-12'], ['tyreR', 'Reifen hinten', 'Rear tyre', '120/70-12'],
  ['pressF', 'Luftdruck vorn', 'Pressure front', '1,8 bar'], ['pressR', 'Luftdruck hinten', 'Pressure rear', '2,0 bar / Sozius 2,2'],
  ['battery', 'Batterie', 'Battery', 'YTX4L-BS 12 V'], ['bulbHead', 'Scheinwerfer', 'Headlight', 'H4 12 V 35/35 W'],
  ['bulbRear', 'Rücklicht/Blinker', 'Rear light/indicators', 'P21/5W, RY10W'], ['plug', 'Zündkerze', 'Spark plug', 'NGK CR7HSA'],
  ['belt', 'Antriebsriemen', 'Drive belt', '743 × 20 × 30'], ['oil', 'Motoröl', 'Engine oil', '2T teilsynth. / 10W-40'],
  ['fuelType', 'Kraftstoff', 'Fuel', 'Super E5'], ['techNote', 'Notiz', 'Note', 'Variomatik neu 09/26'],
];
// --- Mein Roller: Fahrzeugdaten, Werkstatt, Wartungsbuch. Nur localStorage auf diesem Gerät (persönliche Daten,
// nie auf den Server); Sicherung als JSON-Datei. km-Stand = Tacho-Eintrag + seitdem gefahrene Navi-Fahrten.
const ROLLER_TEXT = ['model', 'year', 'plate', 'vin', 'insurer', 'policy', 'assist', 'shop', 'shopTel', 'shopAddr', ...ROLLER_TECHNIK.map(t => t[0])];
const ROLLER_NUM = ['odo', 'oilEvery', 'serviceMonths'];
const ROLLER_DEZ = ['fuel', 'price', 'tank', 'reserve']; // Verbrauch l/100 km, Benzinpreis €/l, Tank und Reserve l; Komma erlaubt
let roller = { oilEvery: 0, serviceMonths: 12, log: [], ...store.get('roller', {}) };
const saveRoller = () => store.set('roller', roller);
const telHref = t => 'tel:' + String(t).replace(/[^\d+]/g, '');

function rollerKm() {
  if (!(+roller.odo > 0)) return null;
  const since = roller.odoDate || '';
  return Math.round(+roller.odo + exp.rides.filter(r => r.date && r.date > since).reduce((sum, r) => sum + (r.km || 0), 0));
}

function rollerDue() {
  const km = rollerKm(), due = [];
  const last = re => roller.log.filter(e => re.test(e.what)).sort((a, b) => (b.date > a.date) - (b.date < a.date))[0];
  if (+roller.oilEvery > 0 && km != null) {
    const oil = last(/öl/i), left = (oil?.km ?? +roller.odo) + +roller.oilEvery - km;
    if (oil || left <= 300) due.push(left <= 0 ? `🔧 Ölwechsel fällig (${-left} km drüber)` : `🔧 Ölwechsel in ${left} km`);
  }
  if (+roller.serviceMonths > 0) {
    const sv = last(/inspektion|service|wartung/i);
    if (sv) {
      const next = new Date(sv.date); next.setMonth(next.getMonth() + +roller.serviceMonths);
      const days = Math.ceil((next - Date.now()) / 864e5);
      if (days <= 30) due.push(days <= 0 ? '🔧 Inspektion fällig' : `🔧 Inspektion in ${days} Tagen`);
    }
  }
  // Versicherungskennzeichen gilt bis Ende Februar; ab Dezember erinnern
  const m = new Date().getMonth();
  if (roller.plate && (m === 11 || m <= 1)) due.push('🪪 Neues Versicherungskennzeichen ab 1. März');
  return due;
}

function rollerRender() {
  const km = rollerKm(), due = rollerDue();
  $('rollerSummary').textContent = [roller.model, km != null ? `≈ ${km.toLocaleString('de-DE')} km` : '', ...due].filter(Boolean).join(' · ') || 'noch leer';
  $('odoHint').textContent = km != null && roller.odoDate
    ? `Eingetragen am ${new Date(roller.odoDate).toLocaleDateString('de-DE')}, mit gefahrenen Touren seitdem jetzt ≈ ${km.toLocaleString('de-DE')} km.` : '';
  $('rollerDue').textContent = due.join(' · ');
  // Kompakte Übersicht der eingetragenen Daten (antippen markiert den Wert zum Kopieren)
  const card = [['Modell', [roller.model, roller.year].filter(Boolean).join(', ')], ['Kennzeichen', roller.plate], ['FIN', roller.vin],
    ['Versicherung', [roller.insurer, roller.policy].filter(Boolean).join(' · ')], ['Werkstatt', [roller.shop, roller.shopAddr].filter(Boolean).join(', ')],
    ...ROLLER_TECHNIK.map(([k, de]) => [de, roller[k]])].filter(([, v]) => v);
  $('rollerCard').innerHTML = card.map(([k, v]) => `<span>${k}</span><span>${escapeHtml(v)}</span>`).join('');
  const links = [];
  if (roller.assist) links.push(`<a href="${telHref(roller.assist)}">📞 Pannenhilfe</a>`);
  if (roller.shopTel) links.push(`<a href="${telHref(roller.shopTel)}">📞 Werkstatt</a>`);
  if (roller.shopAddr || roller.shopLatLng) links.push('<button id="shopGo">🧭 Werkstatt als Ziel</button>');
  $('rollerLinks').innerHTML = links.join('');
  if ($('shopGo')) $('shopGo').onclick = async () => {
    try {
      roller.shopLatLng ??= await geocode(roller.shopAddr);
      saveRoller();
      changeWaypoints(() => { waypoints[waypoints.length - 1] = { latlng: L.latLng(roller.shopLatLng), text: roller.shop || roller.shopAddr }; });
    } catch (err) { $('rollerDue').textContent = '⚠️ ' + err.message; }
  };
  $('mtList').innerHTML = roller.log.map((e, i) => ({ e, i })).sort((a, b) => (b.e.date > a.e.date) - (b.e.date < a.e.date)).map(({ e, i }) =>
    `<li><span>${new Date(e.date).toLocaleDateString('de-DE')} · ${escapeHtml(e.what)}</span><span>${e.km != null ? e.km.toLocaleString('de-DE') + ' km' : ''}</span><button data-i="${i}" title="Eintrag löschen">✕</button></li>`).join('');
}

$('rollerTechnik').insertAdjacentHTML('beforeend', ROLLER_TECHNIK.map(([k, de, , bsp]) =>
  `<label for="rl_${k}">${de}</label><input id="rl_${k}" type="text" autocomplete="off" spellcheck="false" placeholder="z. B. ${bsp}">`).join(''));
function rollerFill() {
  for (const k of [...ROLLER_TEXT, ...ROLLER_NUM]) $('rl_' + k).value = roller[k] ?? '';
  for (const k of ROLLER_DEZ) $('rl_' + k).value = roller[k] ? String(roller[k]).replace('.', ',') : '';
  $('rollerEdit').open = !roller.model && !roller.odo; // leer: gleich die Eingabefelder zeigen
  rollerRender();
}
for (const k of ROLLER_TEXT) $('rl_' + k).onchange = () => {
  roller[k] = $('rl_' + k).value.trim();
  if (k === 'shopAddr') delete roller.shopLatLng; // neue Adresse neu suchen
  saveRoller(); rollerRender();
};
for (const k of ROLLER_NUM) $('rl_' + k).onchange = () => {
  roller[k] = $('rl_' + k).value === '' ? '' : Math.max(0, Math.round(+$('rl_' + k).value));
  if (k === 'odo') roller.odoDate = new Date().toISOString(); // ab jetzt zählen neue Fahrten dazu
  saveRoller(); rollerRender();
};
// Spritkosten stehen in der Tour-Zusammenfassung; nach einer Änderung dort gleich nachziehen
for (const k of ROLLER_DEZ) $('rl_' + k).onchange = () => {
  const v = parseFloat($('rl_' + k).value.replace(',', '.'));
  const ohne = currentTrip && stageTripText(currentTrip.summary);
  roller[k] = v > 0 ? Math.round(v * 100) / 100 : '';
  $('rl_' + k).value = roller[k] ? String(roller[k]).replace('.', ',') : '';
  saveRoller(); rollerRender(); tankZeigen();
  if (ohne) $('summary').textContent = $('summary').textContent.replace(ohne, stageTripText(currentTrip.summary));
  if (routeCoords) tankPlan();
};
$('mtAdd').onclick = () => {
  const what = $('mtWhat').value.trim();
  if (!what) return;
  const km = $('mtKm').value === '' ? rollerKm() : Math.round(+$('mtKm').value);
  roller.log.push({ date: new Date().toISOString(), km, what });
  // Höherer km-Stand im Eintrag = neuer Tachostand
  if (km != null && km > (rollerKm() ?? -1)) { roller.odo = km; roller.odoDate = new Date().toISOString(); $('rl_odo').value = km; }
  $('mtWhat').value = $('mtKm').value = '';
  saveRoller(); rollerRender();
};
$('mtWhat').onkeydown = e => { if (e.key === 'Enter') $('mtAdd').click(); };
$('mtList').onclick = e => {
  const i = e.target.closest('button')?.dataset.i;
  if (i == null || !confirm(`„${roller.log[i].what}“ löschen?`)) return;
  roller.log.splice(+i, 1); saveRoller(); rollerRender();
};
$('rollerExport').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ app: 'scooterways-roller', version: 1, roller }, null, 1)], { type: 'application/json' }));
  a.download = `scooterways-roller-${new Date().toISOString().slice(0, 10)}.json`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('rollerImport').onchange = async e => {
  try {
    const data = JSON.parse(await e.target.files[0].text());
    if (data?.app !== 'scooterways-roller' || typeof data.roller !== 'object') throw new Error('Keine Scooterways-Rollersicherung');
    roller = { oilEvery: 0, serviceMonths: 12, ...data.roller, log: Array.isArray(data.roller.log) ? data.roller.log : [] };
    saveRoller(); rollerFill();
    $('rollerDue').textContent = '✓ Sicherung geladen. ' + $('rollerDue').textContent;
  } catch (err) { $('rollerDue').textContent = '⚠️ ' + (err instanceof SyntaxError ? 'Datei ist kein gültiges JSON' : err.message); }
  e.target.value = '';
};
rollerFill();
