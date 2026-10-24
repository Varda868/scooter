# scooter

50er-Routenplaner (PWA) für https://scooter.thai-klasse.de/ – Auslieferung per Plesk-Git-Deployment aus `main`.

## Aufbau

- `index.html` – nur HTML-Gerüst, lädt `css/app.css` und die Skripte aus `js/` in fester Reihenfolge.
- `js/NN-thema.js` – klassische Skripte (keine ES-Module), teilen sich den globalen Gültigkeitsbereich. Die Nummer ist die Ladereihenfolge: Code, der beim Laden sofort läuft, darf nur Funktionen und Variablen aus gleich- oder niedriger nummerierten Dateien benutzen. In Funktionen und Ereignissen ist die Reihenfolge egal.
- Oberfläche (`js/21-oberflaeche.js`): Leiste in Reiter Tour · Unterwegs · Entdecker · Roller · Einstellung, gewählter Reiter wird gemerkt. Am Handy liegt die Leiste unter der Karte und klappt auf Kopf und Reiter ein (▾).
- `sw.js` – Service Worker. Neue Dateien in `APP_FILES` eintragen und `VERSION` erhöhen. Eigene Skripte und CSS kommen „Netz zuerst“, damit Seite und Module immer zusammenpassen.
