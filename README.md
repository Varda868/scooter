# scooter

50er-Routenplaner (PWA) für https://scooter.thai-klasse.de/ – Auslieferung per Plesk-Git-Deployment aus `main`.

## Aufbau

- `index.html` – nur HTML-Gerüst, lädt `css/app.css` und die Skripte aus `js/` in fester Reihenfolge.
- `js/NN-thema.js` – klassische Skripte (keine ES-Module), teilen sich den globalen Gültigkeitsbereich. Die Nummer ist die Ladereihenfolge: Code, der beim Laden sofort läuft, darf nur Funktionen und Variablen aus gleich- oder niedriger nummerierten Dateien benutzen. In Funktionen und Ereignissen ist die Reihenfolge egal.
- Oberfläche (`js/21-oberflaeche.js`): Leiste in Reiter Tour · Unterwegs · Entdecker · Roller · Einstellung, gewählter Reiter wird gemerkt. Am Handy liegt die Leiste unter der Karte und klappt auf Kopf und Reiter ein (▾).
- Talk (`js/22-talk.js`, `talk/`): Gruppenfunk über Nostr-Relays mit Taste oder VOX. Codec2, Wiedergabe, VOX und Netz sind unveränderte Kopien aus der b:con-App (Herkunft und Lizenzen in `talk/QUELLE.md`); geladen wird erst, wenn Talk eingeschaltet ist.
- Standort teilen (`js/23-standort.js`): über die Talk-Verbindung, nur versiegelt mit der Gruppe (Gruppen-Passwort) oder per NIP-44 an einen Kontakt, als flüchtige Nostr-Art 24425 (Relays speichern nichts). Gesendet wird nur bei sichtbarer App mit laufendem GPS, höchstens alle 30 s; die Freigabe endet nach der gewählten Zeit von selbst.
- `sw.js` – Service Worker. Neue Dateien in `APP_FILES` eintragen und `VERSION` erhöhen. Eigene Skripte und CSS kommen „Netz zuerst“, damit Seite und Module immer zusammenpassen.

## Eigene POI-Daten (`poi/`)

POIs entlang der Route kommen zuerst aus eigenen Kacheln unter `poi/` (neben der App, nicht im Repo), sonst wie bisher von Overpass.

- `tools/poi-kacheln.py` baut aus `osmium export -f geojsonseq` Kacheln von 1°×1° (`poi/t/{lat}_{lon}.json`) und `poi/index.json` (Stand, Kachelliste). Die Filter liest es aus `POI_TYPES` in `js/01-grundlagen.js`. Ein neuer POI-Typ landet also beim nächsten Lauf automatisch in den Kacheln.
- `.github/workflows/poi-kacheln.yml` läuft am 3. jedes Monats, auf Wunsch auch von Hand (Actions → POI-Kacheln → Run workflow, optional nur einzelne Regionen wie `europe/germany/bayern`). Es geht Land für Land durch die Geofabrik-Extrakte Europas und lädt das Ergebnis per FTPS hoch. Dafür vier Repository-Secrets anlegen: `POI_FTP_HOST`, `POI_FTP_USER`, `POI_FTP_PASS`, `POI_FTP_DIR` (Zielordner, also das `poi`-Verzeichnis im Webroot von scooter.thai-klasse.de). Ohne Secrets wird nur gebaut.
- Die App nimmt die eigenen Daten, wenn mindestens 90 % der Kacheln um die Route vorhanden sind. Fehlende Kacheln gelten als leer (Meer). Der Service Worker hält die Kacheln offline vor.
- Daten © OpenStreetMap-Mitwirkende, ODbL 1.0.
- Vektorkarte `poi/karte.pmtiles`: `.github/workflows/karte.yml` schneidet sie im März, Juli und Oktober aus dem aktuellen Protomaps-Build. Gebiet: `tools/karte-gebiet.geojson` (Europa ohne Ukraine, Belarus und Russland, mit Istanbul und der Nordafrika-Küste), Zoom bis 14, ca. 20 GB. Gleiches FTP-Konto wie die POI-Kacheln. Die alte Datei wird vor dem Upload gelöscht, in der Zwischenzeit zeigt die App die Online-Karte. Neue Datei (ETag geändert) → die App verwirft die gespeicherten Vektorkacheln.

## Lizenz

AGPL-3.0 (`LICENSE`), weil Talk Teile der b:con-App (AGPL-3.0) übernimmt. In `talk/` gelten zusätzlich LGPL-2.1 für Codec2 und MIT für secp256k1, siehe `talk/QUELLE.md`.
