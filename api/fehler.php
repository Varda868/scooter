<?php
// Fehlerberichte aus der Dev-Version (🐞-Dialog → „An Server senden“). Nur aus der eigenen App, gedrosselt, Größe begrenzt.
define('SW_API', 1);
require __DIR__ . '/lib/kern.php';
sw_cors();

const FEHLER_MAX_BYTES = 65536, FEHLER_PRO_STUNDE = 10, FEHLER_PRO_TAG_ALLE = 300, FEHLER_BEHALTEN = 1000;

if ($_SERVER['REQUEST_METHOD'] !== 'POST') sw_fehler('nur POST', 405);
if (!sw_eingerichtet()) sw_fehler('Server nicht eingerichtet', 503);
if (!sw_origin_ok()) sw_fehler('Herkunft nicht erlaubt', 403);
$roh = sw_rumpf(FEHLER_MAX_BYTES);
if ($roh === null) sw_fehler('Bericht zu groß', 413);
$b = json_decode($roh, true);
if (!is_array($b) || !is_string($b['text'] ?? null) || trim($b['text']) === '') sw_fehler('Bericht fehlt', 400);
if (!sw_drossel('fehler:' . sw_ip(), FEHLER_PRO_STUNDE, 3600) || !sw_drossel('fehler:alle', FEHLER_PRO_TAG_ALLE, 86400))
  sw_fehler('Zu viele Berichte, bitte später', 429);

$db = sw_db();
$db->prepare('INSERT INTO sw_fehler (t, ip, version, ua, text) VALUES (?, ?, ?, ?, ?)')->execute([
  time(), sw_ip(), mb_substr((string)($b['version'] ?? ''), 0, 64), mb_substr($_SERVER['HTTP_USER_AGENT'] ?? '', 0, 255), $b['text'],
]);
$id = (int)$db->lastInsertId();
// Aufräumen nebenbei: älter als 30 Tage oder über der Höchstzahl
$db->prepare('DELETE FROM sw_fehler WHERE t < ? OR id <= ?')->execute([time() - 30 * 86400, $id - FEHLER_BEHALTEN]);
sw_json(['ok' => true, 'id' => $id]);
