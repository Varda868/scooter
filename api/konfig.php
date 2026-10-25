<?php
// Öffentliche Einstellungen für die App (Endpunkte aus dem Admin-Bereich). Schlüssel stehen hier nie drin.
define('SW_API', 1);
require __DIR__ . '/lib/kern.php';
sw_cors();
require __DIR__ . '/lib/webpush.php';
require __DIR__ . '/lib/relays.php';
if (!sw_eingerichtet()) sw_json(['eingerichtet' => false]);
$w = sw_config()['werte'];
sw_json([
  'eingerichtet' => true,
  'valhalla' => $w['valhalla_url'],
  'photon' => $w['photon_url'],
  'overpass' => $w['overpass_urls'],
  'openMeteo' => $w['open_meteo_url'],
  'proxy' => (bool)$w['proxy_an'],
  'vapid' => extension_loaded('openssl') ? push_vapid()['pub'] : null,
  'tomtomAmServer' => $w['proxy_an'] && $w['tomtom_key'] !== '',
  // Talk-Relays in der Reihenfolge aus dem Admin-Bereich, nur eingeschaltete
  'relays' => array_values(array_column(array_filter(relay_liste(), fn($r) => $r['an']), 'url')),
]);
