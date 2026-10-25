<?php
// Talk-Relays prüfen: TLS und Zertifikat, WebSocket-Handshake, NIP-11, Lesetest (REQ bis EOSE).
// Ohne Bibliothek: ein kleiner WebSocket-Client über stream_socket_client. Den Schreibtest macht der Browser des Admins
// (admin.js), denn PHP bräuchte dafür Schnorr-Signaturen (secp256k1), die openssl nicht kann. Nur zum Prüfen gibt es
// sie in schnorr.php (Adress-Event des eigenen Relays, siehe relay_adresswechsel).
defined('SW_API') || exit;
require_once __DIR__ . '/schnorr.php';

const RELAY_ZEIT_S = 6;               // je Schritt höchstens so lange warten
const RELAY_VERLAUF_TAGE = 7;
const RELAY_CRON_ABSTAND_S = 240;     // Cron-Aufrufe öfter als alle 4 min werden übergangen
const RELAY_ART_ADRESSE = 34424;      // Adress-Event der b:con-Relays (bcon-core doc/ARTEN.md), d = "bcon-relay"

// Gespeicherte Liste bereinigen: nur wss://, keine Doppelten
function relay_liste(): array {
  $out = []; $gesehen = [];
  foreach ((array)sw_wert('relays') as $r) {
    $u = relay_url_norm((string)($r['url'] ?? ''));
    if ($u === null || isset($gesehen[$u])) continue;
    $gesehen[$u] = 1;
    $pk = strtolower((string)($r['pk'] ?? ''));
    $out[] = ['url' => $u, 'an' => !empty($r['an']), 'eigen' => !empty($r['eigen']), 'pk' => preg_match('/^[0-9a-f]{64}$/', $pk) ? $pk : ''];
  }
  return $out;
}
// wss://host[:port][/pfad], host auch als [IPv6]; null = ungültig
function relay_url_norm(string $u): ?string {
  $u = trim($u);
  if (!preg_match('~^wss://(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d{1,5})?(/[^\s<>"\'#]*)?$~i', $u, $m)) return null;
  if (strlen($u) > 250) return null;
  if ($m[1][0] === '[' && !filter_var(trim($m[1], '[]'), FILTER_VALIDATE_IP, FILTER_FLAG_IPV6)) return null;
  return strtolower('wss://' . $m[1] . ($m[2] ?? '')) . (($m[3] ?? '') === '/' ? '' : ($m[3] ?? ''));
}
function relay_teile(string $url): array {
  $p = parse_url($url);
  $host = $p['host'];
  return ['host' => $host, 'name' => trim($host, '[]'), 'ip6' => $host[0] === '[', 'port' => $p['port'] ?? 443,
    'pfad' => ($p['path'] ?? '') === '' ? '/' : $p['path'] . (isset($p['query']) ? '?' . $p['query'] : '')];
}

