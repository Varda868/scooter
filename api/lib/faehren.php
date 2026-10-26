<?php
// Fährdaten: Quellen, geplante Läufe (über wartung.php), Verlauf, Mail und Qualitätsbericht.
// Läuft auf dem Server; die App bekommt nur fertige, kleine Dateien unter poi/ (Kacheln, poi/fahrplan/*.json).
defined('SW_API') || exit;

// id => [Name, Art, empfohlener Zeitplan (Cron-Stil), längste erwartete Pause in Stunden (für „überfällig“), Text]
// Art: lauf = läuft hier über wartung.php, extern = läuft woanders (GitHub Action), probe = noch in Erprobung
const FAEHR_QUELLEN = [
  'osm' => ['OSM-Fährkacheln (poi/f/)', 'lauf', '15 6 * * *', 30,
    'Die Linien selbst baut die monatliche POI-Action aus OpenStreetMap (Wege und route=ferry-Relationen). Dieser Lauf wertet die Kacheln aus: Linien, Abdeckung je Meer, verdächtige Linien, Vergleich mit Fahrplänen.'],
  'se' => ['Schweden: Trafiklab GTFS Sverige 2', 'lauf', '20 4 * * *', 24 * 33,
    'Amtlicher Gesamtfahrplan Schwedens, nur Fährlinien (GTFS route_type 4 und 1000–1299): Abfahrten je Tag, Dauer, Häfen. Braucht einen kostenlosen Schlüssel von trafiklab.se (50 Abrufe in 30 Tagen). Der Lauf darf täglich angestoßen werden: geladen wird nur alle 27 Tage, nach einem Fehler einmal am nächsten Tag erneut.'],
  'no' => ['Norwegen: Entur GTFS', 'probe', '30 4 4 * *', 0, 'Mit Fjordfähren. Wird gerade auf dem Lifebook erprobt.'],
  'dk' => ['Dänemark: Rejseplanen GTFS', 'probe', '40 4 4 * *', 0, 'Gesamtfahrplan mit Fährlinien. Wird gerade erprobt.'],
  'fi' => ['Finnland: Fintraffic GTFS', 'probe', '50 4 4 * *', 0, 'Schären- und Ålandfähren (CC BY 4.0). Wird gerade erprobt.'],
  'ee' => ['Estland: peatus.ee GTFS', 'probe', '0 5 4 * *', 0, 'Inselfähren Estlands. Wird gerade erprobt.'],
  'ferryhopper' => ['Ferryhopper (Häfen, Verbindungen, Abfahrten)', 'probe', '0 5 * * 1', 0, 'Wöchentlich Häfen und Verbindungen, täglich Abfahrten der Linien der App. Nutzungsbedingungen noch offen.'],
  'ais_fi' => ['AIS Finnland (Digitraffic)', 'probe', '*/15 * * * *', 0, 'Schiffspositionen im Finnischen Meerbusen und um Åland (CC BY 4.0), daraus ein lernender Fahrplan.'],
  'ais_dk' => ['AIS Dänemark (Tagesdateien)', 'probe', '0 6 * * *', 0, 'Kattegat, Belte, Öresund: Kiel–Oslo, Kopenhagen–Oslo, Frederikshavn–Göteborg. Wird gerade erprobt.'],
];
const FAEHR_SE_URL = 'https://opendata.samtrafiken.se/gtfs-sweden/sweden.zip?key=';
const FAEHR_SE_MAX = 1536 * 1048576, FAEHR_HAFEN_M = 5000, FAEHR_TAGE = 28;

