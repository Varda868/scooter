// --- Panne: Hilfe in der Nähe. Werkstätten braucht man erst bei einer Panne, und dann vom Standort aus, nicht als
// POI neben der Route. Daten aus den eigenen POI-Kacheln (auch offline), ohne Kacheln über Overpass.
// Oben fest: eigene Nummern aus „Mein Roller“ und der Automobilclub des Landes. Talk: Hilferuf per Sprache, der
// Standort geht dabei nie von selbst offen in die Region.
const PANNE_RADIEN = [10000, 25000, 50000], PANNE_MIN = 5, PANNE_MAX = 10, PANNE_NOT = 3;
// Pannenhilfe der Automobilclubs (ohne Gewähr); 112 gilt überall für Unfall und Verletzte
const PANNE_CLUBS = {
  de: ['ADAC Pannenhilfe', '+49 89 20 20 4000'], at: ['ÖAMTC Pannenhilfe', '120'], ch: ['TCS Pannenhilfe', '140'],
  it: ['ACI Soccorso stradale', '803 116'], nl: ['ANWB Wegenwacht', '+31 88 269 2888'], be: ['Touring Pannenhilfe', '+32 70 344 777'],
  lu: ['ACL Pannenhilfe', '+352 26 000'], cz: ['ÚAMK Pannenhilfe', '1230'], sk: ['SATC Pannenhilfe', '18 124'],
  hu: ['Magyar Autóklub', '188'], si: ['AMZS Pannenhilfe', '1987'], hr: ['HAK Pannenhilfe', '1987'], es: ['RACE Asistencia', '+34 900 112 222'],
};
// Roller-Fachbetrieb vor Motorrad vor Auto: Rang 0, 1, 2
const PANNE_ROLLER = /roller|scooter|moped|mofa|zweirad|vespa|piaggio|kymco|peugeot|aprilia|rieju|kreidler|baotian|\bsym\b|motorini|ciclomotor|bromfiets|brommer|skútr|skuter/i;
function panneRang(t) {
  if (t.shop === 'scooter' || t.shop === 'motorcycle_repair' || t.craft === 'motorcycle_repair' || t['motorcycle:repair'] === 'yes' ||
    ['moped', 'scooter', 'motorcycle'].some(k => t['service:vehicle:' + k] === 'yes') || PANNE_ROLLER.test(`${t.name || ''} ${t.brand || ''} ${t.brands || ''}`)) return 0;
  if (t.shop === 'motorcycle') return 1;
  return t.shop === 'car_repair' ? 2 : -1;
}
// Eigene Marke aus „Mein Roller“ (Modell, z. B. „Piaggio Zip“) bevorzugen
function panneMarke(t) {
  const m = (roller.model || '').toLowerCase(), alle = Object.entries(t).map(([k, v]) => `${k}=${v}`).join(' ').toLowerCase();
  return BRANDS.some(b => { const w = b.toLowerCase(); return m.includes(w) && (alle.includes(w) || (w === 'vespa' && alle.includes('piaggio'))); });
}

