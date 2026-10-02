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
from mathutils import Matrix, Vector, noise

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


def tessellate_ngons(bm):
    """Triangulates n-gons of a height-field surface in plan (XY): dissolved street
    n-gons are large and slightly curved, and filling them in their best-fit plane
    folds them (lost coverage = holes); in plan they are always simple."""
    from mathutils.geometry import tessellate_polygon
    for f in [f for f in bm.faces if len(f.verts) > 4]:
        verts = list(f.verts)
        mi, sm = f.material_index, f.smooth
        if abs(f.normal.z) < 0.5:
            continue                                  # vertical faces (kerb edges) stay as they are
        tris = tessellate_polygon([[Vector((v.co.x, v.co.y, 0.0)) for v in verts]])
        if os.environ.get('RILL_TESS_DEBUG'):
            P = [(v.co.x, v.co.y) for v in verts]
            a_f = abs(sum(P[i - 1][0] * P[i][1] - P[i][0] * P[i - 1][1] for i in range(len(P)))) / 2
            a_t = sum(abs((P[j][0] - P[i][0]) * (P[k][1] - P[i][1]) - (P[k][0] - P[i][0]) * (P[j][1] - P[i][1])) / 2 for (i, j, k) in tris)
            if abs(a_f - a_t) > 0.01:
                keys = [(round(x, 4), round(y, 4)) for (x, y) in P]
                print(f'    TESS face {len(P)} verts area {a_f:.3f} tris {a_t:.3f} dup-pos {len(keys) - len(set(keys))} ntris {len(tris)}')
        nrm = f.normal.copy()
        bm.faces.remove(f)
        for (i, j, k) in tris:
            tri = [verts[i], verts[j], verts[k]]
            try:
                nf = bm.faces.new(tri)
            except ValueError:
                continue
            nf.normal_update()
            if nf.normal.dot(nrm) < 0:
                nf.normal_flip()
            nf.material_index, nf.smooth = mi, sm


def _up_area(bm):
    """Plan (XY) area of the upward faces: exact for height-field surfaces."""
    tot = 0.0
    for f in bm.faces:
        if f.normal.z > 0.5:
            p = [v.co for v in f.verts]
            tot += abs(sum(p[i - 1].x * p[i].y - p[i].x * p[i - 1].y for i in range(len(p)))) / 2
    return tot


def build(builder, lightmap_tpm=None, vertex_color=None, color_max_edge=None, dissolve=False, seam_grid=None):
    if dissolve:
        bm = builder.bm
        bm.normal_update()
        a_before = _up_area(bm)
        dbg = builder.name == os.environ.get('RILL_DISSOLVE_DEBUG')
        step = lambda nm: dbg and (bm.normal_update() or print(f'    {nm}: {_up_area(bm):.2f} m2, {len(bm.faces)} faces'))
        step('start')
        bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=0.0005)
        step('remove_doubles')
        bmesh.ops.dissolve_degenerate(bm, dist=0.002, edges=bm.edges[:])
        step('dissolve_degenerate')
        delimit = {'MATERIAL'}
        if seam_grid:
            # Seam lines on a coarse grid bound the planar merge: dissolved faces stay
            # within one cell and cannot wrap around islands or cut-outs.
            gx0, gy0, cell = seam_grid
            on = lambda c, o: abs((c - o) / cell - round((c - o) / cell)) < 1e-4
            for e in bm.edges:
                a_, b_ = e.verts[0].co, e.verts[1].co
                if (on(a_.x, gx0) and on(b_.x, gx0) and abs(a_.x - b_.x) < 1e-4) or (on(a_.y, gy0) and on(b_.y, gy0) and abs(a_.y - b_.y) < 1e-4):
                    e.seam = True
            delimit = {'MATERIAL', 'SEAM'}
        bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(0.6), verts=bm.verts[:], edges=bm.edges[:], delimit=delimit)
        step('dissolve_limit')
        bmesh.ops.dissolve_degenerate(bm, dist=0.002, edges=bm.edges[:])
        step('dissolve_degenerate 2')
        # Dissolved n-gons are large, concave and slightly curved: fill them in plan.
        bm.normal_update()
        tessellate_ngons(bm)
        step('tessellate_ngons')
        bmesh.ops.triangulate(bm, faces=bm.faces[:], quad_method='BEAUTY', ngon_method='BEAUTY')
        step('triangulate')
        # bmesh ops leave element tags set; MeshBuilder reads face tags as "explicit UVs".
        for f in bm.faces:
            f.tag = False
        bm.normal_update()
        lost = a_before - _up_area(bm)
        if abs(lost) > 0.05:
            print(f'  WARNING {builder.name}: dissolve changed walkable area by {lost:.2f} m2')
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
    # the shop street from the station entrance north to Hässelby torg, and the square itself
    # (Resenärer stands on it); buildings are carved out of every surface anyway
    [(-70, -34), (-44, -34), (-46, -27), (-81, 68), (-60, 80), (-58, 92), (-100, 99), (-108, 80), (-98, 62), (-90, 40), (-84, 20)],
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
    polys, segs = HS.march(g, f, split=10)
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
        res = build(b, TPM_STREET, dissolve=True, seam_grid=(g.x0, g.y0, g.res * 10))
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


def face_with_holes(b, outer, holes, z, mat, up=True):
    """Horizontal face with holes (triangulated in plan)."""
    from mathutils.geometry import tessellate_polygon
    loops = [[Vector((p[0], p[1], 0.0)) for p in outer]] + [[Vector((p[0], p[1], 0.0)) for p in h] for h in holes]
    flat = [p for lp in loops for p in lp]
    for (i, j, k) in tessellate_polygon(loops):
        tri = [flat[i], flat[j], flat[k]]
        n = (tri[1] - tri[0]).cross(tri[2] - tri[0])
        if abs(n.z) < 1e-10:
            continue
        if (n.z > 0) != up:
            tri = tri[::-1]
        b.face([(q.x, q.y, z) for q in tri], mat)


def split_loops(loops):
    """[(outer, [holes])]: contour loops are CCW outers / CW holes."""
    outers = [l_ for l_ in loops if HL.area2(l_) > 0]
    holes = [l_ for l_ in loops if HL.area2(l_) < 0]
    return [(o_, [h for h in holes if HL.poly_contains(o_, *h[0])]) for o_ in outers]


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
# ---- station layout (before the deck and platform: the stairwell cuts through both).
# The ticket hall fills the south wing of the centre building (OSM 259713115) under the
# platform's west end, its glazed front facing the shop street (OSM entrance at (-54, -5));
# a switchback stair rises through the deck and platform into a stair house on the platform.
CENTRE_ID = 259713115
_cr = next(bd for bd in L['buildings'] if bd['id'] == CENTRE_ID)['ring']
_near = lambda q: Vector(min(_cr, key=lambda p: math.dist(p, q)))
WO, WN = _near((-46, -27)), _near((-81, 68))
ES, EN = _near((-28, -21)), _near((-42, 10))
WA = (WN - WO).normalized()                 # along the wing, northwards (west face direction)
WB = Vector((WA.y, -WA.x))                  # across the wing, eastwards into the building
HP = lambda s_, b_: WO + WA * s_ + WB * b_   # hall frame (s along, b across) -> plan
HS0, HS1 = 13.0, 35.0


def east_b(s_):
    """Across-distance of the wing's east face at s."""
    p0, e = WO + WA * s_, EN - ES
    det = -WB.x * e.y + e.x * WB.y
    r = ES - p0
    return (-r.x * e.y + e.x * r.y) / det


HALL_RING = [tuple(HP(HS0, 0.0)), tuple(HP(HS0, east_b(HS0))), tuple(HP(HS1, east_b(HS1))), tuple(HP(HS1, 0.0))]
if HL.area2(HALL_RING) < 0:
    HALL_RING = HALL_RING[::-1]
Z_HALL = max(H(x, y) for (x, y) in HALL_RING) + 0.12
CEIL_H = 3.4
Z_ROOF = Z_HALL + 4.5
# switchback: flight A rises east from the hall, flight B returns west to the platform
FW, CWT, WT, TREAD = 2.0, 0.25, 0.2, 0.29
B_FOOT = 6.5
NR = int(round((PLAT_Z - Z_HALL) / 0.17))
RR = (PLAT_Z - Z_HALL) / NR
NA = (NR + 1) // 2
NB = NR - NA
Z_LAND = Z_HALL + NA * RR
B_LAND0 = B_FOOT + (NA - 1) * TREAD
B_LAND1 = B_LAND0 + 1.6
B_TOP = B_LAND0 - (NB - 1) * TREAD
_mids, _spans = [], []
for _b in np.arange(B_FOOT - 1.0, B_LAND1 + 1.0, 0.5):
    _ss = [s_ for s_ in np.arange(0.0, 50.0, 0.1) if HS.sample(gv, d_pl, *HP(s_, _b)) < -0.2]
    if _ss:
        _mids.append((min(_ss) + max(_ss)) / 2)
        _spans.append((min(_ss), max(_ss)))
S_MID = sum(_mids) / len(_mids)
SA0 = S_MID - (2 * FW + CWT) / 2
SA1 = SA0 + FW
SB0 = SA1 + CWT
SB1 = SB0 + FW
CORE = [tuple(HP(SA0 - WT, B_FOOT - WT)), tuple(HP(SB1 + WT, B_FOOT - WT)), tuple(HP(SB1 + WT, B_LAND1 + WT)), tuple(HP(SA0 - WT, B_LAND1 + WT))]
if HL.area2(CORE) < 0:
    CORE = CORE[::-1]
