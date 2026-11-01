// Knopf „anzeigen“ neben jedem Passwortfeld (Admin, Setup): am Handy vertippt man sich leicht.
// Beim Absenden wieder verdeckt, damit der Browser das Feld weiter als Passwort behandelt.
for (const feld of document.querySelectorAll('input[type=password]')) {
  const box = document.createElement('span'), knopf = document.createElement('button');
  box.className = 'pw-feld';
  knopf.type = 'button'; knopf.className = 'pw-auge'; knopf.textContent = '👁';
  knopf.title = 'Passwort anzeigen'; knopf.setAttribute('aria-label', 'Passwort anzeigen'); knopf.setAttribute('aria-pressed', 'false');
  feld.replaceWith(box); box.append(feld, knopf);
  knopf.onclick = () => {
    const zeigen = feld.type === 'password';
    feld.type = zeigen ? 'text' : 'password';
    knopf.setAttribute('aria-pressed', String(zeigen));
    knopf.title = zeigen ? 'Passwort verbergen' : 'Passwort anzeigen';
    knopf.setAttribute('aria-label', knopf.title);
    feld.focus();
  };
  feld.form?.addEventListener('submit', () => { feld.type = 'password'; });
}
