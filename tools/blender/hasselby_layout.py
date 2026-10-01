"""OSM extract -> layout for the Hässelby torg slice (tools/hasselby/osm.json).

Local metres around Hässelby gård station (x east, y north, Blender
coordinates). Map data © OpenStreetMap contributors (ODbL). Only the layout
is used (footprints, storeys, street centrelines, the viaduct line, point
features); everything visible is modelled for 1993.
"""

import json
import math
import os

LAT0, LON0 = 59.36694, 17.84444
KX = 111320.0 * math.cos(math.radians(LAT0))
KY = 110540.0
OSM_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'hasselby', 'osm.json')

# Carriageway widths (m) by OSM class; named streets can override below.
ROAD_W = {'primary': 9.0, 'secondary': 8.5, 'tertiary': 8.0, 'unclassified': 7.5, 'residential': 6.5,
          'living_street': 5.0, 'service': 4.5}
ROAD_W_NAMED = {'Maltesholmsvägen': 9.0, 'Astrakangatan': 7.5, 'Kvarnhagsgatan': 7.0, 'Loviselundsvägen': 7.0}
PATH_W = {'footway': 2.6, 'cycleway': 3.0, 'path': 2.0, 'pedestrian': 4.0, 'steps': 2.4}


def xy(n):
    return ((n['lon'] - LON0) * KX, (n['lat'] - LAT0) * KY)


def area2(pts):
    a = 0.0
    for i in range(len(pts)):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % len(pts)]
        a += x1 * y2 - x2 * y1
    return a / 2.0


def simplify_ring(pts, min_edge=0.35, angle_deg=4.0):
    """Drops duplicate closing points, tiny edges and near-collinear vertices; CCW."""
    if len(pts) > 1 and math.dist(pts[0], pts[-1]) < 1e-6:
        pts = pts[:-1]
    if area2(pts) < 0:
        pts = pts[::-1]
    changed = True
    cos_t = math.cos(math.radians(180 - angle_deg))
    while changed and len(pts) > 3:
        changed = False
        out = []
        n = len(pts)
        for i in range(n):
            p0, p1, p2 = pts[i - 1], pts[i], pts[(i + 1) % n]
            a = (p0[0] - p1[0], p0[1] - p1[1])
            b = (p2[0] - p1[0], p2[1] - p1[1])
            la, lb = math.hypot(*a), math.hypot(*b)
            if la < min_edge or lb < 1e-6:
                changed = True
                continue
            if (a[0] * b[0] + a[1] * b[1]) / (la * lb) < cos_t:
                changed = True
                continue
            out.append(p1)
        if len(out) < 3:
            break
        pts = out
    return pts


def load(path=OSM_PATH, radius=230.0):
    with open(path) as f:
        d = json.load(f)
    nodes = {}
    for e in d['elements']:
        # Overpass returns tagged nodes and again as untagged skeleton nodes: keep the tags.
        if e['type'] == 'node' and ('tags' in e or e['id'] not in nodes):
            nodes[e['id']] = e
    ways = [e for e in d['elements'] if e['type'] == 'way' and 'tags' in e]

    def pts(w):
        return [xy(nodes[i]) for i in w['nodes'] if i in nodes]

    def near(p):
        return any(abs(x) < radius and abs(y) < radius for (x, y) in p)

    L = {'buildings': [], 'roads': [], 'paths': [], 'parking': [], 'grass': [], 'rails': [], 'platform': None,
         'lamps': [], 'trees': [], 'benches': [], 'bins': [], 'bus_stops': [], 'entrances': [], 'pois': [], 'crossings': []}
    for w in ways:
        t = w['tags']
        p = pts(w)
        if len(p) < 2 or not near(p):
            continue
        if 'building' in t and t['building'] not in ('roof',):
            ring = simplify_ring(p)
            if len(ring) < 3 or abs(area2(ring)) < 8:
                continue
            L['buildings'].append({
                'id': w['id'], 'ring': ring, 'levels': int(float(t.get('building:levels', '1') or 1)),
                'kind': t['building'], 'street': t.get('addr:street', ''), 'number': t.get('addr:housenumber', ''),
                'roof': t.get('roof:shape', 'flat' if int(float(t.get('building:levels', '1') or 1)) >= 6 else ''),
                'area': abs(area2(ring)),
            })
        elif 'highway' in t:
            hw = t['highway']
            if t.get('area') == 'yes':
                L['paths'].append({'id': w['id'], 'pts': p, 'kind': hw, 'area': True, 'name': t.get('name', '')})
            elif hw in ROAD_W:
                if t.get('tunnel') == 'yes' or t.get('layer', '0').startswith('-'):
                    continue
                w_ = float(t['width']) if 'width' in t and float(t['width']) < 11 else ROAD_W_NAMED.get(t.get('name', ''), ROAD_W[hw])
                L['roads'].append({'id': w['id'], 'pts': p, 'kind': hw, 'width': w_, 'name': t.get('name', ''),
                                   'sidewalk': t.get('sidewalk', 'both' if hw in ('residential', 'unclassified', 'living_street') else 'no')})
            elif hw in PATH_W:
                if t.get('tunnel') == 'yes':
                    continue
                L['paths'].append({'id': w['id'], 'pts': p, 'kind': hw, 'width': PATH_W[hw], 'surface': t.get('surface', 'asphalt'),
                                   'area': False, 'name': t.get('name', '')})
        elif 'railway' in t:
            if t['railway'] == 'platform':
                L['platform'] = simplify_ring(p, 0.2, 1.0)
            elif t['railway'] == 'subway':
                L['rails'].append({'id': w['id'], 'pts': p, 'bridge': t.get('bridge') == 'yes', 'layer': int(t.get('layer', '0'))})
        elif t.get('amenity') == 'parking':
            L['parking'].append(simplify_ring(p, 0.3))
        elif t.get('landuse') in ('grass', 'flowerbed') or t.get('leisure') in ('park', 'playground'):
            L['grass'].append(simplify_ring(p, 0.3))
    for n in nodes.values():
        t = n.get('tags')
        if not t:
            continue
        p = xy(n)
        if abs(p[0]) > radius or abs(p[1]) > radius:
            continue
        if t.get('highway') == 'street_lamp':
            L['lamps'].append(p)
        elif t.get('natural') == 'tree':
            L['trees'].append(p)
        elif t.get('amenity') == 'bench':
            L['benches'].append(p)
        elif t.get('amenity') == 'waste_basket':
            L['bins'].append(p)
        elif t.get('highway') == 'bus_stop':
            L['bus_stops'].append((p, t.get('name', '')))
        elif t.get('railway') == 'subway_entrance':
            L['entrances'].append(p)
        elif t.get('highway') == 'crossing':
            L['crossings'].append(p)
        elif 'shop' in t or t.get('amenity') in ('pharmacy', 'restaurant', 'cafe', 'bar', 'library', 'bank', 'post_office'):
            L['pois'].append((p, t.get('shop') or t.get('amenity'), t.get('name', '')))
    return L


def poly_contains(ring, x, y):
    inside = False
    n = len(ring)
    for i in range(n):
        ax, ay = ring[i]
        bx, by = ring[(i + 1) % n]
        if (ay > y) != (by > y) and x < ax + (y - ay) / (by - ay) * (bx - ax):
            inside = not inside
    return inside


if __name__ == '__main__':
    L = load()
    print({k: len(v) if isinstance(v, list) else (len(v) if v else 0) for k, v in L.items()})
