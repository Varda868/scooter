# Lizenzen

Scooterways selbst steht unter der **AGPL-3.0** (`LICENSE`). Alle fremden Dateien, die die App lädt, liegen im
eigenen Repo und werden von der eigenen Adresse ausgeliefert; kein CDN, keine Webfonts (die Oberfläche nutzt die
Systemschrift `system-ui`). In der App: Menü → „Lizenzen“ (`lizenzen.html`).

## Mitgelieferte Komponenten (`vendor/`, `talk/`)

| Komponente | Version | Lizenz | Herkunft | Lizenztext |
|---|---|---|---|---|
| Leaflet | 1.9.4 | BSD-2-Clause | npm `leaflet` | `vendor/leaflet-1.9.4/LICENSE.txt` |
| MapLibre GL JS | 5.6.0 | BSD-3-Clause | npm `maplibre-gl` | `vendor/maplibre-gl-5.6.0/LICENSE.txt` |
| PMTiles | 4.3.0 | BSD-3-Clause | npm `pmtiles` | `vendor/pmtiles-4.3.0/LICENSE.txt` |
| Protomaps basemaps (Kartenstil) | 5.5.0 | BSD-3-Clause, Gestaltung CC0 | npm `@protomaps/basemaps` | `vendor/protomaps-basemaps-5.5.0/LICENSE.txt` |
| maplibre-gl-leaflet | 0.1.3 | ISC | npm `@maplibre/maplibre-gl-leaflet` | `vendor/maplibre-gl-leaflet-0.1.3/LICENSE.txt` |
| Noto Sans Regular/Medium/Italic (Kartenschrift als Glyphen) | basemaps-assets `028c18f` | SIL OFL 1.1 | github.com/protomaps/basemaps-assets | `vendor/protomaps-assets/fonts/OFL.txt` |
| Kartensymbole „light“ v4 | basemaps-assets `028c18f` | MIT (aus tangrams/icons), Gestaltung CC0 | github.com/protomaps/basemaps-assets | `vendor/protomaps-assets/sprites/LICENSE-tangrams-icons.txt` |
| Talk (Sprechfunk, VOX, Netz) | b:con-app `78eab39` | AGPL-3.0 | codeberg.org/bcongrid/bcon-app | `talk/LICENSE-AGPL-3.0.txt` |
| Codec2 (WASM) | drowe67/codec2 `310777b` | LGPL-2.1 | github.com/drowe67/codec2 | `talk/LICENSE-codec2-LGPL-2.1.txt` |
| @noble/secp256k1 | 3.2.0 | MIT | npm `@noble/secp256k1` | `talk/LICENSE-secp256k1-MIT.txt` |

Unverändert übernommen; entfernt wurde nur der Verweis auf die Sourcemap (`//# sourceMappingURL=…`), weil die
`.map`-Dateien nicht mitgeliefert werden. Von den Schriften liegen nur die Bereiche für Latein, Griechisch und
Kyrillisch bei (`0-255` … `1280-1535`, `7680-8703`); andere Schriften (Arabisch, CJK …) zeigt die Karte ohne Beschriftung.

## Daten und Dienste

| Quelle | Wofür | Lizenz / Bedingungen |
|---|---|---|
| OpenStreetMap-Mitwirkende | Karte, POIs, Fähren, Orte, Routing-Graph | ODbL 1.0 – © OpenStreetMap-Mitwirkende |
| Protomaps-Basiskarte (eigener Auszug als `poi/karte.pmtiles`) | Vektorkarte | Daten ODbL (OSM) |
| Valhalla (valhalla1.openstreetmap.de, FOSSGIS) | Routing, Höhen | freie Software, Daten ODbL |
| Nominatim, Photon (komoot), Overpass API | Ortssuche, POI-Abfragen | freie Software, Daten ODbL |
| Open-Meteo | Wetter | CC BY 4.0 |
| MET Norway (Ersatz im Proxy) | Wetter | CC BY 4.0 / NLOD 2.0 |
| Deutscher Wetterdienst über Bright Sky | Warnungen Deutschland | Quellenvermerk „Deutscher Wetterdienst“ (GeoNutzV) |
| EUMETNET MeteoAlarm | Warnungen übriges Europa | Bedingungen von MeteoAlarm, Quelle wird genannt |
| EMMA-Umrisse (`api/lib/emma.json`) | Zuordnung der Warngebiete | CC0 |
| Trafiklab (Samtrafiken), GTFS Sweden 3 | Fahrpläne Schweden | Bedingungen von Trafiklab |
| Traveline TNDS, NaPTAN | Fahrpläne Großbritannien | Open Government Licence v3.0 |
| TomTom Traffic (nur mit Schlüssel) | Baustellen, Sperrungen | proprietär, Bedingungen von TomTom |

TomTom ist der einzige nicht freie Dienst; er ist abschaltbar und nur aktiv, wenn ein Schlüssel hinterlegt ist.