// Ein Relay prüfen. Ergebnis: ok, ms_verb (TCP+TLS+WebSocket), ms_eose, ip (Gegenstelle), cert_bis, nip11 (Kurzfassung), fehler
function relay_pruefen(string $url): array {
  $r = ['url' => $url, 'ok' => false, 'ms_verb' => null, 'ms_eose' => null, 'ip' => null, 'cert_bis' => null, 'nip11' => null, 'fehler' => null, 'schreiben' => null];
  $t = relay_teile($url);
  $r['nip11'] = relay_nip11($t);
  $ctx = ['verify_peer' => true, 'verify_peer_name' => true, 'peer_name' => $t['name'], 'capture_peer_cert' => true,
    'SNI_enabled' => !$t['ip6'] && !filter_var($t['name'], FILTER_VALIDATE_IP)];
  $start = microtime(true);
  $s = @stream_socket_client("ssl://{$t['host']}:{$t['port']}", $errno, $errstr, RELAY_ZEIT_S, STREAM_CLIENT_CONNECT, stream_context_create(['ssl' => $ctx]));
  if (!$s) {
    // Zertifikat trotzdem ansehen, damit das Dashboard sagt, was daran nicht stimmt
    $ctx['verify_peer'] = $ctx['verify_peer_name'] = false;
    $s2 = @stream_socket_client("ssl://{$t['host']}:{$t['port']}", $e2, $es2, RELAY_ZEIT_S, STREAM_CLIENT_CONNECT, stream_context_create(['ssl' => $ctx]));
    if ($s2) {
      $c = relay_zertifikat($s2); fclose($s2);
      $r['cert_bis'] = $c['bis'];
      $r['fehler'] = 'Zertifikat ungültig' . ($c['bis'] && $c['bis'] < time() ? ' (abgelaufen)' : ($c['namen'] ? ' (gilt für ' . implode(', ', array_slice($c['namen'], 0, 3)) . ')' : ''));
    } else $r['fehler'] = 'keine Verbindung: ' . (relay_text($errstr) ?: "Fehler $errno");
    return $r;
  }
  $r['ip'] = relay_gegenstelle($s);
  $r['cert_bis'] = relay_zertifikat($s)['bis'];
  stream_set_timeout($s, RELAY_ZEIT_S);
  try {
    relay_handshake($s, $t);
    $r['ms_verb'] = (int)round((microtime(true) - $start) * 1000);
    // Lesetest: irgendein Event abonnieren und auf EOSE warten (nicht jedes Relay hat Events dieser Art, EOSE kommt trotzdem)
    $sub = 'sw' . bin2hex(random_bytes(4));
    $t0 = microtime(true);
    relay_senden($s, json_encode(['REQ', $sub, ['kinds' => [1], 'limit' => 1]]));
    $ende = $t0 + RELAY_ZEIT_S;
    while (microtime(true) < $ende) {
      $m = relay_lesen($s, $ende);
      if ($m === null) break;
      $j = json_decode($m, true);
      if (!is_array($j)) continue;
      if (($j[0] ?? '') === 'EOSE' && ($j[1] ?? '') === $sub) { $r['ms_eose'] = (int)round((microtime(true) - $t0) * 1000); break; }
      if (in_array($j[0] ?? '', ['CLOSED', 'NOTICE'], true)) { $r['fehler'] = relay_text((string)($j[0] . ': ' . ($j[2] ?? $j[1] ?? ''))); if ($j[0] === 'CLOSED') break; }
    }
    relay_senden($s, json_encode(['CLOSE', $sub]));
    relay_senden($s, '', 0x8);
    if ($r['ms_eose'] === null && !$r['fehler']) $r['fehler'] = 'kein EOSE in ' . RELAY_ZEIT_S . ' s';
    $r['ok'] = $r['ms_eose'] !== null;
  } catch (RuntimeException $e) {
    $r['fehler'] = relay_text($e->getMessage());
  }
  fclose($s);
  return $r;
}

function relay_text(string $s): string { return mb_substr(preg_replace('/\s+/', ' ', trim($s)), 0, 200); }
function relay_gegenstelle($s): ?string {
  $n = (string)stream_socket_get_name($s, true);
  // "1.2.3.4:443" oder "[2a11:…]:443" bzw. "2a11:…:443"
  return preg_replace('/:\d+$/', '', trim($n, '[]')) ?: null;
}
function relay_zertifikat($s): array {
  $p = stream_context_get_params($s)['options']['ssl']['peer_certificate'] ?? null;
  $x = $p ? openssl_x509_parse($p) : null;
  $namen = [];
  foreach (explode(',', (string)($x['extensions']['subjectAltName'] ?? '')) as $n) if (trim($n) !== '') $namen[] = trim(preg_replace('/^(DNS|IP Address):/', '', trim($n)));
  return ['bis' => isset($x['validTo_time_t']) ? (int)$x['validTo_time_t'] : null, 'namen' => $namen];
}

