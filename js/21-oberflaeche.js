// --- Oberfläche: Leiste in Reiter gegliedert (Tour, Unterwegs, Entdecker, Roller, Einstellung).
// Am Handy liegt die Leiste unten unter der Karte und lässt sich auf Kopf und Reiter einklappen.
function showTab(name) {
  if (!$('tab-' + name)) name = 'tour';
  document.querySelectorAll('#tabs [data-tab]').forEach(b => {
    const on = b.dataset.tab === name;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on);
  });
  document.querySelectorAll('#panel .tab').forEach(t => { t.hidden = t.id !== 'tab-' + name; });
  $('panel').scrollTop = 0;
  settings.tab = name; store.set('settings', settings);
  setSheet(true);
}
$('tabs').onclick = e => { const b = e.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); };

function setSheet(open) {
  const was = !document.body.classList.contains('sheet-min');
  document.body.classList.toggle('sheet-min', !open);
  $('sheetBtn').textContent = open ? '▾' : '▴';
  $('sheetBtn').setAttribute('aria-expanded', open);
  if (was !== open) setTimeout(() => map.invalidateSize(), 50);
}
$('sheetBtn').onclick = () => setSheet(document.body.classList.contains('sheet-min'));

// Einzelne Bereiche in eigenem Reiter immer offen
$('exploreBox').open = $('rollerBox').open = true;
if (settings.profileBox == null) $('profileBox').open = true;

// Fahrprofil-Kurzfassung auch im Reiter Tour; Antippen führt zu den Einstellungen
const mirrorProfile = () => { $('profileLine').textContent = '⚙ ' + $('profileSummary').textContent; };
new MutationObserver(mirrorProfile).observe($('profileSummary'), { childList: true, characterData: true, subtree: true });
mirrorProfile();
$('profileLine').onclick = () => { showTab('setup'); $('profileBox').open = true; };

// Zähler am Reiter: gefundene POIs und Caches entlang der Route, Hinweis bei fälliger Wartung
function updateBadges() {
  const n = document.querySelectorAll('#pois li, #caches li').length;
  $('tabBadgeUnterwegs').hidden = !n;
  $('tabBadgeUnterwegs').textContent = n > 99 ? '99+' : n;
  $('tabBadgeRoller').hidden = !$('rollerDue').textContent.trim() || $('rollerDue').textContent.startsWith('✓');
}
['pois', 'caches', 'rollerDue'].forEach(id => new MutationObserver(updateBadges).observe($(id), { childList: true, characterData: true, subtree: true }));
updateBadges();

// Verknüpfungen der installierten App (Langdruck aufs Symbol): ?tab=… wählt den Reiter, talk=1 klappt Talk auf
const startParams = new URLSearchParams(location.search);
showTab(startParams.get('tab') || settings.tab || 'tour');
if (startParams.get('talk') === '1') $('talkBox').open = true;
if (location.search) history.replaceState(null, '', location.pathname);

// Als App installieren: Chrome meldet die Möglichkeit, der Knopf im Reiter Einstellung löst sie aus
let installPrompt = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; $('installBtn').hidden = false; });
addEventListener('appinstalled', () => { installPrompt = null; $('installBtn').hidden = true; });
$('installBtn').onclick = async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null; $('installBtn').hidden = true;
};
