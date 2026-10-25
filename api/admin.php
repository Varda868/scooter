<?php
// Admin-Bereich für den PC: Schlüssel und Endpunkte, Fehlerberichte, Passwort.
// Weitere Bereiche (Push-Abos, Kurzlinks …) liegen als lib/admin-*.php daneben und tragen sich in $BEREICHE ein.
define('SW_API', 1);
require __DIR__ . '/lib/kern.php';
sw_html_koepfe();

if (!sw_eingerichtet()) { header('Location: setup.php', true, 303); exit; }
sw_sitzung();

function admin_seite(string $titel, string $inhalt, bool $menue = true): void {
  global $BEREICHE;
  echo '<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>Scooterways Admin</title><link rel="stylesheet" href="admin.css"></head><body>';
  if ($menue) {
    echo '<nav><b>🛵 Admin</b>';
    foreach ($BEREICHE as $k => $b) echo ' <a href="?s=' . h($k) . '"' . (($_GET['s'] ?? 'start') === $k ? ' aria-current="page"' : '') . '>' . h($b['titel']) . '</a>';
    echo '<form method="post" action="?s=abmelden" class="rechts"><input type="hidden" name="csrf" value="' . h(sw_csrf()) . '"><button class="klein">Abmelden</button></form></nav>';
  }
  echo '<main><h1>' . h($titel) . '</h1>', $inhalt, '</main></body></html>';
  exit;
}
function admin_hinweis(?string $ok, ?string $fehler = null): string {
  return ($ok ? '<p class="ok">' . h($ok) . '</p>' : '') . ($fehler ? '<p class="fehler">' . h($fehler) . '</p>' : '');
}
function admin_csrf_feld(): string { return '<input type="hidden" name="csrf" value="' . h(sw_csrf()) . '">'; }
function admin_zeit(int $t): string { return date('d.m.Y H:i', $t); } // Serverzeit, in Plesk auf Europe/Berlin

// --- Anmelden ---
if (!sw_admin()) {
  $m = '';
  if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    if (!sw_csrf_ok()) $m = 'Formular abgelaufen, bitte noch einmal.';
    elseif (sw_login_gesperrt()) $m = 'Zu viele Fehlversuche. Bitte 15 Minuten warten.';
    elseif (sw_anmelden((string)($_POST['pw'] ?? ''))) { header('Location: admin.php', true, 303); exit; }
    else $m = 'Passwort falsch.';
  }
  $BEREICHE = [];
  admin_seite('Anmelden', admin_hinweis(isset($_GET['eingerichtet']) ? 'Einrichtung abgeschlossen, das Setup ist jetzt gesperrt.' : null, $m ?: null) .
    '<form method="post">' . admin_csrf_feld() . '<label>Passwort <input type="password" name="pw" required autofocus autocomplete="current-password"></label><button>Anmelden</button></form>', false);
}

// POST nur mit gültigem CSRF-Token
if ($_SERVER['REQUEST_METHOD'] === 'POST' && !sw_csrf_ok()) { http_response_code(400); $BEREICHE = []; admin_seite('Fehler', admin_hinweis(null, 'Formular abgelaufen. Bitte Seite neu laden.')); }
if (($_GET['s'] ?? '') === 'abmelden' && $_SERVER['REQUEST_METHOD'] === 'POST') { sw_abmelden(); header('Location: admin.php', true, 303); exit; }
function admin_zurueck(string $s, string $ok = ''): void { header('Location: admin.php?s=' . rawurlencode($s) . ($ok ? '&ok=' . rawurlencode($ok) : ''), true, 303); exit; }
$OK = isset($_GET['ok']) ? substr((string)$_GET['ok'], 0, 120) : null;

$BEREICHE = [
  'start' => ['titel' => 'Übersicht', 'fn' => 'bereich_start'],
  'werte' => ['titel' => 'Schlüssel & Endpunkte', 'fn' => 'bereich_werte'],
  'fehler' => ['titel' => 'Fehlerberichte', 'fn' => 'bereich_fehler'],
];
foreach (glob(__DIR__ . '/lib/admin-*.php') as $f) require $f;
$BEREICHE['passwort'] = ['titel' => 'Passwort', 'fn' => 'bereich_passwort'];

