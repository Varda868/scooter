<?php
// Amtliche Wetterwarnungen entlang einer Route. Deutschland: DWD über Bright Sky (je Warnzelle/Gemeinde),
// übriges Europa: MeteoAlarm (EUMETNET, Feeds je Land). Alles ohne Schlüssel, auf dem Server zwischengespeichert.
// Einheitliche Stufen: 1 gelb, 2 orange, 3 rot, 4 violett (extrem, nur DWD)
defined('SW_API') || exit;

const WARN_BRIGHTSKY = 'https://api.brightsky.dev/alerts';
const WARN_TTL = 900, WARN_MAX_PUNKTE = 60;
const WARN_STUFE_DWD = ['minor' => 1, 'moderate' => 2, 'severe' => 3, 'extreme' => 4];

function warn_cache(string $name): string { return sw_daten(true) . "/cache/warnungen/$name"; }
function warn_cache_lesen(string $name, int $ttl): ?array {
  $f = warn_cache($name);
  $t = @filemtime($f);
  return $t && time() - $t < $ttl ? json_decode((string)@file_get_contents($f), true) : null;
}
function warn_cache_schreiben(string $name, $daten): void {
  $f = warn_cache($name);
  @mkdir(dirname($f), 0700, true);
  $tmp = "$f." . bin2hex(random_bytes(4));
  if (@file_put_contents($tmp, json_encode($daten, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)) !== false) @rename($tmp, $f);
}

// Mehrere GET-Abrufe parallel; Rückgabe [Schlüssel => [status, text]]
function warn_holen(array $urls, int $zeit = 12): array {
  $mh = curl_multi_init(); $h = []; $aus = [];
  foreach ($urls as $k => $u) {
    $c = curl_init($u);
    curl_setopt_array($c, [CURLOPT_RETURNTRANSFER => true, CURLOPT_USERAGENT => 'Scooterways/1 (+https://scooter.thai-klasse.de)',
      CURLOPT_PROTOCOLS => CURLPROTO_HTTPS, CURLOPT_CONNECTTIMEOUT => 6, CURLOPT_TIMEOUT => $zeit, CURLOPT_ENCODING => '']);
    curl_multi_add_handle($mh, $c);
    $h[$k] = $c;
  }
  do { $s = curl_multi_exec($mh, $laeuft); if ($laeuft) curl_multi_select($mh, 1.0); } while ($laeuft && $s === CURLM_OK);
  foreach ($h as $k => $c) {
    $aus[$k] = [(int)curl_getinfo($c, CURLINFO_RESPONSE_CODE), (string)curl_multi_getcontent($c)];
    curl_multi_remove_handle($mh, $c);
    curl_close($c);
  }
  curl_multi_close($mh);
  return $aus;
}

// Grob Deutschland (Nachbarn liefern bei Bright Sky einfach nichts, kosten aber Abrufe)
function warn_in_de(float $la, float $lo): bool { return $la > 47.2 && $la < 55.1 && $lo > 5.8 && $lo < 15.1; }

// DWD: je Punkt (auf 0,05° gerundet, ~5 km) die Warnungen der Warnzelle
function warn_dwd(array $punkte): array {
  $zellen = []; $fehlt = [];
  foreach ($punkte as $i => [$la, $lo]) {
    if (!warn_in_de($la, $lo)) continue;
    $q = sprintf('lat=%.2f&lon=%.2f', round($la * 20) / 20, round($lo * 20) / 20);
    $zellen[$q][] = $i;
  }
  $antwort = [];
  foreach ($zellen as $q => $_) {
    $c = warn_cache_lesen('dwd-' . sha1($q), WARN_TTL);
    if ($c !== null) $antwort[$q] = $c; else $fehlt[$q] = WARN_BRIGHTSKY . '?' . $q;
  }
  foreach (warn_holen($fehlt) as $q => [$st, $text]) {
    $j = $st === 200 ? json_decode($text, true) : null;
    if (!is_array($j)) continue;
    $antwort[$q] = ['alerts' => $j['alerts'] ?? [], 'ort' => $j['location']['name'] ?? null];
    warn_cache_schreiben('dwd-' . sha1($q), $antwort[$q]);
  }
  $aus = [];
  foreach ($antwort as $q => $a) foreach ((array)$a['alerts'] as $w) {
    if (($w['status'] ?? 'actual') !== 'actual' || ($w['category'] ?? 'met') !== 'met') continue;  // health = Hitze/UV
    $id = 'dwd:' . ($w['alert_id'] ?? $w['id'] ?? sha1(json_encode($w)));
    $aus[$id] ??= [
      'id' => $id, 'quelle' => 'DWD', 'stufe' => WARN_STUFE_DWD[$w['severity'] ?? ''] ?? 1,
      'art' => warn_art((string)($w['event_en'] ?? ''), (string)($w['event_de'] ?? '')),
      'ereignis' => warn_text($w['event_de'] ?? $w['event_en'] ?? 'Wetterwarnung'),
      'titel' => warn_text($w['headline_de'] ?? $w['headline_en'] ?? ''),
      'text' => warn_text($w['description_de'] ?? $w['description_en'] ?? '', 600),
      'von' => strtotime($w['onset'] ?? $w['effective'] ?? '') ?: null, 'bis' => strtotime($w['expires'] ?? '') ?: null,
      'gebiet' => $a['ort'], 'punkte' => [],
    ];
    $aus[$id]['punkte'] = array_values(array_unique(array_merge($aus[$id]['punkte'], $zellen[$q])));
  }
  return array_values($aus);
}

