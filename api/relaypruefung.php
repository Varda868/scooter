<?php
// Regelmäßige Relay-Prüfung für eine geplante Aufgabe in Plesk („URL abrufen“). Geschützt durch das Token aus dem
// Admin-Bereich; öfter als alle 4 min wird nicht geprüft. Antwort: kurze Übersicht, ohne Adressen des Servers.
define('SW_API', 1);
require __DIR__ . '/lib/kern.php';
require __DIR__ . '/lib/relays.php';

if (!sw_eingerichtet()) sw_fehler('Server nicht eingerichtet', 503);
$soll = (string)(sw_config()['relay_token'] ?? '');
if ($soll === '' || !hash_equals($soll, (string)($_GET['k'] ?? ''))) { usleep(300000); sw_fehler('nicht erlaubt', 403); }
$zuletzt = (int)sw_db()->query("SELECT MAX(t) FROM sw_relay WHERE quelle = 'server'")->fetchColumn();
if (time() - $zuletzt < RELAY_CRON_ABSTAND_S) sw_json(['ok' => true, 'uebersprungen' => true, 'zuletzt' => $zuletzt]);
@set_time_limit(120);
$e = relay_alle_pruefen();
sw_ip_test(true);
sw_json(['ok' => true, 'relays' => array_map(fn($r) => ['url' => $r['url'], 'ok' => $r['ok'], 'ms' => $r['ms_verb']], $e)]);