function bereich_start(): void {
  global $BEREICHE, $OK;
  $db = sw_db();
  $zahlen = '<li>Fehlerberichte: ' . (int)$db->query('SELECT COUNT(*) FROM sw_fehler')->fetchColumn() . '</li>';
  foreach ($BEREICHE as $b) if (isset($b['zahl'])) $zahlen .= '<li>' . h($b['titel']) . ': ' . (int)($b['zahl'])() . '</li>';
  admin_seite('Übersicht', admin_hinweis($OK) . '<ul>' . $zahlen . '</ul><p class="leise">PHP ' . h(PHP_VERSION) . ' · Datenbank ' .
    (sw_mysql() ? 'MySQL' : 'SQLite') . ' · eingerichtet ' . h(sw_config()['erstellt'] ?? '?') . '</p>');
}

// Endpunkte und Schlüssel. Schlüssel werden nie angezeigt, nur ob einer gesetzt ist.
const ADMIN_URLS = ['valhalla_url' => 'Valhalla (Routing)', 'photon_url' => 'Photon (Ortssuche)', 'open_meteo_url' => 'Open-Meteo (Wetter)'];
const ADMIN_SCHLUESSEL = ['tomtom_key' => 'TomTom-Schlüssel (Verkehr)'];
function admin_url_ok(string $u): bool { return (bool)preg_match('~^https://[a-z0-9.-]+(:\d+)?(/[^\s<>"]*)?$~i', $u); }
function bereich_werte(): void {
  global $OK;
  $c = sw_config(); $w = $c['werte']; $fehler = [];
  if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    foreach (ADMIN_URLS as $k => $_) {
      $u = trim((string)($_POST[$k] ?? ''));
      if (admin_url_ok($u)) $w[$k] = $u; else $fehler[] = ADMIN_URLS[$k] . ': nur https-Adressen';
    }
    $listen = ['overpass_urls' => 'Overpass', 'origins' => 'Erlaubte Herkunft'];
    foreach ($listen as $k => $name) {
      $l = array_values(array_filter(array_map('trim', preg_split('/\R/', (string)($_POST[$k] ?? '')))));
      $bad = array_filter($l, fn($u) => !admin_url_ok($u) || ($k === 'origins' && !preg_match('~^https://[a-z0-9.-]+(:\d+)?$~i', $u)));
      if (!$l || $bad) $fehler[] = "$name: mindestens eine gültige https-Adresse" . ($k === 'origins' ? ' ohne Pfad' : '');
      else $w[$k] = $l;
    }
    foreach (ADMIN_SCHLUESSEL as $k => $_) {
      if (!empty($_POST["{$k}_weg"])) $w[$k] = '';
      elseif (($neu = trim((string)($_POST[$k] ?? ''))) !== '') {
        if (preg_match('/^[\x21-\x7e]{8,200}$/', $neu)) $w[$k] = $neu; else $fehler[] = ADMIN_SCHLUESSEL[$k] . ': Zeichen ungültig';
      }
    }
    if (!$fehler) { $c['werte'] = $w; sw_config_speichern($c); admin_zurueck('werte', 'Gespeichert.'); }
  }
  $html = admin_hinweis($OK, $fehler ? implode(' · ', $fehler) : null) . '<form method="post">' . admin_csrf_feld();
  foreach (ADMIN_URLS as $k => $name) $html .= '<label>' . h($name) . ' <input name="' . $k . '" value="' . h($w[$k]) . '" required></label>';
  $html .= '<label>Overpass-Server (einer pro Zeile) <textarea name="overpass_urls" rows="3">' . h(implode("\n", $w['overpass_urls'])) . '</textarea></label>';
  $html .= '<label>Erlaubte Herkunft (Origin) für die API <textarea name="origins" rows="2">' . h(implode("\n", $w['origins'])) . '</textarea></label>';
  foreach (ADMIN_SCHLUESSEL as $k => $name) {
    $gesetzt = $w[$k] !== '';
    $html .= '<label>' . h($name) . ' <span class="leise">' . ($gesetzt ? 'gesetzt (…' . h(substr($w[$k], -4)) . ')' : 'nicht gesetzt') . '</span>' .
      '<input type="password" name="' . $k . '" placeholder="' . ($gesetzt ? 'leer lassen = unverändert' : 'neuen Schlüssel eingeben') . '" autocomplete="off"></label>' .
      ($gesetzt ? '<label class="zeile"><input type="checkbox" name="' . $k . '_weg" value="1"> Schlüssel löschen</label>' : '');
  }
  admin_seite('Schlüssel & Endpunkte', $html . '<button>Speichern</button></form><p class="leise">Die Werte liegen in config.php im privaten Ordner, nicht im Repo.</p>');
}

