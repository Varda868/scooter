<?php
// Wartung für geplante Aufgaben in Plesk („URL abrufen“, Benachrichtigen: „Nur Fehler“). Bei einem Problem antwortet
// die Seite mit HTTP 500 und einer kurzen Liste; Plesk schickt dann eine Mail. Geschützt durch das Token aus dem Admin-Bereich.
//   ?was=relays   alle 15 min: eigenes Relay erreichbar, Zertifikat noch mindestens 2 Tage gültig, überhaupt ein Relay da
//   ?was=gesund   täglich: Valhalla, Photon, Overpass, Wetter, TomTom-Schlüssel, Alter der POI-Daten, Speicher
//   ?was=fehler   täglich: neue Fehlerberichte seit der letzten Meldung
//   ?was=nacht    täglich nachts: Aufräumen und Sicherung von Datenbank (SQLite) und config.php, 7 Tage
define('SW_API', 1);
require __DIR__ . '/lib/kern.php';
require __DIR__ . '/lib/relays.php';
require __DIR__ . '/lib/wartung.php';

const WARTUNG_POI_TAGE = 40, WARTUNG_SICHERUNGEN = 7, WARTUNG_FREI_MB = 300, WARTUNG_CACHE_MAX = 300 * 1048576;

header('Content-Type: text/plain; charset=utf-8');
header('Cache-Control: no-store');
if (!sw_eingerichtet()) { http_response_code(503); exit("Server nicht eingerichtet\n"); }
$soll = (string)(sw_config()['relay_token'] ?? '');
if ($soll === '' || !hash_equals($soll, (string)($_GET['k'] ?? ''))) { usleep(300000); http_response_code(403); exit("nicht erlaubt\n"); }
$was = (string)($_GET['was'] ?? '');
if (!in_array($was, WARTUNG_AUFGABEN, true)) { http_response_code(400); exit("was = " . implode(' | ', WARTUNG_AUFGABEN) . "\n"); }
@set_time_limit(180);

$probleme = []; $info = [];
('wartung_' . $was)($probleme, $info);
wartung_merken($was, $probleme);
if ($probleme) http_response_code(500);
echo ($probleme ? "PROBLEM\n- " . implode("\n- ", $probleme) . "\n\n" : "ok\n"), $info ? implode("\n", $info) . "\n" : '';

function wartung_relays(array &$p, array &$i): void {
  $liste = relay_liste();
  $zuletzt = (int)sw_db()->query("SELECT MAX(t) FROM sw_relay WHERE quelle = 'server'")->fetchColumn();
  // Kurz nach einer Prüfung (Knopf, relaypruefung.php) deren Ergebnis nehmen statt neu zu prüfen
  if (time() - $zuletzt < RELAY_CRON_ABSTAND_S) {
    $q = sw_db()->prepare("SELECT * FROM sw_relay WHERE url = ? AND quelle = 'server' ORDER BY t DESC LIMIT 1");
    $erg = [];
    foreach ($liste as $r) { $q->execute([$r['url']]); if ($e = $q->fetch()) $erg[$r['url']] = $e; }
  } else {
    $erg = array_column(relay_alle_pruefen(), null, 'url');
    sw_ip_test(true);
  }
  $an = 0;
  foreach ($liste as $r) {
    $e = $erg[$r['url']] ?? null;
    if (!$e) continue;
    if ($r['an'] && $e['ok']) $an++;
    $i[] = ($e['ok'] ? 'ok   ' : 'FEHL ') . $r['url'] . ($e['ok'] ? '' : ' – ' . $e['fehler']);
    if (!$r['eigen']) continue;
    if (!$e['ok']) $p[] = "Eigenes Relay {$r['url']} nicht erreichbar: {$e['fehler']}";
    if ($e['cert_bis'] && $e['cert_bis'] - time() < 2 * 86400)
      $p[] = "Zertifikat von {$r['url']} läuft ab: " . date('d.m.Y H:i', (int)$e['cert_bis']);
  }
  if (!$an) $p[] = 'Kein eingeschaltetes Relay erreichbar, Talk geht nicht';
}

