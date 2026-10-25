#!/usr/bin/env python3
"""POI-Kacheln für Scooterways aus OSM-Daten (GeoJSON-Zeilen von `osmium export -f geojsonseq -a type,id`).

Die Filter kommen aus POI_TYPES in js/01-grundlagen.js, damit App und Kacheln nie auseinanderlaufen.
  python3 tools/poi-kacheln.py --osmium        → Ausdrücke für `osmium tags-filter`
  ... | python3 tools/poi-kacheln.py AUSGABE   → AUSGABE/t/{lat}_{lon}.json (1°×1°) und AUSGABE/index.json
Kachel = Liste [ "n123", lat, lon, {tags} ]; nur die Tags, die die App anzeigt oder zum Zuordnen braucht.
"""
import json, os, re, sys, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEEP = {'name', 'brand', 'brands', 'operator', 'opening_hours', 'website', 'contact:website', 'url', 'phone', 'contact:phone',
        'contact:mobile', 'email', 'contact:email', 'fee', 'motorcycle:brands', 'addr:street', 'addr:housenumber', 'addr:postcode',
        'addr:city', 'tents', 'caravans', 'cabins', 'reservation', 'stars', 'capacity', 'power_supply', 'shower', 'dog'}


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


def main(out):
    fs, keys = filters(), set()
    for conds in fs:
        keys.update(k for k, _, _ in conds)
    tiles, seen = {}, set()
    for line in sys.stdin:
        line = line.strip().lstrip('\x1e')
        if not line:
            continue
        f = json.loads(line)
        p = f.get('properties') or {}
        oid = f"{str(p.get('@type', 'n'))[0]}{p.get('@id')}"
        tags = {k: v for k, v in p.items() if not k.startswith('@')}
        if oid in seen or not f.get('geometry') or not any(matches(tags, c) for c in fs):
            continue
        seen.add(oid)
        lon, lat = point(f['geometry'])
        keep = {k: v for k, v in tags.items() if k in KEEP or k in keys or
                (re.match(r'^(motorcycle|scooter):', k) and v == 'yes')}
        tiles.setdefault(f'{int(lat // 1)}_{int(lon // 1)}', []).append([oid, round(lat, 5), round(lon, 5), keep])
    os.makedirs(os.path.join(out, 't'), exist_ok=True)
    for k, items in tiles.items():
        with open(os.path.join(out, 't', k + '.json'), 'w', encoding='utf-8') as fh:
            json.dump(items, fh, ensure_ascii=False, separators=(',', ':'))
    index = {'date': datetime.date.today().isoformat(), 'count': len(seen), 'tiles': sorted(tiles),
             'license': 'Daten © OpenStreetMap-Mitwirkende, ODbL 1.0 (openstreetmap.org/copyright)'}
    with open(os.path.join(out, 'index.json'), 'w', encoding='utf-8') as fh:
        json.dump(index, fh, separators=(',', ':'))
    print(f"{len(seen)} POIs in {len(tiles)} Kacheln", file=sys.stderr)


if __name__ == '__main__':
    if sys.argv[1:] == ['--osmium']:
        print(osmium_expr(filters()))
    elif len(sys.argv) == 2:
        main(sys.argv[1])
    else:
        sys.exit(__doc__)