_pass = min(min(SA0 - WT - lo, hi - SB1 - WT) for (lo, hi) in _spans)
print(f'  station: floor {Z_HALL:.2f}, {NR} risers of {RR * 1000:.0f} mm, platform passages >= {_pass:.2f} m')
d_open = HS.polygon_field(gv, [CORE])
D_PL_FULL = d_pl.copy()
d_pl = np.maximum(d_pl, -d_open)                                    # stairwell through the platform

DECK_HALF = 2.3
d_deck = np.minimum(np.minimum(d_cl[0], d_cl[1]) - DECK_HALF, D_PL_FULL - 0.1)
d_deck = np.maximum(d_deck, S_END + 0.5)                           # deck ends rest on the abutments
d_deck = np.maximum(d_deck, -d_open)                                # ... and the stairwell
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
for loop, holes in split_loops(deck_loops):
    n_ = len(loop)
    ends = [on_end(loop[i]) and on_end(loop[(i + 1) % n_]) for i in range(n_)]
    beam, upst, mid = HS.offset_loop(loop, 0.45), HS.offset_loop(loop, 0.22), HS.offset_loop(loop, 0.11)
    face_with_holes(b, loop, holes, DECK_Z, 'concrete_viaduct')
    face_with_holes(b, beam, holes, SOFFIT_Z + 0.35, 'concrete_viaduct', up=False)
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
    _core_pad = HS.sample(gv, d_open, ((pn + ps) / 2).x, ((pn + ps) / 2).y)
    def _in_hall_way(c):
        p_ = c - WO
        s_, b_ = p_.dot(WA), p_.dot(WB)
        if not (HS0 - 1.0 < s_ < HS1 + 1.0 and -3.0 < b_ < 18.0):
            return False
        return abs(b_ - 3.7) < 2.0 or b_ < 1.0 or (SA0 - 1.5 < s_ < SB1 + 1.5 and b_ < B_LAND1 + 1.5)
    cols = [(c, t) for (c, t) in cols if not _in_hall_way(c)] if any(_in_hall_way(c) for c, _t in cols) else cols
    if len(cols) < 2:
        continue
    if any(HS.sample(gv, d_open, c.x, c.y) < 1.0 for c, _t in cols) or \
            min(HS.sample(gv, d_open, *(ps + (pn - ps) * f_)) for f_ in np.linspace(0, 1, 30)) < 1.2:
        continue                                                     # keep the stair core clear
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
for loop, holes in split_loops(HS.contour_loops(gv, d_pl)):
    n_ = len(loop)
    band, over = HS.offset_loop(loop, 0.5), HS.offset_loop(loop, 0.35)
    face_with_holes(b, band, holes, PLAT_Z, 'paving_slabs')
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
d_can = np.maximum.reduce([D_PL_FULL + 0.25, CAN_A0 - A_GRID, A_GRID - CAN_A1])
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


# ---- Hässelby gård station as in 1993: ticket hall in the centre building's south wing
# (glazed front to the shop street), barrier line with the ticket booth and tripod
# turnstiles, a switchback stair to a stair house on the platform.
print('Building the station...')
STATION = {}
STATION_LIGHTS = []      # indoor (always on)
ENTRANCE_LIGHTS = []
zb_h = min(H(x, y) for (x, y) in HALL_RING) - 0.25


def hwall(b, s0, b0, s1, b1, z0, z1, ops, mat, depth=0.2, **kw):
    """arch.wall between two hall-frame points (outward = right of the travel direction)."""
    o = HP(s0, b0)
    d = HP(s1, b1) - o
    return arch.wall(b, (o.x, o.y, z0), (d.x, d.y), d.length, z1 - z0, ops, depth, mat, **kw)


def hbox(b, s0, s1, b0, b1, z0, z1, mat, top=True):
    c = HP((s0 + s1) / 2, (b0 + b1) / 2)
    box_oriented(b, c, WA, (s1 - s0) / 2, (b1 - b0) / 2, z0, z1, mat, top=top)


def hquad(b, pts, mat, outward):
    arch.quad_facing(b, [(*HP(s_, b_), z) for (s_, b_, z) in pts], outward, mat)


UP3 = (0, 0, 1)
WA3, WB3 = (WA.x, WA.y, 0), (WB.x, WB.y, 0)
nWA3, nWB3 = (-WA.x, -WA.y, 0), (-WB.x, -WB.y, 0)
ZH = Z_HALL - zb_h                      # floor height above the wall base
FRONT_W = HS1 - HS0
S_DOOR = 23.4                           # OSM entrance, on the west face

# hall shell: west front (doorways + steel-framed glazing), east wall, roof
b = MeshBuilder('station_hall')
front_ops = []
for (s_a, s_b_, kind) in [(15.6, 17.6, 'shop'), (17.8, 19.8, 'shop'), (20.0, 22.0, 'shop'), (S_DOOR - 1.0, S_DOOR + 1.0, 'void'),
                          (S_DOOR + 1.2, S_DOOR + 3.2, 'void'), (26.8, 28.8, 'shop'), (29.0, 31.0, 'shop'), (31.2, 33.2, 'shop')]:
    if s_a < 22.4 and kind == 'shop' and s_b_ > S_DOOR - 1.0:
        continue
    u0 = HS1 - s_b_                     # the front runs from HS1 towards HS0
    if kind == 'void':
        front_ops.append((u0, ZH, s_b_ - s_a, 2.35, 'void'))
        front_ops.append((u0, ZH + 2.45, s_b_ - s_a, 0.5, 'shop', 'glass_clear'))
    else:
        front_ops.append((u0, ZH + 0.35, s_b_ - s_a, 2.6, 'shop', 'glass_clear'))
hwall(b, HS1, 0.0, HS0, 0.0, zb_h, Z_ROOF, front_ops, 'tiles_brown', depth=0.25, plinth=ZH, plinth_mat='granite_curb',
      bands=[(ZH + 3.05, ZH + 3.2, 'fascia_dark')], frame='metal_galvanized')
hwall(b, HS0, east_b(HS0), HS1, east_b(HS1), zb_h, Z_ROOF, [(FRONT_W / 2 - 0.5, ZH, 1.0, 2.1, 'door', 'wood_door')], 'brick_brown',
      plinth=ZH + 0.3)
face_with_holes(b, HALL_RING, [CORE], Z_ROOF, 'roof_felt')
arch.roof_edge(b, HALL_RING, Z_ROOF + 0.02, 0.3, 'metal_dark')
res = build(b, TPM_ARCH)
add_mesh_object('station_hall', 'Hässelby gård station hall', 'station_hall', 'building', lightmap=res)

# interior: terrazzo floor, tiled walls (plaster above 2.5 m), ceiling with fluorescent strips
b = MeshBuilder('station_interior')
T_IN = 0.25
eb0, eb1 = east_b(HS0) - T_IN, east_b(HS1) - T_IN
inner = [tuple(HP(HS0 + T_IN, T_IN)), tuple(HP(HS0 + T_IN, eb0)), tuple(HP(HS1 - T_IN, eb1)), tuple(HP(HS1 - T_IN, T_IN))]
if HL.area2(inner) < 0:
    inner = inner[::-1]
face_with_holes(b, inner, [], Z_HALL, 'terrazzo')
face_with_holes(b, inner, [CORE], Z_HALL + CEIL_H, 'ceiling_panel', up=False)
in_ops = [(s_a - (HS0 + T_IN), op[1], op[2], op[3], 'void') for op in front_ops for s_a in [HS1 - op[0] - op[2]]]
in_ops = [(u0, z0 - ZH, w, h_, k) for (u0, z0, w, h_, k) in in_ops]
wkw = dict(plinth=2.5, plinth_mat='tiles_brown')
hwall(b, HS0 + T_IN, T_IN, HS1 - T_IN, T_IN, Z_HALL, Z_HALL + CEIL_H, in_ops, 'plaster_white', depth=0.0, **wkw)
hwall(b, HS1 - T_IN, eb1, HS0 + T_IN, eb0, Z_HALL, Z_HALL + CEIL_H, [(FRONT_W / 2 - 0.5 - T_IN, 0.0, 1.0, 2.1, 'void')], 'plaster_white', depth=0.0, **wkw)
hwall(b, HS0 + T_IN, eb0, HS0 + T_IN, T_IN, Z_HALL, Z_HALL + CEIL_H, [], 'plaster_white', depth=0.0, **wkw)
hwall(b, HS1 - T_IN, T_IN, HS1 - T_IN, eb1, Z_HALL, Z_HALL + CEIL_H, [], 'plaster_white', depth=0.0, **wkw)
lamps_in = MeshBuilder('station_interior_lights')
for s_ in np.arange(HS0 + 1.8, HS1 - 1.0, 3.0):
    for b_ in np.arange(1.5, min(eb0, eb1) - 0.5, 3.2):
        if (SA0 - WT - 0.6 < s_ < SB1 + WT + 0.6) and (B_FOOT - WT - 0.6 < b_ < B_LAND1 + WT + 0.6):
            continue
        c = HP(s_, b_)
        box_oriented(lamps_in, c, WA, 0.6, 0.09, Z_HALL + CEIL_H - 0.06, Z_HALL + CEIL_H - 0.005, 'lamp_fluorescent_indoor')
        if int(round((s_ - HS0) / 3.0)) % 2 == 0 and int(round(b_ / 3.2)) % 2 == 0:
            STATION_LIGHTS.append((c.x, c.y, Z_HALL + CEIL_H - 0.15))
