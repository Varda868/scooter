<?php
// Zwischenspeicher-Proxy für die Dienste der App. Kein offener Proxy: nur feste Ziele aus der Konfiguration,
// nur erlaubte Parameter, nur Aufrufe aus der eigenen App, gedrosselt je Gerät und insgesamt.
// Aufruf: proxy.php?d=wetter|photon|overpass|tomtom|tomtom-flow&… (Overpass als POST data=…, Server-Nr. in s)
define('SW_API', 1);
require __DIR__ . '/lib/kern.php';
sw_cors();

// d => [Ziel, erlaubte Parameter, Sekunden im Speicher, je Gerät/min, insgesamt/Tag]
const PROXY_DIENSTE = [
  'wetter' => ['open_meteo_url', ['latitude', 'longitude', 'hourly', 'minutely_15', 'daily', 'current', 'forecast_days', 'past_days', 'timeformat', 'wind_speed_unit', 'timezone', 'models'], 900, 30, 20000],
  'photon' => ['photon_url', ['q', 'lang', 'limit', 'lat', 'lon', 'bbox', 'osm_tag', 'layer', 'zoom', 'location_bias_scale'], 86400, 60, 20000],
  'overpass' => ['overpass_urls', [], 86400, 12, 5000],
  'tomtom' => ['tomtom_key', ['bbox', 'fields', 'language', 'timeValidityFilter', 'categoryFilter'], 120, 20, 2000],
  'tomtom-flow' => ['tomtom_key', ['z', 'x', 'y'], 300, 600, 30000],
];
const PROXY_TOMTOM = 'https://api.tomtom.com/traffic';
const PROXY_MAX_ANTWORT = 30 * 1048576, PROXY_MAX_ANFRAGE = 20000, PROXY_SPEICHER_MAX = 300 * 1048576;

$d = (string)($_GET['d'] ?? '');
$dienst = PROXY_DIENSTE[$d] ?? null;
if (!$dienst) sw_fehler('unbekannter Dienst', 404);
if (!sw_eingerichtet() || !sw_wert('proxy_an')) sw_fehler('Proxy aus', 503);
// Browser schicken bei fetch/img aus der eigenen Seite Sec-Fetch-Site: same-origin, bei POST außerdem Origin
// (ältere Browser ohne Sec-Fetch-*: Referer der eigenen Seite)
$ref = $_SERVER['HTTP_REFERER'] ?? '';
$gleich = ($_SERVER['HTTP_SEC_FETCH_SITE'] ?? '') === 'same-origin' ||
  ($ref !== '' && in_array(preg_replace('~^(https://[^/]+).*$~', '$1', $ref), (array)sw_wert('origins'), true));
if (!$gleich && !sw_origin_ok()) sw_fehler('Herkunft nicht erlaubt', 403);
[$ziel, $erlaubt, $ttl, $proMin, $proTag] = $dienst;

// Parameter auf die erlaubten beschränken und normiert sortieren (gleiche Anfrage = gleicher Speicherplatz)
$p = [];
foreach ($erlaubt as $k) if (isset($_GET[$k]) && is_string($_GET[$k])) $p[$k] = $_GET[$k];
ksort($p);
$qs = http_build_query($p, '', '&', PHP_QUERY_RFC3986);
if (strlen($qs) > PROXY_MAX_ANFRAGE) sw_fehler('Anfrage zu lang', 414);

$methode = 'GET'; $rumpf = null;
switch ($d) {
  case 'wetter': case 'photon':
    $url = sw_wert($ziel) . '?' . $qs;
    break;
  case 'overpass':
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') sw_fehler('nur POST', 405);
    $roh = sw_rumpf(PROXY_MAX_ANFRAGE);
    parse_str((string)$roh, $form);
    $q = is_string($form['data'] ?? null) ? $form['data'] : '';
    if ($roh === null || $q === '' || !str_starts_with(ltrim($q), '[out:json]')) sw_fehler('Abfrage ungültig', 400);
    $server = (array)sw_wert('overpass_urls');
    $url = $server[(int)($_GET['s'] ?? 0) % max(1, count($server))] ?? null;
    if (!$url) sw_fehler('kein Overpass-Server', 503);
    $methode = 'POST'; $rumpf = 'data=' . rawurlencode($q);
    $qs = $q; // Speicherschlüssel: die Abfrage, nicht der Server
    break;
  case 'tomtom':
    if (!sw_wert('tomtom_key')) sw_fehler('kein Schlüssel auf dem Server', 503);
    $url = PROXY_TOMTOM . '/services/5/incidentDetails?' . $qs . '&key=' . rawurlencode(sw_wert('tomtom_key'));
    break;
  case 'tomtom-flow':
    if (!sw_wert('tomtom_key')) sw_fehler('kein Schlüssel auf dem Server', 503);
    $z = filter_var($p['z'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 0, 'max_range' => 22]]);
    $n = $z === false ? 0 : 1 << $z;
    $x = filter_var($p['x'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 0, 'max_range' => max(0, $n - 1)]]);
    $y = filter_var($p['y'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 0, 'max_range' => max(0, $n - 1)]]);
    if ($z === false || $x === false || $y === false) sw_fehler('Kachel ungültig', 400);
    $url = PROXY_TOMTOM . "/map/4/tile/flow/relative0/$z/$x/$y.png?key=" . rawurlencode(sw_wert('tomtom_key'));
    break;
}

