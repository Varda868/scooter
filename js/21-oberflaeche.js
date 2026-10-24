// --- Oberfläche: Leiste in Reiter gegliedert (Tour, Unterwegs, Entdecker, Roller, Einstellung).
// Am Handy liegt die Leiste unten unter der Karte und lässt sich auf Kopf und Reiter einklappen,
// auf Tablet und PC links und lässt sich auf eine schmale Spalte mit den Reitern einklappen.
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
  $('sheetBtn').textContent = innerWidth > 700 ? (open ? '◂' : '▸') : open ? '▾' : '▴';
  $('sheetBtn').setAttribute('aria-expanded', open);
  if (was !== open) setTimeout(() => map.invalidateSize(), 50);
}
$('sheetBtn').onclick = () => setSheet(document.body.classList.contains('sheet-min'));
matchMedia('(max-width:700px)').addEventListener('change', () => setSheet(!document.body.classList.contains('sheet-min')));

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

showTab(settings.tab || 'tour');
