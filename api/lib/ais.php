<?php
// AIS-Fähren: lernender Fahrplan aus Schiffspositionen (Admin → Fährdaten, Lauf faehren-ais alle 15 min).
// Gespeichert werden keine Spuren, nur Ereignisse „Abfahrt/Ankunft je Hafen“ (Schiff, Hafen, Zeit), 60 Tage lang.
// Daraus baut der Lauf wöchentlich poi/fahrplan/ais.json: Linie, typische Abfahrtszeiten je Wochentag, Dauer als Median.
//
// Quellen: aisstream.io (WebSocket, je Lauf ~60 s offen) und BarentsWatch (Norwegen, OAuth + REST).
// Häfen: Endpunkte der OSM-Fährlinien aus poi/f/ (je Kachelstand einmal zu Häfen zusammengefasst).
// Schiffe: gepflegte MMSI-Liste (Admin) plus gelernte Passagierschiffe (AIS-Schiffstyp 60–69, im Hafen gesehen).
defined('SW_API') || exit;

const AIS_HAFEN_M = 1000;          // Radius um einen Anleger
const AIS_LANGSAM_KN = 1.0;        // darunter: liegt
const AIS_ABFAHRT_KN = 3.0;        // im Hafen erst ab diesem Tempo „abgefahren“ (Verholen an einen anderen Liegeplatz zählt nicht)
const AIS_SEKUNDEN = 60;           // WebSocket offen
const AIS_LUECKE_S = 1200;         // zwei Beobachtungen höchstens so weit auseinander → Zeit gilt als genau
const AIS_TAGE = 60;               // Rohereignisse
const AIS_FAHRPLAN_TAGE = 7;       // Fahrplan neu bauen
const AIS_MAX_MMSI = 200;          // aisstream: höchstens 200 MMSI je Abo
const AIS_MAX_GELERNT = 2000;
const AIS_FEHL_MELDEN = 4;         // aisstream so oft hintereinander gescheitert → Problem (Mail)
const AIS_STREAM = 'wss://stream.aisstream.io/v0/stream';
const AIS_BW_TOKEN = 'https://id.barentswatch.no/connect/token';
const AIS_BW_LIVE = 'https://live.ais.barentswatch.no/v1/latest/combined';
const AIS_EUROPA = [[[27.0, -19.0], [72.0, 32.0]]];  // Kanaren bis Nordkap
const AIS_UA = 'Scooterways-Faehren/1 (+https://scooterways.dns.navy)';

// --- Häfen: [key, name, lat, lon, tz]; key = Mittelpunkt auf 3 Stellen. Nachbarn: Häfen, die eine OSM-Fährlinie verbindet.
function ais_index(bool $neu = false): array {
  static $mem = null;
  if ($mem && !$neu) return $mem;
  $ix = json_decode((string)@file_get_contents(sw_docroot() . '/poi/index.json'), true);
  $stand = (string)($ix['date'] ?? '');
  $datei = sw_daten(true) . '/ais-haefen.json';
  $alt = json_decode((string)@file_get_contents($datei), true);
  if (!$neu && is_array($alt) && ($alt['stand'] ?? null) === $stand && !empty($alt['haefen'])) return $mem = $alt;
  $punkte = [];  // [lat, lon, Name oder null, Linie]
  foreach (faehr_osm_linien() as $id => $l) {
    // Endpunkte der Teile; Stellen, an denen zwei Teile aneinanderstoßen, sind keine Anleger
    $n = [];
    foreach ($l['teile'] as $pts) if (count($pts) >= 2) foreach ([$pts[0], end($pts)] as $q) {
      $k = round($q[0], 4) . ',' . round($q[1], 4);
      $n[$k] = [($n[$k][0] ?? 0) + 1, $q];
    }
    foreach ($n as [$c, $q]) if ($c === 1) $punkte[] = [$q[0], $q[1], null, "o$id"];
  }
  foreach (FAEHR_REFERENZ as $meer => $ref) foreach ($ref as $r => [$a, $la1, $lo1, $b, $la2, $lo2]) { $punkte[] = [$la1, $lo1, $a, "r$meer$r"]; $punkte[] = [$la2, $lo2, $b, "r$meer$r"]; }
  // Zusammenfassen: alles innerhalb AIS_HAFEN_M um den ersten Punkt eines Hafens
  $haefen = []; $gitter = []; $linien = [];
  foreach ($punkte as [$la, $lo, $name, $lid]) {
    $h = ais_hafen_bei($haefen, $gitter, $la, $lo);
    if ($h === null) { $haefen[] = ['lat' => $la, 'lon' => $lo, 'ref' => null]; $h = count($haefen) - 1; $gitter[ais_zelle($la, $lo)][] = $h; }
    if ($name !== null && $haefen[$h]['ref'] === null) $haefen[$h]['ref'] = $name;
    $linien[$lid][$h] = 1;
  }
  $aus = []; $nachbarn = [];
  foreach ($haefen as $h) $aus[] = [sprintf('%.3f,%.3f', $h['lat'], $h['lon']), $h['ref'], round($h['lat'], 5), round($h['lon'], 5), ais_tz($h['lat'], $h['lon'])];
  foreach ($linien as $hs) foreach (array_keys($hs) as $a) foreach (array_keys($hs) as $b) if ($a !== $b) $nachbarn[$aus[$a][0]][$aus[$b][0]] = 1;
  $nachbarn = array_map('array_keys', $nachbarn);
  $mem = ['stand' => $stand, 'haefen' => $aus, 'nachbarn' => $nachbarn];
  @file_put_contents($datei, json_encode($mem, JSON_UNESCAPED_UNICODE));
  return $mem;
}
function ais_haefen(bool $neu = false): array { return ais_index($neu)['haefen']; }
function ais_zelle(float $la, float $lo): string { return (int)floor($la / 0.02) . ':' . (int)floor($lo / 0.03); }
// Index des nächsten Hafens im Radius; $haefen als Liste mit lat/lon (Aufbau) oder als [key, name, lat, lon, tz]
function ais_hafen_bei(array $haefen, array $gitter, float $la, float $lo): ?int {
  $zi = (int)floor($la / 0.02); $zo = (int)floor($lo / 0.03); $best = null; $bm = AIS_HAFEN_M;
  for ($a = -1; $a <= 1; $a++) for ($b = -1; $b <= 1; $b++) foreach ($gitter[($zi + $a) . ':' . ($zo + $b)] ?? [] as $k) {
    $h = $haefen[$k];
    $m = faehr_m($la, $lo, (float)($h['lat'] ?? $h[2]), (float)($h['lon'] ?? $h[3]));
    if ($m <= $bm) { $bm = $m; $best = $k; }
  }
  return $best;
}
function ais_gitter(array $haefen): array {
  $g = [];
  foreach ($haefen as $k => $h) $g[ais_zelle($h[2], $h[3])][] = $k;
  return $g;
}

