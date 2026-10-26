<?php
// Gemeinsames für api/wartung.php und den Admin-Bereich „Wartung“: Aufgaben, Zustand in sw_meta
defined('SW_API') || exit;

const WARTUNG_AUFGABEN = ['relays', 'gesund', 'fehler', 'nacht', 'faehren-osm', 'faehren-se', 'faehren-uk'];
// Empfohlene Zeitpläne für Plesk (Cron-Stil) und was die Aufgabe tut
const WARTUNG_PLAN = [
  'relays' => ['*/15 * * * *', 'Relay-Wächter: eigenes Relay erreichbar, Zertifikat noch ≥ 2 Tage'],
  'gesund' => ['0 7 * * *', 'Gesundheitscheck: Dienste, TomTom-Schlüssel, Alter der POI-Daten, Speicher'],
  'fehler' => ['0 19 * * *', 'Neue Fehlerberichte seit der letzten Mail'],
  'nacht' => ['30 3 * * *', 'Aufräumen und Sicherung (7 Tage) im privaten Ordner'],
];
// Fährdaten-Läufe: Zeitplan und Text stehen in FAEHR_QUELLEN (lib/faehren.php), der Admin-Bereich „Fährdaten“ zeigt sie

function wartung_meta(string $k, ?string $v = null): ?string {
  $db = sw_db();
  if ($v === null) { $q = $db->prepare('SELECT v FROM sw_meta WHERE k = ?'); $q->execute([$k]); $r = $q->fetchColumn(); return $r === false ? null : (string)$r; }
  $db->prepare('DELETE FROM sw_meta WHERE k = ?')->execute([$k]);
  $db->prepare('INSERT INTO sw_meta (k, v) VALUES (?, ?)')->execute([$k, mb_substr($v, 0, 255)]);
  return $v;
}
function wartung_merken(string $was, array $probleme): void {
  wartung_meta("wartung_$was", json_encode(['t' => time(), 'ok' => !$probleme, 'p' => mb_substr(implode(' · ', $probleme), 0, 180)]));
}
function wartung_stand(string $was): ?array {
  $v = wartung_meta("wartung_$was");
  return $v ? json_decode($v, true) : null;
}