res = build(b, TPM_ARCH)
add_mesh_object('station_interior', 'Station hall interior', 'station_interior', 'building', lightmap=res)

# stair core: walls (tiles inside, both faces), flights, landing, handrails
b = MeshBuilder('station_stairs')
ZT = PLAT_Z + 2.8                        # stair house wall top
DOOR_H = 2.35
for (s0, s1) in ((SA0 - WT, SA0), (SB1, SB1 + WT)):              # outer long walls
    hbox(b, s0, s1, B_FOOT - WT, B_LAND1 + WT, Z_HALL, PLAT_Z, 'tiles_brown')
hbox(b, SA0 - WT, SB1 + WT, B_LAND1, B_LAND1 + WT, Z_HALL, PLAT_Z, 'tiles_brown')   # east wall
hbox(b, SA1, SB0, B_FOOT, B_LAND0, Z_HALL, PLAT_Z + 1.0, 'tiles_brown')            # central wall (parapet on top)
# west wall: doorway into flight A at the bottom, exit from flight B at platform level
hbox(b, SA0, SA1, B_FOOT - WT, B_FOOT, Z_HALL + DOOR_H, PLAT_Z, 'tiles_brown')
hbox(b, SA1, SB0, B_FOOT - WT, B_FOOT, Z_HALL, PLAT_Z, 'tiles_brown')
hbox(b, SB0, SB1, B_FOOT - WT, B_FOOT, Z_HALL, PLAT_Z, 'tiles_brown')
for k in range(NA):                                                  # flight A (+b)
    bb0 = B_FOOT + k * TREAD
    bb1 = B_LAND0 if k == NA - 1 else bb0 + TREAD
    z1 = Z_HALL + (k + 1) * RR
    if k < NA - 1:
        hquad(b, [(SA0, bb0, z1), (SA1, bb0, z1), (SA1, bb1, z1), (SA0, bb1, z1)], 'terrazzo', UP3)
    hquad(b, [(SA0, bb0, z1 - RR), (SA1, bb0, z1 - RR), (SA1, bb0, z1), (SA0, bb0, z1)], 'terrazzo', nWB3)
hquad(b, [(SA0, B_LAND0, Z_LAND), (SB1, B_LAND0, Z_LAND), (SB1, B_LAND1, Z_LAND), (SA0, B_LAND1, Z_LAND)], 'terrazzo', UP3)
hquad(b, [(SB0, B_LAND0, Z_LAND - 0.25), (SB1, B_LAND0, Z_LAND - 0.25), (SB1, B_LAND1, Z_LAND - 0.25), (SB0, B_LAND1, Z_LAND - 0.25)], 'concrete_cast', (0, 0, -1))
for j in range(NB):                                                  # flight B (-b)
    bb1 = B_LAND0 - j * TREAD
    bb0 = bb1 - TREAD
    z1 = Z_LAND + (j + 1) * RR
    hquad(b, [(SB0, bb1, z1 - RR), (SB1, bb1, z1 - RR), (SB1, bb1, z1), (SB0, bb1, z1)], 'terrazzo', WB3)
    if j < NB - 1:
        hquad(b, [(SB0, bb0, z1), (SB1, bb0, z1), (SB1, bb1, z1), (SB0, bb1, z1)], 'terrazzo', UP3)
    # sloped soffit strip under each tread (seen from flight A over the parapet)
    hquad(b, [(SB0, bb0, z1 - RR - 0.2), (SB1, bb0, z1 - RR - 0.2), (SB1, bb1, z1 - 2 * RR - 0.2), (SB0, bb1, z1 - 2 * RR - 0.2)], 'concrete_cast', (0, 0, -1))
hquad(b, [(SB0, B_FOOT - WT, PLAT_Z), (SB1, B_FOOT - WT, PLAT_Z), (SB1, B_TOP, PLAT_Z), (SB0, B_TOP, PLAT_Z)], 'terrazzo', UP3)
# handrails along the outer walls and both sides of the central wall
for (s_r, b0_, z0_, b1_, z1_) in [(SA0 + 0.06, B_FOOT + 0.3, Z_HALL + 0.95, B_LAND0, Z_LAND + 0.9),
                                   (SA1 - 0.06, B_FOOT + 0.3, Z_HALL + 0.95, B_LAND0, Z_LAND + 0.9),
                                   (SB0 + 0.06, B_LAND0, Z_LAND + 0.9, B_TOP + 0.3, PLAT_Z + 0.9),
                                   (SB1 - 0.06, B_LAND0, Z_LAND + 0.9, B_TOP + 0.3, PLAT_Z + 0.9)]:
    p0, p1 = HP(s_r, b0_), HP(s_r, b1_)
    b.tube((p0.x, p0.y, z0_), (p1.x, p1.y, z1_), 0.025, 0.025, 'steel_brushed', sides=6)
res = build(b, TPM_ARCH)
add_mesh_object('station_stairs', 'Stairs to the platform', 'station_stairs', 'structure', lightmap=res)
for (s_, b_, z) in [((SA0 + SA1) / 2, B_FOOT + 1.5, Z_HALL + 2.6), ((SA0 + SB1) / 2, B_LAND0 + 0.8, Z_LAND + 2.6),
                    ((SB0 + SB1) / 2, B_FOOT + 2.0, PLAT_Z + 2.55)]:
    c = HP(s_, b_)
    box_oriented(lamps_in, c, WB, 0.5, 0.08, z - 0.05, z, 'lamp_fluorescent_indoor')
    STATION_LIGHTS.append((c.x, c.y, z - 0.1))

# stair house on the platform: tiled base, steel-framed glazing, flat roof; exit to the west
b = MeshBuilder('station_stairhouse')
s_lo, s_hi, b_lo, b_hi = SA0 - WT, SB1 + WT, B_FOOT - WT, B_LAND1 + WT
glaze = lambda ln: [(c - 0.55, 1.05, 1.1, 1.35, 'shop', 'glass_clear') for c in arch.bays(ln, 1.25, 0.4)]
hwall(b, s_lo, b_hi, s_lo, b_lo, PLAT_Z, ZT, glaze(b_hi - b_lo), 'tiles_brown', depth=WT, frame='metal_railing_dark')   # south side
hwall(b, s_hi, b_lo, s_hi, b_hi, PLAT_Z, ZT, glaze(b_hi - b_lo), 'tiles_brown', depth=WT, frame='metal_railing_dark')   # north side
hwall(b, s_lo, b_lo, s_hi, b_lo, PLAT_Z, ZT, [(SB0 - s_lo, 0.0, FW, DOOR_H, 'void')], 'tiles_brown', depth=WT)          # west, exit
hwall(b, s_hi, b_hi, s_lo, b_hi, PLAT_Z, ZT, [], 'tiles_brown', depth=WT)                                                # east
for (s0, s1, b0, b1) in [(s_lo, s_lo + WT, b_lo, b_hi), (s_hi - WT, s_hi, b_lo, b_hi), (s_lo, s_hi, b_hi - WT, b_hi)]:
    hbox(b, s0, s1, b0, b1, ZT - 0.01, ZT, 'tiles_brown', top=False)
roof = [tuple(HP(s_lo - 0.35, b_lo - 0.35)), tuple(HP(s_hi + 0.35, b_lo - 0.35)), tuple(HP(s_hi + 0.35, b_hi + 0.35)), tuple(HP(s_lo - 0.35, b_hi + 0.35))]
if HL.area2(roof) < 0:
    roof = roof[::-1]
face_with_holes(b, roof, [], ZT + 0.22, 'roof_felt')
face_with_holes(b, roof, [], ZT, 'ceiling_panel', up=False)
for i in range(4):
    a_, c_ = roof[i], roof[(i + 1) % 4]
    wall_seg(b, a_, c_, ZT, ZT + 0.22, 'concrete_cast')
res = build(b, TPM_ARCH)
add_mesh_object('station_stairhouse', 'Stair house on the platform', 'station_stairhouse', 'building', lightmap=res)

# ticket barrier: booth (spärrkur), four tripod turnstiles, balustrades; free zone by the doors
B_BAR = 3.7
S_BOOTH0, S_BOOTH1 = S_DOOR - 6.3, S_DOOR - 3.9
b = MeshBuilder('station_barrier')
hbox(b, S_BOOTH0, S_BOOTH1, B_BAR - 1.0, B_BAR + 1.0, Z_HALL, Z_HALL + 1.0, 'teak_panel')           # booth base
for (sc, bc) in [(S_BOOTH0, B_BAR - 1.0), (S_BOOTH1, B_BAR - 1.0), (S_BOOTH0, B_BAR + 1.0), (S_BOOTH1, B_BAR + 1.0)]:
    hbox(b, sc - 0.04, sc + 0.04, bc - 0.04, bc + 0.04, Z_HALL + 1.0, Z_HALL + 2.45, 'metal_railing_dark')   # corner posts
