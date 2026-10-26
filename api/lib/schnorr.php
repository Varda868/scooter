<?php
// BIP-340-Schnorr prüfen (Nostr-Signaturen), ohne Bibliothek: openssl kann secp256k1-Schnorr nicht.
// Rechnet mit GMP, sonst mit bcmath (langsamer, reicht für die seltene Prüfung eines Adress-Events).
// Jacobi-Koordinaten, damit nur am Ende einmal invertiert werden muss.
defined('SW_API') || exit;

// 'gmp', 'bcmath' oder null (dann kann der Server keine Nostr-Signatur prüfen)
function schnorr_rechenweg(): ?string {
  return extension_loaded('gmp') ? 'gmp' : (extension_loaded('bcmath') ? 'bcmath' : null);
}

final class Secp {
  const P = 'fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f';
  const N = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141';
  const GX = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
  const GY = '483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8';
  public static bool $gmp = true;
  public static ?string $erzwingen = null;  // 'gmp' oder 'bcmath' (nur tools/schnorr-test.php)
  private static $p, $n, $p14, $p2;

  static function init(): void {
    self::$gmp = self::$erzwingen ? self::$erzwingen === 'gmp' : extension_loaded('gmp');
    self::$p = self::hex(self::P);
    self::$n = self::hex(self::N);
    self::$p14 = self::div4(self::add(self::$p, self::zahl(1)));   // (p+1)/4 für die Wurzel
    self::$p2 = self::sub(self::$p, self::zahl(2));                 // p-2 für die Inverse
  }
  // --- Zahlen: GMP-Objekte oder Dezimalstrings (bcmath)
  static function zahl(int $i) { return self::$gmp ? gmp_init($i) : (string)$i; }
  static function hex(string $h) {
    if (self::$gmp) return gmp_init($h === '' ? '0' : $h, 16);
    $z = '0';
    foreach (str_split(strtolower($h)) as $c) $z = bcadd(bcmul($z, '16'), (string)hexdec($c));
    return $z;
  }
  static function hex64($a): string {
    if (self::$gmp) return str_pad(gmp_strval($a, 16), 64, '0', STR_PAD_LEFT);
    $h = '';
    while (bccomp($a, '0') > 0) { $h = dechex((int)bcmod($a, '16')) . $h; $a = bcdiv($a, '16', 0); }
    return str_pad($h, 64, '0', STR_PAD_LEFT);
  }
  static function add($a, $b) { return self::$gmp ? gmp_add($a, $b) : bcadd($a, $b); }
  static function sub($a, $b) { return self::$gmp ? gmp_sub($a, $b) : bcsub($a, $b); }
  static function mul($a, $b) { return self::$gmp ? gmp_mul($a, $b) : bcmul($a, $b); }
  static function div4($a) { return self::$gmp ? gmp_div_q($a, 4) : bcdiv($a, '4', 0); }
  static function cmp($a, $b): int { return self::$gmp ? gmp_cmp($a, $b) : bccomp($a, $b); }
  static function mod($a, $m) {
    if (self::$gmp) return gmp_mod($a, $m);
    $r = bcmod($a, $m);
    return bccomp($r, '0') < 0 ? bcadd($r, $m) : $r;
  }
  static function powmod($a, $e, $m) { return self::$gmp ? gmp_powm($a, $e, $m) : bcpowmod(self::mod($a, $m), $e, $m); }
  static function ungerade($a): bool { return self::$gmp ? gmp_intval(gmp_mod($a, 2)) === 1 : bcmod($a, '2') === '1'; }
  static function null_($a): bool { return self::cmp($a, self::zahl(0)) === 0; }
  // --- Rechnen modulo p
  static function fm($a, $b) { return self::mod(self::mul($a, $b), self::$p); }
  static function fa($a, $b) { return self::mod(self::add($a, $b), self::$p); }
  static function fs($a, $b) { return self::mod(self::sub($a, $b), self::$p); }