function bereich_fehler(): void {
  global $OK;
  $db = sw_db();
  if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    if (isset($_POST['alle'])) $db->exec('DELETE FROM sw_fehler');
    else $db->prepare('DELETE FROM sw_fehler WHERE id = ?')->execute([(int)($_POST['id'] ?? 0)]);
    admin_zurueck('fehler', 'Gelöscht.');
  }
  if (isset($_GET['id'])) {
    $q = $db->prepare('SELECT * FROM sw_fehler WHERE id = ?'); $q->execute([(int)$_GET['id']]);
    $r = $q->fetch();
    if (!$r) admin_zurueck('fehler');
    admin_seite('Fehlerbericht #' . (int)$r['id'], '<p class="leise">' . admin_zeit((int)$r['t']) . ' · ' . h($r['version']) . ' · ' . h($r['ua']) . ' · Gerät ' . h(substr($r['ip'], 0, 6)) . '</p>' .
      '<pre>' . h($r['text']) . '</pre><form method="post">' . admin_csrf_feld() . '<input type="hidden" name="id" value="' . (int)$r['id'] . '"><button class="gefahr">Löschen</button></form>' .
      '<p><a href="?s=fehler">← alle Berichte</a></p>');
  }
  $rows = $db->query('SELECT id, t, version, ua, ip, SUBSTR(text, 1, 140) AS anfang FROM sw_fehler ORDER BY id DESC LIMIT 200')->fetchAll();
  $html = admin_hinweis($OK);
  if (!$rows) $html .= '<p>Keine Berichte.</p>';
  else {
    $html .= '<table><tr><th>Zeit</th><th>Version</th><th>Anfang</th><th></th></tr>';
    foreach ($rows as $r) $html .= '<tr><td>' . admin_zeit((int)$r['t']) . '</td><td>' . h($r['version']) . '</td><td><a href="?s=fehler&amp;id=' . (int)$r['id'] . '">' .
      h($r['anfang']) . '</a></td><td><form method="post">' . admin_csrf_feld() . '<input type="hidden" name="id" value="' . (int)$r['id'] . '"><button class="klein">✕</button></form></td></tr>';
    $html .= '</table><form method="post">' . admin_csrf_feld() . '<input type="hidden" name="alle" value="1"><button class="gefahr">Alle löschen</button></form>';
  }
  admin_seite('Fehlerberichte', $html . '<p class="leise">Berichte werden nach 30 Tagen automatisch gelöscht, höchstens 1000 bleiben.</p>');
}

function bereich_passwort(): void {
  global $OK;
  $m = null;
  if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $c = sw_config(); $neu = (string)($_POST['neu'] ?? '');
    if (sw_login_gesperrt()) $m = 'Zu viele Fehlversuche. Bitte 15 Minuten warten.';
    elseif (!password_verify((string)($_POST['alt'] ?? ''), $c['admin_hash'])) { sw_login_fehlschlag(); $m = 'Das bisherige Passwort stimmt nicht.'; }
    elseif (strlen($neu) < 12) $m = 'Das neue Passwort braucht mindestens 12 Zeichen.';
    elseif ($neu !== ($_POST['neu2'] ?? '')) $m = 'Die beiden neuen Passwörter sind verschieden.';
    else {
      $c['admin_hash'] = password_hash($neu, PASSWORD_DEFAULT); sw_config_speichern($c);
      // Alle anderen Sitzungen ungültig machen: Sitzungsdateien löschen, diese neu anlegen
      foreach (glob(sw_daten() . '/sitzungen/sess_*') as $f) if (basename($f) !== 'sess_' . session_id()) @unlink($f);
      session_regenerate_id(true);
      admin_zurueck('passwort', 'Passwort geändert. Andere Sitzungen sind abgemeldet.');
    }
  }
  admin_seite('Passwort ändern', admin_hinweis($OK, $m) . '<form method="post">' . admin_csrf_feld() .
    '<label>Bisheriges Passwort <input type="password" name="alt" required autocomplete="current-password"></label>' .
    '<label>Neues Passwort (mind. 12 Zeichen) <input type="password" name="neu" required minlength="12" autocomplete="new-password"></label>' .
    '<label>Wiederholen <input type="password" name="neu2" required minlength="12" autocomplete="new-password"></label><button>Ändern</button></form>');
}

$s = $_GET['s'] ?? 'start';
($BEREICHE[$s] ?? $BEREICHE['start'])['fn']();