// Grobe Art für Symbol und Gewichtung in der App
function warn_art(string ...$texte): string {
  $t = mb_strtolower(implode(' ', $texte));
  foreach ([
    'gewitter' => '/thunder|gewitter/', 'glaette' => '/ice|icy|glätte|glatteis|frost|freez/', 'schnee' => '/snow|schnee/',
    'wind' => '/wind|storm|sturm|orkan|böe|gale|hurricane/', 'regen' => '/rain|regen|flood|hochwasser|überflut/',
    'nebel' => '/fog|nebel/', 'hitze' => '/heat|hitze|high.temp/', 'kaelte' => '/cold|kälte|low.temp/',
    'feuer' => '/fire|brand/', 'lawine' => '/avalanche|lawine/', 'kueste' => '/coast|küste|sturmflut/',
  ] as $art => $re) if (preg_match($re, $t)) return $art;
  return 'sonst';
}
function warn_text($s, int $max = 200): string {
  $s = trim(preg_replace('/\s+/u', ' ', strip_tags((string)$s)));
  return mb_strlen($s) > $max ? mb_substr($s, 0, $max - 1) . '…' : $s;
}

// Punkte aus "lat,lon;lat,lon;…"
function warn_punkte(string $p): ?array {
  $aus = [];
  foreach (array_filter(explode(';', $p)) as $t) {
    $x = explode(',', $t);
    if (count($x) !== 2 || !is_numeric($x[0]) || !is_numeric($x[1])) return null;
    [$la, $lo] = [(float)$x[0], (float)$x[1]];
    if (abs($la) > 90 || abs($lo) > 180) return null;
    $aus[] = [$la, $lo];
  }
  return $aus && count($aus) <= WARN_MAX_PUNKTE ? $aus : null;
}

// --- MeteoAlarm: Warnungen je Land, Gebiete als EMMA_ID; Umrisse aus emma.json (tools/emma-umrisse.py) ---
const WARN_METEOALARM = 'https://feeds.meteoalarm.org/api/v1/warnings/feeds-';
const WARN_LAND = ['AT' => 'austria', 'BA' => 'bosnia-herzegovina', 'BE' => 'belgium', 'BG' => 'bulgaria', 'CY' => 'cyprus',
  'CZ' => 'czechia', 'DK' => 'denmark', 'EE' => 'estonia', 'ES' => 'spain', 'FI' => 'finland', 'FR' => 'france', 'GR' => 'greece',
  'HR' => 'croatia', 'HU' => 'hungary', 'IE' => 'ireland', 'IL' => 'israel', 'IS' => 'iceland', 'IT' => 'italy', 'LT' => 'lithuania',
  'LU' => 'luxembourg', 'LV' => 'latvia', 'MD' => 'moldova', 'ME' => 'montenegro', 'MK' => 'republic-of-north-macedonia',
  'MT' => 'malta', 'NL' => 'netherlands', 'NO' => 'norway', 'PL' => 'poland', 'PT' => 'portugal', 'RO' => 'romania',
  'RS' => 'serbia', 'SE' => 'sweden', 'SI' => 'slovenia', 'SK' => 'slovakia', 'GB' => 'united-kingdom', 'CH' => 'switzerland'];