// Wichtige Linien je Meer: [Hafen A, lat, lon, Hafen B, lat, lon]. Abdeckung = Anteil, für den es in den Kacheln
// eine Linie gibt, die an beiden Häfen (≤ 5 km) vorbeikommt. Häfen auf ein paar hundert Meter genau.
const FAEHR_REFERENZ = [
  'Ostsee' => [
    ['Stockholm', 59.32, 18.09, 'Helsinki', 60.16, 24.96], ['Stockholm', 59.32, 18.09, 'Turku', 60.44, 22.22],
    ['Stockholm', 59.32, 18.09, 'Tallinn', 59.44, 24.77], ['Kapellskär', 59.72, 19.07, 'Mariehamn', 60.09, 19.93],
    ['Nynäshamn', 58.90, 17.95, 'Hanko', 59.82, 22.97], ['Nynäshamn', 58.90, 17.95, 'Visby', 57.64, 18.29],
    ['Karlskrona', 56.16, 15.59, 'Gdynia', 54.53, 18.55], ['Karlskrona', 56.16, 15.59, 'Liepāja', 56.52, 21.00],
    ['Travemünde', 53.96, 10.87, 'Trelleborg', 55.37, 13.15], ['Rostock', 54.15, 12.10, 'Trelleborg', 55.37, 13.15],
    ['Rostock', 54.15, 12.10, 'Gedser', 54.57, 11.93], ['Puttgarden', 54.50, 11.23, 'Rødby', 54.65, 11.35],
    ['Świnoujście', 53.91, 14.26, 'Ystad', 55.43, 13.82], ['Helsinki', 60.16, 24.96, 'Tallinn', 59.44, 24.77],
    ['Ystad', 55.43, 13.82, 'Rønne', 55.10, 14.69], ['Kiel', 54.32, 10.14, 'Klaipėda', 55.70, 21.13],
    ['Travemünde', 53.96, 10.87, 'Helsinki-Vuosaari', 60.21, 25.19]],
  'Nordsee/Skagerrak' => [
    ['Kiel', 54.32, 10.14, 'Oslo', 59.90, 10.74], ['Kopenhagen', 55.69, 12.60, 'Oslo', 59.90, 10.74],
    ['Frederikshavn', 57.44, 10.55, 'Göteborg', 57.70, 11.93], ['Hirtshals', 57.59, 9.97, 'Kristiansand', 58.14, 8.00],
    ['Hirtshals', 57.59, 9.97, 'Larvik', 59.05, 10.03], ['IJmuiden', 52.46, 4.60, 'Newcastle', 55.00, -1.45],
    ['Hoek van Holland', 51.98, 4.12, 'Harwich', 51.95, 1.28], ['Europoort', 51.95, 4.13, 'Hull', 53.74, -0.28],
    ['Kiel', 54.32, 10.14, 'Göteborg', 57.70, 11.93]],
  'Ärmelkanal' => [
    ['Calais', 50.97, 1.86, 'Dover', 51.12, 1.33], ['Dunkerque', 51.03, 2.20, 'Dover', 51.12, 1.33],
    ['Ouistreham', 49.28, -0.25, 'Portsmouth', 50.80, -1.10], ['Cherbourg', 49.65, -1.62, 'Poole', 50.71, -1.98],
    ['Le Havre', 49.48, 0.11, 'Portsmouth', 50.80, -1.10], ['Saint-Malo', 48.65, -2.02, 'Portsmouth', 50.80, -1.10],
    ['Roscoff', 48.72, -3.97, 'Plymouth', 50.36, -4.14], ['Dieppe', 49.93, 1.08, 'Newhaven', 50.79, 0.05]],
  'Irische See' => [
    ['Holyhead', 53.31, -4.63, 'Dublin', 53.35, -6.20], ['Cairnryan', 54.97, -5.02, 'Belfast', 54.62, -5.90],
    ['Liverpool', 53.41, -3.00, 'Dublin', 53.35, -6.20], ['Fishguard', 52.01, -4.98, 'Rosslare', 52.25, -6.34],
    ['Heysham', 54.03, -2.92, 'Douglas', 54.15, -4.48]],
  'Atlantik' => [
    ['Cádiz', 36.53, -6.29, 'Las Palmas', 28.14, -15.42], ['Huelva', 37.25, -6.95, 'Santa Cruz de Tenerife', 28.47, -16.25],
    ['Santander', 43.46, -3.80, 'Portsmouth', 50.80, -1.10], ['Bilbao', 43.35, -3.08, 'Portsmouth', 50.80, -1.10],
    ['Roscoff', 48.72, -3.97, 'Cork', 51.83, -8.32], ['Algeciras', 36.13, -5.43, 'Tanger Med', 35.89, -5.50]],
  'Westl. Mittelmeer' => [
    ['Barcelona', 41.37, 2.18, 'Palma', 39.56, 2.63], ['Valencia', 39.45, -0.32, 'Palma', 39.56, 2.63],
    ['Genova', 44.41, 8.92, 'Porto Torres', 40.84, 8.40], ['Livorno', 43.55, 10.30, 'Bastia', 42.70, 9.45],
    ['Civitavecchia', 42.09, 11.79, 'Olbia', 40.92, 9.52], ['Nizza', 43.70, 7.29, 'Ajaccio', 41.92, 8.74],
    ['Marseille', 43.31, 5.36, 'Ajaccio', 41.92, 8.74], ['Napoli', 40.84, 14.26, 'Palermo', 38.13, 13.37],
    ['Salerno', 40.67, 14.75, 'Valletta', 35.89, 14.52], ['Pozzallo', 36.72, 14.85, 'Valletta', 35.89, 14.52],
    ['Genova', 44.41, 8.92, 'Tunis', 36.82, 10.30]],
  'Adria' => [
    ['Ancona', 43.62, 13.50, 'Split', 43.50, 16.44], ['Ancona', 43.62, 13.50, 'Bar', 42.09, 19.09],
    ['Bari', 41.13, 16.86, 'Dubrovnik', 42.66, 18.08], ['Bari', 41.13, 16.86, 'Durrës', 41.31, 19.45],
    ['Split', 43.50, 16.44, 'Stari Grad', 43.18, 16.60], ['Valbiska', 45.06, 14.48, 'Merag', 44.98, 14.43]],
  'Ionisches Meer' => [
    ['Bari', 41.13, 16.86, 'Igoumenitsa', 39.50, 20.26], ['Brindisi', 40.64, 17.94, 'Igoumenitsa', 39.50, 20.26],
    ['Ancona', 43.62, 13.50, 'Patras', 38.25, 21.73], ['Venedig', 45.43, 12.33, 'Patras', 38.25, 21.73],
    ['Kyllini', 37.94, 21.15, 'Zakynthos', 37.78, 20.90]],
  'Ägäis' => [
    ['Piräus', 37.94, 23.63, 'Heraklion', 35.34, 25.14], ['Piräus', 37.94, 23.63, 'Souda', 35.49, 24.07],
    ['Piräus', 37.94, 23.63, 'Rhodos', 36.45, 28.23], ['Rafina', 38.02, 24.01, 'Andros', 37.89, 24.73],
    ['Piräus', 37.94, 23.63, 'Mykonos', 37.45, 25.33], ['Kavala', 40.93, 24.41, 'Limnos', 39.87, 25.06]],
  'Östl. Mittelmeer' => [
    ['Taşucu', 36.32, 33.88, 'Kyrenia', 35.34, 33.33], ['Çeşme', 38.32, 26.30, 'Chios', 38.37, 26.14],
    ['Bodrum', 37.03, 27.43, 'Kos', 36.89, 27.29]],
];

