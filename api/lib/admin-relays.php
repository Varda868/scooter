<?php
// Admin-Bereich „Relays“: Liste der Talk-Relays (Reihenfolge, an/aus, eigenes), Zustand und Verlauf der Prüfungen.
// Die App übernimmt die eingeschalteten Relays über konfig.php. Geprüft wird vom Server (Knopf oder Cron-URL)
// und auf Knopfdruck vom Browser des Admins, der als Einziger auch schreiben kann (flüchtiges, signiertes Event).
defined('SW_API') || exit;
require_once __DIR__ . '/relays.php';

$BEREICHE['relays'] = ['titel' => 'Relays', 'fn' => 'bereich_relays',
  'zahl' => fn() => count(array_filter(relay_liste(), fn($r) => $r['an']))];

function relay_token(): string {
  $c = sw_config();
  if (empty($c['relay_token'])) { $c['relay_token'] = bin2hex(random_bytes(16)); sw_config_speichern($c); }
  return $c['relay_token'];
}

function bereich_relays(): void {
  global $OK;
  $fehler = null;
  if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $aktion = (string)($_POST['aktion'] ?? '');
    if ($aktion === 'speichern') {
      $zeilen = [];
      foreach ((array)($_POST['r'] ?? []) as $z) {
        if (!is_array($z) || !empty($z['weg']) || trim((string)($z['url'] ?? '')) === '') continue;
        $u = relay_url_norm((string)$z['url']);
        if ($u === null) { $fehler = 'Ungültige Adresse: ' . mb_substr((string)$z['url'], 0, 80) . ' (nur wss://host[:port][/pfad], IPv6 in [ ])'; break; }
        $zeilen[] = ['pos' => (float)($z['pos'] ?? 99), 'url' => $u, 'an' => !empty($z['an']), 'eigen' => !empty($z['eigen'])];
      }
      if (!$fehler && !array_filter($zeilen, fn($z) => $z['an'])) $fehler = 'Mindestens ein Relay muss eingeschaltet sein.';
      if (!$fehler) {
        usort($zeilen, fn($a, $b) => $a['pos'] <=> $b['pos']);
        $c = sw_config();
        $c['werte']['relays'] = array_map(fn($z) => ['url' => $z['url'], 'an' => $z['an'], 'eigen' => $z['eigen']], $zeilen);
        sw_config_speichern($c);
        admin_zurueck('relays', 'Gespeichert. Die App übernimmt die Liste beim nächsten Start.');
      }
    } elseif ($aktion === 'pruefen') {
      @set_time_limit(120);
      relay_alle_pruefen();
      sw_ip_test(true);
      admin_zurueck('relays', 'Vom Server geprüft.');
    } elseif ($aktion === 'browser') {
      // Ergebnisse aus admin.js; nur Relays aus der Liste, Werte begrenzt
      $bekannt = array_column(relay_liste(), 'url');
      foreach ((array)json_decode((string)($_POST['daten'] ?? ''), true) as $e) {
        if (!is_array($e) || !in_array($e['url'] ?? '', $bekannt, true)) continue;
        $zahl = fn($k) => isset($e[$k]) && is_numeric($e[$k]) ? max(0, min(60000, (int)$e[$k])) : null;
        relay_merken(['url' => $e['url'], 'ok' => !empty($e['ok']), 'ms_verb' => $zahl('ms_verb'), 'ms_eose' => $zahl('ms_eose'),
          'schreiben' => isset($e['schreiben']) ? (bool)$e['schreiben'] : null, 'ip' => null, 'cert_bis' => null, 'nip11' => null,
          'fehler' => isset($e['fehler']) ? (string)$e['fehler'] : null], 'browser');
      }
      sw_json(['ok' => true]);
    } elseif ($aktion === 'token') {
      $c = sw_config(); $c['relay_token'] = bin2hex(random_bytes(16)); sw_config_speichern($c);
      admin_zurueck('relays', 'Neue Cron-Adresse erzeugt. Bitte in Plesk eintragen.');
    }
  }

  $db = sw_db();
  $liste = relay_liste();
  $html = admin_hinweis($OK, $fehler) . '<form method="post" id="relayForm">' . admin_csrf_feld() . '<input type="hidden" name="aktion" value="speichern">' .
    '<table><tr><th>#</th><th>Adresse</th><th>an</th><th>eigenes</th><th>weg</th></tr>';
  foreach (array_merge($liste, [['url' => '', 'an' => true, 'eigen' => false]]) as $i => $r)
    $html .= '<tr><td><input name="r[' . $i . '][pos]" value="' . ($i + 1) . '" size="2" inputmode="numeric" class="pos"></td>' .
      '<td><input name="r[' . $i . '][url]" value="' . h($r['url']) . '" placeholder="' . ($r['url'] === '' ? 'neues Relay: wss://…' : '') . '" spellcheck="false"></td>' .
      '<td><input type="checkbox" name="r[' . $i . '][an]" value="1"' . ($r['an'] ? ' checked' : '') . '></td>' .
      '<td><input type="checkbox" name="r[' . $i . '][eigen]" value="1"' . ($r['eigen'] ? ' checked' : '') . '></td>' .
      '<td>' . ($r['url'] !== '' ? '<input type="checkbox" name="r[' . $i . '][weg]" value="1">' : '') . '</td></tr>';
  $html .= '</table><button>Liste speichern</button></form>';

  // Zustand: letzte Prüfung je Relay und Quelle, dazu ein kurzer Verlauf
  $html .= '<h2>Zustand</h2><div class="knoepfe"><form method="post">' . admin_csrf_feld() . '<input type="hidden" name="aktion" value="pruefen"><button>Jetzt vom Server prüfen</button></form>' .
    '<button id="browserPruefen" type="button" data-csrf="' . h(sw_csrf()) . '">Im Browser prüfen (mit Schreibtest)</button></div><p id="browserStatus" class="leise"></p>';
  $html .= '<table id="relayZustand"><tr><th>Relay</th><th>Server</th><th>Browser</th><th>Zertifikat</th><th>NIP-11</th><th>Verlauf</th></tr>';
  $letzt = $db->prepare('SELECT * FROM sw_relay WHERE url = ? AND quelle = ? ORDER BY t DESC LIMIT 1');
  $verlauf = $db->prepare("SELECT ok, t FROM sw_relay WHERE url = ? AND quelle = 'server' ORDER BY t DESC LIMIT 24");
  foreach ($liste as $r) {
    $letzt->execute([$r['url'], 'server']); $s = $letzt->fetch() ?: null;
    $letzt->execute([$r['url'], 'browser']); $b = $letzt->fetch() ?: null;
    $verlauf->execute([$r['url']]);
    $punkte = '';
    foreach (array_reverse($verlauf->fetchAll()) as $v) $punkte .= '<span class="punkt ' . ($v['ok'] ? 'gut' : 'schlecht') . '" title="' . admin_zeit((int)$v['t']) . '"></span>';
    $n = $s && $s['nip11'] ? json_decode($s['nip11'], true) : null;
    $html .= '<tr data-url="' . h($r['url']) . '"><td>' . ($r['eigen'] ? '🏠 ' : '') . '<code>' . h($r['url']) . '</code>' . ($r['an'] ? '' : ' <span class="leise">(aus)</span>') .
      ($s && $s['ip'] ? '<br><span class="leise">' . (str_contains($s['ip'], ':') ? 'IPv6' : 'IPv4') . ' ' . h($s['ip']) . '</span>' : '') . '</td>' .
      '<td>' . relay_zelle($s) . '</td><td class="browser">' . relay_zelle($b, true) . '</td><td>' . relay_cert($s, $r['eigen']) . '</td><td>' . relay_nip11_zelle($n) . '</td><td>' . ($punkte ?: '–') . '</td></tr>';
  }
  $html .= '</table>';

  $ip = sw_ip_test();
  $html .= '<h2>Server-Netz</h2><ul><li>Ausgehend IPv6: ' . relay_ip_zeile($ip['ipv6']) . '</li><li>Ausgehend IPv4: ' . relay_ip_zeile($ip['ipv4']) . '</li></ul>' .
    '<p class="leise">Ohne ausgehendes IPv6 kann der Server ein Relay, das nur über IPv6 erreichbar ist, nicht prüfen; die App auf dem Handy ist davon nicht betroffen.</p>';

  $cron = 'https://' . ($_SERVER['HTTP_HOST'] ?? 'scooter.thai-klasse.de') . dirname($_SERVER['SCRIPT_NAME']) . '/relaypruefung.php?k=' . relay_token();
  $html .= '<h2>Regelmäßig prüfen</h2><p>In Plesk unter <b>Geplante Aufgaben</b> eine Aufgabe „URL abrufen“ anlegen, z. B. alle 15 Minuten:</p><pre>' . h($cron) . '</pre>' .
    '<form method="post">' . admin_csrf_feld() . '<input type="hidden" name="aktion" value="token"><button class="klein">Neue Cron-Adresse</button></form>' .
    '<p class="leise">Verlauf: ' . RELAY_VERLAUF_TAGE . ' Tage. Gezeigt werden die letzten 24 Server-Prüfungen.</p>';
  admin_seite('Relays', $html . '<script type="module" src="admin.js"></script>');
}