// Zeitzone eines Anlegers, grob nach Lage (nur Küsten mit Fähren zählen). Standard: Mitteleuropa.
function ais_tz(float $la, float $lo): string {
  $in = fn($la1, $la2, $lo1, $lo2) => $la >= $la1 && $la <= $la2 && $lo >= $lo1 && $lo <= $lo2;
  if ($in(27, 29.6, -18.5, -13)) return 'Atlantic/Canary';
  if ($lo < -24) return 'Atlantic/Azores';
  if ($in(32, 33.3, -17.5, -16)) return 'Atlantic/Madeira';
  if ($la > 62.8 && $lo < -12) return 'Atlantic/Reykjavik';
  if ($in(61.3, 62.5, -8, -6)) return 'Atlantic/Faroe';
  if ($in(35.86, 35.92, -5.39, -5.26) || $in(35.26, 35.33, -2.98, -2.91)) return 'Europe/Madrid';  // Ceuta, Melilla
  if ($la < 35.95 && $lo > -13 && $lo < -1.0) return 'Africa/Casablanca';
  if ($la < 37.3 && $lo >= -1.0 && $lo < 8.6) return 'Africa/Algiers';
  if ($la < 37.6 && $lo >= 8.6 && $lo < 11.7 && !$in(36.7, 36.9, 11.9, 12.1)) return 'Africa/Tunis';
  if ($in(36.9, 42.15, -10, -7.42)) return 'Europe/Lisbon';
  // Großbritannien, Irland, Kanalinseln (Frankreichs Nordküste bleibt draußen: Boulogne, Calais, Dunkerque)
  if ($in(49.15, 49.75, -2.75, -2.0) || ($la >= 49.85 && $lo < -1.0) || ($la > 58.5 && $lo < 0) ||
      ($la >= 50.7 && $lo >= -1.0 && $lo <= 0.6) || ($la >= 51.0 && $lo > 0.6 && $lo <= 1.8) || ($la >= 51.5 && $lo > 0.6 && $lo < 2.0)) return 'Europe/London';
  // Osteuropäische Zeit: Finnland, Åland, Baltikum, Griechenland, Bulgarien/Rumänien/Ukraine, Zypern; Türkei UTC+3
  if ($la >= 59.5 && $lo >= 28.0) return 'Europe/Moscow';
  if ($la >= 59.7 && $lo >= 19.3) return 'Europe/Helsinki';
  if ($in(55.6, 59.7, 20.9, 28.0)) return 'Europe/Riga';
  if ($in(54.3, 55.3, 19.6, 22.9)) return 'Europe/Kaliningrad';
  if ($in(34.5, 35.75, 32.2, 34.6)) return 'Asia/Nicosia';
  if ($la >= 41.98 && $lo >= 27.4) return 'Europe/Sofia';
  if ($in(34.5, 42.2, 26.0, 45)) {
    // griechische Inseln vor der türkischen Küste
    foreach ([[38.9, 39.45, 25.8, 26.65], [38.1, 38.65, 25.8, 26.2], [37.55, 37.85, 26.5, 27.1], [36.95, 37.45, 26.45, 27.1], [36.65, 36.97, 26.9, 27.37],
      [36.35, 36.65, 27.1, 27.9], [35.8, 36.5, 27.65, 28.3], [36.1, 36.2, 29.55, 29.65]] as $g) if ($in(...$g)) return 'Europe/Athens';
    if ($lo >= 26.15 || ($la >= 40.6 && $lo >= 26.05)) return 'Europe/Istanbul';
  }
  if ($in(34.5, 41.8, 19.3, 30) && ($lo >= 20.15 || $la < 39.85)) return 'Europe/Athens';
  return 'Europe/Berlin';
}

