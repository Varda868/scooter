<?php
// Öffentliche Einstellungen für die App (Endpunkte aus dem Admin-Bereich). Schlüssel stehen hier nie drin.
define('SW_API', 1);
require __DIR__ . '/lib/kern.php';
if (!sw_eingerichtet()) sw_json(['eingerichtet' => false]);
$w = sw_config()['werte'];
sw_json([
  'eingerichtet' => true,
  'valhalla' => $w['valhalla_url'],
  'photon' => $w['photon_url'],
  'overpass' => $w['overpass_urls'],
  'openMeteo' => $w['open_meteo_url'],
  'tomtomAmServer' => $w['tomtom_key'] !== '',
]);
