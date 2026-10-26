<?php
// Gemeinsamer Kern der Server-Funktionen: Datenordner, Konfiguration, Datenbank, Drosselung, Sitzung.
// Das Repo ist öffentlich: hier stehen keine Schlüssel. Alles Geheime liegt im Datenordner außerhalb des Webroots.
defined('SW_API') || exit;

const SW_SCHEMA = 7;
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
  // Zugänge für Server-Läufe (Admin → Fährdaten → Schlüssel & Konten, siehe SW_SCHLUESSEL)
  'trafiklab_key' => '', 'trafikverket_key' => '', 'tnds_user' => '', 'tnds_pass' => '',
  'barentswatch_id' => '', 'barentswatch_secret' => '', 'aisstream_key' => '',
  'proxy_an' => true,
  'origins' => ['https://scooter.thai-klasse.de'],
  // Talk-Relays in dieser Reihenfolge; eigen = selbst betriebenes Relay (im Dashboard hervorgehoben, Zertifikat genauer beobachtet)
  'relays' => [
    ['url' => 'wss://nos.lol', 'an' => true, 'eigen' => false],
    ['url' => 'wss://relay.primal.net', 'an' => true, 'eigen' => false],
    ['url' => 'wss://nostr.mom', 'an' => true, 'eigen' => false],
  ],
];
// Schlüssel & Konten (Admin → Fährdaten): je Zugang die Felder in werte[], wo man sich anmeldet bzw. ein Konto anlegt,
// Abruflimit und Lizenz. Neuer Zugang = hier ein Eintrag (Felder auch in SW_STANDARD); leere Felder = Quelle wird übersprungen.
// Werte werden nie zurückgezeigt, nur „gesetzt“ und die letzten 4 Zeichen.
const SW_SCHLUESSEL = [
  'trafiklab' => ['name' => 'Trafiklab · GTFS Sverige 2', 'wofuer' => 'Fahrpläne schwedischer Fähren',
    'felder' => ['trafiklab_key' => 'API-Schlüssel'],
    'login' => 'https://developer.trafiklab.se/login', 'konto' => 'https://www.trafiklab.se/docs/using-trafiklab/creating-an-account/',
    'limit' => '50 Abrufe pro 30 Tage (Bronze)', 'lizenz' => 'CC0'],
  'trafikverket' => ['name' => 'Trafikverket Open API', 'wofuer' => 'Schwedische Straßenfähren (Färjeleden) in Echtzeit',
    'felder' => ['trafikverket_key' => 'API-Schlüssel'],
    'login' => 'https://www.trafikverket.se/e-tjanster/trafikverkets-oppna-api-for-trafikinformation/', 'konto' => '',
    'limit' => 'laut Anbieter fair use', 'lizenz' => 'CC0'],
  'tnds' => ['name' => 'Traveline National Dataset (TNDS)', 'wofuer' => 'Fahrpläne britischer Fähren (TransXChange)',
    'felder' => ['tnds_user' => 'FTP-Benutzer', 'tnds_pass' => 'FTP-Passwort'],
    'login' => 'https://www.data.gov.uk/dataset/traveline-national-dataset', 'konto' => '',
    'limit' => 'wöchentlicher Stand, Abruf per FTP', 'lizenz' => 'OGL'],
  'barentswatch' => ['name' => 'BarentsWatch AIS', 'wofuer' => 'Schiffspositionen Norwegen (Fähren live)',
    'felder' => ['barentswatch_id' => 'Client-ID', 'barentswatch_secret' => 'Client-Secret'],
    'login' => 'https://www.barentswatch.no/minside/', 'konto' => 'https://developer.barentswatch.no/docs/AIS/live-ais-api',
    'limit' => 'laut Anbieter', 'lizenz' => 'NLOD'],
  'aisstream' => ['name' => 'aisstream.io', 'wofuer' => 'Schiffspositionen weltweit (Fähren live)',
    'felder' => ['aisstream_key' => 'API-Schlüssel'],
    'login' => 'https://aisstream.io/authenticate', 'konto' => 'https://aisstream.io',
    'limit' => 'kostenlos, ohne feste Zusage', 'lizenz' => 'laut Anbieter'],
];
function sw_schluessel_link(string $zugang): string {
  $z = SW_SCHLUESSEL[$zugang] ?? null;
  if (!$z) return '';
  $a = fn($url, $text) => '<a href="' . h($url) . '" target="_blank" rel="noopener noreferrer">' . h($text) . '</a>';
  return '<span class="schluessel-link">' . $a($z['login'], 'Login / Anmeldung ↗') . ($z['konto'] ? ' · ' . $a($z['konto'], 'Infos & Konto ↗') : '') . '</span>';
}
// 'voll' = alle Felder gesetzt, 'teil' = einige, 'leer' = keins (Quelle wird übersprungen)
function sw_schluessel_status(string $zugang): string {
  $n = count(array_filter(array_keys(SW_SCHLUESSEL[$zugang]['felder']), fn($f) => (string)sw_wert($f) !== ''));
  return $n === 0 ? 'leer' : ($n === count(SW_SCHLUESSEL[$zugang]['felder']) ? 'voll' : 'teil');
}
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
  if ($v < 2) {
    $db->exec("CREATE TABLE IF NOT EXISTS sw_kurz (id VARCHAR(16) PRIMARY KEY, t INTEGER NOT NULL, bis INTEGER NOT NULL, loesch VARCHAR(64) NOT NULL, abrufe INTEGER NOT NULL DEFAULT 0, ip VARCHAR(64), daten $txt)");
  }
  if ($v < 3) {
    $db->exec("CREATE TABLE IF NOT EXISTS sw_push (id $id, ep VARCHAR(64) NOT NULL UNIQUE, gruppe VARCHAR(64) NOT NULL, endpoint TEXT NOT NULL, p256dh VARCHAR(128) NOT NULL, auth VARCHAR(64) NOT NULL, name VARCHAR(16), t INTEGER NOT NULL, zuletzt INTEGER, fehler INTEGER NOT NULL DEFAULT 0" .
      (sw_mysql() ? ', INDEX sw_push_gruppe (gruppe))' : ')'));
    if (!sw_mysql()) $db->exec('CREATE INDEX IF NOT EXISTS sw_push_gruppe ON sw_push (gruppe)');
  }
  // v4: ein Gerät kann in einer Gruppe und in seinem Postfach (Sprachpost) stehen; ep = Hash aus Ziel und Endpunkt
  if ($v < 4) {
    $db->exec('ALTER TABLE sw_push ADD COLUMN geraet VARCHAR(64)');
    $db->exec("ALTER TABLE sw_push ADD COLUMN art VARCHAR(8) NOT NULL DEFAULT 'gruppe'");
    $db->exec('UPDATE sw_push SET geraet = ep');
  }
  // v5: Verlauf der Relay-Prüfungen (Server per Cron/Knopf, Browser des Admins)
  if ($v < 5) {
    $db->exec("CREATE TABLE IF NOT EXISTS sw_relay (id $id, t INTEGER NOT NULL, url VARCHAR(255) NOT NULL, quelle VARCHAR(8) NOT NULL, ok INTEGER NOT NULL, " .
      "ms_verb INTEGER, ms_eose INTEGER, schreiben INTEGER, ip VARCHAR(64), cert_bis INTEGER, nip11 $txt, fehler VARCHAR(255))");
    $db->exec('CREATE INDEX ' . (sw_mysql() ? '' : 'IF NOT EXISTS ') . 'sw_relay_url ON sw_relay (url, t)');
  }
  // v6: verschlüsselte Profile für den Abgleich zwischen eigenen Geräten (Schlüssel und Fach-Kennung kennt nur die App)
  if ($v < 6) {
    $db->exec("CREATE TABLE IF NOT EXISTS sw_profil (id VARCHAR(64) PRIMARY KEY, t INTEGER NOT NULL, abruf INTEGER, groesse INTEGER NOT NULL, ip VARCHAR(64), daten " . (sw_mysql() ? 'LONGTEXT' : 'TEXT') . ")");
  }
  // v7: Verlauf der Fährdaten-Läufe (Admin → Fährdaten)
  if ($v < 7) {
    $db->exec("CREATE TABLE IF NOT EXISTS sw_faehrlauf (id $id, t INTEGER NOT NULL, quelle VARCHAR(16) NOT NULL, ms INTEGER, ok INTEGER NOT NULL, linien INTEGER, text $txt)");
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
function sw_fenster(int $s): int { return intdiv(time() + (int)date('Z'), $s); }
// Zähler pro Schlüssel und Zeitfenster; false, wenn das Limit erreicht ist
function sw_drossel(string $k, int $max, int $fenster_s): bool {
  $db = sw_db();
  $f = sw_fenster($fenster_s); // Tagesfenster beginnen um Mitternacht deutscher Zeit
  $u = $db->prepare('UPDATE sw_drossel SET n = n + 1 WHERE k = ? AND fenster = ?');
  $u->execute([$k, $f]);
  if ($u->rowCount() === 0) {
    $db->prepare('DELETE FROM sw_drossel WHERE k = ?')->execute([$k]);
    $db->prepare('INSERT INTO sw_drossel (k, fenster, ende, n) VALUES (?, ?, ?, 1)')->execute([$k, $f, ($f + 1) * $fenster_s - (int)date('Z')]);
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
// Zweitadressen der App (Admin → Erlaubte Herkunft) rufen die API von fremder Herkunft auf: CORS nur für diese, ohne Cookies
function sw_cors(): void {
  $o = $_SERVER['HTTP_ORIGIN'] ?? '';
  header('Vary: Origin', false);
  if ($o !== '' && sw_eingerichtet() && in_array($o, (array)sw_wert('origins'), true)) {
    header('Access-Control-Allow-Origin: ' . $o);
    header('Access-Control-Allow-Methods: GET, POST');
    header('Access-Control-Allow-Headers: Content-Type');
    header('Access-Control-Max-Age: 86400');
  }
  if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') { http_response_code(204); exit; }
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
// $skript: eigene Skripte (admin.js) und WebSocket/https-Verbindungen erlauben, nur für den angemeldeten Admin-Bereich
function sw_html_koepfe(bool $skript = false): void {
  header('Content-Type: text/html; charset=utf-8');
  header('Cache-Control: no-store');
  header("Content-Security-Policy: default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" .
    ($skript ? "; script-src 'self'; connect-src 'self' wss: https:" : ''));
  header('X-Frame-Options: DENY');
  header('X-Content-Type-Options: nosniff');
  header('Referrer-Policy: no-referrer');
  header('X-Robots-Tag: noindex, nofollow');
}
function h($s): string { return htmlspecialchars((string)$s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); }
