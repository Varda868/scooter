#!/bin/bash
# Baut poi/karte.pmtiles direkt auf dem Server neu: pmtiles extract aus dem neuesten Protomaps-Build für das Gebiet in
# tools/karte-gebiet.geojson. Der Server lädt mit ~30 MB/s, fertig in etwa 20–30 min (über GitHub + FTP: > 6 h).
# Aufruf als geplante Aufgabe in Plesk („Befehl ausführen“, Benachrichtigen: „Nur Fehler“), im März, Juli und Oktober:
#   bash /var/www/vhosts/thai-klasse.de/scooter.thai-klasse.de/tools/karte-bauen.sh
# Optional: erstes Argument = höchste Zoomstufe (Standard 14), zweites = Build (Standard: neuester), „-f“ als drittes
# baut auch dann, wenn der Build schon online ist.
# Gebaut wird in ../karte-bau neben dem Webroot (nicht öffentlich), dann per mv ersetzt: gleiche Partition, also
# atomar; laufende Abrufe lesen die alte Datei zu Ende. Die App erkennt die neue Datei am ETag.
# Fehler gehen nach stderr mit Exit-Code 1, dann schickt Plesk eine Mail.
set -uo pipefail

WEB="$(cd "$(dirname "$0")/.." && pwd)"
BAU="$(dirname "$WEB")/karte-bau"
Z="${1:-14}"; WUNSCH="${2:-}"; ZWANG="${3:-}"
ZIEL="$WEB/poi/karte.pmtiles"; STAND="$WEB/poi/karte.stand"
GEBIET="$WEB/tools/karte-gebiet.geojson"
fehler() { echo "Karte: $*" >&2; exit 1; }

mkdir -p "$BAU" || fehler "kann $BAU nicht anlegen"
cd "$BAU" || exit 1
# Nur ein Lauf zur Zeit
exec 9>"$BAU/.sperre"
if command -v flock >/dev/null && ! flock -n 9; then echo "Karte: läuft schon"; exit 0; fi
[ -f "$GEBIET" ] || fehler "Gebiet fehlt: $GEBIET"

# pmtiles-Programm aktuell halten (statische Go-Datei von GitHub)
v=$(curl -fsSI https://github.com/protomaps/go-pmtiles/releases/latest | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}' | sed 's#.*/v##')
if [ -n "$v" ] && ! { [ -x ./pmtiles ] && ./pmtiles version 2>/dev/null | grep -q "pmtiles $v,"; }; then
  curl -fsSL "https://github.com/protomaps/go-pmtiles/releases/download/v$v/go-pmtiles_${v}_Linux_x86_64.tar.gz" | tar xz pmtiles \
    || fehler "pmtiles $v nicht ladbar"
fi
[ -x ./pmtiles ] || fehler "pmtiles fehlt"

builds=$(curl -fsSL https://build-metadata.protomaps.dev/builds.json) || fehler "Build-Liste nicht abrufbar"
if [ -n "$WUNSCH" ]; then
  grep -q "\"key\":\"$WUNSCH\"" <<<"$builds" || fehler "Build $WUNSCH gibt es nicht (mehr)"
  build=$WUNSCH
else
  build=$(grep -o '"key":"[0-9]*\.pmtiles"' <<<"$builds" | tail -1 | cut -d'"' -f4)
fi
[ -n "$build" ] || fehler "kein Build gefunden"
if [ "$ZWANG" != "-f" ] && [ -f "$ZIEL" ] && [ "$(cut -d' ' -f1,2 "$STAND" 2>/dev/null)" = "$build $Z" ]; then
  echo "Karte: $build (Zoom $Z) ist schon online"; exit 0
fi

# Platz: neue Datei entsteht neben der alten, also etwa die alte Größe zusätzlich (Kontingent prüft Plesk selbst)
alt=$(stat -c %s "$ZIEL" 2>/dev/null || true)
bedarf=$(( ${alt:-21000000000} * 12 / 10 ))
frei=$(df --output=avail -B1 "$BAU" | tail -1)
[ "$frei" -gt "$bedarf" ] || fehler "zu wenig Platz: $((frei / 1073741824)) GB frei, nötig etwa $((bedarf / 1073741824)) GB"

rm -f karte.neu.pmtiles
start=$(date +%s)
./pmtiles extract "https://build.protomaps.com/$build" karte.neu.pmtiles --region="$GEBIET" --maxzoom="$Z" --download-threads=4 > extract.log 2>&1 \
  || { rm -f karte.neu.pmtiles; fehler "extract fehlgeschlagen: $(tail -5 extract.log | tr '\n' ' ')"; }
./pmtiles show karte.neu.pmtiles > show.log 2>&1 || { rm -f karte.neu.pmtiles; fehler "neue Datei ungültig: $(tail -3 show.log | tr '\n' ' ')"; }
groesse=$(stat -c %s karte.neu.pmtiles)
[ -z "$alt" ] || [ "$groesse" -gt $((alt / 2)) ] || { rm -f karte.neu.pmtiles; fehler "neue Datei verdächtig klein: $((groesse / 1048576)) MB"; }

mv -f karte.neu.pmtiles "$ZIEL" || fehler "Ersetzen fehlgeschlagen"
echo "$build $Z $(date +%Y-%m-%dT%H:%M:%S%z)" > "$STAND"
echo "Karte: $build, Zoom bis $Z, $((groesse / 1073741824)) GB, $(( ($(date +%s) - start) / 60 )) min"