function relay_nip11(array $t): ?array {
  if (!function_exists('curl_init')) return null;
  $c = curl_init('https://' . $t['host'] . ($t['port'] != 443 ? ':' . $t['port'] : '') . $t['pfad']);
  curl_setopt_array($c, [CURLOPT_HTTPHEADER => ['Accept: application/nostr+json'], CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => RELAY_ZEIT_S,
    CURLOPT_CONNECTTIMEOUT => RELAY_ZEIT_S, CURLOPT_FOLLOWLOCATION => false, CURLOPT_PROTOCOLS => CURLPROTO_HTTPS, CURLOPT_MAXFILESIZE => 65536,
    CURLOPT_USERAGENT => 'Scooterways-Relaypruefung/1']);
  $roh = curl_exec($c);
  $ms = (int)round(curl_getinfo($c, CURLINFO_TOTAL_TIME) * 1000);
  $status = (int)curl_getinfo($c, CURLINFO_RESPONSE_CODE);
  curl_close($c);
  $j = is_string($roh) && $status === 200 ? json_decode($roh, true) : null;
  if (!is_array($j)) return ['ok' => false, 'ms' => $ms, 'status' => $status];
  $lim = is_array($j['limitation'] ?? null) ? $j['limitation'] : [];
  return ['ok' => true, 'ms' => $ms, 'name' => relay_text((string)($j['name'] ?? '')), 'software' => relay_text(basename((string)($j['software'] ?? ''))),
    'version' => relay_text((string)($j['version'] ?? '')), 'nips' => array_values(array_filter((array)($j['supported_nips'] ?? []), 'is_int')),
    'self' => preg_match('/^[0-9a-f]{64}$/', (string)($j['self'] ?? '')) ? $j['self'] : null,
    'auth' => !empty($lim['auth_required']), 'bezahlt' => !empty($lim['payment_required'])];
}

// --- WebSocket (RFC 6455), nur was ein Nostr-Client braucht ---
function relay_handshake($s, array $t): void {
  $key = base64_encode(random_bytes(16));
  $origin = (array)sw_wert('origins');
  fwrite($s, "GET {$t['pfad']} HTTP/1.1\r\nHost: {$t['host']}" . ($t['port'] != 443 ? ":{$t['port']}" : '') . "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" .
    "Sec-WebSocket-Key: $key\r\nSec-WebSocket-Version: 13\r\nOrigin: " . ($origin[0] ?? 'https://scooter.thai-klasse.de') . "\r\nUser-Agent: Scooterways-Relaypruefung/1\r\n\r\n");
  $kopf = '';
  while (!str_contains($kopf, "\r\n\r\n")) {
    $z = fgets($s, 4096);
    if ($z === false) throw new RuntimeException('Handshake: keine Antwort');
    $kopf .= $z;
    if (strlen($kopf) > 16384) throw new RuntimeException('Handshake: Antwort zu lang');
  }
  if (!preg_match('~^HTTP/1\.1 101~', $kopf)) throw new RuntimeException('Handshake: ' . strtok($kopf, "\r\n"));
  $soll = base64_encode(sha1($key . '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', true));
  if (!preg_match('~^Sec-WebSocket-Accept:\s*(\S+)~mi', $kopf, $m) || $m[1] !== $soll) throw new RuntimeException('Handshake: falsche Bestätigung');
}
// Client-Rahmen sind immer maskiert
function relay_senden($s, string $daten, int $op = 0x1): void {
  $n = strlen($daten);
  $kopf = chr(0x80 | $op) . ($n < 126 ? chr(0x80 | $n) : ($n < 65536 ? chr(0x80 | 126) . pack('n', $n) : chr(0x80 | 127) . pack('J', $n)));
  $maske = random_bytes(4);
  $roh = '';
  for ($i = 0; $i < $n; $i++) $roh .= $daten[$i] ^ $maske[$i & 3];
  @fwrite($s, $kopf . $maske . $roh);
}
function relay_bytes($s, int $n, float $ende): string {
  $b = '';
  while (strlen($b) < $n) {
    if (microtime(true) > $ende) throw new RuntimeException('Zeitüberschreitung');
    stream_set_timeout($s, max(1, (int)ceil($ende - microtime(true))));
    $teil = fread($s, $n - strlen($b));
    if ($teil === false || ($teil === '' && (feof($s) || stream_get_meta_data($s)['timed_out']))) throw new RuntimeException(feof($s) ? 'Verbindung vom Relay geschlossen' : 'Zeitüberschreitung');
    $b .= $teil;
  }
  return $b;
}
// Nächste Textnachricht (Fragmente zusammengesetzt, Ping beantwortet); null bei Close
function relay_lesen($s, float $ende): ?string {
  $text = '';
  while (true) {
    [$a, $b] = array_values(unpack('C2', relay_bytes($s, 2, $ende)));
    $op = $a & 0x0f; $n = $b & 0x7f;
    if ($n === 126) $n = unpack('n', relay_bytes($s, 2, $ende))[1];
    elseif ($n === 127) $n = unpack('J', relay_bytes($s, 8, $ende))[1];
    if ($n > 4 * 1048576) throw new RuntimeException('Nachricht zu groß');
    $maske = $b & 0x80 ? relay_bytes($s, 4, $ende) : null;
    $daten = $n ? relay_bytes($s, $n, $ende) : '';
    if ($maske) for ($i = 0; $i < $n; $i++) $daten[$i] = $daten[$i] ^ $maske[$i & 3];
    if ($op === 0x8) return null;
    if ($op === 0x9) { relay_senden($s, $daten, 0xA); continue; }
    if ($op === 0xA) continue;
    $text .= $daten;
    if ($a & 0x80) return $text;
  }
}

