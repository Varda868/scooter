<?php
// Admin-Bereich „Push“: angemeldete Geräte je Gruppe (nur Kennung, kein Passwort, kein Inhalt), einzeln oder je Gruppe löschen
defined('SW_API') || exit;

$BEREICHE['push'] = ['titel' => 'Push-Abos', 'fn' => 'bereich_push',
  'zahl' => fn() => sw_db()->query('SELECT COUNT(*) FROM sw_push')->fetchColumn()];

function bereich_push(): void {
  global $OK;
  $db = sw_db();
  if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    if (isset($_POST['gruppe'])) $db->prepare('DELETE FROM sw_push WHERE gruppe = ?')->execute([(string)$_POST['gruppe']]);
    else $db->prepare('DELETE FROM sw_push WHERE id = ?')->execute([(int)($_POST['id'] ?? 0)]);
    admin_zurueck('push', 'Gelöscht.');
  }
  $rows = $db->query('SELECT id, gruppe, art, endpoint, name, t, zuletzt, fehler FROM sw_push ORDER BY art, gruppe, t')->fetchAll();
  $html = admin_hinweis($OK);
  if (!$rows) $html .= '<p>Keine Push-Abos.</p>';
  $gruppen = [];
  foreach ($rows as $r) $gruppen[$r['gruppe']][] = $r;
  foreach ($gruppen as $g => $liste) {
    $html .= '<h2>' . ($liste[0]['art'] === 'post' ? 'Postfach' : 'Gruppe') . ' <code>' . h(substr($g, 0, 12)) . '…</code> · ' . count($liste) . ' Geräte</h2><table><tr><th>Name</th><th>Dienst</th><th>Angemeldet</th><th>Zuletzt</th><th>Fehler</th><th></th></tr>';
    foreach ($liste as $r) $html .= '<tr><td>' . h($r['name'] ?: '–') . '</td><td>' . h(parse_url($r['endpoint'], PHP_URL_HOST)) . '</td><td>' . admin_zeit((int)$r['t']) .
      '</td><td>' . ($r['zuletzt'] ? admin_zeit((int)$r['zuletzt']) : '–') . '</td><td>' . (int)$r['fehler'] . '</td><td><form method="post">' . admin_csrf_feld() .
      '<input type="hidden" name="id" value="' . (int)$r['id'] . '"><button class="klein">✕</button></form></td></tr>';
    $html .= '</table><form method="post">' . admin_csrf_feld() . '<input type="hidden" name="gruppe" value="' . h($g) . '"><button class="gefahr">' . ($liste[0]['art'] === 'post' ? 'Postfach löschen' : 'Ganze Gruppe löschen') . '</button></form>';
  }
  admin_seite('Push-Abos', $html . '<p class="leise">Ein Gerät kann zweimal auftauchen: in seiner Gruppe (Halt, Treffpunkt, Kurznachricht; Kennung aus dem Gruppen-Passwort) und in seinem Postfach (Sprachpost; Kennung aus dem Talk-Schlüssel). Passwort und Inhalt kennt der Server nicht.</p>');
}
