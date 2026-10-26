<?php
// Amtliche Wetterwarnungen für Punkte einer Route: warnungen.php?p=lat,lon;lat,lon;… (höchstens 60 Punkte)
// Antwort: {warnungen: [{id, quelle, stufe 1–4, art, ereignis, titel, text, von, bis (unixtime), gebiet, punkte: [Index]}]}
define('SW_API', 1);
require __DIR__ . '/lib/kern.php';
sw_cors();
require __DIR__ . '/lib/warnungen.php';
if (!sw_eingerichtet() || !sw_wert('proxy_an')) sw_fehler('Proxy aus', 503);
$punkte = warn_punkte((string)($_GET['p'] ?? ''));
if ($punkte === null) sw_fehler('Punkte ungültig', 400);
if (!sw_drossel('warnungen:' . sw_ip(), 30, 60)) sw_fehler('Zu viele Anfragen, bitte kurz warten', 429);

$warnungen = array_merge(warn_dwd($punkte), warn_meteoalarm($punkte));
// Nach Stufe absteigend, dann nach Beginn
usort($warnungen, fn($a, $b) => [$b['stufe'], $a['von']] <=> [$a['stufe'], $b['von']]);
if (random_int(0, 100) === 0) foreach (glob(sw_daten() . '/cache/warnungen/*') ?: [] as $f) if (time() - (int)@filemtime($f) > 86400) @unlink($f);
header('Cache-Control: private, max-age=300');
http_response_code(200);
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
echo json_encode(['warnungen' => $warnungen], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