hbox(b, S_BOOTH0 - 0.06, S_BOOTH1 + 0.06, B_BAR - 1.06, B_BAR + 1.06, Z_HALL + 2.45, Z_HALL + 2.6, 'teak_panel')  # roof cap
for (pa, pb, outv) in [((S_BOOTH0, B_BAR - 1.0), (S_BOOTH1, B_BAR - 1.0), nWB3), ((S_BOOTH1, B_BAR + 1.0), (S_BOOTH0, B_BAR + 1.0), WB3),
                       ((S_BOOTH0, B_BAR + 1.0), (S_BOOTH0, B_BAR - 1.0), nWA3), ((S_BOOTH1, B_BAR - 1.0), (S_BOOTH1, B_BAR + 1.0), WA3)]:
    hquad(b, [(pa[0], pa[1], Z_HALL + 1.0), (pb[0], pb[1], Z_HALL + 1.0), (pb[0], pb[1], Z_HALL + 2.45), (pa[0], pa[1], Z_HALL + 2.45)], 'glass_clear', outv)
hbox(b, S_BOOTH0 + 0.1, S_BOOTH1 - 0.1, B_BAR - 0.95, B_BAR - 0.55, Z_HALL + 1.0, Z_HALL + 1.05, 'teak_panel')    # counter
CAB_W, LANE_W = 0.28, 0.62
s_t = S_BOOTH1 + 0.05
cabs = [s_t + CAB_W / 2 + k * (CAB_W + LANE_W) for k in range(5)]
for sc in cabs:
    hbox(b, sc - CAB_W / 2, sc + CAB_W / 2, B_BAR - 0.65, B_BAR + 0.65, Z_HALL, Z_HALL + 0.98, 'steel_brushed')
S_RAIL0 = cabs[-1] + CAB_W / 2
for (s0, s1) in [(HS0 + T_IN, S_BOOTH0), (S_RAIL0, HS1 - T_IN)]:     # balustrades to the walls
    p0, p1 = HP(s0, B_BAR), HP(s1, B_BAR)
    b.tube((p0.x, p0.y, Z_HALL + 1.0), (p1.x, p1.y, Z_HALL + 1.0), 0.03, 0.03, 'steel_brushed', sides=6)
    for s_ in np.arange(s0, s1 + 0.01, 1.2):
        q = HP(min(s_, s1), B_BAR)
        b.tube((q.x, q.y, Z_HALL), (q.x, q.y, Z_HALL + 1.0), 0.025, 0.025, 'steel_brushed', sides=6)
    hquad(b, [(s0, B_BAR, Z_HALL + 0.1), (s1, B_BAR, Z_HALL + 0.1), (s1, B_BAR, Z_HALL + 0.95), (s0, B_BAR, Z_HALL + 0.95)], 'railing_bars', nWB3)
res = build(b, TPM_ARCH)
add_mesh_object('station_barrier', 'Ticket booth and barrier', 'station_barrier', 'prop', lightmap=res)
c = HP((S_BOOTH0 + S_BOOTH1) / 2, B_BAR)
STATION_LIGHTS.append((c.x, c.y, Z_HALL + 2.3))
add_sign('sign_booth', 'Ticket booth sign', (*HP((S_BOOTH0 + S_BOOTH1) / 2, B_BAR - 1.07), Z_HALL + 2.8), (-WB.x, -WB.y),
         'Biljetter', (2.2, 0.32), font='Inter', weight=700, color='#ffffff', background='#0b3f7e', backlit=1)

# tripod rotors: one object each (they turn as the player walks through the lane)
b = MeshBuilder('turnstile_rotor')                                  # local: +y = passing direction, +x = across the lane
# Tripod arms on a 45° cone about an axis pointing down into the lane: one arm horizontal
# across the lane, the other two angled down (local -x maps to +WA, into the lane).
ax = Vector((-math.sin(math.radians(45)), 0.0, -math.cos(math.radians(45))))
arm0 = Vector((-1.0, 0.0, 0.0))
for k in range(3):
    d = arm0.copy()
    d.rotate(Matrix.Rotation(2 * math.pi * k / 3, 3, ax))
    b.tube((0, 0, 0), tuple(d * 0.5), 0.022, 0.018, 'steel_brushed', sides=6)
b.tube(tuple(-ax * 0.04), tuple(ax * 0.07), 0.05, 0.05, 'steel_brushed', sides=8)
build(b, None)
yaw_t = math.degrees(math.atan2(WB.x, WB.y))
ax_world = Vector((WA.x * -ax.x, WA.y * -ax.x, ax.z))              # local -x -> +WA
for k in range(4):
    pv = HP(cabs[k] + CAB_W / 2 + 0.02, B_BAR)
    lane = HP(cabs[k] + CAB_W / 2 + LANE_W / 2, B_BAR)
    objects.append({
        'id': f'turnstile_{k}', 'name': f'Turnstile {k + 1}', 'type': 'mesh', 'semantic': 'turnstile',
        'asset': f'{ASSET_REL}/turnstile_rotor.glb',
        'transform': {'position': to_engine((pv.x, pv.y, Z_HALL + 0.95)), 'rotation': yaw_quat(yaw_t)},
        'static': False, 'castShadow': True, 'collision': False,
        'turnstile': {'pivot': to_engine((pv.x, pv.y, Z_HALL + 0.95)), 'axis': to_engine(tuple(ax_world.normalized())),
                      'lane': to_engine((lane.x, lane.y, Z_HALL)), 'dir': to_engine((WB.x, WB.y, 0.0))},
    })

# entrance canopy over the front, name band, T sign; the furniture code places around it
b = MeshBuilder('station_canopy')
zc = Z_HALL + 3.25
cs0, cs1, cdep = 15.2, 33.4, 2.3
P4 = lambda s_, o_, z: (*HP(s_, -o_), z)
cq = [P4(cs0, 0, zc + 0.3), P4(cs1, 0, zc + 0.3), P4(cs1, cdep, zc + 0.3), P4(cs0, cdep, zc + 0.3)]
arch.quad_facing(b, cq, UP3, 'concrete_cast')
arch.quad_facing(b, [P4(cs0, 0, zc), P4(cs1, 0, zc), P4(cs1, cdep, zc), P4(cs0, cdep, zc)], (0, 0, -1), 'ceiling_panel')
arch.quad_facing(b, [P4(cs0, cdep, zc - 0.05), P4(cs1, cdep, zc - 0.05), P4(cs1, cdep, zc + 0.3), P4(cs0, cdep, zc + 0.3)], nWB3, 'concrete_cast')
for (s_e, sg) in ((cs0, nWA3), (cs1, WA3)):
    arch.quad_facing(b, [P4(s_e, 0, zc - 0.05), P4(s_e, cdep, zc - 0.05), P4(s_e, cdep, zc + 0.3), P4(s_e, 0, zc + 0.3)], sg, 'concrete_cast')
res = build(b, TPM_ARCH)
add_mesh_object('station_canopy', 'Station entrance canopy', 'station_canopy', 'structure', lightmap=res)
for s_ in np.arange(cs0 + 1.0, cs1 - 0.5, 2.4):
    c = HP(s_, -cdep * 0.55)
    box_oriented(lamps_in, c, WA, 0.6, 0.07, zc - 0.07, zc - 0.005, 'lamp_fluorescent')
    if int(round((s_ - cs0) / 2.4)) % 2 == 0:
        ENTRANCE_LIGHTS.append((c.x, c.y, zc - 0.1))
band_c = HP(S_DOOR, -0.08)
add_sign('sign_station_band', 'Station name band', (band_c.x, band_c.y, Z_HALL + 2.95 + 0.0), (-WB.x, -WB.y), 'Hässelby gård', (8.4, 0.4),
         font='Inter', weight=700, color='#ffffff', background='#0b3f7e', backlit=1, textHeight=0.68, letterSpacing=0.12)
# T sign on a bracket at the front's north end
t_base = HP(HS1 - 0.6, -0.05)
disc_c = HP(HS1 - 0.6, -1.15)
zt = Z_HALL + 4.0
lamps_in.tube((t_base.x, t_base.y, zt + 0.6), (disc_c.x, disc_c.y, zt + 0.6), 0.04, 0.04, 'metal_railing_dark', sides=6)
lamps_in.tube((disc_c.x, disc_c.y, zt + 0.6), (disc_c.x, disc_c.y, zt + 0.5), 0.03, 0.03, 'metal_railing_dark', sides=6)
R_, nseg = 0.5, 24
for sgn in (1, -1):
    fn = WA * sgn                                     # the disc faces along the street (both ways)
    side = Vector((fn.y, -fn.x))
    ring_, uvs_ = [], []
    for k in range(nseg):
        a_ = 2 * math.pi * k / nseg
        lx, lz = math.cos(a_) * R_, math.sin(a_) * R_
        p_ = disc_c + fn * 0.09 - side * lx
        ring_.append((p_.x, p_.y, zt + lz))
        uvs_.append((0.45 + lx * 0.9, 0.45 + lz * 0.9))
    lamps_in.face(ring_, 'sign_tbana', uvs=uvs_)