// --- Einstellungen (config.php): je Quelle an/aus und Zeitplan, Mail-Adresse und -Art. Der Trafiklab-Schlüssel steht
// als geheimer Wert in werte['trafiklab_key'] und wird nie angezeigt.
function faehr_einstellungen(): array {
  $e = sw_config()['faehren'] ?? [];
  $q = [];
  foreach (FAEHR_QUELLEN as $id => [, $art, $cron]) $q[$id] = ['an' => $art === 'lauf' && ($e['quellen'][$id]['an'] ?? true), 'cron' => $e['quellen'][$id]['cron'] ?? $cron];
  return ['quellen' => $q, 'mail' => (string)($e['mail'] ?? ''), 'mail_art' => ($e['mail_art'] ?? 'fehler') === 'immer' ? 'immer' : 'fehler'];
}

// --- Ein Lauf: ausführen, im Verlauf merken, Mail schicken. Gibt [Probleme, Infos] zurück.
function faehr_lauf(string $id, bool $manuell = false, bool $nur_auswerten = false): array {
  $p = []; $i = []; $start = microtime(true); $linien = null;
  $e = faehr_einstellungen();
  if (!isset(FAEHR_QUELLEN[$id]) || FAEHR_QUELLEN[$id][1] !== 'lauf') return [["Quelle $id läuft nicht über den Server"], []];
  if (!$e['quellen'][$id]['an']) return [[], ['ausgeschaltet, übersprungen']];
  @set_time_limit(900); @ignore_user_abort(true);
  try { $linien = ('faehr_lauf_' . $id)($p, $i, $manuell, $nur_auswerten); }
  catch (Throwable $t) { $p[] = 'Abbruch: ' . $t->getMessage(); }
  $dauer = (int)round((microtime(true) - $start) * 1000);
  $db = sw_db();
  $db->prepare('INSERT INTO sw_faehrlauf (t, quelle, ms, ok, linien, text) VALUES (?, ?, ?, ?, ?, ?)')
    ->execute([time(), $id, $dauer, $p ? 0 : 1, $linien, mb_substr(implode("\n", array_merge($p ? ['PROBLEM: ' . implode(' · ', $p)] : [], $i)), 0, 60000)]);
  $db->exec('DELETE FROM sw_faehrlauf WHERE t < ' . (time() - 180 * 86400));
  faehr_mail($id, $p, $i, $dauer);
  return [$p, $i];
}

function faehr_mail(string $id, array $p, array $i, int $ms): void {
  $e = faehr_einstellungen();
  if ($e['mail'] === '' || (!$p && $e['mail_art'] !== 'immer')) return;
  $host = preg_replace('/[^a-z0-9.-]/i', '', $_SERVER['HTTP_HOST'] ?? 'scooter.thai-klasse.de');
  $betreff = 'Scooterways Fährdaten: ' . FAEHR_QUELLEN[$id][0] . ($p ? ' – FEHLER' : ' – ok');
  $text = ($p ? "PROBLEM\n- " . implode("\n- ", $p) . "\n\n" : '') . implode("\n", $i) . "\n\nDauer " . round($ms / 1000) . " s · " . date('d.m.Y H:i') .
    "\nAdmin: https://$host/api/admin.php?s=faehren\n";
  @mail($e['mail'], '=?UTF-8?B?' . base64_encode($betreff) . '?=', $text,
    "From: Scooterways <noreply@$host>\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit");
}

// Verlauf: letzte Läufe, wahlweise einer Quelle
function faehr_verlauf(?string $id = null, int $n = 30): array {
  $db = sw_db();
  $q = $id ? $db->prepare('SELECT * FROM sw_faehrlauf WHERE quelle = ? ORDER BY id DESC LIMIT ' . $n) : $db->prepare('SELECT * FROM sw_faehrlauf ORDER BY id DESC LIMIT ' . $n);
  $q->execute($id ? [$id] : []);
  return $q->fetchAll();
}
// Überfällig oder zuletzt fehlgeschlagen: Liste von Texten für das Banner
function faehr_warnungen(): array {
  $e = faehr_einstellungen(); $w = [];
  foreach (FAEHR_QUELLEN as $id => [$name, $art, , $max]) {
    if ($art !== 'lauf' || !$e['quellen'][$id]['an']) continue;
    if ($id === 'se' && (string)sw_wert('trafiklab_key') === '') continue;
    $l = faehr_verlauf($id, 1)[0] ?? null;
    if (!$l) $w[] = "$name: noch nie gelaufen";
    elseif (!$l['ok']) $w[] = "$name: letzter Lauf fehlgeschlagen (" . admin_zeit_kurz((int)$l['t']) . ')';
    elseif (time() - (int)$l['t'] > $max * 3600) $w[] = "$name: überfällig, zuletzt " . admin_zeit_kurz((int)$l['t']);
  }
  return $w;
}
function admin_zeit_kurz(int $t): string { return date('d.m. H:i', $t); }

