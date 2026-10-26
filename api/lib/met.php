<?php
// Ersatz-Wetterquelle: MET Norway (api.met.no, Locationforecast 2.0, CC BY 4.0), wenn Open-Meteo 429 oder Fehler meldet.
// Rückgabe im Format von Open-Meteo, soweit die App es liest (hourly, minutely_15, current; Zeit als unixtime).
// MET kennt nur einen Punkt je Anfrage, stündlich bis ~2,5 Tage, danach 6-Stunden-Schritte; 15 min gibt es nicht,
// deshalb wird jede Stunde auf vier Viertelstunden verteilt.
defined('SW_API') || exit;

const MET_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/complete';
const MET_MAX_PUNKTE = 60, MET_TTL = 1800;

// Open-Meteo-Parameter → JSON-Text oder null (dann bleibt es beim Fehler von Open-Meteo)
function met_ersatz(array $p, string $ordner): ?string {
  $lat = array_map('floatval', explode(',', (string)($p['latitude'] ?? '')));
  $lon = array_map('floatval', explode(',', (string)($p['longitude'] ?? '')));
  if (!$lat || count($lat) !== count($lon) || count($lat) > MET_MAX_PUNKTE) return null;
  $tage = max(1, min(16, (int)($p['forecast_days'] ?? 7)));
  $felder = fn($k) => array_filter(explode(',', (string)($p[$k] ?? '')));
  $roh = met_holen(array_map(null, $lat, $lon), $ordner);
  $aus = [];
  foreach ($roh as $i => $ts) {
    if ($ts === null) return null;  // halbe Antworten verwirren die App mehr als ein Fehler
    $aus[] = met_umrechnen($ts, $lat[$i], $lon[$i], $tage, $felder('hourly'), $felder('minutely_15'), $felder('current'));
  }
  return json_encode(count($aus) === 1 ? $aus[0] : $aus, JSON_UNESCAPED_SLASHES);
}

// Alle Punkte parallel; je Punkt auf 2 Nachkommastellen gerundet zwischengespeichert (MET bittet um Runden und Cachen)
function met_holen(array $punkte, string $ordner): array {
  $ergebnis = []; $offen = [];
  $mh = curl_multi_init();
  foreach ($punkte as $i => [$la, $lo]) {
    $q = sprintf('lat=%.2f&lon=%.2f', $la, $lo);
    $datei = "$ordner/met-" . sha1($q);
    $alter = @filemtime($datei);
    if ($alter && time() - $alter < MET_TTL && ($j = json_decode((string)@file_get_contents($datei), true))) { $ergebnis[$i] = $j; continue; }
    $c = curl_init(MET_URL . '?' . $q);
    curl_setopt_array($c, [
      CURLOPT_RETURNTRANSFER => true,
      // MET verlangt einen eigenen User-Agent mit Kontakt
      CURLOPT_USERAGENT => 'Scooterways/1 (+https://scooter.thai-klasse.de)',
      CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
      CURLOPT_CONNECTTIMEOUT => 6,
      CURLOPT_TIMEOUT => 15,
      CURLOPT_ENCODING => '',
    ]);
    curl_multi_add_handle($mh, $c);
    $offen[$i] = [$c, $datei];
  }
  do { $s = curl_multi_exec($mh, $laeuft); if ($laeuft) curl_multi_select($mh, 1.0); } while ($laeuft && $s === CURLM_OK);
  foreach ($offen as $i => [$c, $datei]) {
    $text = (string)curl_multi_getcontent($c);
    $j = curl_getinfo($c, CURLINFO_RESPONSE_CODE) === 200 ? json_decode($text, true) : null;
    $ts = $j['properties']['timeseries'] ?? null;
    $ergebnis[$i] = is_array($ts) ? $ts : null;
    if ($ergebnis[$i]) { @mkdir(dirname($datei), 0700, true); @file_put_contents($datei, json_encode($ts)); }
    curl_multi_remove_handle($mh, $c);
    curl_close($c);
  }
  curl_multi_close($mh);
  ksort($ergebnis);
  return $ergebnis;
}