for k in range(nseg):
    a0, a1 = 2 * math.pi * k / nseg, 2 * math.pi * (k + 1) / nseg
    side = Vector((WA.y, -WA.x))
    q = [disc_c + WA * 0.09 + side * math.cos(a0) * R_, disc_c + WA * 0.09 + side * math.cos(a1) * R_,
         disc_c - WA * 0.09 + side * math.cos(a1) * R_, disc_c - WA * 0.09 + side * math.cos(a0) * R_]
    zz = [math.sin(a0) * R_, math.sin(a1) * R_, math.sin(a1) * R_, math.sin(a0) * R_]
    mid_ = side * math.cos((a0 + a1) / 2)
    arch.quad_facing(lamps_in, [(q[i].x, q[i].y, zt + zz[i]) for i in range(4)], (mid_.x, mid_.y, math.sin((a0 + a1) / 2)), 'metal_railing_dark')
build(lamps_in, None)
add_mesh_object('station_lights', 'Station light fittings and T sign', 'station_interior_lights', 'prop', collision=False, cast=False)
# signs inside: exit, to the trains, platform names
add_sign('sign_exit', 'Exit sign', (*HP(S_DOOR, T_IN + 0.05), Z_HALL + 2.75), (WB.x, WB.y), 'Utgång  Hässelby torg', (2.6, 0.26),
         font='Inter', weight=600, color='#ffffff', background='#1d6b3a', backlit=1, uppercase=False)
add_sign('sign_trains', 'To the trains', (*HP((SA0 + SA1) / 2, B_FOOT - WT - 0.03), Z_HALL + 2.7), (-WB.x, -WB.y), 'Till tågen', (1.9, 0.3),
         font='Inter', weight=700, color='#ffffff', background='#0b3f7e', backlit=1, uppercase=False)
for (s_, fac) in ((s_lo - 0.02, (-WA.x, -WA.y)), (s_hi + 0.02, (WA.x, WA.y))):
    add_sign(f'sign_platform_{len(objects)}', 'Platform name sign', (*HP(s_, (b_lo + b_hi) / 2), PLAT_Z + 2.5), fac, 'Hässelby gård', (3.2, 0.42),
             font='Inter', weight=700, color='#ffffff', background='#0b3f7e', backlit=1, textHeight=0.62, letterSpacing=0.08)
add_sign('sign_direction', 'Direction sign', (*HP((SB0 + SB1) / 2, b_lo - 0.03), PLAT_Z + 2.55), (-WB.x, -WB.y), 'Mot T-Centralen', (2.0, 0.28),
         font='Inter', weight=600, color='#ffffff', background='#1d6b3a', backlit=1, uppercase=False)
STATION['front'] = (HP(HS1, 0.0), -WA, FRONT_W, zb_h, ZH)
print(f'  station: hall {FRONT_W:.0f} x {(east_b(HS0) + east_b(HS1)) / 2:.0f} m, stair core s {SA0:.1f}..{SB1:.1f}, top at b {B_TOP:.2f}')


# =============================================================== buildings

FLOOR = 2.8
rnd_b = random.Random(55)


def archetype(bd):
    k, lv = bd['kind'], bd['levels']
    cx = sum(p[0] for p in bd['ring']) / len(bd['ring'])
    cy = sum(p[1] for p in bd['ring']) / len(bd['ring'])
    if bd['area'] < 45 and lv <= 1 and X0 < cx < X1 and Y0 < cy < Y1 and HS.sample(g, d_walk, cx, cy) < 3.0:
        # one kiosk on the forecourt; the smaller modern pavilions (toilet...) did not exist
        return 'kiosk' if bd['area'] >= 30 else None
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
        if ln > 0.2 and not faces_hall(a, (d[0] / ln, d[1] / ln), ln):
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


def machine_room(b, ring, z, mat):
    """Lift machine room on a tall block's roof (centred, along the long axis)."""
    rect = arch.oriented_rect(ring)
    if rect:
        c, u, v, hu, hv = rect
    else:
        c = Vector((sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)))
        u, v, hu, hv = Vector((1, 0)), Vector((0, 1)), 4.0, 3.0
    hu, hv = min(hu * 0.3, 3.2), min(hv * 0.4, 2.4)
    P = lambda a_, b_, zz: (c.x + u.x * a_ + v.x * b_, c.y + u.y * a_ + v.y * b_, zz)
    z1 = z + 2.6
    for (a0, b0, a1, b1) in [(-hu, -hv, hu, -hv), (hu, -hv, hu, hv), (hu, hv, -hu, hv), (-hu, hv, -hu, -hv)]:
        arch.quad_facing(b, [P(a0, b0, z), P(a1, b1, z), P(a1, b1, z1), P(a0, b0, z1)],
                         ((a0 + a1) / 2 * u.x + (b0 + b1) / 2 * v.x, (a0 + a1) / 2 * u.y + (b0 + b1) / 2 * v.y, 0), mat)
    b.quad(P(-hu - 0.1, -hv - 0.1, z1), P(hu + 0.1, -hv - 0.1, z1), P(hu + 0.1, hv + 0.1, z1), P(-hu - 0.1, hv + 0.1, z1), 'roof_felt')


def faces_hall(a, u, ln):
    out = (u[1], -u[0])
    mx, my = a[0] + u[0] * ln / 2 + out[0] * 0.3, a[1] + u[1] * ln / 2 + out[1] * 0.3
    return HL.poly_contains(HALL_RING, mx, my)


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
        machine_room(b, ring, roof_z, wall_m)
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
        machine_room(b, ring, roof_z, 'render_grey')
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
# centre building pieces outside the hall (plan difference via a fine distance field)
_cr_bd = next(bd for bd in L['buildings'] if bd['id'] == CENTRE_ID)
_xs, _ys = [p[0] for p in _cr_bd['ring']], [p[1] for p in _cr_bd['ring']]
_gc = HS.Grid(min(_xs) - 2, min(_ys) - 2, max(_xs) + 2, max(_ys) + 2, 0.1)
_dc = HS.subtract(HS.polygon_field(_gc, [_cr_bd['ring']]), HS.polygon_field(_gc, [HALL_RING]))
CENTRE_PIECES = [HL.simplify_ring(l_, 0.3, 3.0) for l_ in HS.contour_loops(_gc, _dc, tol=0.04) if HL.area2(l_) > 20]
print(f'  centre building split into {len(CENTRE_PIECES)} pieces around the hall')
kinds = {}
for i, bd in enumerate(L['buildings']):
    cx = sum(p[0] for p in bd['ring']) / len(bd['ring'])
    cy = sum(p[1] for p in bd['ring']) / len(bd['ring'])
    if not (X0 + 5 < cx < X1 - 5 and Y0 + 5 < cy < Y1 - 5):
        continue
    if bd['id'] == CENTRE_ID:
        # the centre building minus the ticket hall (its south wing under the platform)
        for k_, piece in enumerate(CENTRE_PIECES):
            nb_ = dict(bd, id=f'{CENTRE_ID}_{k_}', ring=piece, area=abs(HL.area2(piece)))
            kk, _ = build_building(nb_, 900 + k_)
            kinds[kk] = kinds.get(kk, 0) + 1
        continue
    if archetype(bd) is None:
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
_best = {}
for kw in KIOSK_WALLS:                                   # one fascia per kiosk: its longest walk-facing side
    if kw[4] not in _best or kw[2] > _best[kw[4]][2]:
        _best[kw[4]] = kw
for (a, u, ln, z0, bid) in _best.values():
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


def light(obj_id, pos, intensity, rng_, color, kind='spot', outer=60, inner=30, fog=1.0, radius=0.15, always=False):
    objects.append({'id': obj_id, 'type': 'light', 'semantic': 'light', 'transform': {'position': to_engine(pos), 'rotation': [0, 0, 0, 1]},
                    'light': {'kind': kind, 'color': list(color), 'intensity': intensity, 'range': rng_, 'outerAngle': outer,
                              'innerAngle': inner, 'sourceRadius': radius, 'fogScatter': fog, **({'always': True} if always else {})}})


SODIUM, MERCURY, FLUO = (1.0, 0.6, 0.28), (0.8, 0.9, 1.0), (0.9, 0.96, 1.0)
for i, (x, y, h) in enumerate(lamps_street):
    hx, hy = x + math.sin(math.radians(h)) * (ARM + 0.25), y + math.cos(math.radians(h)) * (ARM + 0.25)
    light(f'lamp_street_{i}', (hx, hy, H(x, y) + LAMP_H - 0.05), 2600, 24, SODIUM, outer=64, inner=34)
for i, (x, y) in enumerate(lamps_path):
    light(f'lamp_path_{i}', (x, y, H(x, y) + 4.05), 260, 12, MERCURY, kind='point', fog=0.6, radius=0.23)
for i, (x, y, z) in enumerate(CANOPY_LIGHTS[::2]):
    light(f'platform_light_{i}', (x, y, z), 700, 11, FLUO, outer=80, inner=55, fog=0.4)
for i, (x, y, z) in enumerate(STATION_LIGHTS):
    light(f'station_light_{i}', (x, y, z), 750, 9, FLUO, outer=85, inner=60, fog=0.0, always=True)
for i, (x, y, z) in enumerate(ENTRANCE_LIGHTS):
    light(f'entrance_light_{i}', (x, y, z), 600, 10, FLUO, outer=80, inner=55, fog=0.4)
print(f'  {len(lamps_street)} street lamps, {len(lamps_path)} path lamps')


