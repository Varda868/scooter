<?php
// Web Push für die Gruppe. Der Server kennt weder Gruppen-Passwort noch Inhalt:
// „gruppe“ ist eine aus dem Passwort abgeleitete Kennung, „daten“ ist mit einem ebenso abgeleiteten Schlüssel
// verschlüsselt ({iv, ct}); entschlüsseln kann nur der Service Worker der Gruppenmitglieder.
// POST {aktion: 'abo', gruppe, abo: {endpoint, keys: {p256dh, auth}}, name}
// POST {aktion: 'weg', endpoint}
// POST {aktion: 'senden', gruppe, daten: {iv, ct}, ich: endpoint, eilig: bool}
define('SW_API', 1);
require __DIR__ . '/lib/kern.php';
require __DIR__ . '/lib/webpush.php';

const PUSH_MAX_BYTES = 6000, PUSH_MAX_JE_GRUPPE = 50;

if ($_SERVER['REQUEST_METHOD'] !== 'POST') sw_fehler('nur POST', 405);
if (!sw_eingerichtet()) sw_fehler('Server nicht eingerichtet', 503);
if (!sw_origin_ok()) sw_fehler('Herkunft nicht erlaubt', 403);
$roh = sw_rumpf(PUSH_MAX_BYTES);
if ($roh === null) sw_fehler('zu groß', 413);
$b = json_decode($roh, true);
if (!is_array($b)) sw_fehler('Daten fehlen', 400);
$db = sw_db();
$gruppe = (string)($b['gruppe'] ?? '');
$gruppeOk = (bool)preg_match('/^[a-f0-9]{64}$/', $gruppe);

switch ($b['aktion'] ?? '') {
  case 'abo':
    $ep = (string)($b['abo']['endpoint'] ?? ''); $k = $b['abo']['keys'] ?? [];
    if (!$gruppeOk || !push_endpoint_ok($ep) || strlen($ep) > 1000) sw_fehler('Abo ungültig', 400);
    if (strlen(b64u_dec((string)($k['p256dh'] ?? ''))) !== 65 || strlen(b64u_dec((string)($k['auth'] ?? ''))) !== 16) sw_fehler('Abo-Schlüssel ungültig', 400);
    if (!sw_drossel('push-abo:' . sw_ip(), 20, 3600)) sw_fehler('Zu viele Anmeldungen', 429);
    $n = $db->prepare('SELECT COUNT(*) FROM sw_push WHERE gruppe = ? AND ep <> ?');
    $n->execute([$gruppe, hash('sha256', $ep)]);
    if ($n->fetchColumn() >= PUSH_MAX_JE_GRUPPE) sw_fehler('Gruppe ist voll', 409);
    $db->prepare('DELETE FROM sw_push WHERE ep = ?')->execute([hash('sha256', $ep)]);
    $db->prepare('INSERT INTO sw_push (ep, gruppe, endpoint, p256dh, auth, name, t) VALUES (?, ?, ?, ?, ?, ?, ?)')
      ->execute([hash('sha256', $ep), $gruppe, $ep, $k['p256dh'], $k['auth'], substr(preg_replace('/[^A-Z0-9-]/', '', strtoupper((string)($b['name'] ?? ''))), 0, 9), time()]);
    sw_json(['ok' => true]);

  case 'weg':
    $db->prepare('DELETE FROM sw_push WHERE ep = ?')->execute([hash('sha256', (string)($b['endpoint'] ?? ''))]);
    sw_json(['ok' => true]);

  case 'senden':
    $d = $b['daten'] ?? null;
    if (!$gruppeOk || !is_string($d['iv'] ?? null) || !is_string($d['ct'] ?? null) || strlen($d['iv']) > 24 || strlen($d['ct']) > 3500) sw_fehler('Nachricht ungültig', 400);
    // Nur wer selbst in der Gruppe angemeldet ist, darf an sie senden
    $ich = hash('sha256', (string)($b['ich'] ?? ''));
    $q = $db->prepare('SELECT COUNT(*) FROM sw_push WHERE gruppe = ? AND ep = ?'); $q->execute([$gruppe, $ich]);
    if (!$q->fetchColumn()) sw_fehler('Erst Push für diese Gruppe einschalten', 403);
    if (!sw_drossel('push-senden:' . sw_ip(), 30, 3600) || !sw_drossel("push-gruppe:$gruppe", 60, 3600) || !sw_drossel('push-alle', 3000, 86400))
      sw_fehler('Zu viele Nachrichten, bitte später', 429);
    $q = $db->prepare('SELECT id, endpoint, p256dh, auth FROM sw_push WHERE gruppe = ? AND ep <> ?'); $q->execute([$gruppe, $ich]);
    $abos = $q->fetchAll();
    $inhalt = json_encode(['g' => substr($gruppe, 0, 16), 'iv' => $d['iv'], 'ct' => $d['ct']]);
    $ergebnis = $abos ? push_senden($abos, $inhalt, 3600, !empty($b['eilig']) ? 'high' : 'normal') : [];
    $ok = 0;
    foreach ($ergebnis as $id => $st) {
      // 404/410: Abo gibt es beim Push-Dienst nicht mehr
      if ($st === 404 || $st === 410) $db->prepare('DELETE FROM sw_push WHERE id = ?')->execute([$id]);
      elseif ($st >= 200 && $st < 300) { $ok++; $db->prepare('UPDATE sw_push SET zuletzt = ?, fehler = 0 WHERE id = ?')->execute([time(), $id]); }
      else $db->prepare('UPDATE sw_push SET fehler = fehler + 1 WHERE id = ?')->execute([$id]);
    }
    $db->prepare('DELETE FROM sw_push WHERE fehler >= 20')->execute();
    $db->prepare('UPDATE sw_push SET zuletzt = ? WHERE ep = ?')->execute([time(), $ich]);
    sw_json(['ok' => true, 'an' => $ok, 'von' => count($abos)]);
}
sw_fehler('unbekannte Aktion', 400);
