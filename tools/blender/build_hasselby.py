"""Hässelby torg, November 1993 — vertical-slice map (map 'hasselby').

  blender -b --factory-startup -P tools/blender/build_hasselby.py

Layout from OpenStreetMap (tools/hasselby/osm.json, © OpenStreetMap
contributors, ODbL): building footprints and storeys, street centrelines, the
elevated T-bana line and point features. Everything visible is modelled for
1993 from reference photos (reference/hasselby). Terrain is a plausible
invented valley (no elevation data yet): the square and Astrakangatan low
under the viaduct, rising to track level at the bridge ends and into the rock
cut east of the station.

Blender coordinates: x east, y north, z up, metres; origin at the station.
"""

import json
import math
import os
import random
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Vector, noise

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import PUBLIC, MeshBuilder, export_glb, reset_scene, smoothstep, to_engine, yaw_quat  # noqa: E402
import hasselby_layout as HL  # noqa: E402
import hasselby_surfaces as HS  # noqa: E402

ASSET_REL = 'assets/hasselby'
ASSET_DIR = os.path.join(PUBLIC, ASSET_REL)
MAP_PATH = os.path.join(PUBLIC, 'maps', 'hasselby', 'map.json')
os.makedirs(ASSET_DIR, exist_ok=True)

# Lightmap texel densities (texels per metre). Lightmaps carry sky occlusion and
# bounce only (direct sun comes from the shadow maps), so they can stay coarse;
# budget for the slice is ~2 atlas pages.
TPM_GROUND = 2
TPM_STREET = 3
TPM_ARCH = 6
TPM_TALL = 4

# Slice extent (metres around the station).
X0, X1, Y0, Y1 = -170.0, 170.0, -150.0, 215.0

reset_scene()
random.seed(1993)
objects = []
L = HL.load(radius=260)


def add_mesh_object(obj_id, name, asset, semantic, pos=(0, 0, 0), yaw=0.0, lightmap=None, collision=True, cast=True, extra=None):
    o = {
        'id': obj_id, 'name': name, 'type': 'mesh', 'semantic': semantic,
        'asset': f'{ASSET_REL}/{asset}.glb',
        'transform': {'position': to_engine(pos)},
        'static': True, 'castShadow': cast, 'collision': collision,
    }
    if yaw:
        o['transform']['rotation'] = yaw_quat(yaw)
    if lightmap:
        o['lightmap'] = {'resolution': list(lightmap)}
    if extra:
        o.update(extra)
    objects.append(o)


def add_sign(sid, name, pos, facing, text, size, **opts):
    """Text sign object (rendered by the engine's sign atlas). facing: outward 2D normal."""
    yaw = math.degrees(math.atan2(facing[0], facing[1])) + 180.0
    objects.append({'id': sid, 'name': name, 'type': 'sign', 'semantic': 'sign',
                    'transform': {'position': to_engine(pos), 'rotation': yaw_quat(yaw)},
                    'sign': {'text': text, 'size': [round(size[0], 3), round(size[1], 3)], **opts}})


def build(builder, lightmap_tpm=None, vertex_color=None, color_max_edge=None, dissolve=False):
    if dissolve:
        bm = builder.bm
        bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=0.0005)
        bmesh.ops.dissolve_degenerate(bm, dist=0.002, edges=bm.edges[:])
        bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(0.6), verts=bm.verts[:], edges=bm.edges[:], delimit={'MATERIAL'})
        bmesh.ops.dissolve_degenerate(bm, dist=0.002, edges=bm.edges[:])
        # Dissolved n-gons can pinch at a vertex: triangulate here (beauty) so the mesh stays valid.
        bmesh.ops.triangulate(bm, faces=bm.faces[:], quad_method='BEAUTY', ngon_method='BEAUTY')
        # bmesh ops leave element tags set; MeshBuilder reads face tags as "explicit UVs".
        for f in bm.faces:
            f.tag = False
    obj, res = builder.finish(lightmap_tpm, vertex_color=vertex_color, color_max_edge=color_max_edge)
    # Collapsed slivers can leave duplicate faces: validate() removes them.
    obj.data.validate(verbose=bool(os.environ.get('RILL_VALIDATE')))
    export_glb(obj, os.path.join(ASSET_DIR, builder.name + '.glb'))
    tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    print(f'  {builder.name:28s} {tris:7d} tris  lightmap {res}')
    return res


# =============================================================== terrain + tracks
TRACK_Z = 7.2             # top of rail above the square
DECK_Z = TRACK_Z - 0.75   # top of the viaduct deck slab (under the ballast)
DECK_D = 1.1              # deck depth at the edge beams
SOFFIT_Z = DECK_Z - DECK_D
BED_Z = TRACK_Z - 0.62    # trackbed formation beyond the bridge
PLAT_Z = TRACK_Z + 1.05   # platform surface

BRIDGES = [r['pts'] for r in L['rails'] if r['bridge']]
# Through tracks beyond the bridge (OSM marks part of the eastern track as a tunnel
# further out; inside the slice both tracks run in the rock cut).
RAILS_ALL = [r['pts'] for r in L['rails'] if not r['bridge']]


def _abutments():
    """One abutment line per bridge end, through both track ends:
    (origin, outward normal, lateral axis, half length)."""
    ends = {'w': [], 'e': []}
    for pts in BRIDGES:
        for p, q in ((pts[0], pts[1]), (pts[-1], pts[-2])):
            t = Vector((p[0] - q[0], p[1] - q[1])).normalized()
            ends['w' if p[0] < 0 else 'e'].append((Vector(p), t))
    out = []
    for es in ends.values():
        (p1, t1), (p2, t2) = es
        lat = (p2 - p1).normalized()
        n = Vector((-lat.y, lat.x))
        if n.dot(t1 + t2) < 0:
            n = -n
        out.append(((p1 + p2) / 2, n, lat, (p2 - p1).length / 2))
    return out


ABUTS = _abutments()


def past_end(x, y):
    """Signed distance beyond the nearest bridge end (> 0 on the embankment side)."""
    return max((x - o.x) * n.x + (y - o.y) * n.y for (o, n, _l, _h) in ABUTS)


def _strips():
    """Polygons between the two through tracks beyond each bridge end (one formation)."""
    rings = []
    for (o, n, lat, half) in ABUTS:
        tr = []
        for pts in RAILS_ALL:
            if min(math.dist(pts[0], o), math.dist(pts[-1], o)) > half + 1.0:
                continue
            if math.dist(pts[-1], o) < math.dist(pts[0], o):
                pts = pts[::-1]
            tr.append([p for p in pts if abs(p[0]) < 260 and abs(p[1]) < 260])
        if len(tr) == 2:
            rings.append(tr[0] + tr[1][::-1])
    return rings


_gr = HS.Grid(X0 - 10, Y0 - 10, X1 + 10, Y1 + 10, 0.5)
_d_rail = HS.union_polylines(_gr, [(p, 0.0) for p in RAILS_ALL])
_d_rail = HS.polygon_field(_gr, _strips(), base=_d_rail)


def H0(x, y):
    """Natural ground: a valley at the square rising to track level towards the
    bridge ends and into the rocky hill east of the station."""
    west = smoothstep(-95, -150, x) * 5.2
    east = smoothstep(62, 98, x) * 6.6 + smoothstep(98, 165, x) * 3.4
    north = smoothstep(150, 215, y) * 1.5
    h = west + east + north
    h += 0.25 * noise.noise(Vector((x * 0.03, y * 0.03, 0.5)))
    return h


def H(x, y):
    """Ground with the trackbed formation beyond the bridge ends: embankment slopes
    in the west, a steep rock cut in the east. The step at the bridge end is
    hidden inside the abutment."""
    h = H0(x, y)
    s = past_end(x, y)
    if s > 0.2:
        d = float(HS.sample(_gr, _d_rail, x, y))
        if d < 13.0:
            w = 1.0 - smoothstep(4.0, 12.0 if h < BED_Z else 6.0, d)
            h = h + (BED_Z - h) * w * smoothstep(0.2, 1.2, s)
    return h


def is_cut(x, y):
    """Inside the rock cut (ground lowered by more than a metre)."""
    return H0(x, y) - H(x, y) > 1.0


# =============================================================== street network
def merge_ways(ways, key):
    """Joins ways sharing an endpoint and a key (same street) into longer polylines,
    so kerb fillets only round real junctions, not OSM way splits."""
    items = [list(w['pts']) for w in ways]
    keys = [key(w) for w in ways]
    meta = list(ways)
    merged = True
    while merged:
        merged = False
        for i in range(len(items)):
            if items[i] is None:
                continue
            for j in range(len(items)):
                if i == j or items[j] is None or keys[i] != keys[j]:
                    continue
                a, b = items[i], items[j]
                if math.dist(a[-1], b[0]) < 0.05:
                    items[i] = a + b[1:]
                elif math.dist(a[-1], b[-1]) < 0.05:
                    items[i] = a + b[::-1][1:]
                elif math.dist(a[0], b[-1]) < 0.05:
                    items[i] = b + a[1:]
                elif math.dist(a[0], b[0]) < 0.05:
                    items[i] = b[::-1] + a[1:]
                else:
                    continue
                items[j] = None
                merged = True
    return [(items[i], meta[i]) for i in range(len(items)) if items[i] is not None]


roads = merge_ways(L['roads'], lambda w: (w['name'] or f"_{w['id']}", w['kind'], w['width']))
paths = merge_ways([p for p in L['paths'] if not p['area']], lambda w: (w['kind'], w['width'], w['surface']))
print(f'Streets: {len(roads)} carriageways, {len(paths)} paths (merged)')

# The square and plazas: paved pedestrian areas around the station and the
# centre (OSM has the footways but not the square outlines).
PLAZAS = [
    [(-92, -40), (-22, -40), (-2, -26), (0, -8), (-30, 10), (-52, 6), (-70, 0), (-92, -8)],   # station forecourt (south of the viaduct)
    [(-60, -6), (-38, 2), (-50, 34), (-66, 30)],                                            # passage under the platform end
    [(-81, 43), (-53, 43), (-45, 46), (-51, 62), (-86, 50)],                                 # between the centre buildings
    [(-44, 103), (-10, 113), (-17, 137), (-32, 133), (-58, 122), (-50, 98)],                 # courtyard of Hässelby torg 14-22
]

g = HS.Grid(X0, Y0, X1, Y1, 0.3)
print(f'Surface grid {g.nx}x{g.ny} @ {g.res} m')
d_road = HS.union_polylines(g, [(p, m['width'] / 2) for p, m in roads], fillet=6.0)
d_walk = HS.union_polylines(g, [(p, m['width'] / 2 + 2.4) for p, m in roads if m['sidewalk'] != 'no'], fillet=7.0)
d_walk = HS.polygon_field(g, PLAZAS, base=d_walk)
is_paved = lambda m: m['surface'] in ('paving_stones', 'concrete', 'sett') or m['kind'] == 'steps'
d_walk = HS.union_polylines(g, [(p, m['width'] / 2) for p, m in paths if is_paved(m)], fillet=2.0, base=d_walk)
d_path = HS.union_polylines(g, [(p, m['width'] / 2) for p, m in paths if not is_paved(m)], fillet=2.0)
d_park = HS.polygon_field(g, [r for r in L['parking'] if len(r) >= 3])