function wartung_gesund(array &$p, array &$i): void {
  $w = sw_config()['werte'];
  $ov = (array)$w['overpass_urls'];
  $tests = [
    'Valhalla' => [rtrim($w['valhalla_url'], '/') . '/status', null],
    'Photon' => [$w['photon_url'] . '?q=Augsburg&limit=1', null],
    'Overpass' => [preg_replace('~/interpreter$~', '/status', $ov[0] ?? ''), null],
    'Wetter' => [$w['open_meteo_url'] . '?latitude=48.37&longitude=10.9&current=temperature_2m', null],
  ];
  if ($w['tomtom_key'] !== '')
    $tests['TomTom-Schlüssel'] = ['https://api.tomtom.com/traffic/services/5/incidentDetails?bbox=10.88,48.36,10.9,48.38&fields=%7Bincidents%7Btype%7D%7D&key=' . rawurlencode($w['tomtom_key']), null];
  $mh = curl_multi_init(); $h = [];
  foreach ($tests as $name => [$url]) {
    $c = curl_init($url);
    curl_setopt_array($c, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 20, CURLOPT_CONNECTTIMEOUT => 8, CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
      CURLOPT_USERAGENT => 'Scooterways-Wartung/1 (+https://scooter.thai-klasse.de)', CURLOPT_FOLLOWLOCATION => false]);
    curl_multi_add_handle($mh, $c); $h[$name] = $c;
  }
  do { $s = curl_multi_exec($mh, $laeuft); if ($laeuft) curl_multi_select($mh, 1); } while ($laeuft && $s === CURLM_OK);
  foreach ($h as $name => $c) {
    $st = (int)curl_getinfo($c, CURLINFO_RESPONSE_CODE); $ms = (int)round(curl_getinfo($c, CURLINFO_TOTAL_TIME) * 1000);
    $ok = $st >= 200 && $st < 300;
    $i[] = sprintf('%-17s %s %d (%d ms)', $name, $ok ? 'ok  ' : 'FEHL', $st, $ms);
    // Overpass hat einen Ersatzserver, der Ausfall eines einzelnen ist kein Alarm
    if (!$ok && $name !== 'Overpass') $p[] = "$name antwortet nicht richtig (HTTP $st" . (curl_error($c) ? ', ' . curl_error($c) : '') . ')';
    curl_multi_remove_handle($mh, $c); curl_close($c);
  }
  curl_multi_close($mh);

  $ix = json_decode((string)@file_get_contents(sw_docroot() . '/poi/index.json'), true);
  if (!$ix || empty($ix['date'])) $p[] = 'POI-Daten fehlen (poi/index.json)';
  else {
    $alter = (int)floor((time() - strtotime($ix['date'])) / 86400);
    $i[] = "POI-Daten vom {$ix['date']} ($alter Tage)";
    if ($alter > WARTUNG_POI_TAGE) $p[] = "POI-Daten sind $alter Tage alt, der monatliche Lauf ist wohl ausgefallen";
  }
  $frei = @disk_free_space(sw_daten());
  $cache = wartung_groesse(sw_daten() . '/cache');
  $i[] = 'Zwischenspeicher ' . round($cache / 1048576) . ' MB' . ($frei !== false ? ', frei ' . round($frei / 1048576) . ' MB' : '');
  if ($frei !== false && $frei < WARTUNG_FREI_MB * 1048576) $p[] = 'Wenig Speicher frei: ' . round($frei / 1048576) . ' MB';
}