# =============================================================== street furniture
# Bus shelters at the OSM stops, benches, bins, phone booths, bike racks (props,
# probe-lit; local origin, front towards +y).
print('Street furniture...')
b = MeshBuilder('bus_shelter')                     # 3.6 x 1.4 m, open towards +y (the kerb)
for (x, y) in ((-1.75, -0.65), (1.75, -0.65), (-1.75, 0.6), (1.75, 0.6)):
    b.box(x - 0.04, x + 0.04, y - 0.04, y + 0.04, 0.0, 2.35, 'metal_green')
b.box(-1.9, 1.9, -0.8, 0.8, 2.35, 2.45, 'metal_green')                  # roof
b.box(-1.85, 1.85, -0.72, 0.72, 2.33, 2.35, 'ceiling_panel', skip=('+z',))
b.box(-1.71, 1.71, -0.69, -0.62, 0.15, 1.05, 'metal_painted')           # back panel (lower)
b.box(-1.71, 1.71, -0.69, -0.64, 1.05, 2.3, 'fence_chainlink')          # mesh guard above
b.box(1.72, 1.78, -0.6, 0.55, 0.25, 2.1, 'sign_body')                    # advert case at the end
b.quad((1.781, -0.55, 0.32), (1.781, 0.5, 0.32), (1.781, 0.5, 2.03), (1.781, -0.55, 2.03), 'advert_lit')
b.quad((1.719, 0.5, 0.32), (1.719, -0.55, 0.32), (1.719, -0.55, 2.03), (1.719, 0.5, 2.03), 'advert_lit')
for k in range(3):                                                       # bench
    b.box(-1.2, 0.9, -0.55 + k * 0.12, -0.46 + k * 0.12, 0.44, 0.48, 'wood_door')
b.box(-1.1, -1.05, -0.55, -0.25, 0.0, 0.44, 'metal_dark')
b.box(0.8, 0.85, -0.55, -0.25, 0.0, 0.44, 'metal_dark')
build(b, None)

b = MeshBuilder('bench_park')                       # 1.8 m slatted bench, faces +y
for sx in (-0.75, 0.75):
    b.box(sx - 0.035, sx + 0.035, -0.28, 0.22, 0.0, 0.42, 'metal_dark')
    b.box(sx - 0.035, sx + 0.035, -0.3, -0.24, 0.42, 0.85, 'metal_dark')
for k in range(4):
    b.box(-0.9, 0.9, -0.22 + k * 0.11, -0.22 + k * 0.11 + 0.085, 0.42, 0.46, 'wood_door')
for k in range(2):
    b.box(-0.9, 0.9, -0.3, -0.26, 0.55 + k * 0.15, 0.66 + k * 0.15, 'wood_door')
build(b, None)

b = MeshBuilder('bin_post')                         # green litter bin on a post
b.tube((0, 0, 0), (0, 0, 1.05), 0.03, 0.03, 'metal_green', sides=6)
b.tube((0, 0.2, 0.55), (0, 0.2, 1.05), 0.17, 0.19, 'metal_green', sides=12)
b.tube((0, 0.2, 0.55), (0, 0.2, 0.56), 0.17, 0.17, 'metal_dark', sides=12)
build(b, None)

b = MeshBuilder('phone_booth')                      # aluminium-framed booth, door towards +y
b.box(-0.5, 0.5, -0.5, 0.5, 0.0, 0.08, 'concrete_cast')
for (x, y) in ((-0.48, -0.48), (0.48, -0.48), (-0.48, 0.48), (0.48, 0.48)):
    b.box(x - 0.03, x + 0.03, y - 0.03, y + 0.03, 0.08, 2.25, 'metal_galvanized')
b.box(-0.5, 0.5, -0.5, 0.5, 2.25, 2.55, 'sign_body')
for side in range(4):
    a_ = side * math.pi / 2
    c, s_ = math.cos(a_), math.sin(a_)
    P = lambda u_, z: (c * u_ - s_ * 0.47, s_ * u_ + c * 0.47, z)
    arch.quad_facing(b, [P(-0.45, 0.25), P(0.45, 0.25), P(0.45, 2.2), P(-0.45, 2.2)], (-s_, c, 0), 'car_glass')
    arch.quad_facing(b, [P(-0.45, 0.08), P(0.45, 0.08), P(0.45, 0.25), P(-0.45, 0.25)], (-s_, c, 0), 'metal_galvanized')
build(b, None)

b = MeshBuilder('sign_pole')
b.tube((0, 0, 0), (0, 0, 2.95), 0.035, 0.035, 'metal_galvanized', sides=8)
build(b, None)

b = MeshBuilder('bike_rack')                        # 5 hoops on rails, 3 m
for k in range(5):
    x = -1.2 + k * 0.6
    pts = [(x, -0.35 + 0.7 * i / 8, 0.35 + 0.4 * math.sin(math.pi * i / 8)) for i in range(9)]
    for p, q in zip(pts, pts[1:]):
        b.tube(p, q, 0.02, 0.02, 'metal_galvanized', sides=5, caps=False)
    b.tube((x, -0.35, 0.0), (x, -0.35, 0.35), 0.02, 0.02, 'metal_galvanized', sides=5, caps=False)
    b.tube((x, 0.35, 0.0), (x, 0.35, 0.35), 0.02, 0.02, 'metal_galvanized', sides=5, caps=False)
build(b, None)

furn = {k: [] for k in ('bus_shelter', 'bench_park', 'bin_post', 'phone_booth', 'bike_rack', 'sign_pole')}


def road_frame(x, y):
    """Unit normal away from the nearest carriageway and its distance."""
    eps = 0.4
    gx = (HS.sample(g, d_road, x + eps, y) - HS.sample(g, d_road, x - eps, y)) / (2 * eps)
    gy = (HS.sample(g, d_road, x, y + eps) - HS.sample(g, d_road, x, y - eps)) / (2 * eps)
    ln = math.hypot(gx, gy) or 1.0
    return (gx / ln, gy / ln), HS.sample(g, d_road, x, y)


def heading_of(v):
    return math.degrees(math.atan2(v[0], v[1]))


for (p, name) in L['bus_stops']:
    if not (X0 + 5 < p[0] < X1 - 5 and Y0 + 5 < p[1] < Y1 - 5):
        continue
    n, dr = road_frame(*p)
    x, y = p[0] + n[0] * (2.6 - dr), p[1] + n[1] * (2.6 - dr)       # shelter 2.6 m behind the kerb line
    if HS.sample(g, d_bldg, x, y) < 1.5:
        continue
    furn['bus_shelter'].append((x, y, heading_of((-n[0], -n[1]))))   # open side faces the road
    t = (-n[1], n[0])
    sx, sy = x + t[0] * 3.2 + n[0] * -1.6, y + t[1] * 3.2 + n[1] * -1.6
    furn['bin_post'].append((x - t[0] * 2.6, y - t[1] * 2.6, heading_of((-n[0], -n[1]))))
    # stop sign: pole + name plate (sign objects carry the text)
    furn['sign_pole'].append((sx, sy, 0.0))
    k = len(furn['bus_shelter'])
    add_sign(f'sign_busstop_{k}', 'Bus stop sign', (sx, sy, H(sx, sy) + 2.55), (-n[0], -n[1]), 'Buss\nHässelby gård', (0.62, 0.42),
             font='Inter', weight=700, color='#ffffff', background='#1d4f91', border='#ffffff', textHeight=0.62,
             uppercase=False, doubleSided=True, depth=0.03)

# Resenärer (Thomas Qvarsebo, 1989): eight bronze travellers with suitcases, 1.35 m tall,
# on a 40 cm granite plinth, waiting on Hässelby torg within sight of the T-bana exit.
art = next((n for n in [(-89.4, 74.6)]), None)
b = MeshBuilder('resenarer')
PL_L, PL_W, PL_H = 6.8, 1.5, 0.4
b.box(-PL_L / 2, PL_L / 2, -PL_W / 2, PL_W / 2, -0.3, PL_H, 'granite_curb')
rng_art = random.Random(1989)
for k in range(8):
    x = -PL_L / 2 + 0.55 + k * (PL_L - 1.1) / 7 + rng_art.uniform(-0.1, 0.1)
    y = rng_art.uniform(-0.35, 0.35)
    h = 1.35 * rng_art.uniform(0.93, 1.04)
    yaw = rng_art.uniform(-0.5, 0.5) + (math.pi if k % 3 == 2 else 0.0)
    c, s_ = math.cos(yaw), math.sin(yaw)
    L_ = lambda lx, ly, lz: (x + lx * c - ly * s_, y + lx * s_ + ly * c, PL_H + lz)
    hip, sh = h * 0.5, h * 0.82
    for sx in (-0.07, 0.07):                                          # legs
        b.tube(L_(sx, 0, 0), L_(sx * 1.1, 0, hip), 0.05, 0.065, 'bronze_patina', sides=7)
    b.tube(L_(0, 0, hip - 0.05), L_(0, 0, sh), 0.14, 0.16, 'bronze_patina', sides=8)        # coat / torso
    b.tube(L_(0, 0, hip - 0.25), L_(0, 0, hip + 0.05), 0.12, 0.15, 'bronze_patina', sides=8)
    b.tube(L_(0, 0, sh), L_(0, 0, sh + 0.06), 0.06, 0.05, 'bronze_patina', sides=6)         # neck
    sphere(b, L_(0, 0, sh + 0.15), 0.1, 'bronze_patina', rings=5, seg=8)                    # head
    if k % 2 == 0:
        b.tube(L_(-0.12, 0, sh + 0.25), L_(0.12, 0, sh + 0.25), 0.11, 0.11, 'bronze_patina', sides=8)   # hat brim
    side = 1 if k % 2 else -1
    b.tube(L_(0.17 * side, 0, sh - 0.03), L_(0.2 * side, 0.02, hip - 0.02), 0.045, 0.04, 'bronze_patina', sides=6)   # arm with case
    b.tube(L_(-0.17 * side, 0, sh - 0.03), L_(-0.19 * side, 0.03, hip + 0.05), 0.045, 0.04, 'bronze_patina', sides=6)
    cx_, cy_ = 0.27 * side, 0.02
    sw, sd, sh_ = 0.13, 0.42, 0.32 if k % 3 else 0.38                # suitcase
    pts8 = [L_(cx_ + dx, cy_ + dy, dz) for dz in (0.03, 0.03 + sh_) for (dx, dy) in ((-sw / 2, -sd / 2), (sw / 2, -sd / 2), (sw / 2, sd / 2), (-sw / 2, sd / 2))]
    for (i0, i1, i2, i3) in ((0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)):
        b.face([pts8[i0], pts8[i3], pts8[i2], pts8[i1]] if (i0, i1) == (0, 1) else [pts8[i0], pts8[i1], pts8[i2], pts8[i3]], 'bronze_patina')