// Dauer aus OSM (duration=HH:MM, H:MM:SS, ISO 8601 PT…, Minuten) in Minuten; null, wenn unlesbar
function faehr_dauer_min($d): ?float {
  // Ganzzahlen ausdrücklich umwandeln: nicht getroffene Gruppen liefert preg_match als '' (→ TypeError bei '' * 60)
  $d = trim(str_replace(',', '.', (string)$d));
  if ($d === '') return null;
  if (preg_match('/^(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?$/', $d, $m)) return (int)$m[1] * 60 + (int)$m[2] + (int)($m[3] ?? 0) / 60;
  if (preg_match('/^P(?:(\d+)D)?T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+)S)?$/i', $d, $m) && !preg_match('/T$/i', $d))
    return (int)($m[1] ?? 0) * 1440 + (float)($m[2] ?? 0) * 60 + (float)($m[3] ?? 0) + (int)($m[4] ?? 0) / 60;
  if (preg_match('/^\d+$/', $d)) return (float)$d;  // ganze Zahl = Minuten; Dezimalzahlen sind mehrdeutig → unlesbar
  if (preg_match('/^(?:(\d+)\s*h)?\s*(?:(\d+)\s*(?:min|m))?$/i', $d, $m) && ($m[1] ?? '') . ($m[2] ?? '') !== '') return (int)($m[1] ?? 0) * 60 + (int)($m[2] ?? 0);
  return null;
}
function faehr_m(float $la1, float $lo1, float $la2, float $lo2): float {
  $kx = 111320 * cos(deg2rad(($la1 + $la2) / 2));
  return hypot(($la2 - $la1) * 110540, ($lo2 - $lo1) * $kx);
}
// Kleinster Abstand Punkt → Linie (Punkte [lat, lon]), flach gerechnet
function faehr_abstand(float $la, float $lo, array $pts): float {
  $kx = 111320 * cos(deg2rad($la)); $ky = 110540; $best = INF;
  for ($k = 0, $n = count($pts); $k < $n; $k++) {
    $ax = ($pts[$k][1] - $lo) * $kx; $ay = ($pts[$k][0] - $la) * $ky;
    if ($k === $n - 1) { $best = min($best, hypot($ax, $ay)); break; }
    $bx = ($pts[$k + 1][1] - $lo) * $kx; $by = ($pts[$k + 1][0] - $la) * $ky; $dx = $bx - $ax; $dy = $by - $ay;
    $l = $dx * $dx + $dy * $dy; $t = $l ? max(0, min(1, -($ax * $dx + $ay * $dy) / $l)) : 0;
    $best = min($best, hypot($ax + $t * $dx, $ay + $t * $dy));
  }
  return $best;
}

