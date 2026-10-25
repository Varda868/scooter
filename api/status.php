<?php
// Öffentlicher Kurzcheck: läuft PHP, sind die nötigen Erweiterungen da, ist eingerichtet? Keine Pfade, keine Werte.
define('SW_API', 1);
require __DIR__ . '/lib/kern.php';
sw_json([
  'php' => PHP_VERSION,
  'phpOk' => PHP_VERSION_ID >= 70400,
  'erweiterungen' => array_map('extension_loaded', ['pdo_sqlite' => 'pdo_sqlite', 'pdo_mysql' => 'pdo_mysql', 'openssl' => 'openssl', 'curl' => 'curl', 'mbstring' => 'mbstring']),
  'datenordner' => sw_daten(true) !== null,
  'eingerichtet' => sw_eingerichtet(),
]);
