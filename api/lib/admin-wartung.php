<?php
// Admin-Bereich „Wartung“: Adressen für geplante Aufgaben in Plesk und wie der letzte Lauf ausging
defined('SW_API') || exit;
require_once __DIR__ . '/wartung.php';

$BEREICHE['wartung'] = ['titel' => 'Wartung', 'fn' => 'bereich_wartung'];

function bereich_wartung(): void {
  $basis = 'https://' . ($_SERVER['HTTP_HOST'] ?? 'scooter.thai-klasse.de') . dirname($_SERVER['SCRIPT_NAME']) . '/wartung.php?k=' . relay_token() . '&was=';
  $html = '<p>In Plesk unter <b>Geplante Aufgaben</b> je Zeile eine Aufgabe anlegen: Aufgabentyp <b>URL abrufen</b>, Ausführen <b>Cron-Stil</b>, ' .
    'Benachrichtigen <b>Nur Fehler</b>. Bei einem Problem antwortet die Adresse mit einem Fehler, und Plesk schickt eine Mail.</p>' .
    '<table><tr><th>Aufgabe</th><th>Zeitplan</th><th>Letzter Lauf</th></tr>';
  foreach (WARTUNG_PLAN as $was => [$cron, $text]) {
    $s = wartung_stand($was);
    $html .= '<tr><td><b>' . h($text) . '</b><pre>' . h($basis . $was) . '</pre></td><td><code>' . h($cron) . '</code></td><td>' .
      ($s ? admin_zeit((int)$s['t']) . '<br>' . ($s['ok'] ? '✅ ok' : '❌ ' . h((string)$s['p'])) : '<span class="leise">noch nie</span>') . '</td></tr>';
  }
  $html .= '</table><p class="leise">„relays“ ersetzt die Adresse relaypruefung.php aus dem Bereich Relays (gleiches Token). Neues Token dort über „Neue Cron-Adresse“; danach alle Aufgaben in Plesk anpassen.</p>';
  admin_seite('Wartung', $html);
}
