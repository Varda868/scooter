# talk: Herkunft der Dateien

Sprechfunk über Nostr-Relays mit VOX, übernommen aus der **b:con-talk-App (bcon-app)**.

- Repo: https://codeberg.org/bcongrid/bcon-app
- Copyright: b:con / b:congrid
- Lizenz der App-Dateien: **AGPL-3.0** (`LICENSE-AGPL-3.0.txt`)
- Übernommen am 24.10.2026 vom Branch `vox`, Commit `78eab3986d593d3b2ff2dceab59a4c251bd27f25`
  (VOX, lokal, noch nicht nach Codeberg gepusht; Basis `main` = `98aa962135230081e67aa0478110d89fdfeace37`)

| Datei hier | Datei in bcon-app | letzter Commit der Datei | Lizenz | Art |
|---|---|---|---|---|
| `codec2.js` | `talk/codec2.js` | `5e1ba1a775ec080fddf24b984a192c9b29b98ed1` | LGPL-2.1 (Codec2, drowe67/codec2 Commit 310777b, Emscripten 6.0.12, WASM eingebettet) | klassisches Script, global `Codec2Modul` |
| `sprechfunk.js` | `talk/sprechfunk.js` | `78eab3986d593d3b2ff2dceab59a4c251bd27f25` | AGPL-3.0 | klassisches Script, global `Sprechfunk` |
| `vox.js` | `talk/vox.js` | `78eab3986d593d3b2ff2dceab59a4c251bd27f25` | AGPL-3.0 | klassisches Script, global `Vox` (in Node `module.exports`) |
| `netz.js` | `nostr/netz.js` | `d4feefaca5f5029a2d10d2c9ecc43fcc78e7524e` | AGPL-3.0 | ES-Modul |
| `secp256k1.js` | `nostr/secp256k1.js` | `fc027c8f59702cbfc3beb23677b1e7a01316472a` | MIT (@noble/secp256k1 3.2.0, minimiert) | ES-Modul |
| `APP_AUSZUG.js` | Auszüge aus `app.js` (Zeilen je Abschnitt im Kommentar) | `78eab3986d593d3b2ff2dceab59a4c251bd27f25` | AGPL-3.0 | nur zum Nachlesen, wird nicht eingebunden |

Alle Dateien sind **unverändert** (Inhalt wie im Git-Objekt des Commits). `netz.js` importiert
`./secp256k1.js` aus demselben Ordner; der Pfad passt hier ohne Änderung.

Reihenfolge beim Einbinden wie in bcon-app: `codec2.js`, `sprechfunk.js`, `vox.js` als `<script>`, `netz.js` per
`import("./talk/netz.js")`.

Lizenztexte: `LICENSE-AGPL-3.0.txt` (aus bcon-app), `LICENSE-codec2-LGPL-2.1.txt` (COPYING aus drowe67/codec2,
Commit 310777b), `LICENSE-secp256k1-MIT.txt` (aus bcon-app `nostr/LICENSE-noble-secp256k1`).