// --- Schiffe: gepflegte Liste (config) + gelernt (DB)
function ais_liste(): array {
  $l = [];
  foreach ((array)(sw_config()['faehren']['ais_liste'] ?? []) as $e) if (preg_match('/^\d{9}$/', (string)($e[0] ?? ''))) $l[(string)$e[0]] = (string)($e[1] ?? '');
  return $l;
}
function ais_schiffe(): array {
  $s = [];
  foreach (sw_db()->query('SELECT mmsi, name FROM sw_ais_schiff ORDER BY zuletzt DESC')->fetchAll() as $r) $s[(string)$r['mmsi']] = (string)$r['name'];
  foreach (ais_liste() as $m => $n) $s = [$m => $n ?: ($s[$m] ?? '')] + $s;  // gepflegte zuerst
  return $s;
}
function ais_lernen(string $mmsi, string $name, int $typ, string $quelle): void {
  if (!preg_match('/^\d{9}$/', $mmsi)) return;
  $db = sw_db();
  $q = $db->prepare('UPDATE sw_ais_schiff SET name = ?, typ = ?, zuletzt = ? WHERE mmsi = ?');
  $q->execute([mb_substr($name, 0, 60), $typ, time(), $mmsi]);
  if ($q->rowCount() === 0 && (int)$db->query('SELECT COUNT(*) FROM sw_ais_schiff')->fetchColumn() < AIS_MAX_GELERNT)
    $db->prepare('INSERT INTO sw_ais_schiff (mmsi, name, typ, quelle, t, zuletzt) VALUES (?, ?, ?, ?, ?, ?)')->execute([$mmsi, mb_substr($name, 0, 60), $typ, $quelle, time(), time()]);
}

// --- aisstream.io: Abo schicken, AIS_SEKUNDEN lesen, trennen. Beobachtungen: [mmsi, t, lat, lon, sog, name]
function ais_aisstream(string $key, array $boxen, array $mmsi, bool $lernen, array &$i, ?callable $statisch = null): array {
  $t = relay_teile(AIS_STREAM);
  $ctx = ['verify_peer' => true, 'verify_peer_name' => true, 'peer_name' => $t['name'], 'SNI_enabled' => true];
  $s = @stream_socket_client("ssl://{$t['host']}:{$t['port']}", $errno, $errstr, 10, STREAM_CLIENT_CONNECT, stream_context_create(['ssl' => $ctx]));
  if (!$s) throw new RuntimeException('aisstream: keine Verbindung (' . relay_text($errstr) . ')');
  $obs = []; $n = 0;
  try {
    relay_handshake($s, $t);
    $abo = ['APIKey' => $key, 'BoundingBoxes' => $boxen, 'FilterMessageTypes' => $lernen
      ? ['PositionReport', 'StandardClassBPositionReport', 'ShipStaticData'] : ['PositionReport', 'StandardClassBPositionReport']];
    if ($mmsi) $abo['FiltersShipMMSI'] = array_values(array_map('strval', $mmsi));
    relay_senden($s, json_encode($abo));
    $ende = microtime(true) + AIS_SEKUNDEN;
    while (microtime(true) < $ende) {
      try { $m = relay_lesen($s, $ende); } catch (RuntimeException $e) { if ($e->getMessage() === 'Zeitüberschreitung') break; throw $e; }
      if ($m === null) break;
      $j = json_decode($m, true);
      if (!is_array($j)) continue;
      if (isset($j['error'])) throw new RuntimeException('aisstream meldet: ' . relay_text(str_replace($key, '***', (string)$j['error'])));
      $n++;
      $md = array_change_key_case((array)($j['MetaData'] ?? []));
      $id = (string)($md['mmsi'] ?? '');
      $typ = (string)($j['MessageType'] ?? '');
      $msg = (array)($j['Message'][$typ] ?? []);
      if ($typ === 'ShipStaticData') { if ($statisch) $statisch($id, trim((string)($md['shipname'] ?? $msg['Name'] ?? '')), (int)($msg['Type'] ?? 0)); continue; }
      $la = $msg['Latitude'] ?? $md['latitude'] ?? null; $lo = $msg['Longitude'] ?? $md['longitude'] ?? null;
      if (!is_numeric($la) || !is_numeric($lo) || !isset($msg['Sog']) || abs((float)$la) > 90) continue;
      $obs[] = [$id, time(), (float)$la, (float)$lo, (float)$msg['Sog'], trim((string)($md['shipname'] ?? ''))];
    }
    relay_senden($s, '', 0x8);
  } finally { fclose($s); }
  $i[] = "aisstream: $n Nachrichten in " . AIS_SEKUNDEN . ' s, ' . count($obs) . ' Positionen' . ($lernen ? ' (Lernlauf an den Häfen)' : ' (' . count($mmsi) . ' Schiffe)');
  return $obs;
}