// Speicher: <Datenordner>/cache/<dienst>/<hash>; erste Zeile JSON mit Status und Typ, danach der Inhalt
$ordner = sw_daten(true) . "/cache/$d";
$datei = "$ordner/" . sha1($qs);
$alter = @filemtime($datei);
if ($alter && time() - $alter < $ttl && ($f = @fopen($datei, 'rb'))) {
  $meta = json_decode((string)fgets($f), true);
  proxy_koepfe($meta['typ'] ?? 'application/octet-stream', $ttl - (time() - $alter), 'HIT');
  fpassthru($f);
  exit;
}

// Erst jetzt drosseln: Treffer aus dem Speicher kosten niemanden etwas
if (!sw_drossel("proxy:$d:" . sw_ip(), $proMin, 60)) sw_fehler('Zu viele Anfragen, bitte kurz warten', 429);
if (!sw_drossel("proxy:$d:alle", $proTag, 86400)) sw_fehler('Tageskontingent des Servers erschöpft', 429);

$daten = ''; $zuGross = false;
$c = curl_init($url);
curl_setopt_array($c, [
  CURLOPT_CUSTOMREQUEST => $methode,
  CURLOPT_POSTFIELDS => $rumpf,
  CURLOPT_HTTPHEADER => $rumpf !== null ? ['Content-Type: application/x-www-form-urlencoded'] : [],
  CURLOPT_USERAGENT => 'Scooterways/1 (+https://scooter.thai-klasse.de)',
  CURLOPT_FOLLOWLOCATION => false,
  CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
  CURLOPT_CONNECTTIMEOUT => 8,
  CURLOPT_TIMEOUT => $d === 'overpass' ? 38 : 20, // die App bricht Overpass nach 40 s selbst ab
  CURLOPT_ENCODING => '',
  CURLOPT_WRITEFUNCTION => function ($c, $teil) use (&$daten, &$zuGross) {
    if (strlen($daten) + strlen($teil) > PROXY_MAX_ANTWORT) { $zuGross = true; return 0; }
    $daten .= $teil; return strlen($teil);
  },
]);
$ok = curl_exec($c);
$status = (int)curl_getinfo($c, CURLINFO_RESPONSE_CODE);
$typ = (string)(curl_getinfo($c, CURLINFO_CONTENT_TYPE) ?: 'application/octet-stream');
curl_close($c);
// Wetter: bei Überlast oder Störung von Open-Meteo still auf MET Norway ausweichen (gleiches Format für die App)
if ($d === 'wetter' && ($zuGross || !$ok || $status === 429 || $status >= 500)) {
  require __DIR__ . '/lib/met.php';
  $ersatz = met_ersatz($p, $ordner);
  if ($ersatz !== null) { $ok = true; $zuGross = false; $status = 200; $typ = 'application/json'; $daten = $ersatz; }
}
if ($zuGross) sw_fehler('Antwort zu groß', 502);
if (!$ok || !$status) sw_fehler('Dienst nicht erreichbar', 504);
// Nur Inhaltstypen, die die App erwartet; alles andere würde den Proxy zum Werkzeug für Fremdes machen
if (!preg_match('~^(application/(json|geo\+json)|image/png)~i', $typ)) sw_fehler($status === 200 ? 'unerwartete Antwort' : "Dienst meldet $status", $status === 200 ? 502 : $status);

if ($status === 200) {
  @mkdir($ordner, 0700, true);
  $tmp = "$datei." . bin2hex(random_bytes(4));
  if (@file_put_contents($tmp, json_encode(['typ' => $typ]) . "\n" . $daten) !== false) @rename($tmp, $datei);
  if (random_int(0, 200) === 0) proxy_aufraeumen();
}
http_response_code($status);
proxy_koepfe($typ, $status === 200 ? $ttl : 0, 'MISS');
echo $daten;

function proxy_koepfe(string $typ, int $maxAlter, string $cache): void {
  header("Content-Type: $typ");
  header('X-Content-Type-Options: nosniff');
  header("X-Cache: $cache");
  header($maxAlter > 0 ? "Cache-Control: private, max-age=$maxAlter" : 'Cache-Control: no-store');
}
// Abgelaufenes weg, und über der Höchstgröße die ältesten Dateien
function proxy_aufraeumen(): void {
  $basis = sw_daten() . '/cache';
  $dateien = [];
  foreach (PROXY_DIENSTE as $d => [, , $ttl]) foreach (glob("$basis/$d/*") ?: [] as $f) {
    $t = @filemtime($f);
    if (!$t || time() - $t > $ttl) @unlink($f); else $dateien[$f] = [$t, @filesize($f)];
  }
  $summe = array_sum(array_column($dateien, 1));
  if ($summe <= PROXY_SPEICHER_MAX) return;
  uasort($dateien, fn($a, $b) => $a[0] <=> $b[0]);
  foreach ($dateien as $f => [, $g]) { @unlink($f); if (($summe -= $g) <= PROXY_SPEICHER_MAX * 0.8) break; }
}