function wartung_fehler(array &$p, array &$i): void {
  $db = sw_db();
  $seit = (int)wartung_meta('fehler_gemeldet');
  $q = $db->prepare('SELECT id, t, version, SUBSTR(text, 1, 160) AS anfang FROM sw_fehler WHERE id > ? ORDER BY id'); $q->execute([$seit]);
  $neu = $q->fetchAll();
  if (!$neu) { $i[] = 'keine neuen Fehlerberichte'; return; }
  $p[] = count($neu) . ' neue Fehlerberichte (Admin → Fehlerberichte)';
  foreach (array_slice($neu, 0, 10) as $r) $i[] = date('d.m. H:i', (int)$r['t']) . ' ' . $r['version'] . ' ' . preg_replace('/\s+/', ' ', $r['anfang']);
  wartung_meta('fehler_gemeldet', (string)end($neu)['id']);
}

function wartung_nacht(array &$p, array &$i): void {
  $db = sw_db(); $jetzt = time();
  $n = [];
  $n['Kurzlinks'] = $db->exec("DELETE FROM sw_kurz WHERE bis < $jetzt");
  $n['Drosselung'] = $db->exec("DELETE FROM sw_drossel WHERE ende < $jetzt");
  $n['Anmeldeversuche'] = $db->exec('DELETE FROM sw_login WHERE t < ' . ($jetzt - 86400));
  $n['Push-Abos'] = $db->exec('DELETE FROM sw_push WHERE fehler >= 20');
  $n['Relay-Verlauf'] = $db->exec('DELETE FROM sw_relay WHERE t < ' . ($jetzt - RELAY_VERLAUF_TAGE * 86400));
  $n['Fehlerberichte'] = $db->exec('DELETE FROM sw_fehler WHERE t < ' . ($jetzt - 30 * 86400));
  // Proxy-Speicher: nichts lebt dort länger als einen Tag; über der Höchstgröße die ältesten weg
  $dateien = [];
  foreach (glob(sw_daten() . '/cache/*/*') ?: [] as $f) {
    $t = @filemtime($f);
    if (!$t || $jetzt - $t > 2 * 86400) { @unlink($f); $n['Speicherdateien'] = ($n['Speicherdateien'] ?? 0) + 1; }
    else $dateien[$f] = [$t, (int)@filesize($f)];
  }
  $summe = array_sum(array_column($dateien, 1));
  if ($summe > WARTUNG_CACHE_MAX) {
    uasort($dateien, fn($a, $b) => $a[0] <=> $b[0]);
    foreach ($dateien as $f => [, $g]) { @unlink($f); if (($summe -= $g) <= WARTUNG_CACHE_MAX * 0.8) break; }
  }
  $i[] = 'Aufgeräumt: ' . implode(', ', array_map(fn($k, $v) => "$k $v", array_keys($n), $n));

  // Sicherung in den privaten Ordner; config.php enthält Geheimnisse, deshalb 0600 und nie in den Webroot
  $ziel = sw_daten() . '/sicherung';
  @mkdir($ziel, 0700, true);
  $tag = date('Y-m-d');
  if (!copy(sw_daten() . '/config.php', "$ziel/config-$tag.php")) $p[] = 'Sicherung von config.php fehlgeschlagen';
  else @chmod("$ziel/config-$tag.php", 0600);
  if (sw_mysql()) $i[] = 'MySQL: Datenbank bitte über Plesk sichern (Datenbanken → Sicherung)';
  else {
    $datei = "$ziel/scooterways-$tag.sqlite";
    @unlink($datei);
    try { $db->exec('VACUUM INTO ' . $db->quote($datei)); @chmod($datei, 0600); $i[] = 'Gesichert: ' . basename($datei) . ' (' . round(filesize($datei) / 1024) . ' kB)'; }
    catch (Throwable $e) { $p[] = 'Sicherung der Datenbank fehlgeschlagen: ' . $e->getMessage(); }
  }
  foreach (['config-*.php', 'scooterways-*.sqlite'] as $muster) {
    $alle = glob("$ziel/$muster") ?: [];
    sort($alle);
    foreach (array_slice($alle, 0, max(0, count($alle) - WARTUNG_SICHERUNGEN)) as $alt) @unlink($alt);
  }
}

function wartung_groesse(string $ordner): int {
  $s = 0;
  foreach (glob("$ordner/*/*") ?: [] as $f) $s += (int)@filesize($f);
  return $s;
}