// MET-Symbol → WMO-Wettercode wie bei Open-Meteo
function met_wmo(string $sym): int {
  $s = preg_replace('/_(day|night|polartwilight)$/', '', $sym);
  if (str_contains($s, 'thunder')) return 95;
  $stufe = str_starts_with($s, 'heavy') ? 2 : (str_starts_with($s, 'light') ? 0 : 1);
  if (str_contains($s, 'sleet')) return $stufe ? 67 : 66;
  if (str_contains($s, 'snowshowers')) return $stufe === 2 ? 86 : 85;
  if (str_contains($s, 'snow')) return [71, 73, 75][$stufe];
  if (str_contains($s, 'rainshowers')) return [80, 81, 82][$stufe];
  if (str_contains($s, 'rain')) return [61, 63, 65][$stufe];
  return ['clearsky' => 0, 'fair' => 1, 'partlycloudy' => 2, 'cloudy' => 3, 'fog' => 45][$s] ?? 3;
}

function met_umrechnen(array $ts, float $lat, float $lon, int $tage, array $hourly, array $min15, array $current): array {
  $ende = time() + $tage * 86400;
  // nur der stündliche Teil (next_1_hours vorhanden); die 6-Stunden-Schritte danach würden Stundenwerte vortäuschen
  $stunden = [];
  foreach ($ts as $e) {
    $t = strtotime($e['time'] ?? '');
    $n1 = $e['data']['next_1_hours'] ?? null;
    if (!$t || $t > $ende || !$n1) continue;
    $d = $e['data']['instant']['details'] ?? [];
    $mm = (float)($n1['details']['precipitation_amount'] ?? 0);
    $code = met_wmo((string)($n1['summary']['symbol_code'] ?? ''));
    $temp = $d['air_temperature'] ?? null;
    $schnee = in_array($code, [71, 73, 75, 85, 86], true) || ($temp !== null && $temp <= 0.5 && $mm > 0) ? $mm * 0.7 : 0.0;  // cm wie Open-Meteo
    $stunden[] = ['time' => $t, 'weather_code' => $code, 'temperature_2m' => $temp,
      'precipitation' => $mm, 'snowfall' => round($schnee, 2), 'rain' => $schnee ? 0.0 : $mm,
      'precipitation_probability' => isset($n1['details']['probability_of_precipitation']) ? (int)round($n1['details']['probability_of_precipitation']) : null,
      'wind_speed_10m' => isset($d['wind_speed']) ? round($d['wind_speed'] * 3.6, 1) : null,
      // Böen liefert MET nicht überall (z. B. Augsburg): dann grob 1,6 × Mittelwind über Land
      'wind_gusts_10m' => isset($d['wind_speed_of_gust']) ? round($d['wind_speed_of_gust'] * 3.6, 1) : (isset($d['wind_speed']) ? round($d['wind_speed'] * 3.6 * 1.6, 1) : null),
      'wind_direction_10m' => $d['wind_from_direction'] ?? null, 'relative_humidity_2m' => $d['relative_humidity'] ?? null,
      'cloud_cover' => $d['cloud_area_fraction'] ?? null];
  }
  $aus = ['latitude' => $lat, 'longitude' => $lon, 'quelle' => 'MET Norway'];
  if ($hourly) foreach (array_merge(['time'], $hourly) as $f) $aus['hourly'][$f] = array_column($stunden, $f);
  if ($min15) {
    $m = ['time' => []];
    foreach ($stunden as $h) for ($q = 0; $q < 4; $q++) {
      $m['time'][] = $h['time'] + $q * 900;
      foreach ($min15 as $f) $m[$f][] = in_array($f, ['precipitation', 'snowfall', 'rain'], true) ? round($h[$f] / 4, 2) : ($h[$f] ?? null);
    }
    $aus['minutely_15'] = $m;
  }
  if ($current && $stunden) {
    $aus['current'] = ['time' => $stunden[0]['time']];
    foreach ($current as $f) $aus['current'][$f] = $stunden[0][$f] ?? null;
  }
  return $aus;
}
