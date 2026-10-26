#!/usr/bin/env python3
"""POI-Kacheln für Scooterways aus OSM-Daten (GeoJSON-Zeilen von `osmium export -f geojsonseq -a type,id`).

Die Filter kommen aus POI_TYPES in js/01-grundlagen.js, damit App und Kacheln nie auseinanderlaufen.
  python3 tools/poi-kacheln.py --osmium        → Ausdrücke für `osmium tags-filter`
  ... | python3 tools/poi-kacheln.py AUSGABE   → AUSGABE/t/{lat}_{lon}.json (1°×1°) und AUSGABE/index.json
Kachel = Liste [ "n123", lat, lon, {tags} ]; nur die Tags, die die App anzeigt oder zum Zuordnen braucht.
Fährlinien (Wege und Relationen mit route=ferry, Relationen über tools/faehr-relationen.py) zusätzlich als
AUSGABE/f/{lat}_{lon}.json = [ "w123" oder "r123", [[lat, lon], …], {tags} ] (eine Relation mit mehreren Teilen
steht je Teil einmal drin),
vereinfacht auf etwa 50 m; eine Linie steht in jeder Kachel, die ihr Rahmen berührt.
Orte (place=city|town|village|hamlet, für Vorschläge beim Tippen, auch offline) als AUSGABE/o/{lat}_{lon}.json
= [ [name, lat, lon, art, name:de oder "", bei], … ] mit art c/t/v/h; bei = nächste größere Stadt (Dorf/Weiler: Stadt
im Umkreis von 30 km, Kleinstadt: Großstadt im Umkreis von 60 km), damit gleichnamige Orte unterscheidbar sind.
"""
import json, math, os, re, sys, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEEP = {'name', 'brand', 'brands', 'operator', 'opening_hours', 'website', 'contact:website', 'url', 'phone', 'contact:phone',
        'contact:mobile', 'email', 'contact:email', 'fee', 'motorcycle:brands', 'addr:street', 'addr:housenumber', 'addr:postcode',
        'addr:city', 'tents', 'caravans', 'cabins', 'reservation', 'stars', 'capacity', 'power_supply', 'shower', 'dog',
        'automated', 'self_service'}
# Fähren: wer darf mit, wie lange dauert es
FERRY_KEEP = {'name', 'operator', 'duration', 'website', 'contact:website', 'url', 'fee', 'opening_hours', 'interval',
              'motor_vehicle', 'motorcar', 'motorcycle', 'moped', 'mofa', 'vehicle', 'bicycle', 'foot'}
FERRY_EXPR = 'w/route=ferry'
PLACE_ART = {'city': 'c', 'town': 't', 'village': 'v', 'hamlet': 'h'}
PLACE_EXPR = 'n/place=' + ','.join(PLACE_ART)


def filters():
    src = open(os.path.join(ROOT, 'js', '01-grundlagen.js'), encoding='utf-8').read()
    block = src[src.index('const POI_TYPES'):]
    block = block[:block.index('];')]
    # "[amenity=shelter][shelter_type!=public_transport]" → [("amenity", "=", "shelter"), ("shelter_type", "!=", ...)]
    return [re.findall(r'\[(\w+)(!?=)([^\]]+)\]', f) for f in re.findall(r"'((?:\[[^\]]+\])+)'", block)]


def matches(tags, conds):
    return all((tags.get(k) == v) if op == '=' else (tags.get(k) != v) for k, op, v in conds)


def osmium_expr(fs):
    by_key = {}
    for conds in fs:
        k, _, v = next(c for c in conds if c[1] == '=')
        by_key.setdefault(k, set()).add(v)
    return ' '.join(f"nwr/{k}={','.join(sorted(vs))}" for k, vs in sorted(by_key.items()))


def point(geom):
    t, c = geom['type'], geom['coordinates']
    if t == 'Point':
        return c
    if t == 'LineString':
        return c[len(c) // 2]
    ring = c[0] if t == 'Polygon' else c[0][0]
    ring = ring[:-1] or ring  # geschlossener Ring: letzter Punkt = erster
    return [sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)]


