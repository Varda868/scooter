<?php
// Admin-Bereich „Proxy“: Belegung des Zwischenspeichers, heutige Abrufe, Speicher leeren
defined('SW_API') || exit;

$BEREICHE['proxy'] = ['titel' => 'Proxy', 'fn' => 'bereich_proxy'];

function proxy_dienste(): array { return ['wetter' => 'Wetter', 'photon' => 'Ortssuche', 'overpass' => 'Overpass', 'tomtom' => 'TomTom-Meldungen', 'tomtom-flow' => 'TomTom-Fluss']; }
function bereich_proxy(): void {
  global $OK;
  $basis = sw_daten() . '/cache';
  if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    foreach (array_keys(proxy_dienste()) as $d) foreach (glob("$basis/$d/*") ?: [] as $f) @unlink($f);
    admin_zurueck('proxy', 'Zwischenspeicher geleert.');
  }
  $heute = sw_db()->prepare('SELECT n FROM sw_drossel WHERE k = ? AND fenster = ?');
  $html = admin_hinweis($OK) . '<p>' . (sw_wert('proxy_an') ? 'Proxy ist an.' : 'Proxy ist aus (unter „Schlüssel & Endpunkte“ einschalten).') . '</p>' .
    '<table><tr><th>Dienst</th><th>Dateien</th><th>Größe</th><th>Abrufe heute (ohne Treffer)</th></tr>';
  foreach (proxy_dienste() as $d => $name) {
    $f = glob("$basis/$d/*") ?: [];
    $heute->execute(["proxy:$d:alle", sw_fenster(86400)]);
    $html .= '<tr><td>' . h($name) . '</td><td>' . count($f) . '</td><td>' . number_format(array_sum(array_map('filesize', $f)) / 1048576, 1, ',', '.') .
      ' MB</td><td>' . (int)$heute->fetchColumn() . '</td></tr>';
  }
  admin_seite('Proxy', $html . '</table><form method="post">' . admin_csrf_feld() . '<button class="gefahr">Zwischenspeicher leeren</button></form>' .
    '<p class="leise">Höchstens 300 MB, darüber fliegen die ältesten Einträge raus.</p>');
}