function relay_zelle(?array $e, bool $browser = false): string {
  if (!$e) return '<span class="leise">' . ($browser ? 'noch nicht' : 'noch nie') . '</span>';
  $t = '<span class="leise">' . admin_zeit((int)$e['t']) . '</span><br>';
  if (!$e['ok']) return $t . '❌ ' . h((string)$e['fehler']);
  return $t . '✅ ' . (int)$e['ms_verb'] . ' ms, EOSE ' . (int)$e['ms_eose'] . ' ms' .
    ($e['schreiben'] === null ? '' : ($e['schreiben'] ? ' · ✍️ schreiben ok' : ' · ⚠️ schreiben nicht')) .
    ($e['fehler'] ? '<br><span class="leise">' . h((string)$e['fehler']) . '</span>' : '');
}
function relay_cert(?array $s, bool $eigen): string {
  if (!$s || !$s['cert_bis']) return '–';
  $tage = ((int)$s['cert_bis'] - time()) / 86400;
  // IP-Zertifikate von Let's Encrypt laufen nur wenige Tage; beim eigenen Relay früher warnen
  $warn = $tage < ($eigen ? 2 : 7);
  return ($tage < 0 ? '❌ abgelaufen' : ($warn ? '⚠️ ' : '') . 'bis ' . date('d.m.Y H:i', (int)$s['cert_bis'])) . '<br><span class="leise">noch ' . max(0, round($tage, 1)) . ' Tage</span>';
}
function relay_nip11_zelle(?array $n): string {
  if (!$n) return '–';
  if (empty($n['ok'])) return '<span class="leise">keine Angaben (' . (int)($n['status'] ?? 0) . ')</span>';
  return h(trim(($n['name'] ?? '') . ' · ' . ($n['software'] ?? '') . ' ' . ($n['version'] ?? ''), ' ·')) .
    '<br><span class="leise">NIPs ' . h(implode(', ', array_slice($n['nips'] ?? [], 0, 14))) . (($n['auth'] ?? false) ? ' · Anmeldung nötig' : '') . (($n['bezahlt'] ?? false) ? ' · kostenpflichtig' : '') . '</span>';
}
function relay_ip_zeile(array $p): string {
  return $p['ok'] ? '✅ ' . (int)$p['ms'] . ' ms' . (!empty($p['eigen']) ? ' <span class="leise">(Absender ' . h($p['eigen']) . ')</span>' : '') : '❌ ' . h((string)($p['fehler'] ?? ''));
}
