<?php
// Profil-Abgleich zwischen eigenen Geräten. Die App leitet aus dem Sync-Passwort per PBKDF2 Fach-Kennung und
// AES-GCM-Schlüssel ab und lädt nur Chiffrat hoch; der Server sieht weder Passwort noch Inhalt.
// POST {aktion: 'hoch', id, daten}   speichern (ersetzt den alten Stand)
// POST {aktion: 'runter', id}        → {daten, t}
// POST {aktion: 'info', id}          → {t, groesse} oder {leer: true}
// POST {aktion: 'weg', id}           löschen
define('SW_API', 1);
require __DIR__ . '/lib/kern.php';
sw_cors();

const PROFIL_MAX_BYTES = 4 * 1048576, PROFIL_MAX_ANZAHL = 300, PROFIL_TAGE = 365;

if ($_SERVER['REQUEST_METHOD'] !== 'POST') sw_fehler('nur POST', 405);
if (!sw_eingerichtet()) sw_fehler('Server nicht eingerichtet', 503);
if (!sw_origin_ok()) sw_fehler('Herkunft nicht erlaubt', 403);
$roh = sw_rumpf(PROFIL_MAX_BYTES + 1024);
if ($roh === null) sw_fehler('Profil zu groß (höchstens 4 MB verschlüsselt)', 413);
$b = json_decode($roh, true);
$id = (string)($b['id'] ?? '');
if (!is_array($b) || !preg_match('/^[a-f0-9]{64}$/', $id)) sw_fehler('Kennung ungültig', 400);
// Raten der Kennung ist aussichtslos (256 bit), gedrosselt wird trotzdem
if (!sw_drossel('profil:' . sw_ip(), 60, 3600)) sw_fehler('Zu viele Anfragen, bitte später', 429);
$db = sw_db();

switch ($b['aktion'] ?? '') {
  case 'hoch':
    $d = $b['daten'] ?? null;
    if (!is_string($d) || $d === '' || !preg_match('~^[A-Za-z0-9+/=_-]+$~', $d)) sw_fehler('Daten ungültig', 400);
    if (!sw_drossel('profil-hoch:' . sw_ip(), 30, 3600)) sw_fehler('Zu oft gesichert, bitte später', 429);
    $q = $db->prepare('SELECT COUNT(*) FROM sw_profil WHERE id = ?'); $q->execute([$id]);
    $neu = !$q->fetchColumn();
    if ($neu && $db->query('SELECT COUNT(*) FROM sw_profil')->fetchColumn() >= PROFIL_MAX_ANZAHL) sw_fehler('Der Server hat keinen Platz für weitere Profile', 507);
    $db->prepare('DELETE FROM sw_profil WHERE id = ?')->execute([$id]);
    $db->prepare('INSERT INTO sw_profil (id, t, abruf, groesse, ip, daten) VALUES (?, ?, ?, ?, ?, ?)')->execute([$id, time(), time(), strlen($d), sw_ip(), $d]);
    // Lange nicht genutzte Profile weg
    $db->prepare('DELETE FROM sw_profil WHERE abruf < ?')->execute([time() - PROFIL_TAGE * 86400]);
    sw_json(['ok' => true, 't' => time()]);

  case 'runter': case 'info':
    $q = $db->prepare('SELECT t, groesse' . ($b['aktion'] === 'runter' ? ', daten' : '') . ' FROM sw_profil WHERE id = ?'); $q->execute([$id]);
    $r = $q->fetch();
    if (!$r) sw_json(['ok' => true, 'leer' => true]);
    $db->prepare('UPDATE sw_profil SET abruf = ? WHERE id = ?')->execute([time(), $id]);
    sw_json(['ok' => true, 't' => (int)$r['t'], 'groesse' => (int)$r['groesse']] + (isset($r['daten']) ? ['daten' => $r['daten']] : []));

  case 'weg':
    $db->prepare('DELETE FROM sw_profil WHERE id = ?')->execute([$id]);
    sw_json(['ok' => true]);
}
sw_fehler('unbekannte Aktion', 400);