// --- BarentsWatch: Token (Client Credentials, scope ais), dann die Liste per POST; einmal täglich alle Schiffe zum Lernen
function ais_bw_token(string &$fehler): ?string {
  $id = (string)sw_wert('barentswatch_id'); $geheim = (string)sw_wert('barentswatch_secret');
  if ($id === '' || $geheim === '') { $fehler = 'kein Zugang eingetragen'; return null; }
  $c = curl_init(AIS_BW_TOKEN);
  curl_setopt_array($c, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => http_build_query(['grant_type' => 'client_credentials', 'client_id' => $id, 'client_secret' => $geheim, 'scope' => 'ais']),
    CURLOPT_HTTPHEADER => ['Content-Type: application/x-www-form-urlencoded'], CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 20,
    CURLOPT_PROTOCOLS => CURLPROTO_HTTPS, CURLOPT_USERAGENT => AIS_UA]);
  $r = curl_exec($c); $st = (int)curl_getinfo($c, CURLINFO_RESPONSE_CODE); curl_close($c);
  $j = json_decode((string)$r, true);
  if ($st === 200 && is_string($j['access_token'] ?? null)) return $j['access_token'];
  // nur Status und Fehlercode, nie Antworttext (könnte die Client-ID wiederholen)
  $fehler = "Token abgelehnt (HTTP $st" . (preg_match('/^[a-z_]{3,40}$/', (string)($j['error'] ?? '')) ? ', ' . $j['error'] : '') . ')' .
    (!str_contains($id, ':') ? ' – Client-ID muss die Form „mail:clientname“ haben' : '');
  return null;
}
function ais_barentswatch(string $token, ?array $mmsi, array &$i): array {
  $c = curl_init(AIS_BW_LIVE);
  $kopf = ['Authorization: Bearer ' . $token];
  if ($mmsi !== null) { $kopf[] = 'Content-Type: application/json'; curl_setopt($c, CURLOPT_POSTFIELDS, json_encode(['mmsi' => array_map('intval', $mmsi)])); }
  curl_setopt_array($c, [CURLOPT_HTTPHEADER => $kopf, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 60, CURLOPT_ENCODING => '',
    CURLOPT_PROTOCOLS => CURLPROTO_HTTPS, CURLOPT_USERAGENT => AIS_UA]);
  $r = curl_exec($c); $st = (int)curl_getinfo($c, CURLINFO_RESPONSE_CODE); curl_close($c);
  if ($st !== 200) throw new RuntimeException("BarentsWatch: HTTP $st");
  $obs = [];
  foreach ((array)json_decode((string)$r, true) as $v) {
    if (!is_array($v) || !isset($v['mmsi'], $v['latitude'], $v['longitude'], $v['speedOverGround'])) continue;
    $t = strtotime((string)($v['msgtime'] ?? '')) ?: 0;
    if (time() - $t > AIS_LUECKE_S) continue;  // alte Meldung: sagt nichts über jetzt
    $obs[] = [(string)$v['mmsi'], $t, (float)$v['latitude'], (float)$v['longitude'], (float)$v['speedOverGround'], trim((string)($v['name'] ?? '')), (int)($v['shipType'] ?? 0)];
  }
  $i[] = 'BarentsWatch: ' . count($obs) . ' aktuelle Positionen' . ($mmsi === null ? ' (alle Schiffe, Lernlauf)' : ' (' . count($mmsi) . ' Schiffe)');
  return $obs;
}

