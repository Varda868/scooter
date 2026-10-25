<?php
// Admin-Bereich „Kurzlinks“: alle Tour-Links mit Ablauf und Abrufen, einzeln oder abgelaufene löschen
defined('SW_API') || exit;

$BEREICHE['kurz'] = ['titel' => 'Kurzlinks', 'fn' => 'bereich_kurz',
  'zahl' => fn() => sw_db()->query('SELECT COUNT(*) FROM sw_kurz')->fetchColumn()];

function bereich_kurz(): void {
  global $OK;
  $db = sw_db();
  if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    if (isset($_POST['abgelaufen'])) $db->prepare('DELETE FROM sw_kurz WHERE bis < ?')->execute([time()]);
    else $db->prepare('DELETE FROM sw_kurz WHERE id = ?')->execute([(string)($_POST['id'] ?? '')]);
    admin_zurueck('kurz', 'Gelöscht.');
  }
  $rows = $db->query('SELECT id, t, bis, abrufe, daten FROM sw_kurz ORDER BY t DESC LIMIT 300')->fetchAll();
  $basis = (sw_wert('origins')[0] ?? '') . '/t/';
  $html = admin_hinweis($OK);
  if (!$rows) $html .= '<p>Keine Kurzlinks.</p>';
  else {
    $html .= '<table><tr><th>Link</th><th>Tour</th><th>Erstellt</th><th>Läuft ab</th><th>Abrufe</th><th></th></tr>';
    foreach ($rows as $r) {
      $t = json_decode($r['daten'], true) ?: [];
      $w = $t['waypoints'] ?? [];
      $was = $t['name'] ?: (($w[0]['text'] ?? '?') . ' → ' . (end($w)['text'] ?? '?'));
      $html .= '<tr' . ($r['bis'] < time() ? ' class="leise"' : '') . '><td><a href="' . h($basis . $r['id']) . '" target="_blank" rel="noopener">' . h($r['id']) . '</a></td><td>' .
        h(mb_substr($was, 0, 80)) . ' <span class="leise">(' . count($w) . ' Punkte)</span></td><td>' . admin_zeit((int)$r['t']) . '</td><td>' . admin_zeit((int)$r['bis']) .
        '</td><td>' . (int)$r['abrufe'] . '</td><td><form method="post">' . admin_csrf_feld() . '<input type="hidden" name="id" value="' . h($r['id']) . '"><button class="klein">✕</button></form></td></tr>';
    }
    $html .= '</table><form method="post">' . admin_csrf_feld() . '<input type="hidden" name="abgelaufen" value="1"><button class="gefahr">Abgelaufene löschen</button></form>';
  }
  admin_seite('Kurzlinks', $html);
}
