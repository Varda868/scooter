// Impressum-Angaben (Name, Anschrift, Kontaktmail) kommen vom Server (api/impressum.php, Admin → Impressum),
// weil das Repo öffentlich ist. Zweitadressen fragen wie die App bei der Stammadresse.
const ZWEIT = ['scooterways.dns.navy', 'www.scooterways.dns.navy'];
const API = ZWEIT.includes(location.hostname) ? 'https://scooter.thai-klasse.de/api/' : new URL('api/', location.href).href;
(async () => {
  let d = null;
  try { const res = await fetch(API + 'impressum.php', { cache: 'no-store' }); if (res.ok) d = await res.json(); } catch {}
  for (const el of document.querySelectorAll('[data-impressum]')) {
    const feld = el.dataset.impressum;
    if (!d || d.leer) { el.textContent = 'Angaben werden gerade nicht geladen. Bitte später noch einmal versuchen.'; el.classList.add('fehlt'); continue; }
    if (feld === 'email') { const a = document.createElement('a'); a.href = 'mailto:' + d.email; a.textContent = d.email; el.replaceChildren(a); }
    else el.textContent = feld === 'kontakt' ? `${d.name}\n${d.anschrift}` : d[feld];
  }
})();
