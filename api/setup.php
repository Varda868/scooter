<?php
// Ersteinrichtung: Admin-Passwort und Datenbank. Sperrt sich, sobald ein Passwort gesetzt ist.
// Schutz bis dahin: Einmalcode in setup-code.txt im Datenordner, lesbar nur mit Zugang zum Hosting (Plesk-Dateimanager, FTP).
define('SW_API', 1);
require __DIR__ . '/lib/kern.php';
sw_html_koepfe();

$d = sw_daten(true);
$meldung = '';
function seite(string $inhalt): void {
  echo '<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>Scooterways Setup</title><link rel="stylesheet" href="admin.css"></head><body><main><h1>🛵 Scooterways · Einrichtung</h1>',
    $inhalt, '</main></body></html>';
  exit;
}

if (!$d) {
  http_response_code(500);
  seite('<p class="fehler">Kein beschreibbarer Datenordner außerhalb des Webroots gefunden. Erwartet wird <code>private/scooterways</code> neben dem Ordner der Subdomain. ' .
    'Bitte in Plesk im Ordner <code>private</code> einen Unterordner <code>scooterways</code> anlegen und diese Seite neu laden.</p>');
}
if (sw_eingerichtet()) {
  http_response_code(403);
  seite('<p>Die Einrichtung ist abgeschlossen und gesperrt. <a href="admin.php">Zum Admin-Bereich</a></p>');
}

$codeDatei = "$d/setup-code.txt";
$fehlDatei = "$d/setup-fehler.txt";
if (!is_file($codeDatei)) {
  $code = strtoupper(substr(bin2hex(random_bytes(8)), 0, 12));
  file_put_contents($codeDatei, $code . "\n", LOCK_EX);
  @chmod($codeDatei, 0600);
  @unlink($fehlDatei);
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
  sw_sitzung();
  $fehl = (int)@file_get_contents($fehlDatei);
  $code = trim((string)file_get_contents($codeDatei));
  $pw = (string)($_POST['pw'] ?? '');
  $typ = ($_POST['db'] ?? '') === 'mysql' ? 'mysql' : 'sqlite';
  if (!sw_csrf_ok()) $meldung = 'Formular abgelaufen, bitte noch einmal.';
  elseif (!hash_equals($code, strtoupper(trim((string)($_POST['code'] ?? ''))))) {
    usleep(800000);
    // Nach 10 falschen Codes gibt es einen neuen, Raten lohnt sich nicht
    if (++$fehl >= 10) { @unlink($codeDatei); @unlink($fehlDatei); $meldung = 'Zu viele falsche Codes. Es wurde ein neuer erzeugt.'; }
    else { file_put_contents($fehlDatei, (string)$fehl); $meldung = 'Der Einmalcode stimmt nicht.'; }
  }
  elseif (strlen($pw) < 12) $meldung = 'Das Passwort braucht mindestens 12 Zeichen.';
  elseif ($pw !== ($_POST['pw2'] ?? '')) $meldung = 'Die beiden Passwörter sind verschieden.';
  else {
    $db = ['typ' => $typ];
    if ($typ === 'mysql') foreach (['host', 'name', 'user', 'pass'] as $k) $db[$k] = (string)($_POST["db_$k"] ?? '');
    $c = ['admin_hash' => password_hash($pw, PASSWORD_DEFAULT), 'salz' => bin2hex(random_bytes(16)), 'db' => $db,
      'werte' => SW_STANDARD, 'erstellt' => date('c')];
    try {
      sw_config_speichern($c);
      // Neu laden und Tabellen anlegen; scheitert die Datenbank, wird die Einrichtung zurückgenommen
      $neu = (include "$d/config.php");
      if (($neu['admin_hash'] ?? '') !== $c['admin_hash']) throw new RuntimeException('Konfiguration nicht lesbar');
      (function () use ($c) {
        $o = $c['db'];
        if ($o['typ'] === 'mysql') {
          $p = new PDO("mysql:host={$o['host']};dbname={$o['name']};charset=utf8mb4", $o['user'], $o['pass'], [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
          $p->query('SELECT 1');
        }
      })();
      @unlink($codeDatei); @unlink($fehlDatei);
      header('Location: admin.php?eingerichtet=1', true, 303);
      exit;
    } catch (Throwable $e) {
      @unlink("$d/config.php");
      $meldung = 'Einrichtung fehlgeschlagen: ' . ($typ === 'mysql' ? 'MySQL-Verbindung klappt nicht.' : 'Datenordner nicht beschreibbar.');
    }
  }
}

seite(($meldung ? '<p class="fehler">' . h($meldung) . '</p>' : '') . '
<form method="post" autocomplete="off">
  <input type="hidden" name="csrf" value="' . h(sw_csrf()) . '">
  <p>Den Einmalcode findest du in Plesk im Dateimanager unter <code>private/scooterways/setup-code.txt</code>
     (eine Ebene über dem Ordner der Subdomain).</p>
  <label>Einmalcode <input name="code" required maxlength="20" autocapitalize="characters"></label>
  <label>Admin-Passwort (mind. 12 Zeichen) <input type="password" name="pw" required minlength="12" autocomplete="new-password"></label>
  <label>Passwort wiederholen <input type="password" name="pw2" required minlength="12" autocomplete="new-password"></label>
  <fieldset><legend>Datenbank</legend>
    <label class="zeile"><input type="radio" name="db" value="sqlite" checked> SQLite-Datei im privaten Ordner (nichts anzulegen)</label>
    <label class="zeile"><input type="radio" name="db" value="mysql"> MySQL (vorher in Plesk anlegen)</label>
    <label>Host <input name="db_host" value="localhost"></label>
    <label>Datenbank <input name="db_name"></label>
    <label>Benutzer <input name="db_user"></label>
    <label>Passwort <input type="password" name="db_pass" autocomplete="off"></label>
  </fieldset>
  <button>Einrichten und sperren</button>
</form>');