build(b, None)
ax_, ay_ = art
art_heading = heading_of((STATION['front'][0].x - ax_, STATION['front'][0].y - ay_)) if STATION.get('front') else 160.0
objects.append({'id': 'art_resenarer', 'name': 'Resenärer (Thomas Qvarsebo, 1989)', 'type': 'mesh', 'semantic': 'artwork',
                'asset': f'{ASSET_REL}/resenarer.glb', 'transform': {'position': to_engine((ax_, ay_, H(ax_, ay_) + 0.12)), 'rotation': yaw_quat(art_heading)},
                'static': True, 'castShadow': True, 'collision': True})
for (dx, dy, hd) in ((-5.5, -4.5, 20), (4.5, -5.0, -20), (-7.0, 3.0, 110), (7.5, 2.5, -110)):
    furn['bench_park'].append((ax_ + dx, ay_ + dy, art_heading + hd))
furn['bin_post'].append((ax_ - 3.5, ay_ - 5.5, art_heading))

for p in L['benches']:
    if X0 + 3 < p[0] < X1 - 3 and Y0 + 3 < p[1] < Y1 - 3 and HS.sample(g, d_bldg, *p) > 1.0:
        n, dr = road_frame(*p)
        furn['bench_park'].append((p[0], p[1], heading_of(n) + 180 if dr < 8 else 0.0))
for p in L['bins']:
    if X0 + 3 < p[0] < X1 - 3 and Y0 + 3 < p[1] < Y1 - 3 and HS.sample(g, d_bldg, *p) > 0.8:
        furn['bin_post'].append((p[0], p[1], 0.0))
# the forecourt: benches facing the station, a phone booth by the entrance, bike racks
if STATION.get('front'):
    a, t, ln, zb, z0 = STATION['front']
    out = Vector((t.y, -t.x))
    for k, (u_, o_) in enumerate(((-6.0, 7.5), (-2.5, 9.0), (ln + 3.0, 9.5), (ln + 6.5, 8.0))):
        q = a + t * u_ + out * o_
        if HS.sample(g, d_bldg, q.x, q.y) > 1.5:
            furn['bench_park'].append((q.x, q.y, heading_of((-out.x, -out.y)) + 180))
    q = a + t * (ln + 2.0) + out * 4.5
    furn['phone_booth'].append((q.x, q.y, heading_of((t.x, t.y))))
    add_sign('sign_phone_0', 'Phone booth header', (q.x, q.y, H(q.x, q.y) + 2.4), (t.x, t.y), 'Telefon', (0.96, 0.26),
             font='Barlow Condensed', color='#1b3c8a', background='#f0d23c', backlit=1, doubleSided=False)
    for k in range(2):
        q = a + t * (-2.0 - k * 3.4) + out * 3.4
        if HS.sample(g, d_bldg, q.x, q.y) > 1.0:
            furn['bike_rack'].append((q.x, q.y, heading_of((t.x, t.y)) + 90))
    q = a + t * (ln * 0.5) + out * 5.2
    furn['bin_post'].append((q.x, q.y, heading_of((-out.x, -out.y))))

for name, lst in furn.items():
    if not lst:
        continue
    objects.append({'id': f'furniture_{name}', 'name': f'Street furniture ({name})', 'type': 'instances', 'semantic': 'prop',
                    'asset': f'{ASSET_REL}/{name}.glb', 'castShadow': True, 'transform': {'position': [0, 0, 0]},
                    'instances': [[*to_engine((x, y, H(x, y) + 0.1)), round(h, 1), 1.0] for (x, y, h) in lst]})
print('  ' + ', '.join(f'{k} {len(v)}' for k, v in furn.items()))


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


# =============================================================== decals
# Road paint (zebra crossings, centre dashes, parking bays), manholes, oil, water
# streaks down the viaduct beams, grime along shop bases. Runtime decals: no bake.
print('Decals...')
from common import quat_mul  # noqa: E402
rng_d = random.Random(1966)
ndec = 0


def ground_decal(mat, x, y, z, w, h, along, repeat=1.0, opacity=1.0, depth=0.35):
    """Decal on the ground; `along` = compass heading of the decal's width axis."""
    global ndec
    qx = [-0.7071068, 0, 0, 0.7071068]          # local +Z -> up
    q = quat_mul(yaw_quat(90.0 - along), qx)
    objects.append({'id': f'decal_{ndec:04d}', 'type': 'decal', 'semantic': 'decal',
                    'transform': {'position': to_engine((x, y, z)), 'rotation': [round(v, 6) for v in q]},
                    'decal': {'material': mat, 'size': [round(w, 3), round(h, 3), depth], 'repeat': repeat, 'opacity': opacity}})
    ndec += 1


def wall_decal(mat, x, y, z, w, h, facing, opacity=1.0, depth=0.5):
    """Decal on a wall facing compass heading `facing`."""
    global ndec
    objects.append({'id': f'decal_{ndec:04d}', 'type': 'decal', 'semantic': 'decal',
                    'transform': {'position': to_engine((x, y, z)), 'rotation': yaw_quat(facing + 180)},
                    'decal': {'material': mat, 'size': [round(w, 3), round(h, 3), depth], 'opacity': opacity}})
    ndec += 1


def centreline_dir(x, y):
    """Unit direction of the nearest carriageway centreline segment."""
    best, bd_ = None, 1e9
    for pts, m in roads:
        for a_, c_ in zip(pts, pts[1:]):
            dx, dy = c_[0] - a_[0], c_[1] - a_[1]
            l2 = dx * dx + dy * dy
            if l2 < 1e-9:
                continue
            t_ = max(0.0, min(1.0, ((x - a_[0]) * dx + (y - a_[1]) * dy) / l2))
            dd = math.hypot(x - a_[0] - dx * t_, y - a_[1] - dy * t_)
            if dd < bd_:
                bd_, best = dd, (dx / math.sqrt(l2), dy / math.sqrt(l2))
    return best


# zebra crossings (bars along the traffic direction, side by side across the road)
for c in L['crossings']:
    if not (X0 + 5 < c[0] < X1 - 5 and Y0 + 5 < c[1] < Y1 - 5) or HS.sample(g, d_road, *c) > 0.5:
        continue
    t = centreline_dir(*c)                            # along the road
    n = (t[1], -t[0])
    hd = math.degrees(math.atan2(t[0], t[1]))
    for k in range(-5, 6):
        x, y = c[0] + n[0] * k * 1.0, c[1] + n[1] * k * 1.0
        ends = [(x + t[0] * e_, y + t[1] * e_) for e_ in (-1.6, 0.0, 1.6)]
        if any(HS.sample(g, d_road, ex, ey) > -0.25 for (ex, ey) in ends):
            continue
        ground_decal('decal_paint_line', x, y, H(x, y), 3.0, 0.5, hd, repeat=6.0, opacity=0.9)
# centre dashes on the main roads
for pts, m in roads:
    if m['width'] < 7.4 or m['kind'] == 'service':
        continue
    for (p, t) in resample(pts, 12.0):
        if HS.sample(g, d_road, p[0] + t[1] * 4.5, p[1] - t[0] * 4.5) < 0 and HS.sample(g, d_road, p[0] - t[1] * 4.5, p[1] + t[0] * 4.5) < 0:
            continue                                  # junction
        if any(math.dist(p, c) < 6 for c in L['crossings']):
            continue
        ground_decal('decal_paint_line', p[0], p[1], H(*p), 3.0, 0.11, math.degrees(math.atan2(t[0], t[1])), repeat=1.5, opacity=0.85)
# manholes and cracks
for pts, m in roads:
    for (p, t) in resample(pts, 37.0):
        o = rng_d.uniform(-1.2, 1.2)
        x, y = p[0] + t[1] * o, p[1] - t[0] * o
        if X0 < x < X1 and Y0 < y < Y1:
            ground_decal('decal_manhole', x, y, H(x, y), 0.7, 0.7, rng_d.uniform(0, 360))
            if rng_d.random() < 0.5:
                ground_decal('decal_crack', x + t[0] * 6, y + t[1] * 6, H(x, y), rng_d.uniform(1.5, 3.0), rng_d.uniform(1.0, 2.0), rng_d.uniform(0, 360), opacity=0.8)
