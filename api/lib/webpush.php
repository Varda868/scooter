<?php
// Web Push ohne Bibliothek: VAPID (RFC 8292) und Inhaltsverschlüsselung aes128gcm (RFC 8188/8291) mit openssl.
defined('SW_API') || exit;

// Nur echte Push-Dienste der Browser, sonst ließe sich der Server als Werkzeug für beliebige POSTs missbrauchen
const PUSH_HOSTS = ['~^fcm\.googleapis\.com$~', '~^android\.googleapis\.com$~', '~^updates\.push\.services\.mozilla\.com$~',
  '~^[a-z0-9.-]+\.push\.apple\.com$~', '~^[a-z0-9.-]+\.notify\.windows\.com$~'];
function push_endpoint_ok(string $url): bool {
  $p = parse_url($url);
  if (($p['scheme'] ?? '') !== 'https' || isset($p['port']) || isset($p['user']) || empty($p['host'])) return false;
  foreach (PUSH_HOSTS as $re) if (preg_match($re, strtolower($p['host']))) return true;
  return false;
}

function b64u_enc(string $s): string { return rtrim(strtr(base64_encode($s), '+/', '-_'), '='); }
function b64u_dec(string $s): string { return (string)base64_decode(strtr($s, '-_', '+/') . str_repeat('=', (4 - strlen($s) % 4) % 4), true); }

// Öffentlicher P-256-Schlüssel als 65 Byte (04 || x || y)
function push_roh(array $details): string {
  return "\x04" . str_pad($details['ec']['x'], 32, "\0", STR_PAD_LEFT) . str_pad($details['ec']['y'], 32, "\0", STR_PAD_LEFT);
}
// 65-Byte-Punkt als PEM (SubjectPublicKeyInfo), damit openssl ihn nimmt
function push_pem(string $roh): string {
  $der = hex2bin('3059301306072a8648ce3d020106082a8648ce3d030107034200') . $roh;
  return "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END PUBLIC KEY-----\n";
}
function push_neuer_schluessel() {
  return openssl_pkey_new(['curve_name' => 'prime256v1', 'private_key_type' => OPENSSL_KEYTYPE_EC]);
}

// VAPID-Schlüssel des Servers, beim ersten Bedarf erzeugt und in der Konfiguration abgelegt
function push_vapid(): array {
  $c = sw_config();
  if (empty($c['vapid']['priv'])) {
    $k = push_neuer_schluessel();
    openssl_pkey_export($k, $pem);
    $c['vapid'] = ['priv' => $pem, 'pub' => b64u_enc(push_roh(openssl_pkey_get_details($k)))];
    sw_config_speichern($c);
  }
  return $c['vapid'];
}

// DER-Signatur (SEQUENCE{INTEGER r, INTEGER s}) → 64 Byte r||s für ES256
function push_der_zu_roh(string $der): string {
  $o = 2; if (ord($der[1]) & 0x80) $o += ord($der[1]) & 0x7f;
  $teile = [];
  for ($i = 0; $i < 2; $i++) {
    $len = ord($der[$o + 1]);
    $teile[] = str_pad(ltrim(substr($der, $o + 2, $len), "\0"), 32, "\0", STR_PAD_LEFT);
    $o += 2 + $len;
  }
  return $teile[0] . $teile[1];
}
function push_jwt(string $endpoint, array $vapid): string {
  $p = parse_url($endpoint);
  $kopf = b64u_enc(json_encode(['typ' => 'JWT', 'alg' => 'ES256']));
  $inhalt = b64u_enc(json_encode(['aud' => "{$p['scheme']}://{$p['host']}", 'exp' => time() + 12 * 3600,
    'sub' => (sw_wert('origins')[0] ?? 'https://scooter.thai-klasse.de')]));
  openssl_sign("$kopf.$inhalt", $sig, $vapid['priv'], OPENSSL_ALGO_SHA256);
  return "$kopf.$inhalt." . b64u_enc(push_der_zu_roh($sig));
}

// Nachricht für ein Abo verschlüsseln (RFC 8291), Ergebnis ist der komplette Rumpf
function push_verschluesseln(string $nachricht, string $p256dh, string $auth): string {
  $ua = b64u_dec($p256dh); $geheim = b64u_dec($auth);
  if (strlen($ua) !== 65 || strlen($geheim) !== 16) throw new InvalidArgumentException('Abo-Schlüssel ungültig');
  $eph = push_neuer_schluessel();
  $as = push_roh(openssl_pkey_get_details($eph));
  $ecdh = openssl_pkey_derive(openssl_pkey_get_public(push_pem($ua)), $eph, 32);
  if ($ecdh === false) throw new RuntimeException('ECDH fehlgeschlagen');
  $ikm = hash_hkdf('sha256', $ecdh, 32, "WebPush: info\0" . $ua . $as, $geheim);
  $salz = random_bytes(16);
  $cek = hash_hkdf('sha256', $ikm, 16, "Content-Encoding: aes128gcm\0", $salz);
  $nonce = hash_hkdf('sha256', $ikm, 12, "Content-Encoding: nonce\0", $salz);
  $ct = openssl_encrypt($nachricht . "\x02", 'aes-128-gcm', $cek, OPENSSL_RAW_DATA, $nonce, $tag);
  return $salz . pack('N', 4096) . chr(65) . $as . $ct . $tag;
}

// An mehrere Abos parallel senden; Rückgabe [id => HTTP-Status oder 0]
function push_senden(array $abos, string $nachricht, int $ttl = 3600, string $dringlichkeit = 'normal'): array {
  $vapid = push_vapid();
  $mh = curl_multi_init(); $hs = [];
  foreach ($abos as $a) {
    try { $rumpf = push_verschluesseln($nachricht, $a['p256dh'], $a['auth']); } catch (Throwable $e) { $hs[$a['id']] = null; continue; }
    $c = curl_init($a['endpoint']);
    curl_setopt_array($c, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $rumpf, CURLOPT_RETURNTRANSFER => true,
      CURLOPT_FOLLOWLOCATION => false, CURLOPT_PROTOCOLS => CURLPROTO_HTTPS, CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_TIMEOUT => 10,
      CURLOPT_HTTPHEADER => ['Content-Type: application/octet-stream', 'Content-Encoding: aes128gcm', "TTL: $ttl", "Urgency: $dringlichkeit",
        'Authorization: vapid t=' . push_jwt($a['endpoint'], $vapid) . ', k=' . $vapid['pub']]]);
    curl_multi_add_handle($mh, $c);
    $hs[$a['id']] = $c;
  }
  do { $st = curl_multi_exec($mh, $laeuft); if ($laeuft) curl_multi_select($mh, 1.0); } while ($laeuft && $st === CURLM_OK);
  $ergebnis = [];
  foreach ($hs as $id => $c) {
    $ergebnis[$id] = $c ? (int)curl_getinfo($c, CURLINFO_RESPONSE_CODE) : 0;
    if ($c) { curl_multi_remove_handle($mh, $c); curl_close($c); }
  }
  curl_multi_close($mh);
  return $ergebnis;
}