// Länder ohne Umrisse in emma.json (melden nur Polygone): grob über den Rahmen [Süd, West, Nord, Ost]
const WARN_LAND_RAHMEN = ['GB' => [49.8, -8.7, 60.9, 1.8], 'CH' => [45.8, 5.95, 47.85, 10.5]];
// awareness_type „<n>; <Name>“ → Art
const WARN_ART_MA = [1 => 'wind', 2 => 'glaette', 3 => 'gewitter', 4 => 'nebel', 5 => 'hitze', 6 => 'kaelte', 7 => 'kueste',
  8 => 'feuer', 9 => 'lawine', 10 => 'regen', 12 => 'regen', 13 => 'regen'];
const WARN_MA_TTL = 1200;

function warn_emma(string $teil = 'regionen'): array {
  static $j = null;
  $j ??= json_decode((string)@file_get_contents(__DIR__ . '/emma.json'), true) ?: [];
  return $j[$teil] ?? [];
}
// CAP-Polygon „lat,lon lat,lon …“ → [Rahmen [W, S, O, N], Ring in Tausendstelgrad lon, lat, …]
function warn_polygon(string $s): ?array {
  $ring = [];
  foreach (preg_split('/\s+/', trim($s)) as $paar) {
    $x = explode(',', $paar);
    if (count($x) !== 2 || !is_numeric($x[0]) || !is_numeric($x[1])) return null;
    $ring[] = (int)round($x[1] * 1000); $ring[] = (int)round($x[0] * 1000);
  }
  if (count($ring) < 6) return null;
  $lo = array_filter($ring, fn($k) => $k % 2 === 0, ARRAY_FILTER_USE_KEY); $la = array_diff_key($ring, $lo);
  return [[min($lo) / 1000, min($la) / 1000, max($lo) / 1000, max($la) / 1000], $ring];
}
// Punkt in Ring (flache Liste in Tausendstelgrad lon, lat, …), Strahlverfahren
function warn_im_ring(float $x, float $y, array $r): bool {
  $drin = false; $n = count($r);
  for ($i = 0, $j = $n - 2; $i < $n; $j = $i, $i += 2) {
    [$xi, $yi, $xj, $yj] = [$r[$i], $r[$i + 1], $r[$j], $r[$j + 1]];
    if (($yi > $y) !== ($yj > $y) && $x < ($xj - $xi) * ($y - $yi) / ($yj - $yi) + $xi) $drin = !$drin;
  }
  return $drin;
}
// Index des Punkts → EMMA-Codes, in denen er liegt
function warn_regionen(array $punkte): array {
  $aus = [];
  foreach ($punkte as $i => [$la, $lo]) {
    // Deutschland ist nicht in emma.json (das macht der DWD feiner), Punkte dort finden also nichts
    foreach (warn_emma() as [$code, $b, $ringe]) {
      if ($lo < $b[0] || $lo > $b[2] || $la < $b[1] || $la > $b[3]) continue;
      foreach ($ringe as $r) if (warn_im_ring($lo * 1000, $la * 1000, $r)) { $aus[$i][] = $code; break; }
    }
  }
  return $aus;
}
// Feed eines Landes verdichten: nur aktuelle Warnungen ab Gelb, je Warnung Gebiete, Stufe, Art, Zeiten, Texte (de, sonst en)
function warn_ma_verdichten(string $text): ?array {
  $j = json_decode($text, true);
  if (!is_array($j)) return null;
  $aus = [];
  foreach ((array)($j['warnings'] ?? []) as $w) {
    $a = $w['alert'] ?? [];
    if (($a['status'] ?? '') !== 'Actual' || ($a['msgType'] ?? '') === 'Cancel') continue;
    $infos = (array)($a['info'] ?? []);
    usort($infos, fn($x, $y) => warn_sprachrang($x['language'] ?? '') <=> warn_sprachrang($y['language'] ?? ''));
    $i = $infos[0] ?? null;
    if (!$i) continue;
    $par = array_column((array)($i['parameter'] ?? []), 'value', 'valueName');
    $stufe = (int)($par['awareness_level'] ?? 0) - 1;
    $bis = strtotime($i['expires'] ?? '') ?: null;
    if ($stufe < 1 || ($bis && $bis < time())) continue;
    // Gebiete als EMMA_ID, als NUTS-Code (FR, HU; über alias) oder als eigenes Polygon (NO, SE, GB, CH, FR-Küste)
    $gebiete = []; $flaechen = []; $alias = warn_emma('alias');
    foreach ((array)($i['area'] ?? []) as $ar) {
      foreach ((array)($ar['geocode'] ?? []) as $g) {
        $art = (string)($g['valueName'] ?? ''); $v = (string)($g['value'] ?? '');
        if ($art === 'EMMA_ID' || str_starts_with($art, 'NUTS')) $gebiete[$alias[$v] ?? $v] = $ar['areaDesc'] ?? '';
      }
      foreach ((array)($ar['polygon'] ?? []) as $pg) if (is_string($pg) && ($f = warn_polygon($pg))) $flaechen[] = [...$f, $ar['areaDesc'] ?? ''];
    }
    if (!$gebiete && !$flaechen) continue;
    $aus[] = ['id' => 'ma:' . ($a['identifier'] ?? sha1(json_encode($i))), 'quelle' => 'MeteoAlarm' . (isset($i['senderName']) ? ' · ' . $i['senderName'] : ''),
      'stufe' => min(3, $stufe), 'art' => WARN_ART_MA[(int)($par['awareness_type'] ?? 0)] ?? warn_art((string)($i['event'] ?? '')),
      'ereignis' => warn_text($i['event'] ?? 'Wetterwarnung'), 'titel' => warn_text($i['headline'] ?? ''),
      'text' => warn_text($i['description'] ?? '', 600),
      'von' => strtotime($i['onset'] ?? $i['effective'] ?? '') ?: null, 'bis' => $bis, 'gebiete' => $gebiete, 'flaechen' => $flaechen];
  }
  return $aus;
}
function warn_sprachrang(string $l): int { return str_starts_with($l, 'de') ? 0 : (str_starts_with($l, 'en') ? 1 : 2); }