// Ergebnis in den Verlauf; alte Einträge weg
function relay_merken(array $r, string $quelle): void {
  $db = sw_db();
  $db->prepare('INSERT INTO sw_relay (t, url, quelle, ok, ms_verb, ms_eose, schreiben, ip, cert_bis, nip11, fehler) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    ->execute([time(), $r['url'], $quelle, $r['ok'] ? 1 : 0, $r['ms_verb'], $r['ms_eose'], $r['schreiben'] === null ? null : ($r['schreiben'] ? 1 : 0),
      $r['ip'], $r['cert_bis'], $r['nip11'] === null ? null : json_encode($r['nip11']), $r['fehler'] === null ? null : relay_text($r['fehler'])]);
  $db->prepare('DELETE FROM sw_relay WHERE t < ?')->execute([time() - RELAY_VERLAUF_TAGE * 86400]);
}
// Alle eingetragenen Relays (auch ausgeschaltete) prüfen; beim eigenen Relay danach Schlüssel merken bzw. Adresswechsel
function relay_alle_pruefen(): array {
  $out = [];
  foreach (relay_liste() as $r) {
    $e = relay_pruefen($r['url']);
    if ($r['eigen']) $e = relay_adresswechsel($r, $e);
    relay_merken($e, 'server');
    $out[] = $e;
  }
  return $out;
}

