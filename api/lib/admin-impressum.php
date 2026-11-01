<?php
// Admin-Bereich „Impressum“: Name, Anschrift und Kontaktmail für Impressum und Datenschutzerklärung.
// Nur in config.php im privaten Ordner, nie im Repo. Fehlt etwas, warnt die Übersicht.
defined('SW_API') || exit;

$BEREICHE['impressum'] = ['titel' => 'Impressum', 'fn' => 'bereich_impressum'];

const IMPRESSUM_FELDER = ['impressum_name' => 'Name', 'impressum_anschrift' => 'Anschrift (Straße, PLZ Ort, Land)', 'impressum_email' => 'E-Mail für Kontakt und Datenschutzanfragen'];
function impressum_fehlt(): bool {
  foreach (IMPRESSUM_FELDER as $k => $_) if (trim((string)sw_wert($k)) === '') return true;
  return false;
}
function bereich_impressum(): void {
  global $OK;
  $c = sw_config(); $w = $c['werte']; $fehler = null;
  if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $neu = [
      'impressum_name' => mb_substr(trim((string)($_POST['impressum_name'] ?? '')), 0, 120),
      'impressum_anschrift' => mb_substr(trim(str_replace("\r", '', (string)($_POST['impressum_anschrift'] ?? ''))), 0, 400),
      'impressum_email' => trim((string)($_POST['impressum_email'] ?? '')),
    ];
    if ($neu['impressum_email'] !== '' && !filter_var($neu['impressum_email'], FILTER_VALIDATE_EMAIL)) $fehler = 'Die E-Mail-Adresse ist ungültig.';
    else { $c['werte'] = array_merge($w, $neu); sw_config_speichern($c); admin_zurueck('impressum', 'Gespeichert.'); }
    $w = array_merge($w, $neu);
  }
  $html = admin_hinweis($OK, $fehler);
  if (impressum_fehlt()) $html .= '<p class="banner">⚠️ Impressum unvollständig: Die Seiten Impressum und Datenschutz zeigen dann statt der Angaben nur einen Hinweis.</p>';
  $html .= '<form method="post">' . admin_csrf_feld() .
    '<label>' . IMPRESSUM_FELDER['impressum_name'] . ' <input name="impressum_name" value="' . h($w['impressum_name']) . '" autocomplete="name"></label>' .
    '<label>' . IMPRESSUM_FELDER['impressum_anschrift'] . ' <textarea name="impressum_anschrift" rows="3" autocomplete="street-address">' . h($w['impressum_anschrift']) . '</textarea></label>' .
    '<label>' . IMPRESSUM_FELDER['impressum_email'] . ' <input type="email" name="impressum_email" value="' . h($w['impressum_email']) . '" autocomplete="email"></label>' .
    '<button>Speichern</button></form><p class="leise">Steht nur in config.php im privaten Ordner, nicht im Repo. Öffentlich sichtbar auf <a href="../impressum.html" target="_blank" rel="noopener">impressum.html</a> und <a href="../datenschutz.html" target="_blank" rel="noopener">datenschutz.html</a>.</p>';
  admin_seite('Impressum', $html);
}
