<?php
// Kurzlinks für Touren: /t/<id> → App lädt die Tour. Mit Ablaufdatum, Löschcode für den Ersteller.
// POST {tour, tage}           → {id, bis, loesch}
// GET  ?id=<id>               → {tour, bis}
// POST {loeschen: id, code}   → {ok}
define('SW_API', 1);
require __DIR__ . '/lib/kern.php';

const KURZ_MAX_BYTES = 32768, KURZ_TAGE = [7, 30, 90, 365], KURZ_PRO_STUNDE = 20, KURZ_PRO_TAG_ALLE = 500;
const KURZ_ZEICHEN = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne l, I, O, 0, 1

if (!sw_eingerichtet()) sw_fehler('Server nicht eingerichtet', 503);
$db = sw_db();

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
  $id = (string)($_GET['id'] ?? '');
  if (!preg_match('/^[A-Za-z0-9]{8}$/', $id)) sw_fehler('Link ungültig', 400);
  // Raten verhindern: 120 Abrufe pro Minute und Gerät
  if (!sw_drossel('kurz-get:' . sw_ip(), 120, 60)) sw_fehler('Zu viele Abrufe', 429);
  $q = $db->prepare('SELECT bis, daten FROM sw_kurz WHERE id = ?'); $q->execute([$id]);
  $r = $q->fetch();
  if (!$r) sw_fehler('Link unbekannt', 404);
  if ($r['bis'] < time()) sw_fehler('Link abgelaufen', 410);
  $db->prepare('UPDATE sw_kurz SET abrufe = abrufe + 1 WHERE id = ?')->execute([$id]);
  sw_json(['tour' => json_decode($r['daten'], true), 'bis' => (int)$r['bis']]);
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') sw_fehler('nur GET oder POST', 405);
if (!sw_origin_ok()) sw_fehler('Herkunft nicht erlaubt', 403);
$roh = sw_rumpf(KURZ_MAX_BYTES);
if ($roh === null) sw_fehler('Tour zu groß', 413);
$b = json_decode($roh, true);
if (!is_array($b)) sw_fehler('Daten fehlen', 400);

if (isset($b['loeschen'])) {
  $q = $db->prepare('SELECT loesch FROM sw_kurz WHERE id = ?'); $q->execute([(string)$b['loeschen']]);
  $h = $q->fetchColumn();
  if (!$h || !hash_equals($h, hash('sha256', (string)($b['code'] ?? '')))) sw_fehler('Löschcode falsch', 403);
  $db->prepare('DELETE FROM sw_kurz WHERE id = ?')->execute([(string)$b['loeschen']]);
  sw_json(['ok' => true]);
}

// Tour prüfen und auf das Nötige zurechtstutzen
function kurz_zahl($v, float $max): ?float { return is_numeric($v) && abs((float)$v) <= $max ? round((float)$v, 6) : null; }
$t = $b['tour'] ?? null;
$wps = is_array($t['waypoints'] ?? null) ? $t['waypoints'] : [];
if (count($wps) < 2 || count($wps) > 60) sw_fehler('2 bis 60 Wegpunkte', 400);
$tour = ['v' => 1, 'name' => mb_substr((string)($t['name'] ?? ''), 0, 80), 'waypoints' => [], 'excluded' => []];
foreach ($wps as $w) {
  $lat = kurz_zahl($w['lat'] ?? null, 90); $lon = kurz_zahl($w['lon'] ?? null, 180);
  if ($lat === null || $lon === null) sw_fehler('Wegpunkt ohne Koordinaten', 400);
  $tour['waypoints'][] = ['lat' => $lat, 'lon' => $lon, 'text' => mb_substr((string)($w['text'] ?? ''), 0, 120)];
}
foreach (array_slice(is_array($t['excluded'] ?? null) ? $t['excluded'] : [], 0, 50) as $e) {
  $lat = kurz_zahl($e[0] ?? null, 90); $lon = kurz_zahl($e[1] ?? null, 180);
  if ($lat !== null && $lon !== null) $tour['excluded'][] = [$lat, $lon];
}
$tage = in_array((int)($b['tage'] ?? 0), KURZ_TAGE, true) ? (int)$b['tage'] : 30;
if (!sw_drossel('kurz:' . sw_ip(), KURZ_PRO_STUNDE, 3600) || !sw_drossel('kurz:alle', KURZ_PRO_TAG_ALLE, 86400)) sw_fehler('Zu viele neue Links, bitte später', 429);

$db->prepare('DELETE FROM sw_kurz WHERE bis < ?')->execute([time()]);
$loesch = bin2hex(random_bytes(16));
for ($i = 0; ; $i++) {
  $id = '';
  for ($k = 0; $k < 8; $k++) $id .= KURZ_ZEICHEN[random_int(0, strlen(KURZ_ZEICHEN) - 1)];
  try {
    $db->prepare('INSERT INTO sw_kurz (id, t, bis, loesch, ip, daten) VALUES (?, ?, ?, ?, ?, ?)')
      ->execute([$id, time(), time() + $tage * 86400, hash('sha256', $loesch), sw_ip(), json_encode($tour, JSON_UNESCAPED_UNICODE)]);
    break;
  } catch (PDOException $e) { if ($i >= 3) throw $e; } // Kollision: neue ID
}
sw_json(['id' => $id, 'bis' => time() + $tage * 86400, 'loesch' => $loesch]);