# parking: bay lines between stalls of each parked row and oil stains under the cars
for (mdl, col, x, y, h) in parked:
    hx, hy = math.sin(math.radians(h)), math.cos(math.radians(h))
    if rng_d.random() < 0.55:
        ground_decal('decal_oil', x + hx * 0.8, y + hy * 0.8, H(x, y), 1.1, 1.5, h + rng_d.uniform(-20, 20), opacity=0.75)
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
    for vv in np.arange(min(vs) + 2.6, max(vs) - 2.4, 0.5):
        phase = (vv - min(vs)) % 16.0
        if not (abs(phase - 2.6) < 0.25 or abs(phase - 13.4) < 0.25):
            continue
        for uu in np.arange(min(us) + 1.4 - 1.275, max(us) - 1.2, 2.55):
            p = u * uu + v * vv
            if all(HL.poly_contains(ring, q.x, q.y) for q in (p + v * 2.3, p - v * 2.3)):
                ground_decal('decal_paint_line', p.x, p.y, H(p.x, p.y), 4.6, 0.1, math.degrees(math.atan2(v.x, v.y)), repeat=2.3, opacity=0.8)
# viaduct: water streaks down the edge beams, every ~7 m
for loop in deck_loops:
    for i in range(len(loop)):
        a, c = loop[i], loop[(i + 1) % len(loop)]
        if on_end(a) and on_end(c):
            continue
        ln = math.dist(a, c)
        t = ((c[0] - a[0]) / ln, (c[1] - a[1]) / ln)
        out = (t[1], -t[0])
        for s_ in np.arange(2.0, ln - 1.0, 7.0 + rng_d.uniform(-2, 2)):
            x, y = a[0] + t[0] * s_ + out[0] * 0.02, a[1] + t[1] * s_ + out[1] * 0.02
            wall_decal('decal_waterstreak', x, y, SOFFIT_Z + 0.75, rng_d.uniform(0.8, 1.6), 1.6, math.degrees(math.atan2(out[0], out[1])), opacity=0.8)
# grime along the base of the shop walls and the station front
for (a, u, ln, zb, z0, bd) in SHOP_WALLS:
    out = (u[1], -u[0])
    for s_ in np.arange(3.0, ln - 2.0, 8.0):
        x, y = a[0] + u[0] * s_ + out[0] * 0.02, a[1] + u[1] * s_ + out[1] * 0.02
        wall_decal('decal_grime_base', x, y, z0 + 0.35, 8.0, 0.8, math.degrees(math.atan2(out[0], out[1])), opacity=0.7)
print(f'  {ndec} decals')


# =============================================================== vegetation
# November 1993: bare birches in groups on the lawns, pines on the rocky east hill
# and along the rock cut, scattered spruces, shrubs along building bases. No OSM
# trees exist here, so placement is rule-based (free lawn, clearances, clumping).
print('Planting...')
TREE_ASSET = 'assets/testmap/{}.model.json'
# Bare maples / limes for the parks and streets (built once; RILL_TREES=1 rebuilds them).
import tempfile  # noqa: E402
import trees as TREES  # noqa: E402
for nm_, seed_ in (('tree_maple_a', 51), ('tree_maple_b', 52)):
    if os.environ.get('RILL_TREES') or not os.path.exists(os.path.join(ASSET_DIR, f'{nm_}.model.json')):
        TREES.build_tree(nm_, 'broadleaf', seed_, ASSET_DIR, tempfile.mkdtemp(prefix='rill_impostor_'))
MAPLE_ASSET = ASSET_REL + '/{}.model.json'
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
        sp = 'tree_birch_a' if r < 0.22 else 'tree_birch_b' if r < 0.42 else 'tree_maple_a' if r < 0.55 else \
            'tree_maple_b' if r < 0.66 else 'tree_spruce_a' if r < 0.73 else 'tree_spruce_b' if r < 0.79 else \
            'tree_pine_b' if r < 0.87 else 'shrub_a'
    birch = 'birch' in sp
    rad = 3.2 if birch else 5.0 if 'pine' in sp else 5.5 if 'maple' in sp else 4.2 if 'spruce' in sp else 2.2
    if 'shrub' not in sp and db < 5.0:
        continue
    if not sc.ok(x, y, rad):
        continue
    s_ = rng_v.uniform(0.95, 1.35) if birch else rng_v.uniform(0.9, 1.3)
    plant(sp, x, y, round(s_, 3), rad)

# Trees in round concrete planters on the station forecourt and the courtyard.
b = MeshBuilder('tree_planter')
ring_o = [(1.05 * math.cos(2 * math.pi * k / 20), 1.05 * math.sin(2 * math.pi * k / 20)) for k in range(20)]
ring_i = [(0.88 * x, 0.88 * y) for (x, y) in ring_o]
for k in range(20):
    k2 = (k + 1) % 20
    b.quad((*ring_o[k], -0.1), (*ring_o[k2], -0.1), (*ring_o[k2], 0.45), (*ring_o[k], 0.45), 'concrete_cast')
    b.quad((*ring_o[k], 0.45), (*ring_o[k2], 0.45), (*ring_i[k2], 0.45), (*ring_i[k], 0.45), 'concrete_cast')
    b.quad((*ring_i[k2], 0.3), (*ring_i[k], 0.3), (*ring_i[k], 0.45), (*ring_i[k2], 0.45), 'concrete_cast')
b.face([(x, y, 0.3) for (x, y) in ring_i], 'dirt')
build(b, None)
planters = []
for (px, py) in [(-84, -34), (-74, -36), (-64, -37), (-54, -36), (-70, -10), (-82, -12), (-44, 110), (-28, 118), (-36, 128)]:
    if HS.sample(g, d_bldg, px, py) < 3.0 or not sc.ok(px, py, 4.0) or HS.sample(g, d_road, px, py) < 2.5:
        continue
    if any((px - p[2]) ** 2 + (py - p[3]) ** 2 < 4.0 ** 2 for p in parked):
        continue
    planters.append((px, py))
    sc.add(px, py, 4.0)
    plants.setdefault('tree_maple_a' if len(planters) % 2 else 'tree_maple_b', []).append(
        (px, py, H(px, py) + 0.25, rng_v.uniform(0, 360), round(rng_v.uniform(0.8, 0.95), 3)))
if planters:
    objects.append({'id': 'planters', 'name': 'Tree planters', 'type': 'instances', 'semantic': 'prop', 'asset': f'{ASSET_REL}/tree_planter.glb',
                    'castShadow': True, 'transform': {'position': [0, 0, 0]},
                    'instances': [[*to_engine((x, y, H(x, y) + 0.1)), 0.0, 1.0] for (x, y) in planters]})

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
        'asset': (MAPLE_ASSET if 'maple' in name else TREE_ASSET).format(name), 'castShadow': True,
        'transform': {'position': [0, 0, 0]},
        'instances': [[*to_engine((x, y, z)), round(yaw, 1), s_] for (x, y, z, yaw, s_) in lst],
    })
    ntrees += len(lst)
print('  ' + ', '.join(f'{k} {len(v)}' for k, v in sorted(plants.items())) + f'  (total {ntrees})')


# =============================================================== document
def write_doc():
    gz = lambda x, y: H(x, y) + 0.12
    hd_ = lambda v: math.degrees(math.atan2(v.x, v.y))
    c0 = HP(S_DOOR, -14.0)
    c1 = HP(S_DOOR + 6.0, 1.2)
    c2 = HP((SA0 + SA1) / 2, B_FOOT - 1.4)
    c3 = HP(S_MID, 3.6)
    VIEWS = [
        ('Station entrance (shop street)', (c0.x, c0.y, gz(c0.x, c0.y)), hd_(WB), 6),
        ('Ticket hall and barrier', (c1.x, c1.y, Z_HALL), hd_(WB) - 38, -4),
        ('Stairs to the platform', (c2.x, c2.y, Z_HALL), hd_(WB), 18),
        ('Platform, stair house', (c3.x, c3.y, PLAT_Z), hd_(WB) + 4, -2),
        ('Hässelby torg, Resenärer', (-79, 55, gz(-79, 55)), -26, 2),
        ('Forecourt shops', (-52, -44, gz(-52, -44)), 28, 6),
        ('Astrakangatan under the bridge', (32, -62, gz(32, -62)), -10, 6),
        ('Courtyard, Hässelby torg 14-22', (-36, 126, gz(-36, 126)), 120, 4),
        ('Rock cut', (104, 47.5, BED_Z + 0.3), 78, 3),
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
        'environment': {'preset': 'november'},
        'spawn': {'position': to_engine(VIEWS[0][1]), 'yaw': VIEWS[0][2], 'pitch': 0},
        'objects': objects,
    }
    if os.path.exists(os.path.join(os.path.dirname(MAP_PATH), 'lightmaps', 'lightmapset.json')):
        doc['lightmaps'] = 'lightmaps/lightmapset.json'
    os.makedirs(os.path.dirname(MAP_PATH), exist_ok=True)
    with open(MAP_PATH, 'w') as f:
        json.dump(doc, f, indent=1)
    print(f'Wrote {MAP_PATH}: {len(objects)} objects')


write_doc()
