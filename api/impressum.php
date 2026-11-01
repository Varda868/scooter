<?php
// Angaben für Impressum und Datenschutzerklärung (impressum.html, datenschutz.html). Sie stehen nur in config.php
// (Admin → Impressum), weil das Repo öffentlich ist und eine Privatanschrift dort nicht hingehört.
define('SW_API', 1);
require __DIR__ . '/lib/kern.php';
sw_cors();
if (!sw_eingerichtet()) sw_json(['leer' => true]);
$w = sw_config()['werte'];
$name = trim((string)$w['impressum_name']); $anschrift = trim((string)$w['impressum_anschrift']); $mail = trim((string)$w['impressum_email']);
if ($name === '' || $anschrift === '' || $mail === '') sw_json(['leer' => true]);
sw_json(['name' => $name, 'anschrift' => $anschrift, 'email' => $mail]);