def simplify(pts, tol):
    """Douglas-Peucker in Grad (tol ≈ 0.0005 ≈ 50 m), iterativ wegen langer Linien."""
    if len(pts) < 3:
        return pts
    keep, stack = {0, len(pts) - 1}, [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = pts[a], pts[b]
        dx, dy, best, idx = bx - ax, by - ay, 0, None
        n = (dx * dx + dy * dy) ** 0.5 or 1e-12
        for i in range(a + 1, b):
            d = abs(dy * (pts[i][0] - ax) - dx * (pts[i][1] - ay)) / n
            if d > best:
                best, idx = d, i
        if idx is not None and best > tol:
            keep.add(idx)
            stack += [(a, idx), (idx, b)]
    return [pts[i] for i in sorted(keep)]


def ferry_lines(geom):
    t, c = geom['type'], geom['coordinates']
    return [c] if t == 'LineString' else c if t == 'MultiLineString' else []


def join_lines(parts):
    """Mitgliedswege einer Relation zu möglichst wenigen Linien verketten (gemeinsame Endpunkte, auch umgedreht)."""
    rest, out = [list(p) for p in parts if len(p) >= 2], []
    while rest:
        line = rest.pop(0)
        weiter = True
        while weiter:
            weiter = False
            for i, q in enumerate(rest):
                if q[0] == line[-1]: line += q[1:]
                elif q[-1] == line[-1]: line += q[::-1][1:]
                elif q[-1] == line[0]: line = q[:-1] + line
                elif q[0] == line[0]: line = q[::-1][:-1] + line
                else: continue
                rest.pop(i); weiter = True
                break
        out.append(line)
    return out


def nearby_bigger(places):
    """Hängt an jeden Ort den Namen der nächsten größeren Stadt (Gitter 0,5°, flach gerechnet)."""
    grid = {}
    for items in places.values():
        for p in items:
            if p[3] in 'ct':
                grid.setdefault((int(p[1] // 0.5), int(p[2] // 0.5)), []).append(p)
    for items in places.values():
        for p in items:
            arten, km = ('ct', 30) if p[3] in 'vh' else ('c', 60) if p[3] == 't' else ('', 0)
            best, bd = '', km
            if arten:
                ga, go, kx = int(p[1] // 0.5), int(p[2] // 0.5), math.cos(math.radians(p[1]))
                for a in range(ga - 1, ga + 2):
                    for o in range(go - 1, go + 2):
                        for q in grid.get((a, o), []):
                            if q is p or q[3] not in arten:
                                continue
                            d = math.hypot((q[1] - p[1]) * 111, (q[2] - p[2]) * 111 * kx)
                            if d < bd:
                                best, bd = q[4] or q[0], d
            p.append(best)


def main(out):
    fs, keys = filters(), set()
    for conds in fs:
        keys.update(k for k, _, _ in conds)
    tiles, seen, ferries, fseen, places, pseen = {}, set(), {}, set(), {}, set()
    frel, fwege = {}, {}  # Fähr-Relationen (aus tools/faehr-relationen.py) und einzelne Fährwege
    for line in sys.stdin:
        line = line.strip().lstrip('\x1e')
        if not line:
            continue
        f = json.loads(line)
        p = f.get('properties') or {}
        oid = f"{str(p.get('@type', 'n'))[0]}{p.get('@id')}"
        tags = {k: v for k, v in p.items() if not k.startswith('@')}
        art = PLACE_ART.get(tags.get('place'))
        if art and tags.get('name') and (f.get('geometry') or {}).get('type') == 'Point' and oid not in pseen:
            pseen.add(oid)
            lon, lat = f['geometry']['coordinates']
            de = tags.get('name:de', '')
            places.setdefault(f'{int(lat // 1)}_{int(lon // 1)}', []).append(
                [tags['name'], round(lat, 4), round(lon, 4), art, de if de != tags['name'] else ''])
            if not any(matches(tags, c) for c in fs):
                continue
        if tags.get('route') == 'ferry' and f.get('geometry'):
            if p.get('@type') == 'relation':
                # Länderauszüge liefern dieselbe Relation mehrfach, jeweils mit den Wegen im Land: Teile vereinen
                r = frel.setdefault(oid, {'teile': {}, 'tags': {}})
                r['teile'].update(p.get('@teile') or {})
                for k, v in tags.items():
                    if k != '@teile':
                        r['tags'].setdefault(k, v)
            elif oid not in fwege:
                fwege[oid] = (f['geometry'], tags)
            continue
        if oid in seen or not f.get('geometry') or not any(matches(tags, c) for c in fs):
            continue
        seen.add(oid)
        lon, lat = point(f['geometry'])
        keep = {k: v for k, v in tags.items() if k in KEEP or k in keys or
                (re.match(r'^(motorcycle|scooter|service:vehicle):', k) and v == 'yes') or
                (re.match(r'^payment:(cash|coins|notes|credit_cards|debit_cards|girocard|maestro|visa|mastercard)$', k) and v in ('yes', 'no'))}
        tiles.setdefault(f'{int(lat // 1)}_{int(lon // 1)}', []).append([oid, round(lat, 5), round(lon, 5), keep])
    # Fährlinien: Relationen zuerst (Name, Betreiber, Dauer der ganzen Linie); ihre Mitgliedswege nicht noch einmal
    in_rel = {'w' + w for r in frel.values() for w in r['teile']}
    linien = [(oid, join_lines(r['teile'].values()), r['tags']) for oid, r in frel.items()]
    linien += [(oid, ferry_lines(g), t) for oid, (g, t) in fwege.items() if oid not in in_rel]
    for oid, teile, tags in linien:
        fseen.add(oid)
        keep = {k: v for k, v in tags.items() if k in FERRY_KEEP}
        for n, line in enumerate(teile):
            # Weitere Teile derselben Linie als "r123.1", "r123.2" …: die App zeichnet je ID eine Linie
            pid = oid if not n else f'{oid}.{n}'
            pts = [[round(la, 4), round(lo, 4)] for la, lo in simplify([[c[1], c[0]] for c in line], 0.0005)]
            las, los = [q[0] for q in pts], [q[1] for q in pts]
            for a in range(int(min(las) // 1), int(max(las) // 1) + 1):
                for o in range(int(min(los) // 1), int(max(los) // 1) + 1):
                    ferries.setdefault(f'{a}_{o}', []).append([pid, pts, keep])
    os.makedirs(os.path.join(out, 't'), exist_ok=True)
    for k, items in tiles.items():
        with open(os.path.join(out, 't', k + '.json'), 'w', encoding='utf-8') as fh:
            json.dump(items, fh, ensure_ascii=False, separators=(',', ':'))
    os.makedirs(os.path.join(out, 'f'), exist_ok=True)
    for k, items in ferries.items():
        with open(os.path.join(out, 'f', k + '.json'), 'w', encoding='utf-8') as fh:
            json.dump(items, fh, ensure_ascii=False, separators=(',', ':'))
    nearby_bigger(places)
    os.makedirs(os.path.join(out, 'o'), exist_ok=True)
    for k, items in places.items():
        items.sort(key=lambda x: 'ctvh'.index(x[3]))
        with open(os.path.join(out, 'o', k + '.json'), 'w', encoding='utf-8') as fh:
            json.dump(items, fh, ensure_ascii=False, separators=(',', ':'))
    index = {'date': datetime.date.today().isoformat(), 'count': len(seen), 'tiles': sorted(tiles),
             'places': len(pseen), 'placeTiles': sorted(places),
             'ferries': len(fseen), 'ferryTiles': sorted(ferries),
             'license': 'Daten © OpenStreetMap-Mitwirkende, ODbL 1.0 (openstreetmap.org/copyright)'}
    with open(os.path.join(out, 'index.json'), 'w', encoding='utf-8') as fh:
        json.dump(index, fh, separators=(',', ':'))
    print(f"{len(seen)} POIs in {len(tiles)} Kacheln, {len(fseen)} Fährlinien in {len(ferries)} Kacheln, "
          f"{len(pseen)} Orte in {len(places)} Kacheln", file=sys.stderr)


if __name__ == '__main__':
    if sys.argv[1:] == ['--osmium']:
        print(osmium_expr(filters()), FERRY_EXPR, PLACE_EXPR)
    elif len(sys.argv) == 2:
        main(sys.argv[1])
    else:
        sys.exit(__doc__)
