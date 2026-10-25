<?php
// Gemeinsamer Kern der Server-Funktionen: Datenordner, Konfiguration, Datenbank, Drosselung, Sitzung.
// Das Repo ist öffentlich: hier stehen keine Schlüssel. Alles Geheime liegt im Datenordner außerhalb des Webroots.
defined('SW_API') || exit;

const SW_SCHEMA = 1;
const SW_ADMIN_COOKIE = '__Host-swadmin';
const SW_SITZUNG_S = 1800; // Admin-Sitzung läuft nach 30 min ohne Klick ab

error_reporting(E_ALL);
ini_set('display_errors', '0');
date_default_timezone_set('Europe/Berlin');

// Datenordner: neben dem Webroot (Plesk legt dort „private“ an), nie darin
function sw_docroot(): string {
  return realpath(dirname(__DIR__, 2)) ?: dirname(__DIR__, 2);
}
function sw_daten_kandidaten(): array {
  $vhost = dirname(sw_docroot());
  $k = [];
  if (getenv('SCOOTERWAYS_DATA')) $k[] = getenv('SCOOTERWAYS_DATA');
  $k[] = "$vhost/private/scooterways";
  $k[] = "$vhost/scooterways-daten";
  return $k;
}
function sw_ausserhalb_webroot(string $pfad): bool {
  $root = rtrim(sw_docroot(), '/') . '/';
  $p = rtrim(realpath($pfad) ?: $pfad, '/') . '/';
  return strncmp($p, $root, strlen($root)) !== 0;
}
// Ordner suchen oder anlegen; null, wenn keiner beschreibbar ist (open_basedir, Rechte)
function sw_daten(bool $anlegen = false): ?string {
  static $gefunden = null;
  if ($gefunden) return $gefunden;
  foreach (sw_daten_kandidaten() as $d) {
    if (!sw_ausserhalb_webroot($d)) continue;
    if (!@is_dir($d) && $anlegen) @mkdir($d, 0700, true);
    if (@is_dir($d) && @is_writable($d)) {
      if (!file_exists("$d/.htaccess")) @file_put_contents("$d/.htaccess", "Require all denied\n");
      return $gefunden = $d;
    }
  }
  return null;
}

// --- Konfiguration: config.php im Datenordner, gibt ein Array zurück ---
const SW_STANDARD = [
  'valhalla_url' => 'https://valhalla1.openstreetmap.de',
  'photon_url' => 'https://photon.komoot.io/api/',
  'overpass_urls' => ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'],
  'open_meteo_url' => 'https://api.open-meteo.com/v1/forecast',
  'tomtom_key' => '',
  'origins' => ['https://scooter.thai-klasse.de'],
];
function sw_config(): array {
  static $c = null;
  if ($c !== null) return $c;
  $d = sw_daten();
  $c = $d && is_file("$d/config.php") ? (include "$d/config.php") : [];
  if (!is_array($c)) $c = [];
  $c['werte'] = array_merge(SW_STANDARD, $c['werte'] ?? []);
  return $c;
}
function sw_config_speichern(array $c): void {
  $d = sw_daten(true);
  if (!$d) throw new RuntimeException('Kein beschreibbarer Datenordner');
  $tmp = "$d/config.php." . bin2hex(random_bytes(4));
  $inhalt = "<?php\n// Von Scooterways geschrieben. Enthält Geheimnisse: nicht ins Repo, nicht in den Webroot.\nreturn " . var_export($c, true) . ";\n";
  if (file_put_contents($tmp, $inhalt, LOCK_EX) === false) throw new RuntimeException('Konfiguration nicht schreibbar');
  @chmod($tmp, 0600);
  rename($tmp, "$d/config.php");
  if (function_exists('opcache_invalidate')) @opcache_invalidate("$d/config.php", true);
}
function sw_wert(string $k) { return sw_config()['werte'][$k] ?? null; }
function sw_eingerichtet(): bool { return !empty(sw_config()['admin_hash']); }

