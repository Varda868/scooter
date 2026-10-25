<?php
// Test für api/lib/schnorr.php (Adresswechsel des eigenen Relays). Nur auf der Kommandozeile:
//   php tools/schnorr-test.php
// Prüft ein Adress-Event (Art 34424) mit Beispieladresse 2001:db8::1, signiert mit dem Schlüssel 3 (BIP-340-Testvektor 0),
// einmal mit GMP und einmal mit bcmath, dazu verfälschte Fassungen, die abgelehnt werden müssen.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
define('SW_API', 1);
require __DIR__ . '/../api/lib/schnorr.php';

$ev = json_decode('{"pubkey":"f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9","created_at":1792965740,"kind":34424,' .
  '"tags":[["d","bcon-relay"],["r","wss://[2001:db8::1]/"],["r","ws://[2001:db8::1]/"],["expiration","1793570540"],["alt","b:con-Relay-Adresse"]],' .
  '"content":"","id":"200e5eb7e4e15bd93fd3435d608f851eb173aa9d8f696c04d66175a1e050771b",' .
  '"sig":"bd135060b64facad8cc0ab7e2d1a46528d9639df4fda6dde6f7b9ea25649c0099c7ea8b4a31574535694489da909d3906484ff443e7db565c6b16dc3f32e8025"}', true);

$fehler = 0;
foreach (['gmp', 'bcmath'] as $weg) {
  if (!extension_loaded($weg)) { echo "$weg: nicht vorhanden, übersprungen\n"; continue; }
  Secp::$erzwingen = $weg;
  $kaputt = substr($ev['sig'], 0, 127) . ($ev['sig'][127] === '0' ? '1' : '0');
  $faelle = [
    'gültig' => [fn() => nostr_event_pruefen($ev), true],
    'Signatur verfälscht' => [fn() => nostr_event_pruefen(array_merge($ev, ['sig' => $kaputt])), false],
    'Adresse verfälscht' => [fn() => nostr_event_pruefen(array_merge($ev, ['tags' => [['d', 'bcon-relay'], ['r', 'wss://[2001:db8::2]/']]])), false],
    'fremder Schlüssel' => [fn() => schnorr_pruefen('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', $ev['id'], $ev['sig']), false],
  ];
  foreach ($faelle as $name => [$f, $soll]) {
    $t = microtime(true);
    $ist = $f();
    $ms = (int)round((microtime(true) - $t) * 1000);
    $ok = $ist === $soll;
    if (!$ok) $fehler++;
    printf("%s  %-7s %-22s %s (%d ms)\n", $ok ? 'OK  ' : 'FEHL', $weg, $name, $ist ? 'gültig' : 'abgelehnt', $ms);
  }
}
Secp::$erzwingen = null;
echo $fehler ? "$fehler Fehler\n" : "alles bestanden (im Betrieb: " . schnorr_rechenweg() . ")\n";
exit($fehler ? 1 : 0);