// --- Beobachtungen → Ereignisse. Zustand je Schiff: ort (Hafen-key oder ''), liegt, t (letzte Beobachtung),
// b/bla/blo/bv (letzte Beobachtung in Fahrt: Zeit, Ort, Tempo). Weil jeder Lauf nur eine Minute zuhört, liegen zwischen
// zwei Beobachtungen oft 15–45 min (liegende Schiffe melden nur alle 3 min). Die Zeiten werden deshalb aus Abstand und
// Tempo zurück- bzw. vorgerechnet: Abfahrt = erste Sichtung unterwegs − Weg/Tempo, Ankunft = letzte Sichtung in Fahrt + Weg/Tempo.
function ais_verarbeiten(array $obs, array $haefen, array $gitter, array $nur, array $nachbarn = []): int {
  $db = sw_db(); $neu = 0;
  $pos = []; foreach ($haefen as $h) $pos[$h[0]] = [$h[2], $h[3]];
  usort($obs, fn($a, $b) => $a[1] <=> $b[1]);
  $hol = $db->prepare('SELECT ort, liegt, t, b, bla, blo, bv FROM sw_ais_zustand WHERE mmsi = ?');
  $ins = $db->prepare('INSERT INTO sw_ais_ereignis (mmsi, hafen, art, t, genau) VALUES (?, ?, ?, ?, ?)');
  $weg = $db->prepare('DELETE FROM sw_ais_zustand WHERE mmsi = ?');
  $setz = $db->prepare('INSERT INTO sw_ais_zustand (mmsi, ort, liegt, t, b, bla, blo, bv) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  $kn = fn(float $v) => max(0.5, $v) * 1852 / 3600;  // Knoten → m/s
  $zustand = [];
  foreach ($obs as [$m, $t, $la, $lo, $sog]) {
    if (!isset($nur[$m])) continue;
    if (!isset($zustand[$m])) { $hol->execute([$m]); $zustand[$m] = $hol->fetch() ?: ['ort' => '', 'liegt' => 0, 't' => 0, 'b' => 0, 'bla' => null, 'blo' => null, 'bv' => null]; }
    $z = &$zustand[$m];
    if ($t <= (int)$z['t']) { unset($z); continue; }
    $k = ais_hafen_bei($haefen, $gitter, $la, $lo);
    $hafen = $k === null ? '' : $haefen[$k][0];
    if ($sog < AIS_LANGSAM_KN && $hafen !== '') {
      if (!($z['liegt'] && $z['ort'] === $hafen)) {
        // Abfahrt dort verpasst (liegt jetzt woanders): Zeit nur als Untergrenze
        if ($z['liegt'] && $z['ort'] !== '') { $ins->execute([$m, $z['ort'], 'ab', (int)$z['t'], 0]); $neu++; }
        $an = $t; $genau = false;
        if ((int)$z['b'] && $z['bla'] !== null && $t - (int)$z['b'] <= 3 * 3600) {
          $rest = faehr_m((float)$z['bla'], (float)$z['blo'], $pos[$hafen][0], $pos[$hafen][1]) / $kn((float)$z['bv']);
          $an = (int)round(min($t, (int)$z['b'] + $rest));
          $genau = $rest <= 1800 || $t - (int)$z['b'] <= AIS_LUECKE_S;
        }
        $ins->execute([$m, $hafen, 'an', $an, $genau ? 1 : 0]); $neu++;
        $z['ort'] = $hafen; $z['liegt'] = 1;
      }
    } elseif ($z['liegt'] && $z['ort'] !== '' && ($hafen !== $z['ort'] || $sog >= AIS_ABFAHRT_KN)) {
      if ($hafen === $z['ort']) { $ab = $t; $genau = true; }  // im Hafen in Fahrt gesehen
      else {
        $schon = faehr_m($pos[$z['ort']][0] ?? $la, $pos[$z['ort']][1] ?? $lo, $la, $lo) / $kn($sog);
        $ab = (int)round(max((int)$z['t'], $t - $schon));
        // genau nur, wenn es kurz vorher noch lag (sonst kann es schon ganz woanders gewesen sein)
        $genau = $t - (int)$z['t'] <= AIS_LUECKE_S || ($sog >= AIS_ABFAHRT_KN && $schon <= 1800 && $t - (int)$z['t'] <= $schon + 1800);
      }
      $ins->execute([$m, $z['ort'], 'ab', $ab, $genau ? 1 : 0]); $neu++;
      $z['liegt'] = 0;
    } elseif (!$z['liegt'] && $z['ort'] !== '' && $hafen !== '' && $hafen !== $z['ort'] && in_array($hafen, $nachbarn[$z['ort']] ?? [], true)) {
      // in Fahrt im Anleger-Radius des Gegenhafens: legt gerade an oder ab, zählt als Anlauf
      $ins->execute([$m, $hafen, 'an', $t, $t - (int)$z['t'] <= 3 * 3600 ? 1 : 0]); $neu++;
      $z['ort'] = $hafen; $z['liegt'] = 1;
    } elseif (!$z['liegt'] && $z['ort'] !== '' && $sog >= AIS_LANGSAM_KN && (int)$z['b'] && $z['bla'] !== null && $t - (int)$z['b'] <= 6 * 3600) {
      // Kurze Wende verpasst (zwischen zwei Läufen angelegt und wieder abgelegt): Gegenhafen Y einer Linie ab dem letzten
      // Hafen, wenn der Weg über Y zeitlich passt und deutlich länger ist als der direkte (das Schiff hat also umgedreht)
      $q = [(float)$z['bla'], (float)$z['blo']]; $vq = $kn((float)$z['bv']); $vp = $kn($sog);
      $direkt = faehr_m($q[0], $q[1], $la, $lo); $best = null;
      foreach ($nachbarn[$z['ort']] ?? [] as $y) {
        if (!isset($pos[$y])) continue;
        $d1 = faehr_m($q[0], $q[1], $pos[$y][0], $pos[$y][1]); $d2 = faehr_m($pos[$y][0], $pos[$y][1], $la, $lo);
        if ($d1 + $d2 < 1.4 * $direkt + 2 * AIS_HAFEN_M) continue;
        $an = (int)$z['b'] + $d1 / $vq; $ab = $t - $d2 / $vp;
        if ($ab < $an - 600 || $ab - $an > 3 * 3600) continue;
        $schlupf = abs(($ab - $an) - 900);
        if (!$best || $schlupf < $best[0]) $best = [$schlupf, $y, (int)round($an), (int)round(max($an, $ab)), $d1 / $vq, $d2 / $vp];
      }
      if ($best) {
        [, $y, $an, $ab, $s1, $s2] = $best;
        $ins->execute([$m, $y, 'an', $an, $s1 <= 1800 ? 1 : 0]); $ins->execute([$m, $y, 'ab', $ab, $s2 <= 1800 ? 1 : 0]); $neu += 2;
        $z['ort'] = $y;
      }
    }
    if ($sog >= AIS_LANGSAM_KN) { $z['b'] = $t; $z['bla'] = $la; $z['blo'] = $lo; $z['bv'] = $sog; }
    $z['t'] = $t;
    unset($z);
  }
  foreach ($zustand as $m => $z) { $weg->execute([$m]); $setz->execute([$m, $z['ort'], (int)$z['liegt'], (int)$z['t'], (int)$z['b'], $z['bla'], $z['blo'], $z['bv']]); }
  return $neu;
}

// --- Lauf
function faehr_lauf_ais(array &$p, array &$i, bool $manuell = false, bool $nur_auswerten = false): ?int {
  $db = sw_db();
  if ($nur_auswerten) return ais_fahrplan($p, $i);
  $key = (string)sw_wert('aisstream_key');
  $hatBw = (string)sw_wert('barentswatch_id') !== '' && (string)sw_wert('barentswatch_secret') !== '';
  if ($key === '' && !$hatBw) { $i[] = 'Weder aisstream.io noch BarentsWatch eingetragen, übersprungen'; return null; }
  $haefen = ais_haefen();
  if (!$haefen) { $p[] = 'Keine Häfen: poi/f/ (Fährkacheln) fehlt'; return null; }
  $gitter = ais_gitter($haefen);
  $schiffe = ais_schiffe();
  $alle = $schiffe;
  $i[] = count($haefen) . ' Häfen, ' . count($schiffe) . ' Schiffe (' . count(ais_liste()) . ' gepflegt)';
  $obs = [];

  if ($key !== '') {
    // Lernlauf alle 3 Stunden (und solange die Liste leer ist): kleine Felder um die bekannten Fährhäfen, Passagierschiffe merken
    $lernen = !$schiffe || ((int)date('G') % 3 === 0 && (int)date('i') < 15);
    try {
      if ($lernen) {
        $boxen = [];
        foreach (FAEHR_REFERENZ as $ref) foreach ($ref as [, $la1, $lo1, , $la2, $lo2])
          foreach ([[$la1, $lo1], [$la2, $lo2]] as [$la, $lo]) $boxen[sprintf('%.2f,%.2f', $la, $lo)] = [[round($la - 0.02, 3), round($lo - 0.03, 3)], [round($la + 0.02, 3), round($lo + 0.03, 3)]];
        $gelernt = 0;
        $obs = ais_aisstream($key, array_values($boxen), [], true, $i, function ($m, $name, $typ) use (&$gelernt, &$alle) {
          if ($typ >= 60 && $typ <= 69) { ais_lernen($m, $name, $typ, 'aisstream'); $alle[$m] = $name; $gelernt++; }
        });
        $i[] = "Lernlauf: $gelernt Passagierschiffe an den Häfen gesehen";
      } else {
        // Reihum, wenn mehr als 200 Schiffe bekannt sind: gepflegte immer, die übrigen im Wechsel
        $ms = array_keys($schiffe); $fest = array_keys(ais_liste());
        if (count($ms) > AIS_MAX_MMSI) {
          $rest = array_values(array_diff($ms, $fest)); $platz = max(0, AIS_MAX_MMSI - count($fest));
          $start = $rest ? ((int)(time() / 900) * $platz) % count($rest) : 0;
          $ms = array_merge(array_slice($fest, 0, AIS_MAX_MMSI), array_slice(array_merge($rest, $rest), $start, min($platz, count($rest))));
        }
        $obs = ais_aisstream($key, AIS_EUROPA, $ms, false, $i);
      }
      wartung_meta('ais_fehl', '0');
    } catch (Throwable $e) {
      $n = (int)wartung_meta('ais_fehl') + 1; wartung_meta('ais_fehl', (string)$n);
      $text = str_replace($key, '***', $e->getMessage());
      if ($n >= AIS_FEHL_MELDEN) $p[] = "$text ($n Läufe hintereinander)"; else $i[] = "$text ($n. Mal, gemeldet ab " . AIS_FEHL_MELDEN . ')';
    }
  }

  if ($hatBw) {
    $f = '';
    $token = ais_bw_token($f);
    wartung_meta('ais_bw', $token ? 'ok ' . time() : mb_substr("$f " . time(), 0, 200));
    if (!$token) $i[] = "BarentsWatch übersprungen: $f";
    else try {
      // einmal täglich (erster Lauf nach 04:00) alle Schiffe holen und Passagierschiffe an Anlegern lernen
      if ((int)date('G') === 4 && (int)date('i') < 15) {
        foreach (ais_barentswatch($token, null, $i) as $o) {
          if ($o[6] < 60 || $o[6] > 69 || ais_hafen_bei($haefen, $gitter, $o[2], $o[3]) === null) continue;
          ais_lernen($o[0], $o[5], $o[6], 'barentswatch'); $alle[$o[0]] = $o[5];
        }
      }
      // norwegische Schiffe (MMSI 257–259) und alles, was BarentsWatch gelernt hat
      $bw = array_map('strval', $db->query("SELECT mmsi FROM sw_ais_schiff WHERE quelle = 'barentswatch'")->fetchAll(PDO::FETCH_COLUMN));
      $nor = array_values(array_unique(array_merge($bw, array_filter(array_keys($alle), fn($m) => preg_match('/^25[789]/', (string)$m)))));
      if ($nor) $obs = array_merge($obs, ais_barentswatch($token, array_slice($nor, 0, 1000), $i));
    } catch (Throwable $e) { $i[] = $e->getMessage(); }
  }

  $neu = ais_verarbeiten($obs, $haefen, $gitter, $alle, ais_index()['nachbarn']);
  if ($neu) $db->prepare('UPDATE sw_ais_schiff SET zuletzt = ? WHERE mmsi IN (SELECT DISTINCT mmsi FROM sw_ais_ereignis WHERE t > ?)')->execute([time(), time() - 3600]);
  $i[] = "$neu neue Hafen-Ereignisse";
  // Aufräumen: Rohereignisse 60 Tage, Zustände und gelernte Schiffe, die so lange nicht mehr gesehen wurden
  $alt = time() - AIS_TAGE * 86400;
  $db->exec("DELETE FROM sw_ais_ereignis WHERE t < $alt");
  $db->exec("DELETE FROM sw_ais_zustand WHERE t < $alt");
  $db->exec("DELETE FROM sw_ais_schiff WHERE zuletzt < $alt");
  // wöchentlich den Fahrplan
  if (time() - (int)wartung_meta('ais_fahrplan') > AIS_FAHRPLAN_TAGE * 86400) return ais_fahrplan($p, $i);
  return null;
}

// --- Lernender Fahrplan: Fahrten = Abfahrt X (genau) und die nächste Ankunft Y ≠ X desselben Schiffs innerhalb von 36 h
function ais_fahrplan(array &$p, array &$i): int {
  $db = sw_db();
  wartung_meta('ais_fahrplan', (string)time());
  $haefen = []; foreach (ais_haefen() as $h) $haefen[$h[0]] = $h;
  $namen = [];
  foreach ($db->query('SELECT mmsi, name FROM sw_ais_schiff')->fetchAll() as $r) $namen[$r['mmsi']] = $r['name'];
  foreach (ais_liste() as $m => $n) if ($n !== '') $namen[$m] = $n;
  $ev = $db->query('SELECT mmsi, hafen, art, t, genau FROM sw_ais_ereignis ORDER BY mmsi, t')->fetchAll();
  $erst = $ev ? min(array_map(fn($e) => (int)$e['t'], $ev)) : time();
  $tage = max(1, min(AIS_TAGE, (time() - $erst) / 86400));
  $linien = [];
  for ($k = 0, $n = count($ev); $k < $n; $k++) {
    $a = $ev[$k];
    if ($a['art'] !== 'ab' || !$a['genau'] || !isset($haefen[$a['hafen']])) continue;
    for ($j = $k + 1; $j < $n && $ev[$j]['mmsi'] === $a['mmsi']; $j++) {
      $b = $ev[$j];
      if ((int)$b['t'] - (int)$a['t'] > 36 * 3600) break;
      if ($b['art'] !== 'an') continue;
      if ($b['hafen'] === $a['hafen'] || !isset($haefen[$b['hafen']])) break;
      $l = &$linien[$a['hafen'] . '>' . $b['hafen']];
      $d = new DateTime('@' . (int)$a['t']); $d->setTimezone(new DateTimeZone($haefen[$a['hafen']][4]));
      $l['ab'][(int)$d->format('N')][] = (int)$d->format('G') * 60 + (int)$d->format('i');
      if ($b['genau']) $l['dauer'][] = ((int)$b['t'] - (int)$a['t']) / 60;
      $l['alle'][] = ((int)$b['t'] - (int)$a['t']) / 60;
      $l['schiffe'][$a['mmsi']] = 1;
      unset($l);
      break;
    }
  }
  $wt = [1 => 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  $aus = [];
  foreach ($linien as $schl => $l) {
    $fahrten = array_sum(array_map('count', $l['ab']));
    if ($fahrten < 3) continue;
    // Abfahrtszeiten je Wochentag: Zeiten bis 10 min auseinander bilden eine Gruppe, gezählt ab zwei Beobachtungen
    $zeiten = []; $flach = [];
    foreach ($l['ab'] as $tag => $min) {
      sort($min); $gruppe = [];
      foreach (array_merge($min, [PHP_INT_MAX]) as $x) {
        if ($gruppe && $x - end($gruppe) > 10) {
          if (count($gruppe) >= 2) { $mit = $gruppe[intdiv(count($gruppe), 2)]; $mit = (int)round($mit / 5) * 5; $hm = sprintf('%02d:%02d', intdiv($mit, 60) % 24, $mit % 60); $zeiten[$wt[$tag]][] = $hm; $flach[$hm] = 1; }
          $gruppe = [];
        }
        $gruppe[] = $x;
      }
    }
    if (!$zeiten) continue;
    ksort($flach);
    $dauer = $l['dauer'] ?? $l['alle']; sort($dauer);
    [$von, $nach] = explode('>', $schl);
    $hv = $haefen[$von]; $hn = $haefen[$nach];
    $vn = ais_hafenname($hv); $nn = ais_hafenname($hn);
    $aus[] = ['name' => "$vn – $nn", 'schiffe' => array_values(array_filter(array_map(fn($m) => $namen[$m] ?? '', array_keys($l['schiffe'])))),
      'von' => ['name' => $vn, 'lat' => $hv[2], 'lon' => $hv[3], 'tz' => $hv[4]], 'nach' => ['name' => $nn, 'lat' => $hn[2], 'lon' => $hn[3], 'tz' => $hn[4]],
      'dauer_min' => round($dauer[intdiv(count($dauer), 2)]), 'fahrten' => $fahrten, 'abfahrten_tag' => round($fahrten / $tage, 1),
      'zeiten_wochentag' => array_intersect_key(array_merge(array_fill_keys($wt, null), $zeiten), $zeiten), 'zeiten' => array_keys($flach)];
  }
  usort($aus, fn($x, $y) => strcmp($x['name'], $y['name']));
  $ziel = sw_docroot() . '/poi/fahrplan';
  @mkdir($ziel, 0755, true);
  $json = json_encode(['quelle' => 'AIS (aisstream.io, BarentsWatch), lernend: beobachtete Abfahrten der letzten ' . (int)round($tage) . ' Tage', 'stand' => date('Y-m-d'),
    'tage' => (int)round($tage), 'zeitzone' => 'Ortszeit des Abfahrtshafens', 'linien' => $aus], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  if (@file_put_contents("$ziel/ais.json.tmp", $json) === false || !@rename("$ziel/ais.json.tmp", "$ziel/ais.json")) { $p[] = 'poi/fahrplan/ais.json nicht schreibbar'; return count($aus); }
  $i[] = count($ev) . ' Ereignisse, ' . count($linien) . ' beobachtete Verbindungen → ' . count($aus) . ' Linien mit festen Zeiten in poi/fahrplan/ais.json (' . round(strlen($json) / 1024) . ' kB)';
  return count($aus);
}

// Hafenname: kuratierter Name aus FAEHR_REFERENZ, sonst Ort per Nominatim (einmal je Hafen, gemerkt), sonst Koordinaten
function ais_hafenname(array $h): string {
  if ($h[1]) return $h[1];
  static $cache = null;
  $datei = sw_daten(true) . '/ais-hafennamen.json';
  $cache ??= (array)json_decode((string)@file_get_contents($datei), true);
  if (isset($cache[$h[0]])) return $cache[$h[0]];
  $name = sprintf('%.3f, %.3f', $h[2], $h[3]);
  usleep(1100000);  // Nominatim: höchstens eine Anfrage pro Sekunde
  $c = curl_init('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=12&lat=' . $h[2] . '&lon=' . $h[3]);
  curl_setopt_array($c, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 10, CURLOPT_PROTOCOLS => CURLPROTO_HTTPS, CURLOPT_USERAGENT => AIS_UA]);
  $j = json_decode((string)curl_exec($c), true); $st = (int)curl_getinfo($c, CURLINFO_RESPONSE_CODE); curl_close($c);
  $a = (array)($j['address'] ?? []);
  foreach (['city', 'town', 'village', 'municipality', 'hamlet', 'island', 'suburb'] as $f) if (!empty($a[$f])) { $name = mb_substr((string)$a[$f], 0, 60); break; }
  if ($st === 200) { $cache[$h[0]] = $name; @file_put_contents($datei, json_encode($cache, JSON_UNESCAPED_UNICODE)); }
  return $name;
}

// Für den Admin: Zahlen und die letzten Ereignisse
function ais_status(): array {
  $db = sw_db();
  $z = fn($sql) => (int)$db->query($sql)->fetchColumn();
  $h = []; foreach (ais_haefen() as $x) $h[$x[0]] = $x;
  $letzte = [];
  foreach ($db->query('SELECT e.mmsi, e.hafen, e.art, e.t, e.genau, s.name FROM sw_ais_ereignis e LEFT JOIN sw_ais_schiff s ON s.mmsi = e.mmsi ORDER BY e.t DESC LIMIT 15')->fetchAll() as $r)
    $letzte[] = $r + ['hafenname' => isset($h[$r['hafen']]) ? ($h[$r['hafen']][1] ?: $r['hafen']) : $r['hafen']];
  return ['gelernt' => $z('SELECT COUNT(*) FROM sw_ais_schiff'), 'gepflegt' => count(ais_liste()), 'haefen' => count($h),
    'ereignisse' => $z('SELECT COUNT(*) FROM sw_ais_ereignis'), 'woche' => $z('SELECT COUNT(*) FROM sw_ais_ereignis WHERE t > ' . (time() - 7 * 86400)),
    'liegen' => $z('SELECT COUNT(*) FROM sw_ais_zustand WHERE liegt = 1'), 'fahrplan' => (int)wartung_meta('ais_fahrplan'),
    'fehl' => (int)wartung_meta('ais_fehl'), 'bw' => (string)wartung_meta('ais_bw'), 'letzte' => $letzte];
}
