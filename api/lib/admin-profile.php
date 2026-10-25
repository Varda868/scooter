<?php
// Admin-Bereich „Profile“: verschlüsselte Profile auf dem Server (nur Größe und Zeiten, Inhalt ist nicht lesbar)
defined('SW_API') || exit;

$BEREICHE['profile'] = ['titel' => 'Profile', 'fn' => 'bereich_profile',
  'zahl' => fn() => sw_db()->query('SELECT COUNT(*) FROM sw_profil')->fetchColumn()];

function bereich_profile(): void {
  global $OK;
  $db = sw_db();
  if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $db->prepare('DELETE FROM sw_profil WHERE id = ?')->execute([(string)($_POST['id'] ?? '')]);
    admin_zurueck('profile', 'Gelöscht.');
  }
  $rows = $db->query('SELECT id, t, abruf, groesse, ip FROM sw_profil ORDER BY t DESC')->fetchAll();
  $summe = array_sum(array_column($rows, 'groesse'));
  $html = admin_hinweis($OK) . '<p>' . count($rows) . ' Profile, zusammen ' . round($summe / 1048576, 1) . ' MB.</p>';
  if ($rows) {
    $html .= '<table><tr><th>Fach</th><th>Gesichert</th><th>Zuletzt abgerufen</th><th>Größe</th><th>Gerät</th><th></th></tr>';
    foreach ($rows as $r) $html .= '<tr><td><code>' . h(substr($r['id'], 0, 10)) . '…</code></td><td>' . admin_zeit((int)$r['t']) . '</td><td>' . ($r['abruf'] ? admin_zeit((int)$r['abruf']) : '–') .
      '</td><td>' . round($r['groesse'] / 1024) . ' kB</td><td>' . h(substr((string)$r['ip'], 0, 6)) . '</td><td><form method="post">' . admin_csrf_feld() .
      '<input type="hidden" name="id" value="' . h($r['id']) . '"><button class="klein">✕</button></form></td></tr>';
    $html .= '</table>';
  }
  admin_seite('Profile', $html . '<p class="leise">Inhalt mit dem Sync-Passwort verschlüsselt (AES-GCM, Schlüssel per PBKDF2 in der App). Nach 365 Tagen ohne Abruf wird ein Profil gelöscht.</p>');
}
