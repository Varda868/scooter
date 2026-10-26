#!/usr/bin/env python3
"""Umrisse der MeteoAlarm-Warnregionen (EMMA_ID) für api/lib/emma.json verdichten.

Quelle: KDE foss-public-alert-server, alertHandler/data/EMMA_ID/*.geojson
(© Meteoalarm / EUMETNET, CC0-1.0). Aufruf: tools/emma-umrisse.py <Ordner mit den .geojson> > api/lib/emma.json
Deutschland (kommt fein über DWD/Bright Sky) und Seegebiete (EI…) bleiben draußen. Ausgabe je Region:
[Code, [West, Süd, Ost, Nord], [Ring, …]] mit Ringen als flache Liste ganzzahliger Tausendstelgrad (lon, lat, lon, lat, …).
"""
import glob, json, os, sys
from shapely.geometry import shape

ordner = sys.argv[1]
aus = []
for f in sorted(glob.glob(os.path.join(ordner, '*.geojson'))):
    g = json.load(open(f, encoding='utf-8'))
    ft = (g.get('features') or [g])[0]
    code = ft['properties']['code']
    if code[:2] in ('DE', 'EI'):
        continue
    geo = shape(ft['geometry']).simplify(0.004, preserve_topology=True)
    teile = list(geo.geoms) if geo.geom_type == 'MultiPolygon' else [geo]
    ringe = []
    for t in teile:
        if t.is_empty or t.area < 1e-6:
            continue
        ring = []
        for x, y in t.exterior.coords[:-1]:
            ring += [round(x * 1000), round(y * 1000)]
        if len(ring) >= 6:
            ringe.append(ring)
    if not ringe:
        continue
    w, s, o, n = geo.bounds
    aus.append([code, [round(w, 3), round(s, 3), round(o, 3), round(n, 3)], ringe])
json.dump({'quelle': 'Meteoalarm / EUMETNET (CC0-1.0) über KDE foss-public-alert-server', 'regionen': aus},
          sys.stdout, separators=(',', ':'))