const panne = { ort: null, wer: '', req: 0, land: store.get('panneLand', '') };
async function panneStandort() {
  if (pos.fix && Date.now() - pos.fix.t < 120000) return [pos.fix.lat, pos.fix.lon, 'GPS'];
  try {
    const p = await new Promise((ok, err) => navigator.geolocation.getCurrentPosition(ok, err, { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }));
    return [p.coords.latitude, p.coords.longitude, 'GPS'];
  } catch { const c = map.getCenter(); return [c.lat, c.lng, 'Kartenmitte']; }
}
// Land und nächster Ort (für Clubnummer und Hilferuf); offline bleibt das zuletzt bekannte Land
async function panneOrt([la, lo]) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&accept-language=de&lat=${la}&lon=${lo}`, { signal: AbortSignal.timeout(6000) });
    const a = (await r.json()).address || {};
    if (a.country_code) { panne.land = a.country_code; store.set('panneLand', panne.land); }
    return { ort: a.village || a.town || a.city || a.municipality || a.suburb || '', strasse: a.road || '' };
  } catch { return null; }
}

async function panneOeffnen(ort = null, wer = '') {
  const req = ++panne.req;
  panne.wer = wer;
  $('panneTitel').textContent = wer ? `🔧 Panne bei ${wer}` : '🔧 Panne – Hilfe in der Nähe';
  $('panneListe').innerHTML = '';
  $('panneStatus').textContent = 'Suche Standort …';
  $('panneTalk').hidden = true;
  panneFestZeigen();
  if (!$('panneDlg').open) $('panneDlg').showModal();
  const [la, lo, quelle] = ort || await panneStandort();
  if (req !== panne.req) return;
  panne.ort = [la, lo];
  panneSpracheWaehlen();
  panneOrt([la, lo]).then(o => { if (req === panne.req) { panne.adresse = o; panneFestZeigen(); panneTalkZeigen(); panneSpracheWaehlen(); } });
  panneTalkZeigen();
  let liste = [], r = 0;
  for (r of PANNE_RADIEN) {
    $('panneStatus').textContent = `Suche Werkstätten im Umkreis von ${r / 1000} km${ort ? '' : ` (${quelle})`} …`;
    liste = await panneSuchen(la, lo, r).catch(() => null);
    if (req !== panne.req) return;
    if (liste === null) { $('panneStatus').textContent = '⚠️ Werkstätten gerade nicht abrufbar (offline und keine Kacheln?).'; return; }
    if (liste.filter(w => w.rang < 2).length >= PANNE_MIN) break;
  }
  const fach = liste.filter(w => w.rang < 2).sort((a, b) => (a.d + a.rang * 3000 - (a.marke ? 3000 : 0)) - (b.d + b.rang * 3000 - (b.marke ? 3000 : 0))).slice(0, PANNE_MAX);
  const auto = fach.length < PANNE_MIN ? liste.filter(w => w.rang === 2).sort((a, b) => a.d - b.d).slice(0, PANNE_NOT) : [];
  $('panneStatus').textContent = fach.length || auto.length ? `Im Umkreis von ${r / 1000} km, Luftlinie${ort ? '' : ` ab ${quelle}`}:` : `Keine Werkstatt im Umkreis von ${r / 1000} km gefunden.`;
  $('panneListe').innerHTML = [...fach, ...auto].map((w, i) => panneZeile(w, i, i === fach.length && auto.length)).join('');
  panne.liste = [...fach, ...auto];
}
async function panneSuchen(la, lo, r) {
  const els = (await tileElements([[la, lo]], r, t => panneRang(t) >= 0 ? r : 0).catch(() => null))?.elements ?? await panneOverpass(la, lo, r);
  const ky = 110540, kx = 111320 * Math.cos(la * Math.PI / 180);
  return els.map(e => ({ lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon, tags: e.tags || {} }))
    .filter(e => e.lat != null && panneRang(e.tags) >= 0)
    .map(e => ({ ...e, rang: panneRang(e.tags), marke: panneMarke(e.tags), d: Math.hypot((e.lat - la) * ky, (e.lon - lo) * kx) }))
    .filter(e => e.d <= r);
}
async function panneOverpass(la, lo, r) {
  const q = `[out:json][timeout:20];(nwr[shop~"^(motorcycle|motorcycle_repair|scooter|car_repair)$"](around:${r},${la.toFixed(5)},${lo.toFixed(5)});` +
    `nwr[craft=motorcycle_repair](around:${r},${la.toFixed(5)},${lo.toFixed(5)}););out center tags;`;
  return (await overpassFetch(q, () => {}, () => false)).elements || [];
}
function panneZeile(w, i, notTitel) {
  const t = w.tags, offen = offenUm(t, new Date());
  const tel = ['phone', 'contact:phone', 'contact:mobile'].map(k => t[k]).find(Boolean)?.split(';')[0].trim();
  const art = w.rang === 0 ? '🛵' : w.rang === 1 ? '🏍️' : '🚗';
  const adr = [[t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' '), t['addr:city']].filter(Boolean).join(', ');
  return (notTitel ? '<li class="panne-not">Notlösung: Autowerkstätten (manche helfen auch bei Rollern)</li>' : '') +
    `<li><div><b>${art} ${escapeHtml(t.name || (w.rang === 2 ? 'Autowerkstatt' : 'Zweiradwerkstatt'))}</b>${w.marke ? ' ⭐' : ''}` +
    `<span class="hint"> · ${distText(w.d)}${offen === true ? ' · 🟢 jetzt offen' : offen === false ? ' · 🔴 jetzt zu' : ''}</span>` +
    (adr ? `<br><span class="hint">${escapeHtml(adr)}</span>` : '') + '</div>' +
    `<div class="panne-knoepfe">${tel ? `<a class="knopf" href="${telHref(tel)}">📞 ${escapeHtml(tel)}</a>` : ''}<button data-hin="${i}">🧭 hin</button></div></li>`;
}
function panneFestZeigen() {
  const z = [];
  if (roller.assist) z.push(`<a class="knopf" href="${telHref(roller.assist)}">📞 Pannenhilfe${roller.insurer ? ' (' + escapeHtml(roller.insurer) + ')' : ''}</a>`);
  if (roller.shopTel) z.push(`<a class="knopf" href="${telHref(roller.shopTel)}">📞 ${escapeHtml(roller.shop || 'Meine Werkstatt')}</a>`);
  const club = PANNE_CLUBS[panne.land];
  if (club) z.push(`<a class="knopf" href="${telHref(club[1])}">📞 ${club[0]} ${escapeHtml(club[1])}</a>`);
  $('panneFest').innerHTML = z.join('') + '<div class="hint">Bei Unfall oder Verletzten immer <a href="tel:112">112</a> anrufen.' +
    (!roller.assist && !roller.shopTel ? ' Eigene Pannenhilfe und Werkstatt kannst du unter „Mein Roller“ eintragen.' : '') + '</div>';
}
// Hilferuf über Talk: Sprechtaste auf „an alle“, Ort zum Ansagen zeigen. Kein automatischer Standort in die Region.
function panneTalkZeigen() {
  if (panne.wer) return;
  const an = typeof talkPrefs !== 'undefined' && talkPrefs.on, a = panne.adresse;
  const wo = a ? [a.strasse, a.ort && 'bei ' + a.ort].filter(Boolean).join(' ') : '';
  $('panneTalk').hidden = false;
  $('panneTalk').innerHTML = an
    ? `<button id="panneRufen">📢 Hilferuf über Talk${talkPrefs.pw ? ' (an die Gruppe)' : ' (an alle in der Region)'}</button>` +
      `<div class="hint">Taste halten und sagen, z. B.: „Rollerpanne${wo ? ' ' + escapeHtml(wo) : ''}, kann jemand helfen?“ Den genauen Standort gibst du nur selbst weiter.</div>`
    : '<div class="hint">📢 Mit Talk (Einstellung) kannst du andere Rollerfahrer in der Region um Hilfe bitten.</div>';
  if ($('panneRufen')) $('panneRufen').onclick = () => {
    talkAn = null; talkAnZeigen();
    $('panneDlg').close();
    $('talkPtt').scrollIntoView?.({ block: 'center' });
  };
}
$('panneListe').onclick = e => {
  const w = panne.liste?.[+e.target.closest('[data-hin]')?.dataset.hin];
  if (!w) return;
  $('panneDlg').close();
  changeWaypoints(() => waypoints.splice(0, waypoints.length,
    { latlng: L.latLng(panne.ort[0], panne.ort[1]), text: panne.wer ? `Panne ${panne.wer}` : '📍 Pannenort' },
    { latlng: L.latLng(w.lat, w.lon), text: w.tags.name || 'Werkstatt' }));
};
$('panneZu').onclick = () => $('panneDlg').close();
$('panneKnopf').onclick = () => panneOeffnen();
$('navPanne').onclick = () => panneOeffnen();

// ---- Pannensätze in der Landessprache: zeigen (Handy hinhalten) und vorlesen. Fest in der App, also offline und
// ohne Spracherkennung oder Übersetzungsdienst.
const PANNE_SPRACHEN = { de: 'Deutsch', en: 'English', fr: 'Français', it: 'Italiano', es: 'Español', nl: 'Nederlands', pl: 'Polski', cs: 'Čeština', hr: 'Hrvatski' };
const PANNE_LAND_SPRACHE = { de: 'de', at: 'de', ch: 'de', li: 'de', lu: 'de', fr: 'fr', be: 'fr', mc: 'fr', it: 'it', sm: 'it', va: 'it',
  es: 'es', ad: 'es', nl: 'nl', pl: 'pl', cz: 'cs', sk: 'cs', hr: 'hr', ba: 'hr', rs: 'hr', me: 'hr', gb: 'en', ie: 'en', mt: 'en' };
const PANNE_SAETZE = [
  ['Mein Roller springt nicht an.', "My scooter won't start.", 'Mon scooter ne démarre pas.', 'Il mio scooter non parte.', 'Mi scooter no arranca.', 'Mijn scooter start niet.', 'Mój skuter nie chce zapalić.', 'Můj skútr nechce nastartovat.', 'Moj skuter ne pali.'],
  ['Ich habe einen Platten.', 'I have a flat tyre.', "J'ai un pneu crevé.", 'Ho una gomma bucata.', 'Tengo una rueda pinchada.', 'Ik heb een lekke band.', 'Mam przebitą oponę.', 'Mám píchlou pneumatiku.', 'Imam probušenu gumu.'],
  ['Der Antriebsriemen ist gerissen.', 'The drive belt has snapped.', 'La courroie de transmission a cassé.', 'Si è rotta la cinghia di trasmissione.', 'Se ha roto la correa de transmisión.', 'De aandrijfriem is gebroken.', 'Pękł pasek napędowy.', 'Praskl hnací řemen.', 'Pukao je pogonski remen.'],
  ['Ich habe kein Benzin mehr.', "I've run out of petrol.", "Je suis en panne d'essence.", 'Ho finito la benzina.', 'Me he quedado sin gasolina.', 'Mijn benzine is op.', 'Skończyła mi się benzyna.', 'Došel mi benzín.', 'Nestalo mi je benzina.'],
  ['Ich suche eine Werkstatt, die 50-cm³-Roller repariert.', 'I need a workshop that repairs 50 cc scooters.', 'Je cherche un garage qui répare les scooters 50 cm³.', "Cerco un'officina che ripari scooter 50 cc.", 'Busco un taller que repare scooters de 50 cc.', 'Ik zoek een werkplaats die 50cc-scooters repareert.', 'Szukam warsztatu, który naprawia skutery 50 cm³.', 'Hledám servis, který opravuje skútry 50 cm³.', 'Tražim servis koji popravlja skutere od 50 ccm.'],
  ['Können Sie mir heute helfen?', 'Can you help me today?', "Pouvez-vous m'aider aujourd'hui ?", 'Può aiutarmi oggi?', '¿Puede ayudarme hoy?', 'Kunt u mij vandaag helpen?', 'Czy możecie mi dziś pomóc?', 'Můžete mi dnes pomoct?', 'Možete li mi danas pomoći?'],
  ['Was kostet die Reparatur?', 'How much will the repair cost?', 'Combien coûte la réparation ?', 'Quanto costa la riparazione?', '¿Cuánto cuesta la reparación?', 'Wat kost de reparatie?', 'Ile kosztuje naprawa?', 'Kolik stojí oprava?', 'Koliko košta popravak?'],
  ['Wie lange dauert es?', 'How long will it take?', 'Combien de temps cela prend-il ?', 'Quanto tempo ci vuole?', '¿Cuánto tiempo tarda?', 'Hoe lang duurt het?', 'Jak długo to potrwa?', 'Jak dlouho to bude trvat?', 'Koliko će to trajati?'],
  ['Können Sie meinen Roller abschleppen?', 'Can you tow my scooter?', 'Pouvez-vous remorquer mon scooter ?', 'Può rimorchiare il mio scooter?', '¿Puede remolcar mi scooter?', 'Kunt u mijn scooter wegslepen?', 'Czy możecie odholować mój skuter?', 'Můžete odtáhnout můj skútr?', 'Možete li odšlepati moj skuter?'],
  ['Wo ist die nächste Tankstelle?', 'Where is the nearest petrol station?', 'Où est la station-service la plus proche ?', "Dov'è il distributore di benzina più vicino?", '¿Dónde está la gasolinera más cercana?', 'Waar is het dichtstbijzijnde tankstation?', 'Gdzie jest najbliższa stacja benzynowa?', 'Kde je nejbližší čerpací stanice?', 'Gdje je najbliža benzinska postaja?'],
  ['Bitte rufen Sie diese Nummer an.', 'Please call this number.', "Pouvez-vous appeler ce numéro, s'il vous plaît ?", 'Per favore, chiami questo numero.', 'Por favor, llame a este número.', 'Wilt u dit nummer bellen, alstublieft?', 'Proszę zadzwonić pod ten numer.', 'Zavolejte prosím na toto číslo.', 'Molim vas, nazovite ovaj broj.'],
  ['Es gab einen Unfall, niemand ist verletzt.', "There's been an accident, nobody is hurt.", "Il y a eu un accident, personne n'est blessé.", "C'è stato un incidente, nessuno è ferito.", 'Ha habido un accidente, no hay heridos.', 'Er is een ongeluk gebeurd, niemand is gewond.', 'Był wypadek, nikt nie jest ranny.', 'Stala se nehoda, nikdo není zraněn.', 'Dogodila se nesreća, nitko nije ozlijeđen.'],
  ['Spricht hier jemand Deutsch oder Englisch?', 'Does anyone here speak German?', "Quelqu'un parle allemand ou anglais ici ?", 'Qualcuno qui parla tedesco o inglese?', '¿Alguien aquí habla alemán o inglés?', 'Spreekt iemand hier Duits of Engels?', 'Czy ktoś tu mówi po niemiecku albo po angielsku?', 'Mluví tu někdo německy nebo anglicky?', 'Govori li netko ovdje njemački ili engleski?'],
];
const PANNE_SP_IDX = Object.keys(PANNE_SPRACHEN);
function panneSaetzeZeigen() {
  const sp = $('panneSprache').value, i = PANNE_SP_IDX.indexOf(sp);
  $('panneSaetze').innerHTML = PANNE_SAETZE.map((s, k) => `<li data-satz="${k}"><b>${escapeHtml(s[i])}</b>${sp !== 'de' ? `<br><span class="hint">${escapeHtml(s[0])}</span>` : ''}</li>`).join('');
}
$('panneSprache').innerHTML = Object.entries(PANNE_SPRACHEN).map(([k, n]) => `<option value="${k}">${n}</option>`).join('');
$('panneSprache').onchange = panneSaetzeZeigen;
// Landessprache aus dem Standort, sonst die erste Fremdsprache
function panneSpracheWaehlen() {
  $('panneSprache').value = PANNE_LAND_SPRACHE[panne.land] || 'en';
  panneSaetzeZeigen();
}
$('panneSaetze').onclick = e => {
  const k = e.target.closest('[data-satz]')?.dataset.satz;
  if (k == null) return;
  const sp = $('panneSprache').value, text = PANNE_SAETZE[k][PANNE_SP_IDX.indexOf(sp)];
  $('panneGross').textContent = text;
  $('panneGrossKlein').textContent = sp !== 'de' ? PANNE_SAETZE[k][0] : '';
  $('panneGrossBox').hidden = false;
  panneVorlesen(text, sp);
};
$('panneGrossBox').onclick = e => { if (e.target.id === 'panneNochmal') panneVorlesen($('panneGross').textContent, $('panneSprache').value); else $('panneGrossBox').hidden = true; };
function panneVorlesen(text, sp) {
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = sp; u.rate = 0.9;
    u.voice = speechSynthesis.getVoices().find(v => v.lang.toLowerCase().startsWith(sp)) || null;
    speechSynthesis.speak(u);
  } catch {}
}
