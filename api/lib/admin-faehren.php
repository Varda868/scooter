<?php
// Admin-Bereich „Fährdaten“: Quellen mit Zustand, Zeitplänen und „Jetzt aktualisieren“, Schweden-Schlüssel,
// Mail nach Läufen, Qualitätsbericht (Abdeckung je Meer, verdächtige Linien, Dauer gegen Fahrplan) und Verlauf.
defined('SW_API') || exit;
require_once __DIR__ . '/faehren.php';

$BEREICHE['faehren'] = ['titel' => 'Fährdaten', 'fn' => 'bereich_faehren'];

function bereich_faehren(): void {
  global $OK;
  $fehler = null;
  if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $aktion = (string)($_POST['aktion'] ?? '');
    if ($aktion === 'speichern') {
      $c = sw_config(); $e = $c['faehren'] ?? [];
      $mail = trim((string)($_POST['mail'] ?? ''));
      if ($mail !== '' && !filter_var($mail, FILTER_VALIDATE_EMAIL)) $fehler = 'Mail-Adresse ungültig.';
      foreach (FAEHR_QUELLEN as $id => [, $art]) {
        if ($art !== 'lauf') continue;
        $cron = trim((string)($_POST["cron_$id"] ?? ''));
        if (!preg_match('~^[0-9*/,-]+( [0-9*/,-]+){4}$~', $cron)) { $fehler = 'Zeitplan bitte im Cron-Stil mit fünf Feldern, z. B. 15 6 * * *'; break; }
        $e['quellen'][$id] = ['an' => !empty($_POST["an_$id"]), 'cron' => $cron];
      }
      if (!empty($_POST['trafiklab_weg'])) $c['werte']['trafiklab_key'] = '';
      elseif (($neu = trim((string)($_POST['trafiklab_key'] ?? ''))) !== '') {
        if (preg_match('/^[\x21-\x7e]{8,200}$/', $neu)) $c['werte']['trafiklab_key'] = $neu; else $fehler = 'Trafiklab-Schlüssel: Zeichen ungültig.';
      }
      if (!$fehler) {
        $e['mail'] = $mail; $e['mail_art'] = ($_POST['mail_art'] ?? '') === 'immer' ? 'immer' : 'fehler';
        $c['faehren'] = $e; sw_config_speichern($c);
        admin_zurueck('faehren', 'Gespeichert.');
      }
    } elseif (in_array($aktion, ['lauf', 'auswerten'], true) && isset(FAEHR_QUELLEN[$q = (string)($_POST['q'] ?? '')])) {
      [$p] = faehr_lauf($q, true, $aktion === 'auswerten');
      admin_zurueck('faehren', FAEHR_QUELLEN[$q][0] . ($p ? ': Fehler, siehe Verlauf' : ': fertig'));
    } elseif ($aktion === 'testmail') {
      $e = faehr_einstellungen();
      if ($e['mail'] === '') $fehler = 'Erst eine Mail-Adresse speichern.';
      else { faehr_mail('osm', ['Testmail aus Admin → Fährdaten (kein echter Fehler)'], [], 0); admin_zurueck('faehren', 'Testmail an ' . $e['mail'] . ' verschickt.'); }
    }
  }
  $e = faehr_einstellungen();
  $basis = 'https://' . ($_SERVER['HTTP_HOST'] ?? 'scooter.thai-klasse.de') . dirname($_SERVER['SCRIPT_NAME']) . '/wartung.php?k=' . relay_token() . '&was=faehren-';
  $html = admin_hinweis($OK, $fehler);
  if ($w = faehr_warnungen()) $html .= '<p class="fehler banner">⚠️ ' . implode('<br>⚠️ ', array_map('h', $w)) . '</p>';

  // Quellen
  $html .= '<h2>Quellen</h2><form method="post">' . admin_csrf_feld() . '<input type="hidden" name="aktion" value="speichern">' .
    '<table><tr><th>Quelle</th><th>Zeitplan</th><th>Letzter Lauf</th></tr>';
  foreach (FAEHR_QUELLEN as $id => [$name, $art, $cron, , $text]) {
    $l = faehr_verlauf($id, 1)[0] ?? null;
    $an = $e['quellen'][$id]['an'];
    $html .= '<tr><td>' . ($art === 'lauf' ? '<label class="zeile"><input type="checkbox" name="an_' . $id . '" value="1"' . ($an ? ' checked' : '') . '> <b>' . h($name) . '</b></label>'
        : '<b>' . h($name) . '</b> <span class="leise">· in Erprobung</span>') .
      '<div class="leise">' . h($text) . '</div>' . ($art === 'lauf' ? '<pre>' . h($basis . $id) . '</pre>' : '') . '</td><td>' .
      ($art === 'lauf' ? '<input name="cron_' . $id . '" value="' . h($e['quellen'][$id]['cron']) . '" class="cron">' : '<code>' . h($cron) . '</code>') . '</td><td>' .
      ($l ? admin_zeit((int)$l['t']) . '<br>' . ($l['ok'] ? '✅' : '❌') . ($l['linien'] !== null ? ' ' . (int)$l['linien'] . ' Linien' : '') . ' · ' . round($l['ms'] / 1000) . ' s'
        : '<span class="leise">' . ($art === 'lauf' ? 'noch nie' : 'Platzhalter') . '</span>') . '</td></tr>';
  }
  $gesetzt = (string)sw_wert('trafiklab_key') !== '';
  $html .= '</table><label>Trafiklab-Schlüssel für „GTFS Sverige 2“ <span class="leise">' . ($gesetzt ? 'gesetzt (…' . h(substr((string)sw_wert('trafiklab_key'), -4)) . ')' : 'nicht gesetzt – kostenlos auf trafiklab.se anlegen') . '</span>' .
    '<input type="password" name="trafiklab_key" autocomplete="off" placeholder="' . ($gesetzt ? 'leer lassen = unverändert' : 'Schlüssel eingeben') . '"></label>' .
    ($gesetzt ? '<label class="zeile"><input type="checkbox" name="trafiklab_weg" value="1"> Schlüssel löschen</label>' : '') .
    '<p class="leise">Trafiklab-Abrufe in den letzten 30 Tagen: <b>' . count(faehr_se_stand()['abrufe']) . ' von ' . FAEHR_SE_LIMIT . '</b> · „jetzt“ ab ' . FAEHR_SE_SPERRE . ' gesperrt' .
    (($t = faehr_se_stand()['ok_t']) ? ' · letzter erfolgreicher Abruf ' . admin_zeit((int)$t) : '') . '</p>' .
    '<label>Mail an <input type="email" name="mail" value="' . h($e['mail']) . '" placeholder="leer = keine eigene Mail (Plesk meldet Fehler trotzdem)"></label>' .
    '<label class="zeile"><input type="radio" name="mail_art" value="fehler"' . ($e['mail_art'] === 'fehler' ? ' checked' : '') . '> nur bei Fehlern</label>' .
    '<label class="zeile"><input type="radio" name="mail_art" value="immer"' . ($e['mail_art'] === 'immer' ? ' checked' : '') . '> nach jedem Lauf eine kurze Zusammenfassung (neue und weggefallene Linien, Abdeckung, Verdächtiges)</label>' .
    '<button>Speichern</button></form>';
  $html .= '<div class="knoepfe">';
  $se = faehr_se_stand(); $n = count($se['abrufe']);
  foreach (FAEHR_QUELLEN as $id => [$name, $art]) if ($art === 'lauf')
    $html .= '<form method="post">' . admin_csrf_feld() . '<input type="hidden" name="aktion" value="lauf"><input type="hidden" name="q" value="' . $id . '"><button class="klein"' .
      ($id === 'se' && $n >= FAEHR_SE_SPERRE ? ' disabled title="Schon ' . $n . ' Abrufe in 30 Tagen"' : '') . '>↻ ' . h($name) . ' jetzt</button></form>';
  $html .= is_file(sw_daten() . '/gtfs-se.zip') ? '<form method="post">' . admin_csrf_feld() . '<input type="hidden" name="aktion" value="auswerten"><input type="hidden" name="q" value="se"><button class="klein">⟳ Schweden neu auswerten (ohne Abruf)</button></form>' : '';
  $html .= '<form method="post">' . admin_csrf_feld() . '<input type="hidden" name="aktion" value="testmail"><button class="klein">✉ Testmail</button></form></div>' .
    '<p class="leise">In Plesk unter <b>Geplante Aufgaben</b> je Quelle eine Aufgabe „URL abrufen“ mit der Adresse und dem Zeitplan von oben anlegen. ' .
    'Bei einem Fehler antwortet die Adresse mit HTTP 500. Wer hier eine Mail-Adresse einträgt, kann Plesk auf „Nicht benachrichtigen“ stellen, sonst kommen Fehler doppelt. ' .
    'Der Schweden-Lauf lädt einige hundert MB und kann mehrere Minuten dauern; „jetzt“ wartet so lange. „Neu auswerten“ nimmt die Datei auf dem Server und verbraucht keinen Abruf.</p>';

  // Qualitätsbericht aus dem letzten OSM-Lauf
  $b = json_decode((string)@file_get_contents(sw_daten() . '/faehren-bericht.json'), true);
  $html .= '<h2>Qualität der Fährlinien</h2>';
  if (!$b) $html .= '<p class="leise">Noch kein Bericht. „OSM-Fährkacheln jetzt“ erzeugt ihn.</p>';
  else {
    $html .= '<p class="leise">Stand ' . admin_zeit((int)$b['t']) . ' · Kacheln vom ' . h($b['stand']) . ' · ' . (int)$b['linien'] . ' Linien, davon ' . (int)$b['relationen'] . ' aus Relationen</p>' .
      '<table><tr><th>Meer</th><th>Abdeckung</th><th>Fehlt</th></tr>';
    foreach ($b['meere'] as $meer => $m) $html .= '<tr><td>' . h($meer) . '</td><td>' . (int)$m['prozent'] . ' % <span class="leise">von ' . (int)$m['n'] . '</span></td><td>' . h(implode(', ', $m['fehlt'])) . '</td></tr>';
    $html .= '</table>';
    $osm = fn($id) => '<a href="https://www.openstreetmap.org/' . ($id[0] === 'r' ? 'relation/' : 'way/') . h(substr($id, 1)) . '" target="_blank" rel="noopener">' . h($id) . '</a>';
    if ($b['dauer']) {
      $html .= '<h3>Dauer weicht vom Fahrplan ab (über 25 %)</h3><table><tr><th>Linie</th><th>OSM</th><th>Fahrplan</th><th></th></tr>';
      foreach ($b['dauer'] as $d) $html .= '<tr><td>' . h($d['name']) . ' ' . $osm($d['id']) . '</td><td>' . (int)$d['osm'] . ' min</td><td>' . (int)$d['fahrplan'] . ' min (' . h($d['quelle']) . ')</td><td>' . ($d['abw'] > 0 ? '+' : '') . (int)$d['abw'] . ' %</td></tr>';
      $html .= '</table>';
    }
    $v = $b['verdaechtig'];
    $html .= '<details><summary>' . count($v) . ' verdächtige Linien</summary><table><tr><th>Linie</th><th>Grund</th></tr>';
    foreach (array_slice($v, 0, 300) as $x) $html .= '<tr><td>' . $osm($x['id']) . ' ' . h($x['name']) . '</td><td>' . h($x['grund']) . '</td></tr>';
    $html .= '</table></details>';
  }

  // Verlauf
  $html .= '<h2>Verlauf</h2><table><tr><th>Zeit</th><th>Quelle</th><th>Dauer</th><th>Ergebnis</th></tr>';
  foreach (faehr_verlauf(null, 30) as $l) $html .= '<tr><td>' . admin_zeit((int)$l['t']) . '</td><td>' . h(FAEHR_QUELLEN[$l['quelle']][0] ?? $l['quelle']) . '</td><td>' . round($l['ms'] / 1000) . ' s</td><td>' .
    '<details><summary>' . ($l['ok'] ? '✅' : '❌') . ($l['linien'] !== null ? ' ' . (int)$l['linien'] . ' Linien' : '') . '</summary><pre>' . h((string)$l['text']) . '</pre></details></td></tr>';
  admin_seite('Fährdaten', $html . '</table><p class="leise">Zeiten in deutscher Ortszeit. Der Verlauf bleibt 180 Tage.</p>');
}