// --- Datenbank: SQLite-Datei im Datenordner (Standard) oder MySQL ---
function sw_db(): PDO {
  static $db = null;
  if ($db) return $db;
  $c = sw_config()['db'] ?? ['typ' => 'sqlite'];
  if (($c['typ'] ?? '') === 'mysql') {
    $db = new PDO("mysql:host={$c['host']};dbname={$c['name']};charset=utf8mb4", $c['user'], $c['pass'],
      [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
  } else {
    $d = sw_daten(true);
    if (!$d) throw new RuntimeException('Kein beschreibbarer Datenordner');
    $db = new PDO("sqlite:$d/scooterways.sqlite", null, null,
      [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
    $db->exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000');
  }
  sw_schema($db);
  return $db;
}
function sw_mysql(): bool { return (sw_config()['db']['typ'] ?? '') === 'mysql'; }
// Tabellen anlegen; spätere Versionen hängen hier weitere Schritte an
function sw_schema(PDO $db): void {
  $id = sw_mysql() ? 'INTEGER PRIMARY KEY AUTO_INCREMENT' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  $txt = sw_mysql() ? 'MEDIUMTEXT' : 'TEXT';
  $db->exec('CREATE TABLE IF NOT EXISTS sw_meta (k VARCHAR(64) PRIMARY KEY, v VARCHAR(255))');
  $v = (int)($db->query("SELECT v FROM sw_meta WHERE k='schema'")->fetchColumn() ?: 0);
  if ($v >= SW_SCHEMA) return;
  if ($v < 1) {
    $db->exec("CREATE TABLE IF NOT EXISTS sw_drossel (k VARCHAR(128) PRIMARY KEY, fenster INTEGER NOT NULL, ende INTEGER NOT NULL, n INTEGER NOT NULL)");
    $db->exec("CREATE TABLE IF NOT EXISTS sw_login (id $id, ip VARCHAR(64) NOT NULL, t INTEGER NOT NULL)");
    $db->exec("CREATE TABLE IF NOT EXISTS sw_fehler (id $id, t INTEGER NOT NULL, ip VARCHAR(64), version VARCHAR(64), ua VARCHAR(255), text $txt)");
  }
  $db->prepare('DELETE FROM sw_meta WHERE k=?')->execute(['schema']);
  $db->prepare('INSERT INTO sw_meta (k, v) VALUES (?, ?)')->execute(['schema', (string)SW_SCHEMA]);
}

// --- Anfragen ---
// IP nur gehasht speichern (mit Salz aus der Konfiguration), reicht für Drosselung und Zuordnung
function sw_ip(): string {
  $salz = sw_config()['salz'] ?? 'ohne-setup';
  return substr(hash_hmac('sha256', $_SERVER['REMOTE_ADDR'] ?? '', $salz), 0, 24);
}
// Zähler pro Schlüssel und Zeitfenster; false, wenn das Limit erreicht ist
function sw_drossel(string $k, int $max, int $fenster_s): bool {
  $db = sw_db();
  $f = intdiv(time(), $fenster_s);
  $u = $db->prepare('UPDATE sw_drossel SET n = n + 1 WHERE k = ? AND fenster = ?');
  $u->execute([$k, $f]);
  if ($u->rowCount() === 0) {
    $db->prepare('DELETE FROM sw_drossel WHERE k = ?')->execute([$k]);
    $db->prepare('INSERT INTO sw_drossel (k, fenster, ende, n) VALUES (?, ?, ?, 1)')->execute([$k, $f, ($f + 1) * $fenster_s]);
    if (random_int(0, 50) === 0) $db->prepare('DELETE FROM sw_drossel WHERE ende < ?')->execute([time()]);
    return true;
  }
  $n = $db->prepare('SELECT n FROM sw_drossel WHERE k = ?');
  $n->execute([$k]);
  return (int)$n->fetchColumn() <= $max;
}
// Nur Aufrufe aus der eigenen App (Origin-Kopf, den Browser bei POST und fetch immer mitschicken)
function sw_origin_ok(): bool {
  $o = $_SERVER['HTTP_ORIGIN'] ?? '';
  return $o !== '' && in_array($o, (array)sw_wert('origins'), true);
}
function sw_json($daten, int $status = 200) {
  http_response_code($status);
  header('Content-Type: application/json; charset=utf-8');
  header('Cache-Control: no-store');
  header('X-Content-Type-Options: nosniff');
  echo json_encode($daten, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  exit;
}
function sw_fehler(string $text, int $status) { sw_json(['fehler' => $text], $status); }
// Rumpf mit Obergrenze lesen; null bei zu groß
function sw_rumpf(int $max): ?string {
  if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > $max) return null;
  $s = file_get_contents('php://input', false, null, 0, $max + 1);
  return $s === false || strlen($s) > $max ? null : $s;
}

// --- Admin-Sitzung ---
function sw_sitzung(): void {
  if (session_status() === PHP_SESSION_ACTIVE) return;
  $d = sw_daten(true);
  if ($d) { @mkdir("$d/sitzungen", 0700); session_save_path("$d/sitzungen"); }
  session_name(SW_ADMIN_COOKIE);
  session_set_cookie_params(['lifetime' => 0, 'path' => '/', 'secure' => true, 'httponly' => true, 'samesite' => 'Strict']);
  ini_set('session.use_strict_mode', '1');
  ini_set('session.gc_maxlifetime', (string)SW_SITZUNG_S);
  session_start();
  if (!empty($_SESSION['admin']) && time() - ($_SESSION['zuletzt'] ?? 0) > SW_SITZUNG_S) sw_abmelden();
  if (!empty($_SESSION['admin'])) $_SESSION['zuletzt'] = time();
}
function sw_admin(): bool { sw_sitzung(); return !empty($_SESSION['admin']); }
function sw_abmelden(): void { $_SESSION = []; session_regenerate_id(true); }
function sw_csrf(): string {
  sw_sitzung();
  return $_SESSION['csrf'] ??= bin2hex(random_bytes(32));
}
function sw_csrf_ok(): bool {
  return isset($_SESSION['csrf'], $_POST['csrf']) && hash_equals($_SESSION['csrf'], (string)$_POST['csrf']);
}
// Login-Drosselung: 5 Fehlversuche je IP oder 30 insgesamt in 15 min sperren
function sw_login_gesperrt(): bool {
  $db = sw_db();
  $ab = time() - 900;
  $db->prepare('DELETE FROM sw_login WHERE t < ?')->execute([$ab - 86400]);
  $ip = $db->prepare('SELECT COUNT(*) FROM sw_login WHERE ip = ? AND t >= ?');
  $ip->execute([sw_ip(), $ab]);
  $alle = $db->prepare('SELECT COUNT(*) FROM sw_login WHERE t >= ?');
  $alle->execute([$ab]);
  return $ip->fetchColumn() >= 5 || $alle->fetchColumn() >= 30;
}
function sw_login_fehlschlag(): void {
  sw_db()->prepare('INSERT INTO sw_login (ip, t) VALUES (?, ?)')->execute([sw_ip(), time()]);
}
function sw_anmelden(string $pw): bool {
  if (sw_login_gesperrt()) return false;
  $hash = sw_config()['admin_hash'] ?? '';
  if (!$hash || !password_verify($pw, $hash)) { sw_login_fehlschlag(); usleep(800000); return false; }
  if (password_needs_rehash($hash, PASSWORD_DEFAULT)) {
    $c = sw_config(); $c['admin_hash'] = password_hash($pw, PASSWORD_DEFAULT); sw_config_speichern($c);
  }
  session_regenerate_id(true);
  $_SESSION = ['admin' => true, 'zuletzt' => time(), 'csrf' => bin2hex(random_bytes(32))];
  return true;
}

// Strenge Kopfzeilen für die HTML-Seiten (Setup, Admin)
function sw_html_koepfe(): void {
  header('Content-Type: text/html; charset=utf-8');
  header('Cache-Control: no-store');
  header("Content-Security-Policy: default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  header('X-Frame-Options: DENY');
  header('X-Content-Type-Options: nosniff');
  header('Referrer-Policy: no-referrer');
  header('X-Robots-Tag: noindex, nofollow');
}
function h($s): string { return htmlspecialchars((string)$s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); }