// --- OSM-Kacheln auswerten
function faehr_osm_linien(): array {
  $ordner = sw_docroot() . '/poi/f';
  $linien = [];
  foreach (glob("$ordner/*.json") ?: [] as $f) {
    foreach ((array)json_decode((string)file_get_contents($f), true) as $el) {
      if (!is_array($el) || count($el) < 3) continue;
      $id = explode('.', (string)$el[0])[0];  // weitere Teile einer Relation („r123.1“) gehören zu r123
      $linien[$id]['teile'][(string)$el[0]] = $el[1];
      $linien[$id]['tags'] = $el[2];
    }
  }
  // Rahmen je Linie, damit die Suche nach Häfen nicht jede Linie ganz durchrechnen muss
  foreach ($linien as &$l) {
    $la = $lo = [];
    foreach ($l['teile'] as $pts) foreach ($pts as $q) { $la[] = $q[0]; $lo[] = $q[1]; }
    $l['rahmen'] = $la ? [min($la), max($la), min($lo), max($lo)] : [0, -1, 0, -1];
  }
  unset($l);
  return $linien;
}
function faehr_lauf_osm(array &$p, array &$i, bool $manuell = false, bool $nur_auswerten = false): int {
  $ix = json_decode((string)@file_get_contents(sw_docroot() . '/poi/index.json'), true);
  if (!$ix) { $p[] = 'poi/index.json fehlt'; return 0; }
  $alter = (int)floor((time() - strtotime((string)$ix['date'])) / 86400);
  $linien = faehr_osm_linien();
  $rel = count(array_filter(array_keys($linien), fn($k) => $k[0] === 'r'));
  $i[] = 'Kacheln vom ' . $ix['date'] . " ($alter Tage): " . count($linien) . " Linien, davon $rel aus Relationen, in " . count($ix['ferryTiles'] ?? []) . ' Kacheln';
  if (!$linien) $p[] = 'Keine Fährlinien in poi/f/';
  if ($alter > 40) $p[] = "Fährkacheln sind $alter Tage alt, der monatliche POI-Lauf ist wohl ausgefallen";

  // Neu und weggefallen gegenüber dem letzten Lauf (IDs im privaten Ordner)
  $merk = sw_daten(true) . '/faehren-osm-ids.json';
  $vorher = json_decode((string)@file_get_contents($merk), true);
  $jetzt = [];
  foreach ($linien as $id => $l) $jetzt[$id] = (string)($l['tags']['name'] ?? '');
  if (is_array($vorher)) {
    $neu = array_diff_key($jetzt, $vorher); $weg = array_diff_key($vorher, $jetzt);
    $i[] = 'Seit dem letzten Lauf: ' . count($neu) . ' neu, ' . count($weg) . ' weggefallen';
    foreach (array_slice($neu, 0, 15, true) as $id => $n) $i[] = "  + $id " . ($n ?: '(ohne Namen)');
    foreach (array_slice($weg, 0, 15, true) as $id => $n) $i[] = "  − $id " . ($n ?: '(ohne Namen)');
  }
  @file_put_contents($merk, json_encode($jetzt, JSON_UNESCAPED_UNICODE));

  // Abdeckung je Meer
  $bericht = ['t' => time(), 'stand' => $ix['date'], 'linien' => count($linien), 'relationen' => $rel, 'meere' => [], 'verdaechtig' => [], 'dauer' => []];
  $i[] = 'Abdeckung wichtiger Linien je Meer:';
  foreach (FAEHR_REFERENZ as $meer => $ref) {
    $fehlt = [];
    foreach ($ref as [$a, $la1, $lo1, $b, $la2, $lo2]) if (!faehr_finde($linien, $la1, $lo1, $la2, $lo2)) $fehlt[] = "{$a}–{$b}";
    $pz = (int)round((count($ref) - count($fehlt)) / count($ref) * 100);
    $bericht['meere'][$meer] = ['prozent' => $pz, 'fehlt' => $fehlt, 'n' => count($ref)];
    $i[] = sprintf('  %-20s %3d %%', $meer, $pz) . ($fehlt ? ' – fehlt: ' . implode(', ', $fehlt) : '');
  }

  // Verdächtig: lang ohne Namen, unlesbare Dauer, unplausibles Tempo
  foreach ($linien as $id => $l) {
    $km = 0;
    foreach ($l['teile'] as $pts) for ($k = 1; $k < count($pts); $k++) $km += faehr_m($pts[$k - 1][0], $pts[$k - 1][1], $pts[$k][0], $pts[$k][1]) / 1000;
    $t = $l['tags']; $grund = null;
    if ($km > 50 && empty($t['name'])) $grund = sprintf('%.0f km ohne Namen', $km);
    elseif (isset($t['duration']) && faehr_dauer_min($t['duration']) === null) $grund = 'Dauer unlesbar: „' . mb_substr((string)$t['duration'], 0, 20) . '“';
    elseif (($min = faehr_dauer_min($t['duration'] ?? null)) && $km > 10 && $km / ($min / 60) > 60) $grund = sprintf('%.0f km in %s → %.0f km/h', $km, $t['duration'], $km / ($min / 60));
    if ($grund) $bericht['verdaechtig'][] = ['id' => $id, 'name' => (string)($t['name'] ?? ''), 'grund' => $grund];
  }
  $i[] = count($bericht['verdaechtig']) . ' verdächtige Linien (Admin → Fährdaten)';

  // Dauer: OSM gegen Fahrpläne (soweit vorhanden)
  foreach (glob(sw_docroot() . '/poi/fahrplan/*.json') ?: [] as $f) {
    $fp = json_decode((string)file_get_contents($f), true);
    foreach ((array)($fp['linien'] ?? []) as $fl) {
      $osm = faehr_finde($linien, $fl['von']['lat'], $fl['von']['lon'], $fl['nach']['lat'], $fl['nach']['lon']);
      $om = $osm ? faehr_dauer_min($linien[$osm]['tags']['duration'] ?? null) : null;
      if (!$om || empty($fl['dauer_min'])) continue;
      $abw = ($om - $fl['dauer_min']) / $fl['dauer_min'] * 100;
      if (abs($abw) > 25) $bericht['dauer'][] = ['id' => $osm, 'name' => $fl['von']['name'] . ' – ' . $fl['nach']['name'], 'osm' => round($om), 'fahrplan' => round($fl['dauer_min']), 'abw' => round($abw), 'quelle' => basename($f, '.json')];
    }
  }
  if ($bericht['dauer']) $i[] = count($bericht['dauer']) . ' Linien mit mehr als 25 % Abweichung der Dauer zum Fahrplan';
  @file_put_contents(sw_daten(true) . '/faehren-bericht.json', json_encode($bericht, JSON_UNESCAPED_UNICODE));
  return count($linien);
}
// ID der ersten Linie, die an beiden Punkten vorbeikommt, sonst null
function faehr_finde(array $linien, float $la1, float $lo1, float $la2, float $lo2): ?string {
  $drin = function (array $r, float $la, float $lo): bool {
    $d = FAEHR_HAFEN_M / 110540; $dlo = $d / max(0.2, cos(deg2rad($la)));
    return $la >= $r[0] - $d && $la <= $r[1] + $d && $lo >= $r[2] - $dlo && $lo <= $r[3] + $dlo;
  };
  foreach ($linien as $id => $l) {
    if (!$drin($l['rahmen'], $la1, $lo1) || !$drin($l['rahmen'], $la2, $lo2)) continue;
    $a = $b = false;
    foreach ($l['teile'] as $pts) {
      $a = $a || faehr_abstand($la1, $lo1, $pts) <= FAEHR_HAFEN_M;
      $b = $b || faehr_abstand($la2, $lo2, $pts) <= FAEHR_HAFEN_M;
    }
    if ($a && $b) return (string)$id;
  }
  return null;
}