f_road = d_road
f_park = HS.subtract(d_park, d_road)
d_hard = np.minimum(d_road, d_park)
f_kerb = np.maximum(np.maximum(d_hard - 0.16, -d_hard), d_walk)       # granite kerb stones along the carriageway
f_walk = HS.subtract(d_walk, d_hard - 0.16)
f_path = HS.subtract(d_path, np.minimum(d_hard - 0.16, d_walk))

# Building footprints are carved out of every surface.
d_bldg = HS.polygon_field(g, [b['ring'] for b in L['buildings']])

SURF = {  # class: (field, material, height above terrain)
    'road': (f_road, 'asphalt', 0.0),
    'parking': (f_park, 'asphalt', 0.0),
    'kerb': (f_kerb, 'granite_curb', 0.13),
    'walk': (f_walk, 'paving_square', 0.12),
    'path': (f_path, 'asphalt_path', 0.03),
}
hs = {}  # sampled heights per class for props


def surface_z(cls, x, y):
    return H(x, y) + SURF[cls][2]


TILE = 85.0  # street mesh tiles (culling + lightmap packing)


def tile_of(p):
    return (int(math.floor((p[0] - X0) / TILE)), int(math.floor((p[1] - Y0) / TILE)))


print('Building street surfaces...')
for cls, (f, mat, dz) in SURF.items():
    f = HS.subtract(f, d_bldg)
    polys, segs = HS.march(g, f)
    tiles = {}
    for poly in polys:
        cx = sum(p[0] for p in poly) / len(poly)
        cy = sum(p[1] for p in poly) / len(poly)
        tiles.setdefault(tile_of((cx, cy)), []).append(poly)
    edges = {}
    if dz > 0.0:
        for a, b in segs:
            edges.setdefault(tile_of(((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)), []).append((a, b))
    for key in sorted(set(tiles) | set(edges)):
        b = MeshBuilder(f'street_{cls}_{key[0]}_{key[1]}')
        for poly in tiles.get(key, []):
            # crossings exactly on a corner duplicate a point: drop repeats
            q = [p for k, p in enumerate(poly) if math.dist(p, poly[k - 1]) > 1e-6]
            if len(q) < 3 or abs(HL.area2(q)) < 1e-5:
                continue
            b.face([(x, y, H(x, y) + dz) for (x, y) in q], mat)
        # vertical edge faces down to the neighbouring (lower) level
        for (a, c) in edges.get(key, []):
            za, zc = H(*a), H(*c)
            b.quad((c[0], c[1], zc + dz), (a[0], a[1], za + dz), (a[0], a[1], za - 0.06), (c[0], c[1], zc - 0.06), mat if cls != 'walk' else 'granite_curb')
        if not b.bm.faces:
            continue
        res = build(b, TPM_STREET, dissolve=True)
        add_mesh_object(b.name, f'Street {cls} {key}', b.name, 'ground', lightmap=res)


# Terrain: one continuous 2 m height grid (hidden a few cm below the street meshes),
# lawn blending into trodden earth (vertex colour R).
print('Building terrain...')
TG = 2.0


def ground_color(co, mat):
    x, y = co.x, co.y
    n = noise.noise(Vector((x * 0.07, y * 0.07, 2.0))) + 0.5 * noise.noise(Vector((x * 0.25, y * 0.25, 5.0)))
    near_walk = 1.0 - smoothstep(0.0, 2.5, float(HS.sample(g, d_walk, x, y)))
    near_path = 1.0 - smoothstep(0.0, 1.8, float(HS.sample(g, d_path, x, y)))
    worn = 0.25 + 0.3 * n + 0.45 * max(near_walk, near_path)
    return (min(1.0, max(0.0, worn)), 1.0, 0.0, 1.0)


nxt, nyt = int((X1 - X0) / TILE) + 1, int((Y1 - Y0) / TILE) + 1
for ti in range(nxt):
    for tj in range(nyt):
        tx0, ty0 = X0 + ti * TILE, Y0 + tj * TILE
        tx1, ty1 = min(X1, tx0 + TILE), min(Y1, ty0 + TILE)
        if tx1 <= tx0 or ty1 <= ty0:
            continue
        b = MeshBuilder(f'terrain_{ti}_{tj}')
        # Tile edges land exactly on tile boundaries (no cracks between tiles).
        xs = np.linspace(tx0, tx1, int(math.ceil((tx1 - tx0) / TG)) + 1)
        ys = np.linspace(ty0, ty1, int(math.ceil((ty1 - ty0) / TG)) + 1)
        for j in range(len(ys) - 1):
            for i in range(len(xs) - 1):
                x0, x1, y0, y1 = xs[i], xs[i + 1], ys[j], ys[j + 1]
                hq = (H(x0, y0), H(x1, y0), H(x1, y1), H(x0, y1))
                cx_, cy_ = (x0 + x1) / 2, (y0 + y1) / 2
                mat = 'rock_granite' if max(hq) - min(hq) > 1.4 and is_cut(cx_, cy_) else 'ground_lawn'
                b.quad((x0, y0, hq[0] - 0.04), (x1, y0, hq[1] - 0.04), (x1, y1, hq[2] - 0.04), (x0, y1, hq[3] - 0.04), mat)
        res = build(b, TPM_GROUND, vertex_color=ground_color)
        add_mesh_object(b.name, f'Terrain {ti},{tj}', b.name, 'terrain', lightmap=res)


# =============================================================== viaduct + platform
# Hässelby gård (1958): two single-track deck slabs on board-formed concrete bents,
# joined under the wedge-shaped island platform; the station hall sits under the
# platform's wide west end. Tracks continue at grade on an embankment (west) and
# into a rock cut (east).
print('Building the viaduct...')
import arch  # noqa: E402


def resample(chain, step):
    """(point, unit tangent) every `step` metres along a polyline."""
    out = []
    acc = step * 0.5
    for a, b in zip(chain, chain[1:]):
        ln = math.dist(a, b)
        if ln < 1e-9:
            continue
        while acc <= ln:
            t = acc / ln
            out.append(((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t), ((b[0] - a[0]) / ln, (b[1] - a[1]) / ln)))
            acc += step
        acc -= ln
    return out


def clean(poly, min_area=1e-6):
    q = [p for k, p in enumerate(poly) if math.dist(p, poly[k - 1]) > 1e-6]
    return q if len(q) >= 3 and abs(HL.area2(q)) > min_area else None


def wall_seg(b, a, c, z0, z1, mat, outward=True):
    """Vertical face on a march() boundary segment (inside on the left of a->c)."""
    if outward:
        b.quad((a[0], a[1], z0), (c[0], c[1], z0), (c[0], c[1], z1), (a[0], a[1], z1), mat)
    else:
        b.quad((c[0], c[1], z0), (a[0], a[1], z0), (a[0], a[1], z1), (c[0], c[1], z1), mat)


def emit_region(b, f, z, mat, flip=False):
    for poly in HS.march(gv, f)[0]:
        q = clean(poly)
        if q:
            b.face([(x, y, z) for (x, y) in (reversed(q) if flip else q)], mat)


we = lambda p: list(p) if p[0][0] < p[-1][0] else list(p)[::-1]
TRK = [we(p) for p in BRIDGES]
TRK.sort(key=lambda p: -sum(q[1] for q in p) / len(p))           # north track first
D_TRK = (Vector(TRK[1][-1]) - Vector(TRK[1][0])).normalized()      # general track direction (WSW -> ENE)
along = lambda x, y: x * D_TRK.x + y * D_TRK.y

gv = HS.Grid(-125.0, -50.0, 95.0, 62.0, 0.2)
GX, GY = np.meshgrid(gv.xs, gv.ys)
S_END = np.max([(GX - o.x) * n.x + (GY - o.y) * n.y for (o, n, _l, _h) in ABUTS], axis=0)
d_cl = [HS.union_polylines(gv, [(p, 0.0)]) for p in TRK]           # distance to each track centreline
d_strip = HS.polygon_field(gv, [TRK[0] + TRK[1][::-1]])

# Island platform: between the tracks, edges 1.6 m from the centrelines, ends square to the line.
PLAT_EDGE = 1.6
A_W, A_E = along(-52.0, -5.0), 84.0
A_GRID = GX * D_TRK.x + GY * D_TRK.y
d_pl = np.maximum.reduce([d_strip, PLAT_EDGE - d_cl[0], PLAT_EDGE - d_cl[1], A_W - A_GRID, A_GRID - A_E])
DECK_HALF = 2.3
d_deck = np.minimum(np.minimum(d_cl[0], d_cl[1]) - DECK_HALF, d_pl - 0.1)
d_deck = np.maximum(d_deck, S_END + 0.5)                           # deck ends rest on the abutments
s_end = lambda x, y: past_end(x, y)

# ---- deck slab, edge beams, parapet upstands (simplified outline loops + inset ribbons)
UPST = 0.32           # parapet upstand above the deck
deck_loops = HS.contour_loops(gv, d_deck)
on_end = lambda p: s_end(p[0], p[1]) > -0.65


def ribbon(b, outer, inner, i, z, mat, up=True):
    j = (i + 1) % len(outer)
    a, c, ci, ai = outer[i], outer[j], inner[j], inner[i]
    q = [(a[0], a[1], z), (c[0], c[1], z), (ci[0], ci[1], z), (ai[0], ai[1], z)]
    b.face(q if up else q[::-1], mat)


def edge_runs(flags):
    """Maximal runs of consecutive edges with flag False -> lists of vertex indices."""
    n = len(flags)
    if not any(flags):
        return [list(range(n)) + [0]]
    k0 = next(i for i in range(n) if flags[i]) + 1
    runs, cur = [], []
    for s_ in range(n):
        i = (k0 + s_) % n
        if flags[i]:
            if len(cur) > 1:
                runs.append(cur)
            cur = []
            continue
        if not cur:
            cur = [i]
        cur.append((i + 1) % n)
    if len(cur) > 1:
        runs.append(cur)
    return runs


b = MeshBuilder('viaduct_deck')
RAIL_RUNS = []
for loop in deck_loops:
    n_ = len(loop)
    ends = [on_end(loop[i]) and on_end(loop[(i + 1) % n_]) for i in range(n_)]
    beam, upst, mid = HS.offset_loop(loop, 0.45), HS.offset_loop(loop, 0.22), HS.offset_loop(loop, 0.11)
    b.face([(x, y, DECK_Z) for (x, y) in loop], 'concrete_viaduct')
    b.face([(x, y, SOFFIT_Z + 0.35) for (x, y) in reversed(beam)], 'concrete_viaduct')
    for i in range(n_):
        j = (i + 1) % n_
        ribbon(b, loop, beam, i, SOFFIT_Z, 'concrete_viaduct', up=False)
        wall_seg(b, beam[i], beam[j], SOFFIT_Z, SOFFIT_Z + 0.35, 'concrete_viaduct', outward=False)
        if ends[i]:
            wall_seg(b, loop[i], loop[j], SOFFIT_Z, DECK_Z, 'concrete_viaduct')
            continue
        wall_seg(b, loop[i], loop[j], SOFFIT_Z, DECK_Z + UPST, 'concrete_viaduct')
        ribbon(b, loop, upst, i, DECK_Z + UPST, 'concrete_viaduct')
        wall_seg(b, upst[i], upst[j], DECK_Z, DECK_Z + UPST, 'concrete_viaduct', outward=False)
    RAIL_RUNS += [[mid[k] for k in run] for run in edge_runs(ends)]
# end posts where the parapets meet the abutments
for (o, n, lat, half) in ABUTS:
    for pts in BRIDGES:
        for p, q in ((pts[0], pts[1]), (pts[-1], pts[-2])):
            if math.dist(p, o) > half + 0.5:
                continue
            t = Vector((p[0] - q[0], p[1] - q[1])).normalized()
            nn = Vector((-t.y, t.x))
            for side in (-1, 1):
                c0 = Vector(p) - t * 0.8 + nn * (DECK_HALF - 0.2) * side
                P = lambda a_, b_, z: (c0.x + t.x * a_ + nn.x * b_, c0.y + t.y * a_ + nn.y * b_, z)
                z0_, z1_ = SOFFIT_Z, DECK_Z + UPST + 1.15
                for (a0, b0, a1, b1) in [(-0.32, -0.32, 0.32, -0.32), (0.32, -0.32, 0.32, 0.32), (0.32, 0.32, -0.32, 0.32), (-0.32, 0.32, -0.32, -0.32)]:
                    b.quad(P(a0, b0, z0_), P(a1, b1, z0_), P(a1, b1, z1_), P(a0, b0, z1_), 'concrete_viaduct')
                b.quad(P(-0.32, -0.32, z1_), P(0.32, -0.32, z1_), P(0.32, 0.32, z1_), P(-0.32, 0.32, z1_), 'concrete_viaduct')
res = build(b, 6)
add_mesh_object('viaduct_deck', 'T-bana viaduct deck', 'viaduct_deck', 'structure', lightmap=res)

# ---- railings: posts every ~2 m, top rail, flat-bar infill (alpha), along the upstand
b = MeshBuilder('viaduct_railing')
zr0, zr1 = DECK_Z + UPST, DECK_Z + UPST + 1.0
for pts in RAIL_RUNS:
    if len(pts) < 2 or sum(math.dist(a, c) for a, c in zip(pts, pts[1:])) < 1.0:
        continue
    for (p, t) in resample(pts, 2.0):
        b.tube((p[0], p[1], zr0), (p[0], p[1], zr1), 0.03, 0.03, 'metal_railing_dark', sides=6, caps=False)
    for a, c in zip(pts, pts[1:]):
        b.tube((a[0], a[1], zr1), (c[0], c[1], zr1), 0.028, 0.028, 'metal_railing_dark', sides=6, caps=False)
        b.tube((a[0], a[1], zr0 + 0.08), (c[0], c[1], zr0 + 0.08), 0.02, 0.02, 'metal_railing_dark', sides=4, caps=False)
        b.quad((a[0], a[1], zr0 + 0.08), (c[0], c[1], zr0 + 0.08), (c[0], c[1], zr1 - 0.03), (a[0], a[1], zr1 - 0.03), 'railing_bars')
build(b, None)
add_mesh_object('viaduct_railing', 'Viaduct railing', 'viaduct_railing', 'structure', collision=False)

# ---- abutments: deck seat across the formation, wing walls following the embankment
for k, (o, n, lat, half) in enumerate(ABUTS):
    b = MeshBuilder(f'abutment_{k}')
    S0, S1 = -0.9, 4.2
    P = lambda s, l, z: (o.x + n.x * s + lat.x * l, o.y + n.y * s + lat.y * l, z)
    cols = []
    for l in np.arange(-(half + 13.0), half + 13.0 + 1e-6, 0.5):
        core = abs(l) <= half + DECK_HALF + 0.3
        zback = H(*P(S1 + 0.3, l, 0)[:2])
        zt = DECK_Z - 0.02 if core else min(DECK_Z - 0.02, zback + 0.12)
        zg = min(H(*P(S0, l, 0)[:2]), H(*P(S1, l, 0)[:2])) - 0.3
        cols.append((l, zt, zg, core or zt - H(*P(S0, l, 0)[:2]) > 0.3))
    run = [c for c in cols if c[3]]
    for (l0, t0, g0, _), (l1, t1, g1, _) in zip(run, run[1:]):
        if l1 - l0 > 0.51:
            continue
        arch.quad_facing(b, [P(S0, l0, g0), P(S0, l1, g1), P(S0, l1, t1), P(S0, l0, t0)], (-n.x, -n.y, 0), 'concrete_viaduct')  # front
        arch.quad_facing(b, [P(S0, l0, t0), P(S1, l0, t0), P(S1, l1, t1), P(S0, l1, t1)], (0, 0, 1), 'concrete_viaduct')       # top
        arch.quad_facing(b, [P(S1, l0, g0), P(S1, l1, g1), P(S1, l1, t1), P(S1, l0, t0)], (n.x, n.y, 0), 'concrete_viaduct')    # back
    for (l, t_, g_, _), sgn in ((run[0], -1), (run[-1], 1)):
        quad = [P(S0, l, g_), P(S1, l, g_), P(S1, l, t_), P(S0, l, t_)]
        arch.quad_facing(b, quad, (lat.x * sgn, lat.y * sgn, 0), 'concrete_viaduct')
    res = build(b, TPM_ARCH, dissolve=True)
    add_mesh_object(b.name, f'Viaduct abutment {k}', b.name, 'structure', lightmap=res)

# ---- bents: a crosshead under the soffit and board-formed columns under each track
# (and under the platform where it is wide); none in the carriageways.
b = MeshBuilder('viaduct_bents')
a_lo = max(along(*o) for (o, n, _l, _h) in ABUTS if n.x < 0) + 6.0
a_hi = min(along(*o) for (o, n, _l, _h) in ABUTS if n.x > 0) - 6.0
nb = max(1, int(round((a_hi - a_lo) / 15.0)))
BENTS = []


def cross_track(pts, a):
    """Point where the polyline crosses along == a (and the local tangent)."""
    for p, q in zip(pts, pts[1:]):
        ap, aq = along(*p), along(*q)
        if (ap - a) * (aq - a) <= 0 and ap != aq:
            t = (a - ap) / (aq - ap)
            tg = Vector((q[0] - p[0], q[1] - p[1])).normalized()
            return Vector((p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t)), tg
    return None, None


def box_oriented(b, c, u, hu, hv, z0, z1, mat, top=False):
    v = Vector((-u.y, u.x))
    P = lambda a_, b_, z: (c.x + u.x * a_ + v.x * b_, c.y + u.y * a_ + v.y * b_, z)
    for (a0, b0, a1, b1) in [(-hu, -hv, hu, -hv), (hu, -hv, hu, hv), (hu, hv, -hu, hv), (-hu, hv, -hu, -hv)]:
        b.quad(P(a0, b0, z0), P(a1, b1, z0), P(a1, b1, z1), P(a0, b0, z1), mat)
    b.quad(P(-hu, hv, z0), P(hu, hv, z0), P(hu, -hv, z0), P(-hu, -hv, z0), mat)
    if top:
        b.quad(P(-hu, -hv, z1), P(hu, -hv, z1), P(hu, hv, z1), P(-hu, hv, z1), mat)


for i in range(nb + 1):
    a = a_lo + (a_hi - a_lo) * i / nb
    pts_t = [cross_track(p, a) for p in TRK]
    if any(p is None for p, _t in pts_t):
        continue
    (pn, tn), (ps, ts) = pts_t
    cols = [(pn, tn), (ps, ts)]
    wide = A_W + 1.0 < a < A_E - 1.0 and (pn - ps).length > 8.5
    if wide:
        cols.append(((pn + ps) / 2, (tn + ts).normalized()))
    if any(HS.sample(g, d_road, c.x, c.y) < 1.2 for c, _t in cols):
        continue
    BENTS.append(cols)
    joined = A_W - 2.0 < a < A_E + 2.0
    v = (pn - ps).normalized()
    u = Vector((v.y, -v.x))
    if joined:
        mid = (pn + ps) / 2
        box_oriented(b, mid, u, 0.55, (pn - ps).length / 2 + DECK_HALF - 0.5, SOFFIT_Z - 0.55, SOFFIT_Z + 0.05, 'concrete_viaduct')
    else:
        for c, _t in cols[:2]:
            box_oriented(b, c, u, 0.55, DECK_HALF - 0.5, SOFFIT_Z - 0.55, SOFFIT_Z + 0.05, 'concrete_viaduct')
    for c, t in cols:
        zg = H(c.x, c.y) - 0.3
        box_oriented(b, c, t, 0.8, 0.5, zg, SOFFIT_Z - 0.5, 'concrete_viaduct')
res = build(b, TPM_ARCH)
add_mesh_object('viaduct_bents', 'Viaduct bents', 'viaduct_bents', 'structure', lightmap=res)
print(f'  {len(BENTS)} bents')

# ---- track: ballast, concrete sleepers, running rails, third rail with its cover board
print('Building tracks...')
zb_top = TRACK_Z - 0.32
all_tracks = [p for p in BRIDGES + RAILS_ALL]
for ti, track in enumerate(all_tracks):
    pts = [p for p in track if X0 - 8 < p[0] < X1 + 8 and Y0 - 8 < p[1] < Y1 + 8]
    if len(pts) < 2:
        continue
    others = np.array([q for k, o in enumerate(all_tracks) if k != ti for q in o])
    b = MeshBuilder(f'track_{ti}')
    samples = resample(pts, 1.0)
    for k in range(len(samples) - 1):
        (p, t), (q, t2) = samples[k], samples[k + 1]
        n0, n1 = (-t[1], t[0]), (-t2[1], t2[0])
        for (w0, w1, z0_, z1_) in [(-1.3, 1.3, zb_top, zb_top), (1.3, 2.0, zb_top, zb_top - 0.45), (-2.0, -1.3, zb_top - 0.45, zb_top)]:
            b.quad((p[0] + n0[0] * w0, p[1] + n0[1] * w0, z0_), (q[0] + n1[0] * w0, q[1] + n1[1] * w0, z0_),
                   (q[0] + n1[0] * w1, q[1] + n1[1] * w1, z1_), (p[0] + n0[0] * w1, p[1] + n0[1] * w1, z1_), 'ballast')
    for (p, t) in resample(pts, 0.65):
        u = Vector((t[0], t[1]))
        v = Vector((-t[1], t[0]))
        P = lambda a_, c_, z: (p[0] + u.x * a_ + v.x * c_, p[1] + u.y * a_ + v.y * c_, z)
        z0_, z1_ = zb_top - 0.03, zb_top + 0.13
        hl, hw = 0.12, 1.25
        b.quad(P(-hl, -hw, z1_), P(hl, -hw, z1_), P(hl, hw, z1_), P(-hl, hw, z1_), 'concrete_cast')
        b.quad(P(hl, -hw, z0_), P(hl, hw, z0_), P(hl, hw, z1_), P(hl, -hw, z1_), 'concrete_cast')
        b.quad(P(-hl, hw, z0_), P(-hl, -hw, z0_), P(-hl, -hw, z1_), P(-hl, hw, z1_), 'concrete_cast')
    gauge = 1.435 / 2 + 0.035
    rs = resample(pts, 2.0)
    # third rail on the side away from the other track (never at the platform)
    mid = Vector(rs[len(rs) // 2][0])
    near = others[np.argmin(np.hypot(others[:, 0] - mid.x, others[:, 1] - mid.y))] if len(others) else (mid.x, mid.y + 10)
    tn = Vector(rs[len(rs) // 2][1])
    side = -1.0 if Vector((-tn.y, tn.x)).dot(Vector((near[0] - mid.x, near[1] - mid.y))) > 0 else 1.0
    rails = [(-gauge, 0.072, 0.155, 0.0, 'rail_steel'), (gauge, 0.072, 0.155, 0.0, 'rail_steel'),
             (side * (gauge + 0.72), 0.08, 0.17, 0.02, 'rail_steel'), (side * (gauge + 0.72), 0.26, 0.03, 0.24, 'wood_fascia')]
    for off, wdt, hgt, lift, mat in rails:
        line = [(p[0] - t[1] * off, p[1] + t[0] * off) for (p, t) in rs]
        r0_, r1_ = zb_top + 0.13 + lift, zb_top + 0.13 + lift + hgt
        for a, c in zip(line, line[1:]):
            d_ = Vector((c[0] - a[0], c[1] - a[1], 0)).normalized()
            nn = Vector((-d_.y, d_.x, 0)) * (wdt / 2)
            b.quad((a[0] - nn.x, a[1] - nn.y, r1_), (c[0] - nn.x, c[1] - nn.y, r1_), (c[0] + nn.x, c[1] + nn.y, r1_), (a[0] + nn.x, a[1] + nn.y, r1_), mat)
            b.quad((c[0] + nn.x, c[1] + nn.y, r0_), (a[0] + nn.x, a[1] + nn.y, r0_), (a[0] + nn.x, a[1] + nn.y, r1_), (c[0] + nn.x, c[1] + nn.y, r1_), mat)
            b.quad((a[0] - nn.x, a[1] - nn.y, r0_), (c[0] - nn.x, c[1] - nn.y, r0_), (c[0] - nn.x, c[1] - nn.y, r1_), (a[0] - nn.x, a[1] - nn.y, r1_), mat)
    build(b, None)
    add_mesh_object(b.name, f'Track {ti}', b.name, 'structure', collision=False)

# ---- island platform: slab with an overhanging edge, light edge band
b = MeshBuilder('platform')
for loop in HS.contour_loops(gv, d_pl):
    n_ = len(loop)
    band, over = HS.offset_loop(loop, 0.5), HS.offset_loop(loop, 0.35)
    b.face([(x, y, PLAT_Z) for (x, y) in band], 'paving_slabs')
    for i in range(n_):
        j = (i + 1) % n_
        ribbon(b, loop, band, i, PLAT_Z, 'platform_edge')
        wall_seg(b, loop[i], loop[j], PLAT_Z - 0.25, PLAT_Z, 'concrete_cast')
        ribbon(b, loop, over, i, PLAT_Z - 0.25, 'concrete_cast', up=False)
        wall_seg(b, over[i], over[j], DECK_Z, PLAT_Z - 0.25, 'concrete_viaduct')
res = build(b, TPM_ARCH)
add_mesh_object('platform', 'Island platform', 'platform', 'structure', lightmap=res)

# ---- canopy: flat roof on a central column row, dark slatted fascia, fluorescent fittings
CANOPY_Z = PLAT_Z + 3.0
CAN_A0, CAN_A1 = A_W + 4.0, A_W + 64.0
d_can = np.maximum.reduce([d_pl + 0.25, CAN_A0 - A_GRID, A_GRID - CAN_A1])
b = MeshBuilder('platform_canopy')
for loop in HS.contour_loops(gv, d_can):
    b.face([(x, y, CANOPY_Z + 0.45) for (x, y) in loop], 'roof_felt')
    b.face([(x, y, CANOPY_Z) for (x, y) in reversed(loop)], 'canopy_soffit')
    for i in range(len(loop)):
        wall_seg(b, loop[i], loop[(i + 1) % len(loop)], CANOPY_Z - 0.05, CANOPY_Z + 0.5, 'canopy_fascia')
CANOPY_COLS = []
for a in np.arange(CAN_A0 + 3.0, CAN_A1 - 2.0, 7.5):
    pts_t = [cross_track(p, a) for p in TRK]
    if any(p is None for p, _t in pts_t):
        continue
    m = (pts_t[0][0] + pts_t[1][0]) / 2
    CANOPY_COLS.append((m, (pts_t[0][1] + pts_t[1][1]).normalized()))
for (m, t) in CANOPY_COLS:
    box_oriented(b, m, t, 0.13, 0.13, PLAT_Z, CANOPY_Z, 'metal_railing_dark')
    box_oriented(b, m, t, 0.08, 1.5, CANOPY_Z - 0.2, CANOPY_Z, 'metal_railing_dark')      # cross beam
lamp_b = MeshBuilder('platform_canopy_lights')
CANOPY_LIGHTS = []
for (m, t) in CANOPY_COLS:
    v = Vector((-t.y, t.x))
    for side in (-1, 1):
        c = m + v * 1.6 * side + t * 3.75
        if HS.sample(gv, d_can, c.x, c.y) > -0.4:
            continue
        box_oriented(lamp_b, c, t, 0.65, 0.08, CANOPY_Z - 0.09, CANOPY_Z - 0.01, 'lamp_fluorescent', top=False)
        CANOPY_LIGHTS.append((c.x, c.y, CANOPY_Z - 0.12))
res = build(b, TPM_ARCH)
add_mesh_object('platform_canopy', 'Platform canopy', 'platform_canopy', 'structure', lightmap=res)
build(lamp_b, None)
add_mesh_object('platform_canopy_lights', 'Canopy light fittings', 'platform_canopy_lights', 'prop', collision=False, cast=False)
print(f'  canopy: {len(CANOPY_COLS)} columns, {len(CANOPY_LIGHTS)} fittings')


# ---- station hall under the platform's west end: glazed front towards the forecourt
# (wood/steel framed doors, brown tiles), entrance canopy, name band, T sign.
SOUTH = Vector((D_TRK.y, -D_TRK.x))
HALL_A0, HALL_A1 = -37.0, -15.0
near_rings = [bd['ring'] for bd in L['buildings']
              if any(-60 < x < 0 and -30 < y < 30 for (x, y) in bd['ring'])]
d_hall = np.maximum.reduce([d_strip + 1.0, HALL_A0 - A_GRID, A_GRID - HALL_A1])   # columns stand just outside the glass
d_hall = HS.subtract(d_hall, HS.polygon_field(gv, near_rings) - 0.02)
HALL_TOP = SOFFIT_Z + 0.35
FRONT_H = 2.95
b = MeshBuilder('station_hall')
STATION = {'front': None}
for loop in HS.contour_loops(gv, d_hall, tol=0.05):
    zg = min(H(x, y) for (x, y) in loop)
    zb = zg - 0.25
    z0 = max(H(x, y) for (x, y) in loop) + 0.12 - zb     # floor level above the wall base
    for i in range(len(loop)):
        a, c = loop[i], loop[(i + 1) % len(loop)]
        t = Vector((c[0] - a[0], c[1] - a[1]))
        ln = t.length
        if ln < 0.3:
            continue
        t /= ln
        mid = ((a[0] + c[0]) / 2, (a[1] + c[1]) / 2)
        outward = Vector((t.y, -t.x))
        # walls against the neighbouring building are internal
        if any(HL.poly_contains(r, mid[0] + outward.x * 0.3, mid[1] + outward.y * 0.3) for r in near_rings):
            continue
        ops = []
        front = outward.dot(SOUTH) > 0.75
        if front:
            # glazed front: doors in the middle, fixed glazing either side, transom above
            nb_ = max(3, int(round((ln - 1.2) / 2.0)))
            w_ = (ln - 1.2) / nb_
            for k in range(nb_):
                u0 = 0.6 + k * w_
                kind = 'door' if abs(k - (nb_ - 1) / 2) < 1.6 else 'shop'
                if kind == 'door':
                    ops.append((u0 + 0.06, z0, w_ - 0.12, 2.25, 'door', 'hall_interior', z0))
                    ops.append((u0 + 0.06, z0 + 2.33, w_ - 0.12, FRONT_H - 2.45, 'shop', 'hall_interior', z0))
                else:
                    ops.append((u0 + 0.06, z0 + 0.25, w_ - 0.12, FRONT_H - 0.37, 'shop', 'hall_interior', z0))
            STATION['front'] = (Vector(a), t, ln, zb, z0)
        elif ln > 6:
            ops.append((ln / 2 - 1.1, z0, 2.2, 2.3, 'door', 'hall_interior', z0))
        arch.wall(b, (a[0], a[1], zb), t, ln, HALL_TOP - zb, ops, 0.12, 'tiles_brown',
                  plinth=z0 + 0.0 if front else z0 + 0.25, plinth_mat='granite_curb',
                  bands=[(z0 + FRONT_H, z0 + FRONT_H + 0.08, 'fascia_dark')] if front else (),
                  frame='metal_galvanized')
res = build(b, TPM_ARCH)
add_mesh_object('station_hall', 'Hässelby gård station hall', 'station_hall', 'building', lightmap=res)

# Entrance canopy along the front, name band, T sign on the nearest bent column.
if STATION['front']:
    a, t, ln, zb, z0 = STATION['front']
    out = Vector((t.y, -t.x))
    b = MeshBuilder('station_canopy')
    zc = zb + z0 + FRONT_H + 0.35
    dep = 2.4
    P = lambda u_, o_, z: (a.x + t.x * u_ + out.x * o_, a.y + t.y * u_ + out.y * o_, z)
    u0_, u1_ = -0.6, ln + 0.6
    b.quad(P(u0_, 0, zc + 0.3), P(u0_, dep, zc + 0.3), P(u1_, dep, zc + 0.3), P(u1_, 0, zc + 0.3), 'concrete_cast')
    b.quad(P(u0_, dep, zc), P(u0_, 0, zc), P(u1_, 0, zc), P(u1_, dep, zc), 'ceiling_panel')
    arch.quad_facing(b, [P(u0_, dep, zc - 0.05), P(u1_, dep, zc - 0.05), P(u1_, dep, zc + 0.3), P(u0_, dep, zc + 0.3)], (out.x, out.y, 0), 'concrete_cast')
    for uu in (u0_, u1_):
        arch.quad_facing(b, [P(uu, 0, zc - 0.05), P(uu, dep, zc - 0.05), P(uu, dep, zc + 0.3), P(uu, 0, zc + 0.3)], (t.x * (1 if uu > 0 else -1), t.y * (1 if uu > 0 else -1), 0), 'concrete_cast')
    res = build(b, TPM_ARCH)
    add_mesh_object('station_canopy', 'Station entrance canopy', 'station_canopy', 'structure', lightmap=res)
    lamp_b = MeshBuilder('station_canopy_lights')
    STATION_LIGHTS = []
    for uu in np.arange(1.2, ln, 2.4):
        c = Vector(P(uu, dep * 0.55, 0)[:2])
        box_oriented(lamp_b, c, t, 0.6, 0.07, zc - 0.07, zc - 0.005, 'lamp_fluorescent')
        STATION_LIGHTS.append((c.x, c.y, zc - 0.1))
    # name band over the doors (lettering comes from a sign object)
    band_u0, band_u1 = ln / 2 - 4.2, ln / 2 + 4.2
    bz0, bz1 = zb + z0 + FRONT_H - 0.42, zb + z0 + FRONT_H - 0.04
    arch.quad_facing(lamp_b, [P(band_u0, 0.06, bz0), P(band_u1, 0.06, bz0), P(band_u1, 0.06, bz1), P(band_u0, 0.06, bz1)], (out.x, out.y, 0), 'sign_blue_band')
    STATION['band'] = (Vector(P((band_u0 + band_u1) / 2, 0.07, 0)[:2]), t, out, (bz0 + bz1) / 2, band_u1 - band_u0, bz1 - bz0)
    bc_ = P((band_u0 + band_u1) / 2, 0.075, (bz0 + bz1) / 2)
    add_sign('sign_station_band', 'Station name band', bc_, out, 'Hässelby gård', (band_u1 - band_u0, bz1 - bz0),
             font='Inter', weight=700, color='#ffffff', background='#0b3f7e', backlit=1, textHeight=0.68, letterSpacing=0.12)
    # T sign: the column nearest the front's east end gets a bracket and a backlit disc
    east = Vector(P(ln, 0, 0)[:2])
    cols = [(c, tt) for bent in BENTS for (c, tt) in bent]
    col, ct = min(cols, key=lambda ct_: (ct_[0] - east).length) if cols else (east + out * 3, t)
    if (col - east).length < 12:
        side = 1                                             # disc east of the column, over the canopy
        disc_c = col + t * side * (0.8 + 0.95)
        zt = 4.55
        lamp_b.tube((col.x + t.x * side * 0.8, col.y + t.y * side * 0.8, zt + 0.55), (disc_c.x, disc_c.y, zt + 0.55), 0.04, 0.04, 'metal_railing_dark', sides=6)
        lamp_b.tube((disc_c.x, disc_c.y, zt + 0.55), (disc_c.x, disc_c.y, zt + 0.45), 0.03, 0.03, 'metal_railing_dark', sides=6)
        # disc: 0.9 m opal face both sides, thin dark rim; faces the forecourt
        R_ = 0.5
        nseg = 24
        for sgn in (1, -1):
            fn = out * sgn
            ring_ = []
            uvs_ = []
            for k in range(nseg):
                ang = 2 * math.pi * k / nseg
                lx, lz = math.cos(ang) * R_, math.sin(ang) * R_
                p = disc_c + fn * 0.09 + t * lx * sgn
                ring_.append((p.x, p.y, zt + lz))
                uvs_.append((0.45 + lx * 0.9, 0.45 + lz * 0.9))
            lamp_b.face(ring_, 'sign_tbana', uvs=uvs_)
        for k in range(nseg):
            a0, a1 = 2 * math.pi * k / nseg, 2 * math.pi * (k + 1) / nseg
            q = [disc_c + out * 0.09 + t * math.cos(a0) * -R_, disc_c + out * 0.09 + t * math.cos(a1) * -R_,
                 disc_c - out * 0.09 + t * math.cos(a1) * -R_, disc_c - out * 0.09 + t * math.cos(a0) * -R_]
            zz = [math.sin(a0) * R_, math.sin(a1) * R_, math.sin(a1) * R_, math.sin(a0) * R_]
            mid_ = disc_c + t * math.cos((a0 + a1) / 2) * -R_
            arch.quad_facing(lamp_b, [(q[i].x, q[i].y, zt + zz[i]) for i in range(4)],
                             (mid_.x - disc_c.x, mid_.y - disc_c.y, math.sin((a0 + a1) / 2)), 'metal_railing_dark')
        STATION['tsign'] = (disc_c.x, disc_c.y, zt)
    build(lamp_b, None)
    add_mesh_object('station_canopy_lights', 'Station lights and signs', 'station_canopy_lights', 'prop', collision=False, cast=False)
    print(f"  station hall front {ln:.1f} m at {tuple(round(v, 1) for v in a)}, T sign at {tuple(round(v, 1) for v in STATION.get('tsign', ()))}")


# =============================================================== buildings

FLOOR = 2.8
rnd_b = random.Random(55)


def archetype(bd):
    k, lv = bd['kind'], bd['levels']
    cx = sum(p[0] for p in bd['ring']) / len(bd['ring'])
    cy = sum(p[1] for p in bd['ring']) / len(bd['ring'])
    if bd['area'] < 45 and lv <= 1 and X0 < cx < X1 and Y0 < cy < Y1 and HS.sample(g, d_walk, cx, cy) < 3.0:
        return 'kiosk'                       # small pavilions standing on the square
    if bd['area'] < 40 or k in ('shed', 'roof', 'toilets'):
        return 'shed'
    if k == 'parking':
        return 'garage'
    if lv >= 14:
        return 'tower'
    if lv >= 9:
        return 'point'
    if k in ('retail', 'government', 'office', 'commercial'):
        return 'kiosk' if bd['area'] < 70 else 'retail'
    if k in ('school', 'kindergarten', 'public'):
        return 'school'
    if k in ('apartments', 'residential', 'yes', 'house') and lv >= 2:
        return 'slab'
    return 'pavilion'


# Facade palettes per archetype (1950s Hässelby: light render with ochre panels on the
# point blocks, red-brown brick in the centre, yellow render + red tile roofs on the
# low slabs).
POINT_RENDERS = ['render_white', 'render_cream', 'render_cream', 'render_grey']
SLAB_RENDERS = ['render_yellow', 'render_yellow', 'render_ochre', 'render_cream']
WIN = 'window_interior'      # interior-mapped rooms; lit state per room in the shader


def edges_of(ring):
    """(start, unit direction, length, perimeter distance at start) per wall."""
    n = len(ring)
    acc = 0.0
    for i in range(n):
        a, c = ring[i], ring[(i + 1) % n]
        d = (c[0] - a[0], c[1] - a[1])
        ln = math.hypot(*d)
        if ln > 0.2:
            yield a, (d[0] / ln, d[1] / ln), ln, acc
        acc += ln + 2.0   # gap: each wall is its own lightmap chart (packs better than one long belt)


def faces_walk(a, u, ln):
    """Does this wall face paved pedestrian space (pavement, square, plaza)?"""
    out = (u[1], -u[0])
    hits = 0
    for t_ in (0.25, 0.5, 0.75):
        x, y = a[0] + u[0] * ln * t_ + out[0] * 3.0, a[1] + u[1] * ln * t_ + out[1] * 3.0
        if X0 < x < X1 and Y0 < y < Y1 and HS.sample(g, d_walk, x, y) < 0.5:
            hits += 1
    return hits >= 2


def build_building(bd, idx):
    kind = archetype(bd)
    ring = bd['ring']
    zs = [H(x, y) for (x, y) in ring]
    zb = min(zs) - 0.25                      # walls start below the lowest ground
    z0 = max(zs) + 0.08                      # ground floor level
    lv = max(1, bd['levels'])
    rng = random.Random(bd['id'])
    name = f'bldg_{idx:03d}_{kind}'
    b = MeshBuilder(name)
    roof_z = None
    if kind == 'point':
        wall_m = rng.choice(POINT_RENDERS)
        top = z0 + lv * FLOOR + 0.4
        for (a, u, ln, us0) in edges_of(ring):
            ops = []
            for c in arch.bays(ln, 2.6, 0.7):
                for f in range(lv):
                    zf = (z0 - zb) + f * FLOOR
                    ops.append((c - 0.6, zf + 0.08, 1.2, 0.78, 'panel', 'panel_ochre'))
                    ops.append((c - 0.6, zf + 0.92, 1.2, 1.32, 'window', WIN, zf))
            arch.wall(b, (a[0], a[1], zb), u, ln, top - zb, ops, 0.16, wall_m, plinth=(z0 - zb) + 0.45, plinth_mat='concrete_cast', u_start=us0)
        roof_z = top
        arch.polygon_roof(b, ring, roof_z, 'roof_felt')
        arch.roof_edge(b, ring, roof_z + 0.02, 0.32, 'metal_dark')
    elif kind == 'tower':
        top = z0 + lv * FLOOR + 0.5
        for (a, u, ln, us0) in edges_of(ring):
            ops = []
            if ln < 22:   # narrow end walls: red, one column of small windows
                for f in range(lv):
                    zf = (z0 - zb) + f * FLOOR
                    ops.append((ln * 0.5 - 0.35, zf + 1.1, 0.7, 0.8, 'window', WIN, zf))
                arch.wall(b, (a[0], a[1], zb), u, ln, top - zb, ops, 0.14, 'render_red', plinth=(z0 - zb) + 0.5, u_start=us0)
            else:         # long sides: grey render, glazed balcony bands between window pairs
                cs = arch.bays(ln, 3.4, 1.2)
                for k, c in enumerate(cs):
                    for f in range(lv):
                        zf = (z0 - zb) + f * FLOOR
                        if k % 3 == 1:
                            ops.append((c - 1.45, zf + 0.12, 2.9, FLOOR - 0.3, 'glazed', 'glass_balcony'))
                        else:
                            ops.append((c - 0.6, zf + 0.92, 1.2, 1.3, 'window', WIN, zf))
                arch.wall(b, (a[0], a[1], zb), u, ln, top - zb, ops, 0.16, 'render_grey', plinth=(z0 - zb) + 0.5, u_start=us0)
        roof_z = top
        arch.polygon_roof(b, ring, roof_z, 'roof_felt')
        arch.roof_edge(b, ring, roof_z + 0.02, 0.4, 'metal_dark')
    elif kind == 'retail':
        g_h = 4.2
        up = max(0, lv - 1)
        top = z0 + g_h + up * 3.1 + 0.5
        for (a, u, ln, us0) in edges_of(ring):
            ops = []
            shop = ln > 7 and faces_walk(a, u, ln)
            for k, c in enumerate(arch.bays(ln, 3.3, 0.6)):
                if shop:
                    if k % 4 == 1:
                        ops.append((c - 0.55, (z0 - zb) + 0.02, 1.1, 2.3, 'door', 'shop_interior', z0 - zb))
                    else:
                        ops.append((c - 1.4, (z0 - zb) + 0.35, 2.8, 2.6, 'shop', 'shop_interior', z0 - zb))
                for f in range(up):
                    zf = (z0 - zb) + g_h + f * 3.1
                    ops.append((c - 1.35, zf + 0.9, 2.7, 1.25, 'window', 'office_interior', zf))
            bands = [((z0 - zb) + 3.15, (z0 - zb) + 4.0, 'fascia_dark')] if shop else []
            if shop:
                SHOP_WALLS.append((a, u, ln, zb, z0, bd))
            arch.wall(b, (a[0], a[1], zb), u, ln, top - zb, ops, 0.2, 'brick_brown', plinth=(z0 - zb) + 0.3, plinth_mat='concrete_cast', bands=bands, u_start=us0)
        roof_z = top
        arch.polygon_roof(b, ring, roof_z, 'roof_felt')
        arch.roof_edge(b, ring, roof_z + 0.02, 0.35, 'metal_dark')
    elif kind in ('slab', 'school', 'pavilion'):
        wall_m = {'slab': rng.choice(SLAB_RENDERS), 'school': 'brick_yellow', 'pavilion': 'render_cream'}[kind]
        fl = 3.3 if kind == 'school' else FLOOR
        top = z0 + lv * fl + 0.3
        win_w = 1.6 if kind == 'school' else 1.2
        for (a, u, ln, us0) in edges_of(ring):
            ops = []
            for k, c in enumerate(arch.bays(ln, 3.0 if kind == 'school' else 2.7, 0.8)):
                for f in range(lv):
                    zf = (z0 - zb) + f * fl
                    if f == 0 and kind == 'slab' and k % 5 == 2 and ln > 12:
                        ops.append((c - 0.6, zf - 0.05, 1.2, 2.2, 'door', 'wood_door'))
                        continue
                    ops.append((c - win_w / 2, zf + 0.9, win_w, 1.35 if kind != 'school' else 1.75, 'window', WIN if kind != 'school' else 'office_interior', zf))
            arch.wall(b, (a[0], a[1], zb), u, ln, top - zb, ops, 0.18, wall_m, plinth=(z0 - zb) + 0.5, plinth_mat='concrete_cast', u_start=us0)
        rect = arch.oriented_rect(ring)
        if rect and kind != 'pavilion':
            roof_z = arch.gable_roof(b, rect, top, 24, 0.45, 'roof_tiles', wall_m, 'wood_fascia')
        else:
            roof_z = top
            arch.polygon_roof(b, ring, top, 'roof_felt')
            arch.roof_edge(b, ring, top + 0.02, 0.3, 'metal_dark')
    elif kind == 'kiosk':
        # 1950s/60s square kiosk: painted panels, a serving hatch towards the walk, fascia
        top = z0 + 2.75
        for (a, u, ln, us0) in edges_of(ring):
            ops = []
            if ln > 2.4 and faces_walk(a, u, ln):
                ops.append((0.35, (z0 - zb) + 0.95, ln - 0.7, 1.2, 'shop', 'kiosk_interior', z0 - zb))
                KIOSK_WALLS.append((a, u, ln, z0, bd['id']))
            elif ln > 1.8:
                ops.append((ln / 2 - 0.45, (z0 - zb) + 0.02, 0.9, 2.05, 'door', 'wood_door'))
            arch.wall(b, (a[0], a[1], zb), u, ln, top - zb, ops, 0.08, 'kiosk_panel', plinth=(z0 - zb) + 0.3,
                      plinth_mat='concrete_cast', bands=[((z0 - zb) + 2.3, top - zb, 'fascia_dark')], u_start=us0)
        roof_z = top
        arch.polygon_roof(b, ring, top, 'roof_felt')
        arch.roof_edge(b, ring, top + 0.02, 0.12, 'metal_dark')
    else:  # shed / garage
        top = z0 + (2.6 if kind == 'garage' else 2.4)
        for (a, u, ln, us0) in edges_of(ring):
            ops = []
            if kind == 'garage' and ln > 5:
                for c in arch.bays(ln, 3.0, 0.4):
                    ops.append((c - 1.15, (z0 - zb) + 0.02, 2.3, 2.1, 'panel', 'garage_door'))
            arch.wall(b, (a[0], a[1], zb), u, ln, top - zb, ops, 0.1, 'concrete_cast' if kind == 'garage' else 'wood_planks', u_start=us0)
        roof_z = top
        arch.polygon_roof(b, ring, top, 'roof_felt')
    res = build(b, TPM_ARCH if kind in ('retail', 'slab', 'school', 'pavilion') else TPM_TALL)
    add_mesh_object(name, f"{kind} {bd['street']} {bd['number']}".strip(), name, 'building', lightmap=res)
    return kind, roof_z


SHOP_WALLS = []
KIOSK_WALLS = []
print('Building buildings...')
kinds = {}
for i, bd in enumerate(L['buildings']):
    cx = sum(p[0] for p in bd['ring']) / len(bd['ring'])
    cy = sum(p[1] for p in bd['ring']) / len(bd['ring'])
    if not (X0 + 5 < cx < X1 - 5 and Y0 + 5 < cy < Y1 - 5):
        continue
    k, _ = build_building(bd, i)
    kinds[k] = kinds.get(k, 0) + 1
print('  archetypes:', kinds)

# Shop fascias, 1993: fictional local businesses (kiosk, florist, video rental...).
BRANDS = [
    ('Gårdens Blommor', 'Pacifico', '#ffffff', '#2f5b33', 0),
    ('Skomakeri', 'Barlow Condensed', '#1c1c1c', '#e8e2cf', 0),
    ('Pizzeria Napoli', 'Archivo Black', '#ffffff', '#a3201a', 1),
    ('Konditori Gården', 'Pacifico', '#5b2b16', '#f1e6cc', 0),
    ('Torgets Livs', 'Jost', '#ffffff', '#b8261f', 1),
    ('Video 2000', 'Archivo Black', '#ffe14a', '#18225e', 1),
    ('Kemtvätt', 'Jost', '#ffffff', '#2c6c96', 0),
    ('Herrfrisör', 'Barlow Condensed', '#ffffff', '#222222', 0),
    ('Hässelby Foto', 'Jost', '#ffffff', '#c35a12', 1),
    ('Optik', 'Inter', '#ffffff', '#1c3f6e', 1),
    ('Tobak & Press', 'Barlow Condensed', '#ffffff', '#1d5d3a', 1),
    ('Apotek', 'Inter', '#ffffff', '#1b6b46', 1),
    ('Järn & Färg', 'Barlow Condensed', '#ffffff', '#3b3b3b', 0),
    ('Leksaker', 'Archivo Black', '#ffffff', '#cc3a1e', 1),
    ('Västerbanken', 'Inter', '#ffffff', '#0d3a66', 1),
    ('Café Ankaret', 'Pacifico', '#ffffff', '#3d2a1e', 0),
    ('Damfrisering Lena', 'Pacifico', '#7b1d3e', '#f2dfe4', 0),
]
brand_rng = random.Random(1993)
brands = BRANDS[:]
brand_rng.shuffle(brands)
nsign = 0
for (a, u, ln, zb, z0, bd) in SHOP_WALLS:
    out = (u[1], -u[0])
    nper = 1 if ln < 16 else 2
    for k in range(nper):
        if nsign >= len(brands):
            break
        text, font, col, bg, lit = brands[nsign % len(brands)]
        w_ = min(ln / nper - 1.2, 2.2 + 0.32 * len(text))
        if w_ < 1.5:
            continue
        uc = ln * (k + 0.5) / nper
        zc = z0 + 3.575
        pos = (a[0] + u[0] * uc + out[0] * 0.03, a[1] + u[1] * uc + out[1] * 0.03, zc)
        add_sign(f'sign_shop_{nsign:02d}', f'Shop sign {text}', pos, out, text, (w_, 0.7 if lit else 0.62),
                 font=font, color=col, background=bg, backlit=lit, depth=0.14 if lit else 0,
                 uppercase=font not in ('Pacifico',), textHeight=0.6 if font != 'Pacifico' else 0.78)
        nsign += 1
KIOSKS = [('Torgkiosken', '#f4d13a', '#7a1c14'), ('Korv & Glass', '#ffffff', '#1f4f8a'), ('Pressboden', '#ffffff', '#b3261e')]
done_k = {}
for (a, u, ln, z0, bid) in KIOSK_WALLS:
    k = done_k.setdefault(bid, len(done_k))
    text, col, bg = KIOSKS[k % len(KIOSKS)]
    out = (u[1], -u[0])
    pos = (a[0] + u[0] * ln / 2 + out[0] * 0.03, a[1] + u[1] * ln / 2 + out[1] * 0.03, z0 + 2.525)
    add_sign(f'sign_kiosk_{nsign:02d}', f'Kiosk sign {text}', pos, out, text, (min(ln - 0.3, 3.4), 0.38),
             font='Barlow Condensed', color=col, background=bg, backlit=1, depth=0.1)
    nsign += 1
print(f'  {nsign} shop signs')


# =============================================================== street lighting
# 1993: sodium mast lamps along the streets (orange), mercury opal-globe lamps on
# the footpaths (bluish white). OSM lamp positions are kept; the rest are spaced
# along the centrelines.
print('Lighting the streets...')


def sphere(b, c, r, mat, rings=6, seg=12):
    pts = [[(c[0] + r * math.sin(math.pi * i / rings) * math.cos(2 * math.pi * k / seg),
             c[1] + r * math.sin(math.pi * i / rings) * math.sin(2 * math.pi * k / seg),
             c[2] - r * math.cos(math.pi * i / rings)) for k in range(seg)] for i in range(rings + 1)]
    for i in range(rings):
        for k in range(seg):
            k2 = (k + 1) % seg
            q = [pts[i][k], pts[i][k2], pts[i + 1][k2], pts[i + 1][k]]
            if i == 0:
                b.face([q[0], q[2], q[3]], mat, smooth=True)
            elif i == rings - 1:
                b.face([q[0], q[1], q[2]], mat, smooth=True)
            else:
                b.face(q, mat, smooth=True)


LAMP_H = 8.6
ARM = 1.7
b = MeshBuilder('lamp_street')            # arm points +y (north) in local space
b.tube((0, 0, 0), (0, 0, LAMP_H), 0.095, 0.055, 'metal_galvanized', sides=10)
b.tube((0, 0, LAMP_H - 0.45), (0, ARM * 0.55, LAMP_H + 0.05), 0.035, 0.035, 'metal_galvanized', sides=6)
b.tube((0, ARM * 0.55, LAMP_H + 0.05), (0, ARM, LAMP_H + 0.1), 0.035, 0.035, 'metal_galvanized', sides=6)
b.box(-0.17, 0.17, ARM - 0.12, ARM + 0.62, LAMP_H + 0.02, LAMP_H + 0.17, 'metal_dark')
b.quad((-0.15, ARM + 0.6, LAMP_H + 0.015), (0.15, ARM + 0.6, LAMP_H + 0.015), (0.15, ARM - 0.1, LAMP_H + 0.015), (-0.15, ARM - 0.1, LAMP_H + 0.015), 'lamp_sodium')
build(b)
b = MeshBuilder('lamp_path')
b.tube((0, 0, 0), (0, 0, 3.7), 0.055, 0.04, 'metal_green', sides=8)
b.tube((0, 0, 3.7), (0, 0, 3.85), 0.07, 0.09, 'metal_green', sides=8)
sphere(b, (0, 0, 4.07), 0.23, 'lamp_globe')
build(b)

lamps_street, lamps_path = [], []
osm_lamps = [p for p in L['lamps'] if X0 < p[0] < X1 and Y0 < p[1] < Y1]


def lamp_spot_ok(x, y):
    if not (X0 + 2 < x < X1 - 2 and Y0 + 2 < y < Y1 - 2):
        return False
    if HS.sample(g, d_bldg, x, y) < 1.5 or float(HS.sample(_gr, _d_rail, x, y)) < 5:
        return False
    if -125 < x < 95 and -50 < y < 62 and HS.sample(gv, d_deck, x, y) < 1.0:
        return False
    return True


def near_any(lst, x, y, r):
    return any((p[0] - x) ** 2 + (p[1] - y) ** 2 < r * r for p in lst)


for pts, m in roads:
    if m['kind'] == 'service':
        continue
    off = m['width'] / 2 + 0.9
    for (p, t) in resample(pts, 30.0):
        n = (-t[1], t[0])
        x, y = p[0] + n[0] * off, p[1] + n[1] * off
        # stay out of junctions (another carriageway nearby) and keep clear of OSM lamps
        if HS.sample(g, d_road, x, y) < 0.3 or not lamp_spot_ok(x, y):
            continue
        if near_any(lamps_street, x, y, 18) or near_any(osm_lamps, x, y, 14):
            continue
        lamps_street.append((x, y, math.degrees(math.atan2(-n[0], -n[1]))))
for (x, y) in osm_lamps:
    # OSM lamps: arm towards the nearest carriageway, globe lamps when far from roads
    dr = HS.sample(g, d_road, x, y)
    if dr < 6.0:
        eps = 0.5
        gx = (HS.sample(g, d_road, x + eps, y) - HS.sample(g, d_road, x - eps, y)) / (2 * eps)
        gy = (HS.sample(g, d_road, x, y + eps) - HS.sample(g, d_road, x, y - eps)) / (2 * eps)
        lamps_street.append((x, y, math.degrees(math.atan2(-gx, -gy))))
    else:
        lamps_path.append((x, y))
for pts, m in paths:
    for (p, t) in resample(pts, 24.0):
        n = (-t[1], t[0])
        x, y = p[0] + n[0] * (m['width'] / 2 + 0.6), p[1] + n[1] * (m['width'] / 2 + 0.6)
        if not lamp_spot_ok(x, y) or HS.sample(g, d_road, x, y) < 4.0:
            continue
        if near_any(lamps_path, x, y, 16) or near_any([(a, b_) for a, b_, _ in lamps_street], x, y, 12):
            continue
        lamps_path.append((x, y))

objects.append({'id': 'lamps_street', 'name': 'Street lamps (sodium)', 'type': 'instances', 'semantic': 'streetlight',
                'asset': f'{ASSET_REL}/lamp_street.glb', 'castShadow': True, 'transform': {'position': [0, 0, 0]},
                'instances': [[*to_engine((x, y, H(x, y) - 0.05)), round(h, 1), 1.0] for (x, y, h) in lamps_street]})
objects.append({'id': 'lamps_path', 'name': 'Path lamps (mercury globes)', 'type': 'instances', 'semantic': 'streetlight',
                'asset': f'{ASSET_REL}/lamp_path.glb', 'castShadow': True, 'transform': {'position': [0, 0, 0]},
                'instances': [[*to_engine((x, y, H(x, y) - 0.05)), 0.0, 1.0] for (x, y) in lamps_path]})


def light(obj_id, pos, intensity, rng_, color, kind='spot', outer=60, inner=30, fog=1.0, radius=0.15):
    objects.append({'id': obj_id, 'type': 'light', 'semantic': 'light', 'transform': {'position': to_engine(pos), 'rotation': [0, 0, 0, 1]},
                    'light': {'kind': kind, 'color': list(color), 'intensity': intensity, 'range': rng_, 'outerAngle': outer,
                              'innerAngle': inner, 'sourceRadius': radius, 'fogScatter': fog}})


SODIUM, MERCURY, FLUO = (1.0, 0.6, 0.28), (0.8, 0.9, 1.0), (0.9, 0.96, 1.0)
for i, (x, y, h) in enumerate(lamps_street):
    hx, hy = x + math.sin(math.radians(h)) * (ARM + 0.25), y + math.cos(math.radians(h)) * (ARM + 0.25)
    light(f'lamp_street_{i}', (hx, hy, H(x, y) + LAMP_H - 0.05), 2600, 24, SODIUM, outer=64, inner=34)
for i, (x, y) in enumerate(lamps_path):
    light(f'lamp_path_{i}', (x, y, H(x, y) + 4.05), 260, 12, MERCURY, kind='point', fog=0.6, radius=0.23)
for i, (x, y, z) in enumerate(CANOPY_LIGHTS[::2]):
    light(f'platform_light_{i}', (x, y, z), 700, 11, FLUO, outer=80, inner=55, fog=0.4)
for i, (x, y, z) in enumerate(STATION_LIGHTS[::2]):
    light(f'entrance_light_{i}', (x, y, z), 600, 10, FLUO, outer=80, inner=55, fog=0.4)
print(f'  {len(lamps_street)} street lamps, {len(lamps_path)} path lamps')


# =============================================================== parked cars
# Fictional lookalikes of the cars on a Stockholm street in 1993 (tools/blender/cars.py):
# 240/740-style Volvos dominate, then 900-style Saabs and small hatches.
print('Parking cars...')
import cars as CARS  # noqa: E402
from mathutils import Matrix  # noqa: E402

for cname, spec in CARS.SPECS.items():
    b = MeshBuilder(f'car_{cname}')
    CARS.build_car(b, spec)
    bmesh.ops.translate(b.bm, vec=(-spec['L'] / 2, 0, 0), verts=b.bm.verts)
    bmesh.ops.rotate(b.bm, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, 'Z'), verts=b.bm.verts)   # front -> +y
    build(b, None)

MIX = [('volta244', 0.26), ('volta245', 0.2), ('volta744', 0.16), ('saga900', 0.16), ('gulf', 0.22)]
COLOURS = [('red', 0.16), ('darkblue', 0.14), ('white', 0.14), ('silver', 0.14), ('beige', 0.08), ('green', 0.08),
           ('black', 0.07), ('brown', 0.06), ('lightblue', 0.07), ('yellow', 0.06)]
rng_c = random.Random(240)


def pick(table):
    r = rng_c.random()
    for k, p in table:
        if r < p:
            return k
        r -= p
    return table[-1][0]


parked = []   # (model, colour, x, y, heading)


def car_spot_free(x, y, heading, L_=4.8):
    hx, hy = math.sin(math.radians(heading)), math.cos(math.radians(heading))
    for t_ in (-L_ / 2, 0, L_ / 2):
        px, py = x + hx * t_, y + hy * t_
        if not (X0 + 2 < px < X1 - 2 and Y0 + 2 < py < Y1 - 2) or HS.sample(g, d_bldg, px, py) < 0.6:
            return False
        if -125 < px < 95 and -50 < py < 62 and HS.sample(gv, d_deck, px, py) < 0.5 and HS.sample(gv, S_END, px, py) < 0:
            # under the deck is fine (parking under the viaduct), but not inside bents
            if any((c.x - px) ** 2 + (c.y - py) ** 2 < 2.2 ** 2 for bent in BENTS for (c, _t) in bent):
                return False
    return all((x - p[2]) ** 2 + (y - p[3]) ** 2 > 2.6 ** 2 for p in parked)


# parking areas: stall rows along the longest edge
for ring in L['parking']:
    if len(ring) < 3 or abs(HL.area2(ring)) < 60:
        continue
    cx = sum(p[0] for p in ring) / len(ring)
    cy = sum(p[1] for p in ring) / len(ring)
    if not (X0 < cx < X1 and Y0 < cy < Y1):
        continue
    e = max(((ring[i], ring[(i + 1) % len(ring)]) for i in range(len(ring))), key=lambda ab: math.dist(*ab))
    u = Vector((e[1][0] - e[0][0], e[1][1] - e[0][1])).normalized()
    v = Vector((-u.y, u.x))
    us = [Vector(p).dot(u) for p in ring]
    vs = [Vector(p).dot(v) for p in ring]
    period = 16.0                                  # stall row 5 m + aisle 6 m + stall row 5 m
    for vv in np.arange(min(vs) + 2.6, max(vs) - 2.4, 0.5):
        phase = (vv - min(vs)) % period
        if not (abs(phase - 2.6) < 0.25 or abs(phase - 13.4) < 0.25):
            continue
        facing = -1 if phase < 8 else 1
        for uu in np.arange(min(us) + 1.4, max(us) - 1.2, 2.55):
            p = u * uu + v * vv
            corners = [p + u * a_ + v * c_ for a_ in (-1.1, 1.1) for c_ in (-2.3, 2.3)]
            if not all(HL.poly_contains(ring, q.x, q.y) for q in corners):
                continue
            if rng_c.random() > 0.62:
                continue
            hv = v * facing
            heading = math.degrees(math.atan2(hv.x, hv.y)) + rng_c.uniform(-3, 3)
            if car_spot_free(p.x, p.y, heading):
                parked.append((pick(MIX), pick(COLOURS), p.x, p.y, heading))
# kerbside parking on residential streets
for pts, m in roads:
    if m['kind'] not in ('residential', 'living_street', 'unclassified') or m['width'] < 6.5:
        continue
    for (p, t) in resample(pts, 6.2):
        n = (-t[1], t[0])
        x, y = p[0] + n[0] * (m['width'] / 2 - 1.05), p[1] + n[1] * (m['width'] / 2 - 1.05)
        # not in junctions or at crossings
        if HS.sample(g, d_road, x + n[0] * 2.5, y + n[1] * 2.5) < 0.0:
            continue
        if any(math.dist((x, y), c) < 8 for c in L['crossings']) or any(math.dist((x, y), s_[0]) < 15 for s_ in L['bus_stops']):
            continue
        if rng_c.random() > 0.3:
            continue
        heading = math.degrees(math.atan2(t[0], t[1]))
        if car_spot_free(x, y, heading):
            parked.append((pick(MIX), pick(COLOURS), x, y, heading))

groups = {}
for (mdl, col, x, y, h) in parked:
    groups.setdefault((mdl, col), []).append((x, y, h))
for (mdl, col), lst in sorted(groups.items()):
    objects.append({
        'id': f'cars_{mdl}_{col}', 'name': f'Parked cars ({mdl}, {col})', 'type': 'instances', 'semantic': 'vehicle',
        'asset': f'{ASSET_REL}/car_{mdl}.glb', 'castShadow': True, 'transform': {'position': [0, 0, 0]},
        'materialOverrides': {'car_paint': f'car_paint_{col}'},
        'instances': [[*to_engine((x, y, H(x, y) + 0.0)), round(h, 1), 1.0] for (x, y, h) in lst],
    })
# Swedish plates of the period: white, black characters, three letters + three digits
PL = 'ABCDEFGHJKLMNOPRSTUWXZ'
for i, (mdl, col, x, y, h) in enumerate(parked):
    spec = CARS.SPECS[mdl]
    text = ''.join(rng_c.choice(PL) for _ in range(3)) + ' ' + ''.join(rng_c.choice('0123456789') for _ in range(3))
    hx, hy = math.sin(math.radians(h)), math.cos(math.radians(h))
    for k, (pp, fwd) in enumerate(zip(CARS.plate_positions(spec), (1, -1))):
        along_ = pp[0] - spec['L'] / 2
        pos = (x + hx * along_, y + hy * along_, H(x, y) + pp[2])
        add_sign(f'plate_{i:03d}_{k}', 'Licence plate', pos, (hx * fwd, hy * fwd), text, (0.48, 0.11),
                 font='Barlow Condensed', weight=600, color='#111111', background='#f2f1ea', border='#111111',
                 textHeight=0.72, letterSpacing=0.04)
print(f'  {len(parked)} cars in {len(groups)} groups')


# =============================================================== vegetation
# November 1993: bare birches in groups on the lawns, pines on the rocky east hill
# and along the rock cut, scattered spruces, shrubs along building bases. No OSM
# trees exist here, so placement is rule-based (free lawn, clearances, clumping).
print('Planting...')
TREE_ASSET = 'assets/testmap/{}.model.json'
rng_v = random.Random(77)


def clear_of_hard(x, y, k=1.0):
    if not (X0 + 2 < x < X1 - 2 and Y0 + 2 < y < Y1 - 2):
        return False
    for f_, c_ in ((d_road, 2.6), (d_park, 2.0), (d_walk, 1.6), (d_path, 1.0)):
        if HS.sample(g, f_, x, y) < c_ * k:
            return False
    if float(HS.sample(_gr, _d_rail, x, y)) < 6.5:
        return False
    if -125 < x < 95 and -50 < y < 62 and HS.sample(gv, d_deck, x, y) < 3.5:
        return False
    return True


class Scatter:
    """Dart-throwing Poisson disc with per-sample radius (spatial hash)."""
    def __init__(self, cell=2.0):
        self.cell, self.grid = cell, {}

    def ok(self, x, y, r):
        c = self.cell
        ix, iy = int(math.floor(x / c)), int(math.floor(y / c))
        n = int(math.ceil(8.0 / c))
        for j in range(iy - n, iy + n + 1):
            for i in range(ix - n, ix + n + 1):
                for (px, py, pr) in self.grid.get((i, j), ()):
                    if (px - x) ** 2 + (py - y) ** 2 < max(r, pr) ** 2:
                        return False
        return True

    def add(self, x, y, r):
        self.grid.setdefault((int(math.floor(x / self.cell)), int(math.floor(y / self.cell))), []).append((x, y, r))


sc = Scatter()
plants = {}   # asset name -> [(x, y, z, yaw, scale)]
for (x, y, _h) in lamps_street:
    sc.add(x, y, 2.5)
for (x, y) in lamps_path:
    sc.add(x, y, 2.0)


def plant(name, x, y, scale, r):
    sc.add(x, y, r)
    z = H(x, y) - 0.06
    plants.setdefault(name, []).append((x, y, z, rng_v.uniform(0, 360), scale))


def clump(x, y):
    """Clumping density 0..1 (groves vs open lawn)."""
    n = noise.noise(Vector((x * 0.022, y * 0.022, 7.0))) + 0.5 * noise.noise(Vector((x * 0.06, y * 0.06, 9.0)))
    return smoothstep(-0.25, 0.55, n)


for _ in range(26000):
    x, y = rng_v.uniform(X0, X1), rng_v.uniform(Y0, Y1)
    db = HS.sample(g, d_bldg, x, y)
    if db < 3.5 or not clear_of_hard(x, y):
        continue
    hill = H0(x, y) > 4.5 and x > 55       # rocky hill east of the station
    edge = min(x - X0, X1 - x, y - Y0, Y1 - y) < 25
    dens = clump(x, y) * (1.0 if not hill else 1.6) + (0.35 if edge else 0.0)
    if rng_v.random() > dens * 0.55:
        continue
    r = rng_v.random()
    if hill or (is_cut(x, y + 6) or is_cut(x, y - 6)):
        sp = 'tree_pine_a' if r < 0.38 else 'tree_pine_b' if r < 0.76 else 'tree_spruce_a' if r < 0.84 else 'tree_birch_a'
    else:
        sp = 'tree_birch_a' if r < 0.32 else 'tree_birch_b' if r < 0.62 else 'tree_pine_a' if r < 0.74 else \
            'tree_pine_b' if r < 0.84 else 'tree_spruce_b' if r < 0.9 else 'shrub_a'
    birch = 'birch' in sp
    rad = 3.2 if birch else 5.0 if 'pine' in sp else 4.2 if 'spruce' in sp else 2.2
    if 'shrub' not in sp and db < 5.0:
        continue
    if not sc.ok(x, y, rad):
        continue
    s_ = rng_v.uniform(0.8, 1.15) if birch else rng_v.uniform(0.85, 1.25)
    plant(sp, x, y, round(s_, 3), rad)

# Shrubs along building bases (foundation planting) and path edges.
for bd in L['buildings']:
    ring = bd['ring']
    if bd['area'] < 60:
        continue
    for (a, u, ln, _us) in edges_of(ring):
        out = (u[1], -u[0])
        for t_ in np.arange(1.5, ln - 1.0, 3.2):
            if rng_v.random() > 0.35:
                continue
            x, y = a[0] + u[0] * t_ + out[0] * 1.7, a[1] + u[1] * t_ + out[1] * 1.7
            if not clear_of_hard(x, y, 0.5) or not sc.ok(x, y, 1.6):
                continue
            plant('shrub_a' if rng_v.random() < 0.5 else 'shrub_b', x, y, round(rng_v.uniform(0.6, 1.0), 3), 1.6)

ntrees = 0
for name, lst in sorted(plants.items()):
    objects.append({
        'id': f'veg_{name}', 'name': f'Vegetation ({name})', 'type': 'instances', 'semantic': 'vegetation',
        'asset': TREE_ASSET.format(name), 'castShadow': True,
        'transform': {'position': [0, 0, 0]},
        'instances': [[*to_engine((x, y, z)), round(yaw, 1), s_] for (x, y, z, yaw, s_) in lst],
    })
    ntrees += len(lst)
print('  ' + ', '.join(f'{k} {len(v)}' for k, v in sorted(plants.items())) + f'  (total {ntrees})')


# =============================================================== document
def write_doc():
    gz = lambda x, y: H(x, y) + 0.12
    VIEWS = [
        ('Station entrance', (-27, -14, gz(-27, -14)), 5, 10),
        ('Forecourt shops', (-52, -44, gz(-52, -44)), 28, 6),
        ('Astrakangatan under the bridge', (32, -62, gz(32, -62)), -10, 6),
        ('Courtyard, Hässelby torg 14-22', (-36, 126, gz(-36, 126)), 120, 4),
        ('Platform', (-34, 3.0, PLAT_Z), 68, 0),
        ('Rock cut', (130, 50.5, BED_Z + 0.4), -100, 2),
        ('Overview', (-120, -120, 60), 45, -24),
    ]
    for i, (name, p, yaw, pitch) in enumerate(VIEWS):
        objects.append({'id': f'view_{i}', 'name': name, 'type': 'marker', 'semantic': 'viewpoint', 'transform': {'position': to_engine(p)}, 'yaw': yaw, 'pitch': pitch})
    # Lighting volumes: ambient-cube probes for trees, cars and props; box-projected
    # reflection probes where the glazing and wet ground need local reflections.
    zc = 22.0
    objects.append({'id': 'probes_main', 'name': 'Main probe volume', 'type': 'probeVolume', 'semantic': 'lighting',
                    'transform': {'position': to_engine(((X0 + X1) / 2, (Y0 + Y1) / 2, zc - 2))},
                    'volume': {'size': [X1 - X0, 44.0, Y1 - Y0], 'spacing': [6.0, 4.0, 6.0]}})

    def rprobe(pid, name, p, bmin, bmax, blend, prio):
        lo = to_engine(bmin)
        hi = to_engine(bmax)
        objects.append({'id': pid, 'name': name, 'type': 'reflectionProbe', 'semantic': 'lighting',
                        'transform': {'position': to_engine(p)},
                        'probe': {'boxMin': [min(lo[i], hi[i]) for i in range(3)], 'boxMax': [max(lo[i], hi[i]) for i in range(3)],
                                  'blend': blend, 'priority': prio}})
    rprobe('rp_forecourt', 'Station forecourt (under the deck)', (-30, -12, 1.8), (-60, -30, -0.5), (0, 5, SOFFIT_Z), 2.0, 2)
    rprobe('rp_platform', 'Platform', (-10, 9, PLAT_Z + 1.7), (-55, -8, PLAT_Z - 0.5), (80, 40, PLAT_Z + 4.5), 2.0, 2)
    rprobe('rp_astrakan', 'Astrakangatan', (32, -45, 1.8), (18, -150, -0.5), (46, 60, 14), 4.0, 1)
    rprobe('rp_shops', 'Shop row, forecourt', (-60, -40, 1.8), (-100, -60, -0.5), (-20, -18, 12), 3.0, 1)
    rprobe('rp_courtyard', 'Courtyard, Hässelby torg 14-22', (-35, 118, 1.8), (-60, 95, -0.5), (-8, 140, 12), 3.0, 1)
    rprobe('rp_centre', 'Centre (default)', (-40, 40, 2.0), (-170, -150, -1.0), (170, 215, 40), 8.0, 0)
    doc = {
        'format': 'rill.map', 'version': 1, 'name': 'hasselby',
        'description': 'Hässelby torg, November 1993 (vertical slice). Layout © OpenStreetMap contributors (ODbL). Generated by tools/blender/build_hasselby.py.',
        'environment': {'preset': 'overcast'},
        'spawn': {'position': to_engine((-62, -30, H(-62, -30) + 0.12)), 'yaw': 30, 'pitch': 0},
        'objects': objects,
    }
    if os.path.exists(os.path.join(os.path.dirname(MAP_PATH), 'lightmaps', 'lightmapset.json')):
        doc['lightmaps'] = 'lightmaps/lightmapset.json'
    os.makedirs(os.path.dirname(MAP_PATH), exist_ok=True)
    with open(MAP_PATH, 'w') as f:
        json.dump(doc, f, indent=1)
    print(f'Wrote {MAP_PATH}: {len(objects)} objects')


write_doc()
