#!/usr/bin/env python3
"""Fährlinien aus route=ferry-Relationen als GeoJSON-Zeilen für tools/poi-kacheln.py.

`osmium export` baut aus Routen-Relationen keine Linien; viele große Linien (Stockholm–Helsinki, Salerno–Valletta)
stehen in OSM aber nur so. Eingabe: OPL von `osmium tags-filter r/route=ferry` (Mitgliedswege und Knoten sind
dabei), Ausgabe je Relation ein Feature mit @type=relation und den Mitgliedswegen in "@teile" {Weg-ID: [[lon, lat], …]}.
Länderauszüge schneiden Linien an der Grenze ab; poi-kacheln.py fügt die Teile derselben Relation wieder zusammen.
  osmium cat -f opl faehren.osm.pbf | python3 tools/faehr-relationen.py >> pois.geojsonseq
"""
import json, re, sys


def tags_lesen(feld):
    """OPL-Tags „k=v,k2=v2“; Sonderzeichen stehen als %hex% (Codepunkt)."""
    aus = {}
    if not feld:
        return aus
    for paar in feld.split(','):
        k, _, v = paar.partition('=')
        dek = lambda s: re.sub(r'%([0-9a-fA-F]+)%', lambda m: chr(int(m.group(1), 16)), s)
        aus[dek(k)] = dek(v)
    return aus


def main():
    knoten, wege, relationen = {}, {}, []
    for zeile in sys.stdin:
        teile = zeile.split()
        if not teile:
            continue
        felder = {t[0]: t[1:] for t in teile[1:]}
        art, oid = teile[0][0], teile[0][1:]
        if art == 'n' and felder.get('x') and felder.get('y'):
            knoten[oid] = (float(felder['x']), float(felder['y']))
        elif art == 'w':
            wege[oid] = ([n[1:] for n in felder.get('N', '').split(',') if n], tags_lesen(felder.get('T')))
        elif art == 'r':
            t = tags_lesen(felder.get('T'))
            if t.get('route') == 'ferry':
                mitglieder = [m.split('@')[0][1:] for m in felder.get('M', '').split(',') if m.startswith('w')]
                relationen.append((oid, t, mitglieder))
    for oid, t, mitglieder in relationen:
        linien = {}
        for w in mitglieder:
            refs, wt = wege.get(w, ([], {}))
            pts = [list(knoten[n]) for n in refs if n in knoten]
            if len(pts) >= 2:
                linien[w] = pts
            # Was die Relation nicht sagt (Dauer, wer mit darf), steht oft am Weg
            for k, v in wt.items():
                t.setdefault(k, v)
        if not linien:
            continue
        print(json.dumps({'type': 'Feature', 'geometry': {'type': 'MultiLineString', 'coordinates': list(linien.values())},
                          'properties': {**t, '@type': 'relation', '@id': int(oid), '@teile': linien}},
                         ensure_ascii=False, separators=(',', ':')))


if __name__ == '__main__':
    main()