// --- Schweden: GTFS Sverige 2 laden und nur die Fähren behalten. stop_times.txt ist groß (Millionen Zeilen),
// deshalb zeilenweise direkt aus dem ZIP; im Speicher stehen nur Fährfahrten.
// Trafiklab erlaubt mit dem Gratis-Schlüssel nur 50 Abrufe in 30 Tagen. Deshalb: höchstens ein Download in
// FAEHR_SE_ABSTAND_T Tagen, nach einem Fehler höchstens eine Wiederholung am nächsten Tag, ETag/If-Modified-Since,
// Zähler aller Abrufe (auch fehlgeschlagener) und die ZIP-Datei bleibt liegen, damit sich neu auswerten lässt.
const FAEHR_SE_LIMIT = 50, FAEHR_SE_SPERRE = 40, FAEHR_SE_ABSTAND_T = 27;
function faehr_se_stand(?array $neu = null): array {
  $datei = sw_daten(true) . '/gtfs-se.json';
  if ($neu !== null) { @file_put_contents($datei, json_encode($neu)); return $neu; }
  $s = json_decode((string)@file_get_contents($datei), true) ?: [];
  $s['abrufe'] = array_values(array_filter((array)($s['abrufe'] ?? []), fn($t) => $t > time() - 30 * 86400));
  return $s + ['etag' => '', 'lastmod' => '', 'ok_t' => 0, 'fehl' => 0, 'versuch_t' => 0];
}
function faehr_lauf_se(array &$p, array &$i, bool $manuell = false, bool $nur_auswerten = false): ?int {
  $zip = sw_daten(true) . '/gtfs-se.zip';
  if (!class_exists('ZipArchive')) { $p[] = 'PHP-Erweiterung zip fehlt (in Plesk unter PHP-Einstellungen einschalten)'; return null; }
  if ($nur_auswerten) {
    if (!is_file($zip)) { $p[] = 'Noch keine Schweden-Datei auf dem Server'; return null; }
    $i[] = 'Neu ausgewertet ohne Abruf (Datei vom ' . date('d.m.Y', filemtime($zip)) . ')';
    return faehr_gtfs_auswerten($zip, 'se', 'Trafiklab GTFS Sverige 2 (Samtrafiken)', $p, $i);
  }
  $key = (string)sw_wert('trafiklab_key');
  if ($key === '') { $i[] = 'Kein Trafiklab-Schlüssel eingetragen, übersprungen'; return null; }
  $st = faehr_se_stand(); $n = count($st['abrufe']);
  if (($st['abgelehnt'] ?? '') === hash('sha256', $key)) {
    $p[] = 'Dieser Schlüssel wurde schon abgelehnt (HTTP 401/403); kein neuer Abruf, damit kein Kontingent verbraucht wird. Unter „Schlüssel & Konten“ einen gültigen Schlüssel für „GTFS Sverige 2“ eintragen.';
    return null;
  }
  if ($n >= ($manuell ? FAEHR_SE_SPERRE : FAEHR_SE_LIMIT - 5)) { $p[] = "Abruf gesperrt: schon $n Abrufe in 30 Tagen (Grenze " . FAEHR_SE_LIMIT . ')'; return null; }
  if (!$manuell) {
    // Planmäßig: Daten noch frisch → nichts tun; nach Fehlern höchstens einmal am nächsten Tag wiederholen
    if ($st['ok_t'] && time() - $st['ok_t'] < FAEHR_SE_ABSTAND_T * 86400) { $i[] = 'Letzter Abruf vom ' . date('d.m.Y', $st['ok_t']) . ', noch aktuell'; return null; }
    if ($st['fehl'] >= 2) { $p[] = 'Zwei Abrufe in Folge fehlgeschlagen, keine weiteren Versuche: bitte im Admin prüfen und „jetzt“ drücken'; return null; }
    if ($st['fehl'] && time() - $st['versuch_t'] < 20 * 3600) { $i[] = 'Wiederholung erst morgen'; return null; }
  }
  $fh = fopen("$zip.tmp", 'wb');
  $koepfe = [];
  if ($st['etag'] !== '' && is_file($zip)) $koepfe[] = 'If-None-Match: ' . $st['etag'];
  if ($st['lastmod'] !== '' && is_file($zip)) $koepfe[] = 'If-Modified-Since: ' . $st['lastmod'];
  $antwort = [];
  $c = curl_init(FAEHR_SE_URL . rawurlencode($key));
  curl_setopt_array($c, [CURLOPT_FILE => $fh, CURLOPT_TIMEOUT => 600, CURLOPT_CONNECTTIMEOUT => 15, CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
    CURLOPT_USERAGENT => 'Scooterways/1 (+https://scooterways.dns.navy)', CURLOPT_FOLLOWLOCATION => true, CURLOPT_MAXREDIRS => 3,
    CURLOPT_HTTPHEADER => $koepfe, CURLOPT_ENCODING => '',
    CURLOPT_HEADERFUNCTION => function ($c, $z) use (&$antwort) { if (preg_match('/^(etag|last-modified):\s*(.+?)\s*$/i', $z, $m)) $antwort[strtolower($m[1])] = $m[2]; return strlen($z); },
    CURLOPT_NOPROGRESS => false, CURLOPT_PROGRESSFUNCTION => fn($c, $dl, $da) => $da > FAEHR_SE_MAX ? 1 : 0]);
  $ok = curl_exec($c); $code = (int)curl_getinfo($c, CURLINFO_RESPONSE_CODE); $err = curl_error($c);
  curl_close($c); fclose($fh);
  $st['abrufe'][] = time(); $st['versuch_t'] = time();
  $i[] = 'Abrufe in den letzten 30 Tagen: ' . count($st['abrufe']) . ' von ' . FAEHR_SE_LIMIT . ' (dieser mitgezählt)';
  if ($ok && $code === 304) {
    @unlink("$zip.tmp");
    $st['ok_t'] = time(); $st['fehl'] = 0; faehr_se_stand($st);
    $i[] = 'Trafiklab: unverändert seit dem letzten Abruf (304), vorhandene Datei neu ausgewertet';
    return faehr_gtfs_auswerten($zip, 'se', 'Trafiklab GTFS Sverige 2 (Samtrafiken)', $p, $i);
  }
  if (!$ok || $code !== 200) {
    @unlink("$zip.tmp");
    $st['fehl']++;
    if ($code === 401 || $code === 403) $st['abgelehnt'] = hash('sha256', $key);
    faehr_se_stand($st);
    // Den Schlüssel nie in Meldungen: nur Status
    $p[] = $code === 401 || $code === 403 ? "Trafiklab lehnt den Schlüssel ab (HTTP $code): ungültig oder nicht für „GTFS Sverige 2“ freigeschaltet. Bei Trafiklab im Projekt die API „GTFS Sverige 2“ hinzufügen und deren Schlüssel nehmen (neue Schlüssel brauchen ggf. einige Minuten). Weitere Abrufe erst mit neuem Schlüssel." : ($code === 429 ? 'Trafiklab: Kontingent erschöpft (HTTP 429)' :
      "Download fehlgeschlagen (HTTP $code" . ($err ? ', ' . preg_replace('/key=[^&\s]+/', 'key=…', $err) : '') . ')');
    return null;
  }
  rename("$zip.tmp", $zip);
  $st['ok_t'] = time(); $st['fehl'] = 0; $st['etag'] = $antwort['etag'] ?? ''; $st['lastmod'] = $antwort['last-modified'] ?? '';
  faehr_se_stand($st);
  $i[] = 'GTFS geladen: ' . round(filesize($zip) / 1048576) . ' MB (bleibt auf dem Server für Neuauswertungen)';
  return faehr_gtfs_auswerten($zip, 'se', 'Trafiklab GTFS Sverige 2 (Samtrafiken)', $p, $i);
}
// GTFS-ZIP → poi/fahrplan/{ziel}.json mit den Fährverbindungen; gibt die Zahl der Verbindungen zurück
function faehr_gtfs_auswerten(string $zip, string $ziel_name, string $quelle, array &$p, array &$i): ?int {
  $z = new ZipArchive();
  if ($z->open($zip) !== true) { $p[] = 'GTFS-ZIP nicht lesbar'; return null; }
  $lies = function (string $datei, callable $zeile) use ($z) {
    $s = $z->getStream($datei);
    if (!$s) throw new RuntimeException("$datei fehlt im GTFS");
    $kopf = fgetcsv($s, 0, ',', '"', '');
    $kopf[0] = preg_replace('/^\xEF\xBB\xBF/', '', (string)$kopf[0]);
    $spalten = array_flip($kopf);
    while (($r = fgetcsv($s, 0, ',', '"', '')) !== false) if (count($r) > 1) $zeile($r, $spalten);
    fclose($s);
  };
  $routen = [];
  $lies('routes.txt', function ($r, $s) use (&$routen) {
    $typ = (int)$r[$s['route_type']];
    if ($typ === 4 || ($typ >= 1000 && $typ <= 1299)) $routen[$r[$s['route_id']]] = ['name' => trim($r[$s['route_long_name']] ?? '') ?: trim($r[$s['route_short_name']] ?? ''), 'agency' => $r[$s['agency_id']] ?? ''];
  });
  $betreiber = [];
  $lies('agency.txt', function ($r, $s) use (&$betreiber) { $betreiber[$r[$s['agency_id']] ?? ''] = $r[$s['agency_name']]; });
  $fahrten = [];
  $lies('trips.txt', function ($r, $s) use (&$fahrten, $routen) { if (isset($routen[$r[$s['route_id']]])) $fahrten[$r[$s['trip_id']]] = [$r[$s['route_id']], $r[$s['service_id']], null, null, null, null, -1, PHP_INT_MAX]; });
  // je Fahrt erster und letzter Halt: [route, service, von, ab, nach, an, größte seq, kleinste seq]
  $lies('stop_times.txt', function ($r, $s) use (&$fahrten) {
    $t = $r[$s['trip_id']];
    if (!isset($fahrten[$t])) return;
    $seq = (int)$r[$s['stop_sequence']]; $f = &$fahrten[$t];
    if ($seq < $f[7]) { $f[7] = $seq; $f[2] = $r[$s['stop_id']]; $f[3] = $r[$s['departure_time']]; }
    if ($seq > $f[6]) { $f[6] = $seq; $f[4] = $r[$s['stop_id']]; $f[5] = $r[$s['arrival_time']]; }
  });
  $halte = [];
  $brauche = [];
  foreach ($fahrten as $f) { $brauche[$f[2]] = 1; $brauche[$f[4]] = 1; }
  $lies('stops.txt', function ($r, $s) use (&$halte, $brauche) { if (isset($brauche[$r[$s['stop_id']]])) $halte[$r[$s['stop_id']]] = [$r[$s['stop_name']], (float)$r[$s['stop_lat']], (float)$r[$s['stop_lon']]]; });
  $tage = faehr_gtfs_tage($z, $lies, array_unique(array_column($fahrten, 1)));
  $z->close();

  $sek = function (?string $hms) { return preg_match('/^(\d+):(\d\d):(\d\d)$/', (string)$hms, $m) ? $m[1] * 3600 + $m[2] * 60 + $m[3] : null; };
  $gruppen = [];
  foreach ($fahrten as $f) {
    [$rid, $sid, $von, $ab, $nach, $an] = $f;
    $a = $sek($ab); $b = $sek($an);
    if ($von === null || $nach === null || $von === $nach || $a === null || $b === null || $b <= $a || !isset($halte[$von], $halte[$nach])) continue;
    $g = &$gruppen["$rid|$von|$nach"];
    $g['route'] = $rid; $g['von'] = $von; $g['nach'] = $nach;
    $g['dauer'][] = ($b - $a) / 60;
    $g['abfahrten'] = ($g['abfahrten'] ?? 0) + ($tage[$f[1]] ?? 0);
    if (($tage[$f[1]] ?? 0) > 0) $g['zeiten'][substr($ab, 0, 5)] = 1;
    unset($g);
  }
  $aus = [];
  foreach ($gruppen as $g) {
    if (empty($g['abfahrten'])) continue;
    sort($g['dauer']);
    $zeiten = array_keys($g['zeiten'] ?? []); sort($zeiten);
    [$vn, $vla, $vlo] = $halte[$g['von']]; [$nn, $nla, $nlo] = $halte[$g['nach']];
    $aus[] = ['name' => $routen[$g['route']]['name'], 'betreiber' => $betreiber[$routen[$g['route']]['agency']] ?? '',
      'von' => ['name' => $vn, 'lat' => round($vla, 5), 'lon' => round($vlo, 5)], 'nach' => ['name' => $nn, 'lat' => round($nla, 5), 'lon' => round($nlo, 5)],
      'dauer_min' => round($g['dauer'][intdiv(count($g['dauer']), 2)]), 'abfahrten_tag' => round($g['abfahrten'] / FAEHR_TAGE, 1),
      'zeiten' => array_slice($zeiten, 0, 40)];
  }
  usort($aus, fn($x, $y) => strcmp($x['von']['name'] . $x['nach']['name'], $y['von']['name'] . $y['nach']['name']));
  $ziel = sw_docroot() . '/poi/fahrplan';
  @mkdir($ziel, 0755, true);
  $json = json_encode(['quelle' => $quelle, 'stand' => date('Y-m-d'), 'tage' => FAEHR_TAGE, 'linien' => $aus], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  if (@file_put_contents("$ziel/$ziel_name.json.tmp", $json) === false || !@rename("$ziel/$ziel_name.json.tmp", "$ziel/$ziel_name.json")) { $p[] = "poi/fahrplan/$ziel_name.json nicht schreibbar"; return count($aus); }
  $i[] = count($routen) . ' Fährrouten, ' . count($fahrten) . ' Fahrten → ' . count($aus) . " Verbindungen in poi/fahrplan/$ziel_name.json (" . round(strlen($json) / 1024) . ' kB)';
  if (!$aus) $p[] = 'Keine Fährverbindungen im GTFS gefunden – Format geändert?';
  return count($aus);
}
// Wie viele der nächsten FAEHR_TAGE Tage jede service_id fährt (calendar.txt und calendar_dates.txt, beide optional)
function faehr_gtfs_tage(ZipArchive $z, callable $lies, array $dienste): array {
  $brauche = array_flip($dienste); $heute = new DateTimeImmutable('today'); $tage = [];
  $daten = [];
  for ($d = 0; $d < FAEHR_TAGE; $d++) { $t = $heute->modify("+$d day"); $daten[$t->format('Ymd')] = (int)$t->format('N'); }
  $aktiv = [];
  if ($z->locateName('calendar.txt') !== false) $lies('calendar.txt', function ($r, $s) use (&$aktiv, $brauche, $daten) {
    $id = $r[$s['service_id']];
    if (!isset($brauche[$id])) return;
    $wt = [1 => 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    foreach ($daten as $tag => $n) if ($tag >= $r[$s['start_date']] && $tag <= $r[$s['end_date']] && $r[$s[$wt[$n]]] === '1') $aktiv[$id][$tag] = 1;
  });
  if ($z->locateName('calendar_dates.txt') !== false) $lies('calendar_dates.txt', function ($r, $s) use (&$aktiv, $brauche, $daten) {
    $id = $r[$s['service_id']]; $tag = $r[$s['date']];
    if (!isset($brauche[$id], $daten[$tag])) return;
    if ($r[$s['exception_type']] === '1') $aktiv[$id][$tag] = 1; else unset($aktiv[$id][$tag]);
  });
  foreach ($dienste as $id) $tage[$id] = count($aktiv[$id] ?? []);
  return $tage;
}