function warn_meteoalarm(array $punkte): array {
  $reg = warn_regionen($punkte);
  $laender = [];
  foreach ($reg as $codes) foreach ($codes as $c) if (isset(WARN_LAND[substr($c, 0, 2)])) $laender[substr($c, 0, 2)] = true;
  foreach ($punkte as [$la, $lo]) foreach (WARN_LAND_RAHMEN as $l => [$s, $w, $n, $o]) if ($la >= $s && $la <= $n && $lo >= $w && $lo <= $o) $laender[$l] = true;
  // fehlende Länder parallel vorladen, dann aus dem Speicher lesen
  $fehlt = [];
  foreach (array_keys($laender) as $l) if (warn_cache_lesen("ma-$l", WARN_MA_TTL) === null) $fehlt[$l] = WARN_METEOALARM . WARN_LAND[$l];
  foreach (warn_holen($fehlt, 20) as $l => [$st, $text])
    if ($st === 200 && ($v = warn_ma_verdichten($text)) !== null) warn_cache_schreiben("ma-$l", $v);
  $aus = [];
  foreach (array_keys($laender) as $l) foreach (warn_cache_lesen("ma-$l", WARN_MA_TTL + 600) ?? [] as $w) {
    if ($w['bis'] && $w['bis'] < time()) continue;
    $pk = []; $namen = [];
    foreach ($punkte as $i => [$la, $lo]) {
      $treffer = array_intersect($reg[$i] ?? [], array_keys($w['gebiete']));
      foreach ($treffer as $c) $namen[] = $w['gebiete'][$c];
      foreach ($w['flaechen'] ?? [] as [$b, $ring, $name])
        if ($lo >= $b[0] && $lo <= $b[2] && $la >= $b[1] && $la <= $b[3] && warn_im_ring($lo * 1000, $la * 1000, $ring)) { $treffer = true; $namen[] = $name; }
      if ($treffer) $pk[] = $i;
    }
    if (!$pk) continue;
    unset($w['gebiete'], $w['flaechen']);
    $aus[] = $w + ['gebiet' => implode(', ', array_slice(array_values(array_unique(array_filter($namen))), 0, 3)), 'punkte' => $pk];
  }
  return $aus;
}
