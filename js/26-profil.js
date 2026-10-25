// --- Profil sichern und übertragen: alles aus localStorage (scooterways.*) plus gefahrene Touren (IndexedDB) als eine JSON-Datei.
// Zwischenspeicher (POI-Cache, Offline-Karte) bleiben draußen. Schlüssel nur auf Wunsch, dann deutlich gekennzeichnet.
const PROFIL_APP = 'scooterways-profil', PROFIL_PREFIX = 'scooterways.';
const PROFIL_CACHE = ['poiCache', 'vectorMapHeader', 'vectorMapStand'];
// Geheimnisse: [Speicher-Schlüssel, Feld im Objekt oder null für den ganzen Eintrag]
const PROFIL_GEHEIM = [['tomtom', 'key'], ['opencaching', 'key'], ['talk', 'pw'], ['talkSk', null]];

function profilDaten(mitSchluessel) {
  const daten = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k?.startsWith(PROFIL_PREFIX) || PROFIL_CACHE.includes(k.slice(PROFIL_PREFIX.length))) continue;
    daten[k.slice(PROFIL_PREFIX.length)] = localStorage.getItem(k);
  }
  if (!mitSchluessel) for (const [k, feld] of PROFIL_GEHEIM) {
    if (!(k in daten)) continue;
    if (!feld) { delete daten[k]; continue; }
    try { const o = JSON.parse(daten[k]); delete o[feld]; daten[k] = JSON.stringify(o); } catch {}
  }
  return daten;
}

async function profilDatei() {
  const mit = $('profilSchluessel').checked;
  let fahrten = [];
  try { fahrten = (await rideTx('readonly', st => st.getAll())) || []; } catch {}
  const inhalt = { app: PROFIL_APP, version: 1, erstellt: new Date().toISOString(), enthaeltSchluessel: mit, daten: profilDaten(mit), fahrten };
  const tag = new Date().toISOString().slice(0, 10);
  return new File([JSON.stringify(inhalt)], `scooterways-profil-${tag}${mit ? '-MIT-SCHLUESSELN' : ''}.json`, { type: 'application/json' });
}

$('profilSchluessel').onchange = () => { $('profilWarnung').hidden = !$('profilSchluessel').checked; };
$('profilExport').onclick = async () => {
  const f = await profilDatei(), a = document.createElement('a');
  a.href = URL.createObjectURL(f); a.download = f.name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  $('profilStatus').textContent = `💾 ${f.name} (${Math.ceil(f.size / 1024)} kB) gespeichert`;
};
// Android: Teilen-Menü (Nearby Share, Mail an sich selbst …) statt Umweg über den Download-Ordner
$('profilTeilen').hidden = !navigator.canShare?.({ files: [new File(['{}'], 'x.json', { type: 'application/json' })] });
$('profilTeilen').onclick = async () => {
  const f = await profilDatei();
  try { await navigator.share({ files: [f], title: 'Scooterways-Profil' }); } catch {}
};

$('profilImport').onchange = async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  let inhalt;
  try { inhalt = JSON.parse(await f.text()); } catch { $('profilStatus').textContent = '⚠️ Keine lesbare Profildatei'; return; }
  if (inhalt?.app !== PROFIL_APP || typeof inhalt.daten !== 'object') { $('profilStatus').textContent = '⚠️ Das ist keine Scooterways-Profildatei'; return; }
  const n = Object.keys(inhalt.daten).length, fahrten = Array.isArray(inhalt.fahrten) ? inhalt.fahrten : [];
  if (!confirm(`Profil vom ${new Date(inhalt.erstellt).toLocaleString('de-DE')} laden?\n${n} Einträge, ${fahrten.length} Touren` +
    `${inhalt.enthaeltSchluessel ? ', mit Schlüsseln' : ''}.\n\nDas ersetzt das Profil in diesem Browser. Schlüssel, die nicht in der Datei stehen, bleiben erhalten.`)) return;
  // Hier vorhandene Geheimnisse merken, damit eine Datei ohne Schlüssel sie nicht löscht
  const alt = {};
  for (const [k, feld] of PROFIL_GEHEIM) {
    const v = localStorage.getItem(PROFIL_PREFIX + k);
    if (v == null) continue;
    try { alt[k] = feld ? JSON.parse(v)[feld] : v; } catch {}
  }
  for (const k of Object.keys(localStorage)) if (k.startsWith(PROFIL_PREFIX) && !PROFIL_CACHE.includes(k.slice(PROFIL_PREFIX.length))) localStorage.removeItem(k);
  for (const [k, v] of Object.entries(inhalt.daten)) if (typeof v === 'string') localStorage.setItem(PROFIL_PREFIX + k, v);
  for (const [k, feld] of PROFIL_GEHEIM) {
    if (alt[k] == null) continue;
    const v = localStorage.getItem(PROFIL_PREFIX + k);
    if (!feld) { if (v == null) localStorage.setItem(PROFIL_PREFIX + k, alt[k]); continue; }
    let o = {};
    try { o = JSON.parse(v) || {}; } catch {}
    if (!o[feld]) { o[feld] = alt[k]; localStorage.setItem(PROFIL_PREFIX + k, JSON.stringify(o)); }
  }
  try {
    await rideTx('readwrite', st => { st.clear(); for (const r of fahrten) st.put(r); });
  } catch { alert('Touren konnten nicht übernommen werden, der Rest schon.'); }
  location.reload();
};

// --- Kurzanleitung und Hinweis beim ersten Start (und jederzeit unter ⚙ Einstellung)
$('introOk').onclick = () => { store.set('intro', 1); $('intro').close(); };
$('introAuf').onclick = () => $('intro').showModal();
if (!store.get('intro', 0)) $('intro').showModal();