// --- Adresswechsel des eigenen Relays (b:con-Relay, Bauplan P8) ---
// Nach einem IPv6-Präfixwechsel hat das Relay eine neue Adresse und veröffentlicht sie als Adress-Event (Art 34424),
// signiert mit seinem Schlüssel (NIP-11 "self"), auf öffentlichen Relays. Den Schlüssel merkt sich der Server bei der
// ersten erfolgreichen Prüfung (oder er steht von Hand in der Liste). Schlägt die Prüfung fehl, holt der Server das
// neueste Adress-Event dieses Schlüssels, prüft ID und Signatur, prüft die neue Adresse und tauscht sie nur aus, wenn
// auch diese Prüfung klappt.
function relay_adresswechsel(array $r, array $e): array {
  if ($e['ok']) {
    $self = $e['nip11']['self'] ?? null;
    if ($r['pk'] === '' && $self) relay_eintrag_aendern($r['url'], ['pk' => $self]);
    return $e;
  }
  if ($r['pk'] === '' || !schnorr_rechenweg()) return $e;
  $quellen = array_column(array_filter(relay_liste(), fn($x) => $x['an'] && !$x['eigen']), 'url') ?: array_column(SW_STANDARD['relays'], 'url');
  $neu = relay_adresse_suchen($r['pk'], $quellen);
  if ($neu === null || $neu === $r['url']) return $e;
  $e2 = relay_pruefen($neu);
  if (!$e2['ok']) {
    $e['fehler'] .= ' · neue Adresse ' . $neu . ' gefunden, aber nicht erreichbar: ' . $e2['fehler'];
    return $e;
  }
  relay_eintrag_aendern($r['url'], ['url' => $neu]);
  relay_merken($e, 'server');  // der Fehlschlag der alten Adresse bleibt im Verlauf
  $e2['fehler'] = 'Adresse gewechselt, vorher ' . $r['url'];
  return $e2;
}
// Eintrag in der gespeicherten Liste ändern (gefunden über die URL)
function relay_eintrag_aendern(string $url, array $neu): void {
  $c = sw_config();
  $liste = (array)($c['werte']['relays'] ?? []);
  foreach ($liste as &$x) if (relay_url_norm((string)($x['url'] ?? '')) === $url) $x = array_merge($x, $neu);
  unset($x);
  $c['werte']['relays'] = $liste;
  sw_config_speichern($c);
}
// Neuestes gültiges Adress-Event des Schlüssels von den Quellen; Rückgabe die wss-Adresse daraus oder null
function relay_adresse_suchen(string $pk, array $quellen): ?string {
  $best = null;
  foreach (array_slice($quellen, 0, 3) as $q) {
    try { $evs = relay_abfragen($q, ['kinds' => [RELAY_ART_ADRESSE], 'authors' => [$pk], '#d' => ['bcon-relay'], 'limit' => 2]); }
    catch (RuntimeException $x) { continue; }
    foreach ($evs as $ev) {
      if (($ev['pubkey'] ?? '') !== $pk || ($ev['kind'] ?? 0) !== RELAY_ART_ADRESSE || !is_int($ev['created_at'] ?? null)) continue;
      if (($best && $ev['created_at'] <= $best['created_at']) || $ev['created_at'] > time() + 600 || !nostr_event_pruefen($ev)) continue;
      $best = $ev;
    }
  }
  if (!$best) return null;
  $url = null;
  foreach ($best['tags'] as $t) {
    if (!is_array($t)) continue;
    if (($t[0] ?? '') === 'expiration' && (int)($t[1] ?? 0) < time()) return null;
    if (!$url && ($t[0] ?? '') === 'r' && str_starts_with((string)($t[1] ?? ''), 'wss://')) $url = relay_url_norm((string)$t[1]);
  }
  return $url;
}
// REQ an ein Relay, alle Events bis EOSE (höchstens 20)
function relay_abfragen(string $url, array $filter): array {
  $t = relay_teile($url);
  $ctx = ['verify_peer' => true, 'verify_peer_name' => true, 'peer_name' => $t['name'], 'SNI_enabled' => !$t['ip6'] && !filter_var($t['name'], FILTER_VALIDATE_IP)];
  $s = @stream_socket_client("ssl://{$t['host']}:{$t['port']}", $errno, $errstr, RELAY_ZEIT_S, STREAM_CLIENT_CONNECT, stream_context_create(['ssl' => $ctx]));
  if (!$s) throw new RuntimeException('keine Verbindung');
  stream_set_timeout($s, RELAY_ZEIT_S);
  $out = [];
  try {
    relay_handshake($s, $t);
    $sub = 'sa' . bin2hex(random_bytes(4));
    relay_senden($s, json_encode(['REQ', $sub, $filter], JSON_UNESCAPED_SLASHES));
    $ende = microtime(true) + RELAY_ZEIT_S;
    while (microtime(true) < $ende && count($out) < 20) {
      $m = relay_lesen($s, $ende);
      if ($m === null) break;
      $j = json_decode($m, true);
      if (!is_array($j) || ($j[1] ?? '') !== $sub) continue;
      if ($j[0] === 'EVENT' && is_array($j[2] ?? null)) $out[] = $j[2];
      elseif ($j[0] === 'EOSE' || $j[0] === 'CLOSED') break;
    }
    relay_senden($s, json_encode(['CLOSE', $sub]));
    relay_senden($s, '', 0x8);
  } finally { fclose($s); }
  return $out;
}

// Ausgehendes IPv6 (und zum Vergleich IPv4) vom Server aus; 10 min zwischengespeichert
function sw_ip_test(bool $frisch = false): array {
  $d = sw_daten();
  $datei = $d ? "$d/ip-test.json" : null;
  if (!$frisch && $datei && ($alt = json_decode((string)@file_get_contents($datei), true)) && time() - ($alt['t'] ?? 0) < 600) return $alt;
  $probe = function (string $ziel) {
    $t = microtime(true);
    $s = @stream_socket_client("tcp://$ziel", $no, $err, 4);
    if (!$s) return ['ok' => false, 'fehler' => relay_text($err ?: "Fehler $no")];
    $eigen = (string)stream_socket_get_name($s, false);
    fclose($s);
    return ['ok' => true, 'ms' => (int)round((microtime(true) - $t) * 1000), 'eigen' => preg_replace('/:\d+$/', '', trim($eigen, '[]'))];
  };
  $r = ['t' => time(), 'ipv6' => $probe('[2606:4700:4700::1111]:443'), 'ipv4' => $probe('1.1.1.1:443')];
  if ($datei) @file_put_contents($datei, json_encode($r), LOCK_EX);
  return $r;
}
