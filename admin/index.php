<?php
// Kurzadresse /admin → eigentlicher Admin. Immer auf die Stammadresse, auch von scooterways.dns.navy aus,
// damit dort nie eine zweite Einrichtung (setup.php) entsteht.
header('Location: https://scooter.thai-klasse.de/api/admin.php', true, 302);
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');
