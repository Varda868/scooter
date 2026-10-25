<?php
// Web Push für die Gruppe und als Sprachpost an einzelne Kontakte. Der Server kennt weder Passwort noch Inhalt:
// - Gruppe: „gruppe“ ist eine aus dem Gruppen-Passwort abgeleitete Kennung, „daten“ = {iv, ct} mit ebenso
//   abgeleitetem Schlüssel; entschlüsseln kann nur der Service Worker der Mitglieder.
// - Sprachpost: „gruppe“ ist das Postfach des Empfängers (Hash seines Talk-Schlüssels), „daten“ = {ct} mit NIP-44
//   zwischen Absender und Empfänger versiegelt; öffnen kann nur die App des Empfängers.
// POST {aktion: 'abo', gruppe, art: 'gruppe'|'post', abo: {endpoint, keys: {p256dh, auth}}, name}
// POST {aktion: 'weg', endpoint, gruppe?}
// POST {aktion: 'senden', gruppe, daten: {iv, ct}, ich: endpoint, eilig: bool}
// POST {aktion: 'senden', art: 'dm', gruppe: postfach, von: pubkey, daten: {ct}, ich: endpoint}
define('SW_API', 1);
require __DIR__ . '/lib/kern.php';
require __DIR__ . '/lib/webpush.php';

const PUSH_MAX_BYTES = 6000, PUSH_MAX_JE_GRUPPE = 50, PUSH_MAX_JE_POSTFACH = 5;

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
$geraet = fn(string $ep) => hash('sha256', $ep);

// Senden und Ergebnis verbuchen: 404/410 = Abo gibt es beim Push-Dienst nicht mehr
function push_verteilen(PDO $db, array $abos, string $inhalt, int $ttl, string $dringlichkeit): int {
  $ok = 0;
  foreach ($abos ? push_senden($abos, $inhalt, $ttl, $dringlichkeit) : [] as $id => $st) {
    if ($st === 404 || $st === 410) $db->prepare('DELETE FROM sw_push WHERE id = ?')->execute([$id]);
    elseif ($st >= 200 && $st < 300) { $ok++; $db->prepare('UPDATE sw_push SET zuletzt = ?, fehler = 0 WHERE id = ?')->execute([time(), $id]); }
    else $db->prepare('UPDATE sw_push SET fehler = fehler + 1 WHERE id = ?')->execute([$id]);
  }
  $db->prepare('DELETE FROM sw_push WHERE fehler >= 20')->execute();
  return $ok;
}