  // --- Punkte in Jacobi-Koordinaten [X, Y, Z]; null = unendlich
  static function verdoppeln(?array $q): ?array {
    if ($q === null || self::null_($q[1])) return null;
    [$x, $y, $z] = $q;
    $yy = self::fm($y, $y);
    $s = self::fm(self::zahl(4), self::fm($x, $yy));
    $m = self::fm(self::zahl(3), self::fm($x, $x));
    $x3 = self::fs(self::fm($m, $m), self::fm(self::zahl(2), $s));
    $y3 = self::fs(self::fm($m, self::fs($s, $x3)), self::fm(self::zahl(8), self::fm($yy, $yy)));
    return [$x3, $y3, self::fm(self::zahl(2), self::fm($y, $z))];
  }
  static function addieren(?array $a, ?array $b): ?array {
    if ($a === null) return $b;
    if ($b === null) return $a;
    $z1z1 = self::fm($a[2], $a[2]); $z2z2 = self::fm($b[2], $b[2]);
    $u1 = self::fm($a[0], $z2z2); $u2 = self::fm($b[0], $z1z1);
    $s1 = self::fm($a[1], self::fm($b[2], $z2z2)); $s2 = self::fm($b[1], self::fm($a[2], $z1z1));
    if (self::cmp($u1, $u2) === 0) return self::cmp($s1, $s2) === 0 ? self::verdoppeln($a) : null;
    $h = self::fs($u2, $u1); $r = self::fs($s2, $s1);
    $hh = self::fm($h, $h); $hhh = self::fm($h, $hh); $u1hh = self::fm($u1, $hh);
    $x3 = self::fs(self::fs(self::fm($r, $r), $hhh), self::fm(self::zahl(2), $u1hh));
    $y3 = self::fs(self::fm($r, self::fs($u1hh, $x3)), self::fm($s1, $hhh));
    return [$x3, $y3, self::fm($h, self::fm($a[2], $b[2]))];
  }
  // k als 64 Hexzeichen (Bits von oben nach unten)
  static function malnehmen(string $k, ?array $q): ?array {
    $r = null;
    foreach (str_split($k) as $c) {
      $v = hexdec($c);
      for ($bit = 3; $bit >= 0; $bit--) {
        $r = self::verdoppeln($r);
        if ($v >> $bit & 1) $r = self::addieren($r, $q);
      }
    }
    return $r;
  }
  static function affin(?array $q): ?array {
    if ($q === null) return null;
    $zi = self::powmod($q[2], self::$p2, self::$p);
    $zi2 = self::fm($zi, $zi);
    return [self::fm($q[0], $zi2), self::fm($q[1], self::fm($zi, $zi2))];
  }
  // lift_x (BIP-340): Punkt mit geradem y zu x, null wenn es keinen gibt
  static function lift_x($x): ?array {
    if (self::cmp($x, self::$p) >= 0) return null;
    $c = self::fa(self::fm($x, self::fm($x, $x)), self::zahl(7));
    $y = self::powmod($c, self::$p14, self::$p);
    if (self::cmp(self::fm($y, $y), $c) !== 0) return null;
    return [$x, self::ungerade($y) ? self::sub(self::$p, $y) : $y, self::zahl(1)];
  }
  static function n() { return self::$n; }
  static function p() { return self::$p; }
}

// pk (64 hex, x-only), msg (64 hex), sig (128 hex) -> gültig?
function schnorr_pruefen(string $pk, string $msg, string $sig): bool {
  if (!schnorr_rechenweg() || !preg_match('/^[0-9a-f]{64}$/', $pk) || !preg_match('/^[0-9a-f]{64}$/', $msg) || !preg_match('/^[0-9a-f]{128}$/', $sig)) return false;
  Secp::init();
  $P = Secp::lift_x(Secp::hex($pk));
  if (!$P) return false;
  $rh = substr($sig, 0, 64);
  $r = Secp::hex($rh); $s = Secp::hex(substr($sig, 64));
  if (Secp::cmp($r, Secp::p()) >= 0 || Secp::cmp($s, Secp::n()) >= 0) return false;
  $tag = hash('sha256', 'BIP0340/challenge', true);
  $e = Secp::mod(Secp::hex(hash('sha256', $tag . $tag . hex2bin($rh . $pk . $msg))), Secp::n());
  $G = [Secp::hex(Secp::GX), Secp::hex(Secp::GY), Secp::zahl(1)];
  // R = s·G − e·P  (−e·P = (n−e)·P)
  $ne = Secp::hex64(Secp::mod(Secp::sub(Secp::n(), $e), Secp::n()));
  $R = Secp::affin(Secp::addieren(Secp::malnehmen(Secp::hex64($s), $G), Secp::malnehmen($ne, $P)));
  return $R !== null && !Secp::ungerade($R[1]) && Secp::cmp($R[0], $r) === 0;
}

// Ganzes Nostr-Event prüfen: ID (NIP-01-Serialisierung) und Signatur
function nostr_event_pruefen($e): bool {
  if (!is_array($e) || !is_string($e['id'] ?? null) || !is_string($e['pubkey'] ?? null) || !is_int($e['created_at'] ?? null) ||
      !is_int($e['kind'] ?? null) || !is_array($e['tags'] ?? null) || !is_string($e['content'] ?? null) || !is_string($e['sig'] ?? null)) return false;
  $ser = json_encode([0, $e['pubkey'], $e['created_at'], $e['kind'], $e['tags'], $e['content']], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
  if ($ser === false || !hash_equals(hash('sha256', $ser), $e['id'])) return false;
  return schnorr_pruefen($e['pubkey'], $e['id'], $e['sig']);
}