switch ($b['aktion'] ?? '') {
  case 'abo':
    $ep = (string)($b['abo']['endpoint'] ?? ''); $k = $b['abo']['keys'] ?? [];
    $art = ($b['art'] ?? '') === 'post' ? 'post' : 'gruppe';
    if (!$gruppeOk || !push_endpoint_ok($ep) || strlen($ep) > 1000) sw_fehler('Abo ungültig', 400);
    if (strlen(b64u_dec((string)($k['p256dh'] ?? ''))) !== 65 || strlen(b64u_dec((string)($k['auth'] ?? ''))) !== 16) sw_fehler('Abo-Schlüssel ungültig', 400);
    if (!sw_drossel('push-abo:' . sw_ip(), 20, 3600)) sw_fehler('Zu viele Anmeldungen', 429);
    $n = $db->prepare('SELECT COUNT(*) FROM sw_push WHERE gruppe = ? AND geraet <> ?');
    $n->execute([$gruppe, $geraet($ep)]);
    if ($n->fetchColumn() >= ($art === 'post' ? PUSH_MAX_JE_POSTFACH : PUSH_MAX_JE_GRUPPE)) sw_fehler($art === 'post' ? 'Postfach ist voll' : 'Gruppe ist voll', 409);
    // Je Gerät eine Gruppe und ein Postfach: alte Anmeldung derselben Art ersetzen
    $db->prepare('DELETE FROM sw_push WHERE geraet = ? AND (art = ? OR gruppe = ?)')->execute([$geraet($ep), $art, $gruppe]);
    $db->prepare('INSERT INTO sw_push (ep, geraet, art, gruppe, endpoint, p256dh, auth, name, t) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      ->execute([hash('sha256', "$gruppe|$ep"), $geraet($ep), $art, $gruppe, $ep, $k['p256dh'], $k['auth'],
        substr(preg_replace('/[^A-Z0-9-]/', '', strtoupper((string)($b['name'] ?? ''))), 0, 9), time()]);
    sw_json(['ok' => true]);

  case 'weg':
    if ($gruppeOk) $db->prepare('DELETE FROM sw_push WHERE geraet = ? AND gruppe = ?')->execute([$geraet((string)($b['endpoint'] ?? '')), $gruppe]);
    else $db->prepare('DELETE FROM sw_push WHERE geraet = ?')->execute([$geraet((string)($b['endpoint'] ?? ''))]);
    sw_json(['ok' => true]);

  case 'senden':
    $d = $b['daten'] ?? null;
    $ich = $geraet((string)($b['ich'] ?? ''));
    if (($b['art'] ?? '') === 'dm') {
      $von = (string)($b['von'] ?? '');
      if (!$gruppeOk || !preg_match('/^[a-f0-9]{64}$/', $von) || !is_string($d['ct'] ?? null) || strlen($d['ct']) > 3700) sw_fehler('Sprachpost ungültig', 400);
      // Absender muss selbst ein Gerät mit Push sein
      $q = $db->prepare('SELECT COUNT(*) FROM sw_push WHERE geraet = ?'); $q->execute([$ich]);
      if (!$q->fetchColumn()) sw_fehler('Erst Push einschalten', 403);
      if (!sw_drossel('push-dm:' . sw_ip(), 30, 3600) || !sw_drossel("push-postfach:$gruppe", 20, 3600) || !sw_drossel('push-alle', 3000, 86400))
        sw_fehler('Zu viele Sprachnachrichten, bitte später', 429);
      $q = $db->prepare("SELECT id, endpoint, p256dh, auth FROM sw_push WHERE gruppe = ? AND art = 'post' AND geraet <> ?"); $q->execute([$gruppe, $ich]);
      $abos = $q->fetchAll();
      // Einen Tag aufheben, falls das Handy gerade kein Netz hat
      $ok = push_verteilen($db, $abos, json_encode(['dm' => 1, 'von' => $von, 'ct' => $d['ct']]), 86400, 'high');
      $db->prepare('UPDATE sw_push SET zuletzt = ? WHERE geraet = ?')->execute([time(), $ich]);
      sw_json(['ok' => true, 'an' => $ok, 'von' => count($abos)]);
    }
    if (!$gruppeOk || !is_string($d['iv'] ?? null) || !is_string($d['ct'] ?? null) || strlen($d['iv']) > 24 || strlen($d['ct']) > 3500) sw_fehler('Nachricht ungültig', 400);
    // Nur wer selbst in der Gruppe angemeldet ist, darf an sie senden
    $q = $db->prepare('SELECT COUNT(*) FROM sw_push WHERE gruppe = ? AND geraet = ?'); $q->execute([$gruppe, $ich]);
    if (!$q->fetchColumn()) sw_fehler('Erst Push für diese Gruppe einschalten', 403);
    if (!sw_drossel('push-senden:' . sw_ip(), 30, 3600) || !sw_drossel("push-gruppe:$gruppe", 60, 3600) || !sw_drossel('push-alle', 3000, 86400))
      sw_fehler('Zu viele Nachrichten, bitte später', 429);
    $q = $db->prepare('SELECT id, endpoint, p256dh, auth FROM sw_push WHERE gruppe = ? AND geraet <> ?'); $q->execute([$gruppe, $ich]);
    $abos = $q->fetchAll();
    $ok = push_verteilen($db, $abos, json_encode(['g' => substr($gruppe, 0, 16), 'iv' => $d['iv'], 'ct' => $d['ct']]), 3600, !empty($b['eilig']) ? 'high' : 'normal');
    $db->prepare('UPDATE sw_push SET zuletzt = ? WHERE geraet = ?')->execute([time(), $ich]);
    sw_json(['ok' => true, 'an' => $ok, 'von' => count($abos)]);
}
sw_fehler('unbekannte Aktion', 400);
