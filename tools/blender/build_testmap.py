"""Builds the M1 engine test map: geometry assets (GLB) + map document (JSON).

  blender -b --factory-startup -P tools/blender/build_testmap.py

Everything is authored in Blender coordinates (Z up, +Y north) at real-world
scale. Unique static architecture is built in world space (identity
transform); reusable props are built at a local origin and placed by the map.
This is deliberately *test content*: simple geometry designed to expose
scale, filtering, shadow, lighting, fog and performance behaviour.
"""

import math
import os
import random
import sys

import bpy
from mathutils import Vector, noise

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (PUBLIC, MeshBuilder, export_glb, quat_mul, reset_scene,  # noqa: E402
                    smoothstep, to_engine, yaw_quat)

ASSET_REL = 'assets/testmap'
ASSET_DIR = os.path.join(PUBLIC, ASSET_REL)
MAP_PATH = os.path.join(PUBLIC, 'maps', 'testmap', 'map.json')

# Lightmap texel densities (texels per metre).
TPM_TERRAIN = 4
TPM_GROUND = 5
TPM_ARCH = 12
TPM_DETAIL = 16

reset_scene()
random.seed(7)
objects = []  # map document objects


def add_mesh_object(obj_id, name, asset, semantic, pos=(0, 0, 0), yaw=0.0, lightmap=None, collision=True, cast=True, overrides=None, extra=None):
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
    if overrides:
        o['materialOverrides'] = overrides
    if extra:
        o.update(extra)
    objects.append(o)


def build(builder, lightmap_tpm=None, custom_normals=None, vertex_color=None, color_max_edge=None):
    obj, res = builder.finish(lightmap_tpm, custom_normals=custom_normals, vertex_color=vertex_color, color_max_edge=color_max_edge)
    export_glb(obj, os.path.join(ASSET_DIR, builder.name + '.glb'))
    tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    print(f'  {builder.name:24s} {tris:7d} tris  lightmap {res}')
    return res


# =============================================================== layout
WALL_X0, WALL_X1 = -6.0, 56.0
WALL_Y0, WALL_Y1 = 13.6, 14.4
STAIR_X0, STAIR_X1 = 20.0, 23.0
UP_X0, UP_X1 = -15.0, -9.0          # underpass outer footprint
UP_IX0, UP_IX1 = -14.5, -9.5        # inner clear width (5 m)
UP_FLOOR = -3.1
UP_CEIL = -0.5
RAMP_LEN = 24.0

PAVED = [  # terrain holes (x0, x1, y0, y1), integer aligned
    (-100, 100, -7, 7),     # road + sidewalks
    (-40, -16, 7, 12),      # plaza
    (-30, -18, 12, 22),     # small building
    (UP_X0, UP_X1, 7, 31), (UP_X0, UP_X1, -31, -7),  # underpass troughs
    (-45, -18, -30, -7),    # parking
    (5, 50, -32, -20),      # large building
]


def plateau_x(x):
    return smoothstep(WALL_X0, WALL_X0 + 8, x) * (1 - smoothstep(WALL_X1 - 8, WALL_X1, x))


# Distant lakes (Stockholm is never far from water): centre, semi-axes, rotation.
LAKES = [((-640.0, 860.0), (430.0, 220.0), 0.55), ((1180.0, -420.0), (300.0, 190.0), -0.35), ((-1250.0, -900.0), (260.0, 160.0), 0.2)]


def lake_e(x, y, lake):
    (cx, cy), (ax, ay), rot = lake
    dx, dy = x - cx, y - cy
    c, s_ = math.cos(rot), math.sin(rot)
    u, v = dx * c + dy * s_, -dx * s_ + dy * c
    return math.hypot(u / ax, v / ay)


_lake_levels = {}


def lake_level(i):
    if i not in _lake_levels:
        (cx, cy), (ax, ay), rot = LAKES[i]
        shore = []
        for k in range(48):
            t = 2 * math.pi * k / 48
            u, v = math.cos(t) * ax, math.sin(t) * ay
            shore.append(H0(cx + u * math.cos(rot) - v * math.sin(rot), cy + u * math.sin(rot) + v * math.cos(rot)))
        _lake_levels[i] = min(shore) - 0.6
    return _lake_levels[i]


def H(x, y):
    """Terrain height (metres), with lake basins far outside the map."""
    h = H0(x, y)
    if max(abs(x), abs(y)) > 300:
        for i, lk in enumerate(LAKES):
            e = lake_e(x, y, lk)
            if e < 1.2:
                h = h + (lake_level(i) - 3.0 - h) * smoothstep(1.15, 0.85, e)
    return h


def H0(x, y):
    """Terrain height (metres) before lakes."""
    h = 0.0
    if y >= WALL_Y1 - 1e-6:
        h = 3.0 * plateau_x(x)
    # Wooded hill to the north-east, rising behind the retaining wall.
    d = math.hypot(x - 62, y - 72)
    north = smoothstep(WALL_Y1, 34, y)
    h += 15.0 * smoothstep(80, 8, d) * north
    # Rolling ground away from the flat urban core and the road corridor.
    core = max(smoothstep(58, 72, abs(x - 5)), smoothstep(36, 48, y), smoothstep(-34, -46, y))
    core *= smoothstep(9, 22, abs(y))
    h += core * (2.5 * noise.noise(Vector((x / 38.0, y / 38.0, 0.3))) + 1.0 * noise.noise(Vector((x / 13.0, y / 13.0, 1.7))))
    # Beyond the map edge: distant hills.
    r = max(abs(x), abs(y))
    h += smoothstep(100, 450, r) * (18 + 30 * noise.noise(Vector((x / 520.0, y / 520.0, 5.1))))
    return h


def terrain_normal(p):
    e = 0.5
    dx = (H(p.x + e, p.y) - H(p.x - e, p.y)) / (2 * e)
    dy = (H(p.x, p.y + e) - H(p.x, p.y - e)) / (2 * e)
    return Vector((-dx, -dy, 1)).normalized()


def in_paved(x, y):
    return any(x0 <= x <= x1 and y0 <= y <= y1 for (x0, x1, y0, y1) in PAVED)


def forest_floor(x, y):
    return (y > WALL_Y1 and x > WALL_X0 - 2) or y > 40 or abs(x) > 72 or y < -45


def forest_weight(x, y):
    """Soft lawn -> forest-floor mask (vertex colour R on the terrain blend material)."""
    plateau = smoothstep(WALL_Y1 + 0.5, WALL_Y1 + 7, y) * smoothstep(WALL_X0 - 4, WALL_X0 + 4, x)
    w = max(plateau, smoothstep(34, 46, y), smoothstep(64, 78, abs(x)), smoothstep(-40, -50, y))
    w += 0.35 * noise.noise(Vector((x / 9.0, y / 9.0, 2.3)))
    return min(1.0, max(0.0, w))


def terrain_color(co, mat):
    return (forest_weight(co.x, co.y), 0.0, 0.0, 1.0)


print('Building terrain...')
ROWS = sorted(set([float(v) for v in range(-100, 101)] + [WALL_Y0, WALL_Y1]))
COLS = [float(v) for v in range(-100, 101)]
for cy in range(4):
    for cx in range(4):
        x0, x1 = -100 + 50 * cx, -50 + 50 * cx
        y0, y1 = -100 + 50 * cy, -50 + 50 * cy
        b = MeshBuilder(f'terrain_{cx}_{cy}')
        cols = [c for c in COLS if x0 <= c <= x1]
        rows = [r for r in ROWS if y0 <= r <= y1]
        faces = 0
        for j in range(len(rows) - 1):
            for i in range(len(cols) - 1):
                xa, xb, ya, yb = cols[i], cols[i + 1], rows[j], rows[j + 1]
                mx, my = (xa + xb) / 2, (ya + yb) / 2
                if in_paved(mx, my):
                    continue
                # Heights: evaluate each corner from the side of the quad (wall discontinuity).
                def hz(x, y):
                    if abs(y - WALL_Y1) < 1e-6 and my < WALL_Y1:
                        return H(x, y - 1e-3)
                    return H(x, y)
                mat = 'terrain_blend'
                b.quad((xa, ya, hz(xa, ya)), (xb, ya, hz(xb, ya)), (xb, yb, hz(xb, yb)), (xa, yb, hz(xa, yb)), mat, smooth=True)
                faces += 1
        # Skirts on the map boundary hide T-junction cracks against the far landscape.
        edges = []
        if y0 == -100: edges.append([(c, -100.0) for c in cols])            # faces -y: +x
        if y1 == 100: edges.append([(c, 100.0) for c in reversed(cols)])    # faces +y: -x
        if x1 == 100: edges.append([(100.0, r) for r in rows])              # faces +x: +y
        if x0 == -100: edges.append([(-100.0, r) for r in reversed(rows)])  # faces -x: -y
        for seq in edges:
            for k in range(len(seq) - 1):
                (ax, ay), (bx, by) = seq[k], seq[k + 1]
                b.quad((ax, ay, H(ax, ay) - 2), (bx, by, H(bx, by) - 2), (bx, by, H(bx, by)), (ax, ay, H(ax, ay)), 'ground_forest')
        if faces:
            res = build(b, TPM_TERRAIN, custom_normals=terrain_normal, vertex_color=terrain_color)
            add_mesh_object(f'terrain_{cx}_{cy}', f'Terrain chunk {cx},{cy}', f'terrain_{cx}_{cy}', 'terrain', lightmap=res)

# (far landscape is built after the trees: its tree-line strips are rendered from them)

# =============================================================== road
print('Building road...')
for k in range(8):
    x0, x1 = -100 + 25 * k, -75 + 25 * k
    b = MeshBuilder(f'road_{k}')
    b.quad((x0, -4, 0), (x1, -4, 0), (x1, 4, 0), (x0, 4, 0), 'asphalt')
    for s in (1, -1):
        # curb (granite): road-side face, top
        c0, c1 = 4.0 * s, 4.15 * s
        lo, hi = min(c0, c1), max(c0, c1)
        b.quad((x0, lo, 0.12), (x1, lo, 0.12), (x1, hi, 0.12), (x0, hi, 0.12), 'granite_curb')
        if s > 0:  # faces -y (toward the carriageway)
            b.quad((x0, 4.0, 0), (x1, 4.0, 0), (x1, 4.0, 0.12), (x0, 4.0, 0.12), 'granite_curb')
        else:      # faces +y
            b.quad((x1, -4.0, 0), (x0, -4.0, 0), (x0, -4.0, 0.12), (x1, -4.0, 0.12), 'granite_curb')
        # sidewalk
        w0, w1 = (4.15, 7.0) if s > 0 else (-7.0, -4.15)
        b.quad((x0, w0, 0.12), (x1, w0, 0.12), (x1, w1, 0.12), (x0, w1, 0.12), 'paving_slabs')
        # outer edge face (skip over the underpass)
        segs = [(x0, x1)]
        if x0 < UP_X1 and x1 > UP_X0:
            segs = [(x0, UP_X0), (UP_X1, x1)]
        for (a, c) in segs:
            if c - a < 1e-3:
                continue
            if s > 0:
                b.quad((c, 7.0, 0), (a, 7.0, 0), (a, 7.0, 0.12), (c, 7.0, 0.12), 'paving_slabs')
            else:
                b.quad((a, -7.0, 0), (c, -7.0, 0), (c, -7.0, 0.12), (a, -7.0, 0.12), 'paving_slabs')
    res = build(b, TPM_GROUND)
    add_mesh_object(f'road_{k}', f'Main road segment {k}', f'road_{k}', 'road', lightmap=res)

# =============================================================== plaza + parking
print('Building plaza / parking...')
b = MeshBuilder('plaza')
b.quad((-40, 7, 0.12), (-16, 7, 0.12), (-16, 12, 0.12), (-40, 12, 0.12), 'paving_slabs')
b.quad((-40, 12, 0), (-40, 7, 0), (-40, 7, 0.12), (-40, 12, 0.12), 'paving_slabs')
b.quad((-16, 7, 0), (-16, 12, 0), (-16, 12, 0.12), (-16, 7, 0.12), 'paving_slabs')
for (a, c) in [(-40, -30), (-18, -16)]:
    b.quad((c, 12, 0), (a, 12, 0), (a, 12, 0.12), (c, 12, 0.12), 'paving_slabs')
res = build(b, TPM_GROUND)
add_mesh_object('plaza', 'Neighbourhood square', 'plaza', 'plaza', lightmap=res)

b = MeshBuilder('parking')
b.quad((-45, -30, 0.0), (-18, -30, 0.0), (-18, -7, 0.0), (-45, -7, 0.0), 'asphalt')
res = build(b, TPM_GROUND)
add_mesh_object('parking', 'Parking area', 'parking', 'parking', lightmap=res)


# =============================================================== buildings
def wall_with_openings(b, o, u, length, height, openings, depth, wall_mat, plinth=0.0, plinth_mat='concrete_cast', bands=(), band_mat='concrete_cast', glass_mat='glass_window', frame_mat='window_frame', door_mat='wood_door'):
    """Facade rectangle with rectangular openings (reveals, frames, glass).

    o: bottom-left corner seen from outside; u: unit vector along the wall to
    the right (seen from outside). Openings: (u0, z0, w, h, kind).
    """
    o, u = Vector(o), Vector(u).normalized()
    z = Vector((0, 0, 1))
    n = u.cross(z)  # outward
    us = {0.0, length}
    zs = {0.0, height}
    if plinth > 0:
        zs.add(plinth)
    for (z0, z1) in bands:
        zs.update([z0, z1])
    for (u0, z0, w, h, _k) in openings:
        us.update([u0, u0 + w])
        zs.update([z0, z0 + h])
    us, zs = sorted(us), sorted(zs)
    P = lambda a, c, dd=0.0: o + u * a + z * c - n * dd
    for j in range(len(zs) - 1):
        for i in range(len(us) - 1):
            ua, ub, za, zb = us[i], us[i + 1], zs[j], zs[j + 1]
            mu, mz = (ua + ub) / 2, (za + zb) / 2
            if any(u0 < mu < u0 + w and z0 < mz < z0 + h for (u0, z0, w, h, _k) in openings):
                continue
            mat = wall_mat
            if mz < plinth:
                mat = plinth_mat
            elif any(z0 <= mz <= z1 for (z0, z1) in bands):
                mat = band_mat
            b.quad(P(ua, za), P(ub, za), P(ub, zb), P(ua, zb), mat)
    for (u0, z0, w, h, kind) in openings:
        d = depth
        # reveals (inward faces)
        b.quad(P(u0, z0), P(u0, z0, d), P(u0, z0 + h, d), P(u0, z0 + h), wall_mat)              # left jamb (faces +u)
        b.quad(P(u0 + w, z0, d), P(u0 + w, z0), P(u0 + w, z0 + h), P(u0 + w, z0 + h, d), wall_mat)  # right jamb
        b.quad(P(u0, z0 + h), P(u0, z0 + h, d), P(u0 + w, z0 + h, d), P(u0 + w, z0 + h), wall_mat)  # head (faces down)
        sill_mat = 'metal_galvanized' if kind == 'window' else wall_mat
        b.quad(P(u0, z0, d), P(u0, z0), P(u0 + w, z0), P(u0 + w, z0, d), sill_mat)             # sill (faces up)
        pane = door_mat if kind == 'door' else glass_mat
        f = 0.06
        # frame ring slightly in front of the pane
        fd = d - 0.02
        b.quad(P(u0, z0, fd), P(u0 + w, z0, fd), P(u0 + w, z0 + f, fd), P(u0, z0 + f, fd), frame_mat)
        b.quad(P(u0, z0 + h - f, fd), P(u0 + w, z0 + h - f, fd), P(u0 + w, z0 + h, fd), P(u0, z0 + h, fd), frame_mat)
        b.quad(P(u0, z0 + f, fd), P(u0 + f, z0 + f, fd), P(u0 + f, z0 + h - f, fd), P(u0, z0 + h - f, fd), frame_mat)
        b.quad(P(u0 + w - f, z0 + f, fd), P(u0 + w, z0 + f, fd), P(u0 + w, z0 + h - f, fd), P(u0 + w - f, z0 + h - f, fd), frame_mat)
        if kind == 'window' and w > 1.0:
            mid = u0 + w / 2
            b.quad(P(mid - 0.03, z0 + f, fd), P(mid + 0.03, z0 + f, fd), P(mid + 0.03, z0 + h - f, fd), P(mid - 0.03, z0 + h - f, fd), frame_mat)
        # Pane spans the full opening so no void is visible behind the frame ring.
        b.quad(P(u0, z0, d), P(u0 + w, z0, d), P(u0 + w, z0 + h, d), P(u0, z0 + h, d), pane)


def flat_roof(b, x0, x1, y0, y1, z, parapet, t=0.25, roof_mat='gravel', cap_mat='metal_dark', wall_mat='plaster'):
    b.quad((x0 + t, y0 + t, z), (x1 - t, y0 + t, z), (x1 - t, y1 - t, z), (x0 + t, y1 - t, z), roof_mat)
    zt = z + parapet
    # cap (top of parapet ring)
    b.quad((x0, y0, zt), (x1, y0, zt), (x1, y0 + t, zt), (x0, y0 + t, zt), cap_mat)
    b.quad((x0, y1 - t, zt), (x1, y1 - t, zt), (x1, y1, zt), (x0, y1, zt), cap_mat)
    b.quad((x0, y0 + t, zt), (x0 + t, y0 + t, zt), (x0 + t, y1 - t, zt), (x0, y1 - t, zt), cap_mat)
    b.quad((x1 - t, y0 + t, zt), (x1, y0 + t, zt), (x1, y1 - t, zt), (x1 - t, y1 - t, zt), cap_mat)
    # inner parapet faces
    b.quad((x1 - t, y0 + t, z), (x0 + t, y0 + t, z), (x0 + t, y0 + t, zt), (x1 - t, y0 + t, zt), wall_mat)
    b.quad((x0 + t, y1 - t, z), (x1 - t, y1 - t, z), (x1 - t, y1 - t, zt), (x0 + t, y1 - t, zt), wall_mat)
    b.quad((x0 + t, y0 + t, z), (x0 + t, y1 - t, z), (x0 + t, y1 - t, zt), (x0 + t, y0 + t, zt), wall_mat)
    b.quad((x1 - t, y1 - t, z), (x1 - t, y0 + t, z), (x1 - t, y0 + t, zt), (x1 - t, y1 - t, zt), wall_mat)


print('Building small building...')
b = MeshBuilder('building_small')
X0, X1, Y0, Y1, HT = -30.0, -18.0, 12.0, 22.0, 7.0
W = 'plaster_ochre'
up_z = 4.3
wall_with_openings(b, (X0, Y0, 0), (1, 0, 0), X1 - X0, HT,
                   [(4.5, 0.12, 1.0, 2.1, 'door'), (0.8, 0.75, 2.6, 1.9, 'window'), (6.4, 0.75, 4.6, 1.9, 'window')] +
                   [(c - 0.6, up_z, 1.2, 1.4, 'window') for c in (1.8, 4.9, 8.0, 10.6)],
                   0.18, W, plinth=0.45)
wall_with_openings(b, (X1, Y1, 0), (-1, 0, 0), X1 - X0, HT,
                   [(2.0, 0.12, 0.9, 2.1, 'door')] + [(c - 0.5, up_z, 1.0, 1.2, 'window') for c in (5.0, 8.0, 10.5)] + [(6.5, 1.0, 1.0, 1.2, 'window')],
                   0.18, W, plinth=0.45)
wall_with_openings(b, (X1, Y0, 0), (0, 1, 0), Y1 - Y0, HT,
                   [(c - 0.6, 0.9, 1.2, 1.4, 'window') for c in (2.5, 7.5)] + [(c - 0.6, up_z, 1.2, 1.4, 'window') for c in (2.5, 5.0, 7.5)],
                   0.18, W, plinth=0.45)
wall_with_openings(b, (X0, Y1, 0), (0, -1, 0), Y1 - Y0, HT,
                   [(c - 0.6, up_z, 1.2, 1.4, 'window') for c in (2.5, 5.0, 7.5)],
                   0.18, W, plinth=0.45)
# parapet outer faces above the roof line are part of the walls (HT includes parapet? no) -> add them
for (a, c, uu, L) in [((X0, Y0, HT), None, (1, 0, 0), X1 - X0), ((X1, Y1, HT), None, (-1, 0, 0), X1 - X0), ((X1, Y0, HT), None, (0, 1, 0), Y1 - Y0), ((X0, Y1, HT), None, (0, -1, 0), Y1 - Y0)]:
    wall_with_openings(b, a, uu, L, 0.5, [], 0.1, W)
flat_roof(b, X0, X1, Y0, Y1, HT, 0.5, wall_mat=W)
# entrance canopy
b.box(-26.2, -23.8, 10.9, 12.0, 2.6, 2.75, 'metal_dark')
res = build(b, TPM_ARCH)
add_mesh_object('building_small', 'Kiosk / shop pavilion', 'building_small', 'building', lightmap=res)

print('Building large building...')
b = MeshBuilder('building_large')
X0, X1, Y0, Y1 = 5.0, 50.0, -32.0, -20.0
FL, NF = 2.9, 5
HT = FL * NF
ARC = -23.0   # ground-floor recess line (arcade under the overhang)
panel = 'concrete_aggregate'
bands = [(FL * k - 0.2, FL * k + 0.1) for k in range(1, NF)]
win = lambda z: [(1.0 + 3.0 * i, z + 0.85, 1.5, 1.4, 'window') for i in range(15)]
# north facade (upper floors over the arcade)
wall_with_openings(b, (X1, Y1, FL), (-1, 0, 0), X1 - X0, HT - FL,
                   sum([[(u0, z0 - FL, w, h, k) for (u0, z0, w, h, k) in win(FL * f)] for f in range(1, NF)], []),
                   0.2, panel, bands=[(z0 - FL, z1 - FL) for (z0, z1) in bands])
# arcade: recessed ground-floor wall + overhang soffit + columns
wall_with_openings(b, (X1, ARC, 0), (-1, 0, 0), X1 - X0, FL,
                   [(2.0, 0.0, 1.8, 2.3, 'door'), (6.0, 0.6, 4.0, 1.9, 'window'), (12.0, 0.6, 4.0, 1.9, 'window'), (20.0, 0.0, 1.8, 2.3, 'door'),
                    (24.0, 0.6, 5.0, 1.9, 'window'), (31.0, 0.6, 5.0, 1.9, 'window'), (38.5, 0.0, 1.8, 2.3, 'door'), (41.5, 0.6, 2.5, 1.9, 'window')],
                   0.12, 'plaster_white', plinth=0.3)
b.quad((X0, Y1, FL), (X1, Y1, FL), (X1, ARC, FL), (X0, ARC, FL), 'concrete_cast')  # soffit (faces down)
b.quad((X1, Y1, FL - 0.35), (X0, Y1, FL - 0.35), (X0, Y1, FL), (X1, Y1, FL), 'concrete_cast')  # edge beam face (+y)
b.quad((X0, Y1 - 0.25, FL - 0.35), (X1, Y1 - 0.25, FL - 0.35), (X1, Y1 - 0.25, FL), (X0, Y1 - 0.25, FL), 'concrete_cast')  # beam inner face (-y)
b.quad((X1, Y1 - 0.25, FL - 0.35), (X0, Y1 - 0.25, FL - 0.35), (X0, Y1, FL - 0.35), (X1, Y1, FL - 0.35), 'concrete_cast')  # beam underside
for i in range(10):
    cx = X0 + 0.5 + i * (X1 - X0 - 1.0) / 9
    b.box(cx - 0.2, cx + 0.2, Y1 - 0.45, Y1 - 0.05, 0.0, FL - 0.35, 'concrete_cast', skip=('+z', '-z'))
# arcade end walls (brick) close the recess at x0/x1
b.box(X0, X0 + 0.3, ARC, Y1, 0.0, FL, 'brick_red', skip=('-y', '+z', '-z'))
b.box(X1 - 0.3, X1, ARC, Y1, 0.0, FL, 'brick_red', skip=('-y', '+z', '-z'))
# south facade
wall_with_openings(b, (X0, Y0, 0), (1, 0, 0), X1 - X0, HT,
                   [(u0, z0, w, h, k) for f in range(NF) for (u0, z0, w, h, k) in win(FL * f) if not (f == 0 and 5 <= u0 <= 7)] +
                   [(21.75, 0.0, 1.5, 2.2, 'door')],
                   0.2, panel, plinth=0.4, bands=bands)
# end walls (brick) - east and west, above and beside the arcade recess
wall_with_openings(b, (X1, Y0, 0), (0, 1, 0), ARC - Y0, HT, [(c, FL * f + 0.9, 0.6, 1.3, 'window') for f in range(NF) for c in (3.0, 6.5)], 0.2, 'brick_red', plinth=0.4)
wall_with_openings(b, (X1, ARC, FL), (0, 1, 0), Y1 - ARC, HT - FL, [], 0.2, 'brick_red')
wall_with_openings(b, (X0, Y1, FL), (0, -1, 0), Y1 - ARC, HT - FL, [], 0.2, 'brick_red')
wall_with_openings(b, (X0, ARC, 0), (0, -1, 0), ARC - Y0, HT, [(c, FL * f + 0.9, 0.6, 1.3, 'window') for f in range(NF) for c in (2.4, 5.9)], 0.2, 'brick_red', plinth=0.4)
for (a, uu, L) in [((X0, Y0, HT), (1, 0, 0), X1 - X0), ((X1, Y1, HT), (-1, 0, 0), X1 - X0), ((X1, Y0, HT), (0, 1, 0), Y1 - Y0), ((X0, Y1, HT), (0, -1, 0), Y1 - Y0)]:
    wall_with_openings(b, a, uu, L, 0.6, [], 0.1, 'concrete_cast')
flat_roof(b, X0, X1, Y0, Y1, HT, 0.6, wall_mat='concrete_cast')
# arcade floor paving
b.quad((X0, ARC, 0.02), (X1, ARC, 0.02), (X1, Y1, 0.02), (X0, Y1, 0.02), 'paving_slabs')
res = build(b, TPM_ARCH)
add_mesh_object('building_large', '1960s slab block (lamellhus)', 'building_large', 'building', lightmap=res)

# =============================================================== retaining wall + stairs
print('Building retaining wall / stairs...')
b = MeshBuilder('retaining_wall')
top = lambda x: 3.0 * plateau_x(x) + 0.3
back = lambda x: 3.0 * plateau_x(x)
xs = [float(x) for x in range(int(WALL_X0), int(WALL_X1) + 1)]
spans = [(WALL_X0, STAIR_X0 - 0.25), (STAIR_X1 + 0.25, WALL_X1)]
for (sa, sb) in spans:
    seg = [x for x in xs if sa <= x <= sb]
    if seg[0] != sa:
        seg = [sa] + seg
    if seg[-1] != sb:
        seg = seg + [sb]
    for i in range(len(seg) - 1):
        a, c = seg[i], seg[i + 1]
        b.quad((a, WALL_Y0, 0), (c, WALL_Y0, 0), (c, WALL_Y0, top(c)), (a, WALL_Y0, top(a)), 'wall_blend')
        b.quad((c, WALL_Y1, back(c)), (a, WALL_Y1, back(a)), (a, WALL_Y1, top(a)), (c, WALL_Y1, top(c)), 'wall_blend')
        b.quad((a, WALL_Y0, top(a)), (c, WALL_Y0, top(c)), (c, WALL_Y1, top(c)), (a, WALL_Y1, top(a)), 'wall_blend')
    for (x, sgn) in [(sa, -1), (sb, 1)]:
        if x not in (WALL_X0, WALL_X1):
            continue
        if sgn < 0:
            b.quad((x, WALL_Y1, 0), (x, WALL_Y0, 0), (x, WALL_Y0, top(x)), (x, WALL_Y1, top(x)), 'wall_blend')
        else:
            b.quad((x, WALL_Y0, 0), (x, WALL_Y1, 0), (x, WALL_Y1, top(x)), (x, WALL_Y0, top(x)), 'wall_blend')
def wall_moss(co, mat):
    base = 1.0 - smoothstep(0.0, 0.9, co.z)
    crest = smoothstep(top(co.x) - 0.25, top(co.x), co.z) * 0.8
    n = 0.3 * noise.noise(Vector((co.x / 3.0, co.z / 1.5, 7.1)))
    return (min(1.0, max(0.0, max(base, crest) + n)), 0.0, 0.0, 1.0)


res = build(b, TPM_ARCH, vertex_color=wall_moss, color_max_edge=0.4)
add_mesh_object('retaining_wall', 'Retaining wall (3 m)', 'retaining_wall', 'wall', lightmap=res)

b = MeshBuilder('stairs')
N, RISE, RUN, SY0 = 18, 3.0 / 18, 0.3, 8.2
for i in range(N):
    ya, yb = SY0 + i * RUN, SY0 + (i + 1) * RUN
    z0, z1 = i * RISE, (i + 1) * RISE
    b.quad((STAIR_X0, ya, z1), (STAIR_X1, ya, z1), (STAIR_X1, yb, z1), (STAIR_X0, yb, z1), 'concrete_cast')  # tread
    b.quad((STAIR_X0, ya, z0), (STAIR_X1, ya, z0), (STAIR_X1, ya, z1), (STAIR_X0, ya, z1), 'concrete_cast')  # riser
landing_y1 = 15.0
b.quad((STAIR_X0, SY0 + N * RUN, 3.0), (STAIR_X1, SY0 + N * RUN, 3.0), (STAIR_X1, landing_y1, 3.0), (STAIR_X0, landing_y1, 3.0), 'concrete_cast')
# cheek walls (0.25 thick) with sloped tops following the flight
for (cx0, cx1) in [(STAIR_X0 - 0.25, STAIR_X0), (STAIR_X1, STAIR_X1 + 0.25)]:
    pts = [(SY0 - 0.3, 0.25)] + [(SY0 + (i + 0.5) * RUN, (i + 1) * RISE + 0.25) for i in range(N)] + [(landing_y1, 3.25)]
    pts = [pts[0], (SY0 + N * RUN, 3.25), pts[-1]]
    prof = [(SY0 - 0.3, 0.0, 0.25), (SY0 + N * RUN, 0.0, 3.25), (landing_y1, 3.0, 3.25)]
    for k in range(len(prof) - 1):
        (ya, ba, ta), (yb, bb, tb) = prof[k], prof[k + 1]
        # outer + inner faces, top
        b.quad((cx0, yb, bb), (cx0, ya, ba), (cx0, ya, ta), (cx0, yb, tb), 'concrete_wall')
        b.quad((cx1, ya, ba), (cx1, yb, bb), (cx1, yb, tb), (cx1, ya, ta), 'concrete_wall')
        b.quad((cx0, ya, ta), (cx1, ya, ta), (cx1, yb, tb), (cx0, yb, tb), 'concrete_wall')
    b.quad((cx0, SY0 - 0.3, 0), (cx1, SY0 - 0.3, 0), (cx1, SY0 - 0.3, 0.25), (cx0, SY0 - 0.3, 0.25), 'concrete_wall')
res = build(b, TPM_DETAIL)
add_mesh_object('stairs', 'Concrete stairs (18 x 167 mm)', 'stairs', 'stairs', lightmap=res)

b = MeshBuilder('stair_rails')
for rx in (STAIR_X0 + 0.12, STAIR_X1 - 0.12):
    y0, z0 = SY0 - 0.15, 0.9
    y1, z1 = SY0 + N * RUN, 3.9
    b.tube((rx, y0, z0), (rx, y1, z1), 0.022, 0.022, 'metal_galvanized')
    b.tube((rx, y1, z1), (rx, landing_y1 - 0.1, z1), 0.022, 0.022, 'metal_galvanized')
    for k in range(5):
        t = k / 4
        py = y0 + (y1 - y0) * t
        pz_top = z0 + (z1 - z0) * t
        step_i = min(N - 1, max(0, int((py - SY0) / RUN)))
        b.tube((rx, py, (step_i + 1) * RISE if py > SY0 else 0.0), (rx, py, pz_top), 0.02, 0.02, 'metal_galvanized', caps=False)
build(b)
add_mesh_object('stair_rails', 'Stair handrails', 'stair_rails', 'railing', collision=False)

# =============================================================== underpass
print('Building underpass...')
b = MeshBuilder('underpass')


def floor_z(y):
    a = abs(y)
    if a <= 7:
        return UP_FLOOR
    return UP_FLOOR + (a - 7) * (-UP_FLOOR / RAMP_LEN)


ys = [float(v) for v in range(-31, 32)]
for i in range(len(ys) - 1):
    ya, yb = ys[i], ys[i + 1]
    za, zb = floor_z(ya), floor_z(yb)
    b.quad((UP_IX0, ya, za), (UP_IX1, ya, za), (UP_IX1, yb, zb), (UP_IX0, yb, zb), 'asphalt_path')
    tunnel = abs((ya + yb) / 2) < 7
    wall_top = UP_CEIL if tunnel else 0.4
    tile_top_a, tile_top_b = za + 2.0, zb + 2.0
    for (wx, facing) in [(UP_IX0, 1), (UP_IX1, -1)]:
        # inner faces: tiles band in the tunnel section, concrete above / on ramps
        lo_mat = 'tiles_white' if tunnel else 'concrete_grime'
        if facing > 0:  # +x
            q = lambda z0a, z0b, z1a, z1b, m: b.quad((wx, ya, z0a), (wx, yb, z0b), (wx, yb, z1b), (wx, ya, z1a), m)
        else:           # -x
            q = lambda z0a, z0b, z1a, z1b, m: b.quad((wx, yb, z0b), (wx, ya, z0a), (wx, ya, z1a), (wx, yb, z1b), m)
        if tunnel:
            q(za, zb, tile_top_a, tile_top_b, lo_mat)
            q(tile_top_a, tile_top_b, wall_top, wall_top, 'concrete_grime')
        else:
            q(za, zb, wall_top, wall_top, lo_mat)
    if not tunnel:
        # wall tops and outer faces above ground
        for (ox0, ox1) in [(UP_X0, UP_IX0), (UP_IX1, UP_X1)]:
            b.quad((ox0, ya, 0.4), (ox1, ya, 0.4), (ox1, yb, 0.4), (ox0, yb, 0.4), 'concrete_grime')
        b.quad((UP_X0, yb, 0.0), (UP_X0, ya, 0.0), (UP_X0, ya, 0.4), (UP_X0, yb, 0.4), 'concrete_grime')  # -x
        b.quad((UP_X1, ya, 0.0), (UP_X1, yb, 0.0), (UP_X1, yb, 0.4), (UP_X1, ya, 0.4), 'concrete_grime')  # +x
b.quad((UP_IX0, 7, UP_CEIL), (UP_IX1, 7, UP_CEIL), (UP_IX1, -7, UP_CEIL), (UP_IX0, -7, UP_CEIL), 'concrete_cast')  # ceiling
# portal fascias (deck edge) from the ceiling up to the sidewalk
b.quad((UP_X1, 7, UP_CEIL), (UP_X0, 7, UP_CEIL), (UP_X0, 7, 0.12), (UP_X1, 7, 0.12), 'concrete_grime')
b.quad((UP_X0, -7, UP_CEIL), (UP_X1, -7, UP_CEIL), (UP_X1, -7, 0.12), (UP_X0, -7, 0.12), 'concrete_grime')
# wall ends at the ramp tops
for yy in (31.0, -31.0):
    for (ox0, ox1) in [(UP_X0, UP_IX0), (UP_IX1, UP_X1)]:
        if yy > 0:  # +y
            b.quad((ox1, yy, 0.0), (ox0, yy, 0.0), (ox0, yy, 0.4), (ox1, yy, 0.4), 'concrete_grime')
        else:       # -y
            b.quad((ox0, yy, 0.0), (ox1, yy, 0.0), (ox1, yy, 0.4), (ox0, yy, 0.4), 'concrete_grime')
# ceiling light fixtures
for ly in (-3.5, 3.5):
    b.box(-12.6, -11.4, ly - 0.12, ly + 0.12, UP_CEIL - 0.08, UP_CEIL, 'metal_dark', skip=('+z', '-z'))
    b.quad((-12.6, ly + 0.12, UP_CEIL - 0.08), (-11.4, ly + 0.12, UP_CEIL - 0.08), (-11.4, ly - 0.12, UP_CEIL - 0.08), (-12.6, ly - 0.12, UP_CEIL - 0.08), 'lamp_emissive')
def underpass_grime(co, mat):
    fz = floor_z(co.y)
    w = 1.0 - smoothstep(fz + 0.05, fz + 0.7, co.z)
    w += 0.25 * noise.noise(Vector((co.y / 2.0, co.z, 3.3)))
    return (min(1.0, max(0.0, w)), 0.0, 0.0, 1.0)


res = build(b, TPM_ARCH, vertex_color=underpass_grime, color_max_edge=0.4)
add_mesh_object('underpass', 'Pedestrian underpass + ramps', 'underpass', 'underpass', lightmap=res)

b = MeshBuilder('underpass_rails')
for wx in (UP_X0 + 0.25, UP_X1 - 0.25):
    for (y0, y1) in [(7.2, 31.0), (-31.0, -7.2)]:
        b.tube((wx, y0, 1.4), (wx, y1, 1.4), 0.03, 0.03, 'metal_railing_green')
        b.tube((wx, y0, 0.9), (wx, y1, 0.9), 0.015, 0.015, 'metal_railing_green')
        n = int((y1 - y0) / 2)
        for k in range(n + 1):
            py = y0 + (y1 - y0) * k / n
            b.tube((wx, py, 0.4), (wx, py, 1.4), 0.025, 0.025, 'metal_railing_green', caps=False)
build(b)
add_mesh_object('underpass_rails', 'Underpass railings', 'underpass_rails', 'railing', collision=False)

# =============================================================== paths (ribbons draped on terrain)
print('Building paths...')


def catmull(pts, step=1.0):
    out = []
    P = [pts[0]] + pts + [pts[-1]]
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = [Vector(p) for p in P[i - 1:i + 3]]
        seg_len = (p2 - p1).length
        n = max(1, int(seg_len / step))
        for k in range(n):
            t = k / n
            t2, t3 = t * t, t * t * t
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    out.append(Vector(pts[-1]))
    return out


PATHS = {
    'path_forest': ([(21.5, 14.8), (22.0, 20), (26, 28), (35, 36), (46, 44), (54, 56), (58, 68), (63, 80), (70, 92), (74, 100)], 2.6),
    'path_north': ([(-12, 31), (-13, 40), (-18, 55), (-16, 72), (-10, 88), (-8, 100)], 3.0),
    'path_south': ([(-12, -31), (-12, -45), (-16, -62), (-24, -80), (-28, -100)], 3.0),
}
path_polylines = {}
for name, (ctrl, width) in PATHS.items():
    pts = catmull(ctrl, 1.0)
    path_polylines[name] = pts
    b = MeshBuilder(name)
    L = []
    for i, p in enumerate(pts):
        d = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        side = Vector((-d.y, d.x))
        l = Vector((p.x, p.y)) + side * width / 2
        r = Vector((p.x, p.y)) - side * width / 2
        L.append((r, l))
    for i in range(len(L) - 1):
        (r0, l0), (r1, l1) = L[i], L[i + 1]
        z = lambda v: H(v.x, v.y) + 0.04
        b.quad((r0.x, r0.y, z(r0)), (r1.x, r1.y, z(r1)), (l1.x, l1.y, z(l1)), (l0.x, l0.y, z(l0)), 'asphalt_path', smooth=True)
    res = build(b, TPM_GROUND, custom_normals=terrain_normal)
    add_mesh_object(name, name.replace('_', ' '), name, 'path', lightmap=res, cast=False)


def near_path(x, y, margin):
    for pts in path_polylines.values():
        for p in pts[::2]:
            if (p.x - x) ** 2 + (p.y - y) ** 2 < margin * margin:
                return True
    return False


# =============================================================== props (local-origin assets)
print('Building props...')
b = MeshBuilder('streetlight')
b.tube((0, 0, 0), (0, 0, 8.0), 0.09, 0.06, 'metal_galvanized', sides=12)
b.tube((0, 0, 7.55), (0, -1.9, 7.95), 0.035, 0.035, 'metal_galvanized')
b.box(-0.16, 0.16, -2.35, -1.75, 7.9, 8.05, 'metal_dark')
b.quad((-0.14, -1.77, 7.895), (0.14, -1.77, 7.895), (0.14, -2.33, 7.895), (-0.14, -2.33, 7.895), 'lamp_emissive')
build(b)

b = MeshBuilder('path_light')
b.tube((0, 0, 0), (0, 0, 4.0), 0.05, 0.04, 'metal_dark', sides=10)
b.tube((0, 0, 4.0), (0, 0, 4.18), 0.16, 0.16, 'metal_dark', sides=12)
b.face([(0.16 * math.cos(a), 0.16 * math.sin(a), 3.999) for a in [-2 * math.pi * i / 12 for i in range(12)]], 'lamp_emissive')
build(b)

b = MeshBuilder('bollard')
b.tube((0, 0, 0), (0, 0, 0.9), 0.1, 0.1, 'metal_dark', sides=12)
build(b)

b = MeshBuilder('utility_box')
b.box(-0.4, 0.4, -0.2, 0.2, 0.0, 1.25, 'metal_painted')
build(b)

b = MeshBuilder('bench')
for sx in (-0.8, 0.8):
    b.box(sx - 0.04, sx + 0.04, -0.2, 0.2, 0.0, 0.42, 'metal_dark')
for k in range(3):
    b.box(-0.95, 0.95, -0.2 + k * 0.14, -0.2 + k * 0.14 + 0.11, 0.42, 0.46, 'wood_door')
build(b)

b = MeshBuilder('human_reference')
b.tube((0, 0, 0.0), (0, 0, 1.45), 0.19, 0.17, 'debug_checker', sides=16)
b.tube((0, 0, 1.52), (0, 0, 1.8), 0.1, 0.1, 'debug_checker', sides=12)
build(b)

b = MeshBuilder('car_placeholder')
b.box(-0.9, 0.9, -2.25, 2.25, 0.3, 0.95, 'car_paint')
b.box(-0.8, 0.8, -1.2, 1.0, 0.95, 1.45, 'glass_window', skip=('-z',))  # sits on the body: no coplanar underside
for (wx, wy) in [(-0.8, -1.4), (0.8, -1.4), (-0.8, 1.4), (0.8, 1.4)]:
    # Wheel caps stand 3 cm proud of the body sides (coplanar caps z-fought).
    b.tube((wx - 0.12 * (1 if wx > 0 else -1), wy, 0.32), (wx + 0.13 * (1 if wx > 0 else -1), wy, 0.32), 0.32, 0.32, 'rubber_dark', sides=12)
build(b)

b = MeshBuilder('fence_segment')
b.tube((0, 0, 0), (0, 0, 1.9), 0.03, 0.03, 'metal_galvanized', sides=8)
b.tube((0, 0, 1.85), (2.5, 0, 1.85), 0.02, 0.02, 'metal_galvanized', sides=6)
b.quad((0.03, 0, 0.05), (2.47, 0, 0.05), (2.47, 0, 1.83), (0.03, 0, 1.83), 'fence_chainlink', uvs=[(0.03, 0.05), (2.47, 0.05), (2.47, 1.83), (0.03, 1.83)])
build(b)

for vi, (sx, sy, sz, seed) in enumerate([(3.2, 2.4, 1.3, 1), (5.5, 3.8, 1.8, 2), (2.0, 1.6, 1.1, 3)]):
    b = MeshBuilder(f'rock_{"abc"[vi]}')
    import bmesh as _bm
    tmp = _bm.new()
    _bm.ops.create_icosphere(tmp, subdivisions=3, radius=1.0)
    for v in tmp.verts:
        p = v.co.normalized()
        d = 1 + 0.25 * noise.noise(p * 1.7 + Vector((seed, 0, 0))) + 0.08 * noise.noise(p * 5 + Vector((0, seed, 0)))
        v.co = Vector((p.x * sx * d, p.y * sy * d, p.z * sz * d - sz * 0.35))
    for f in tmp.faces:
        b.face([v.co.copy() for v in f.verts], 'rock_granite', smooth=True)
    tmp.free()
    build(b)


# Trees: procedural Scots pine / Norway spruce / silver birch with LODs + impostors (tools/blender/trees.py).
import tempfile  # noqa: E402
from trees import build_tree  # noqa: E402
TREE_VARIANTS = {'tree_pine': [('pine', 11), ('pine', 12)], 'tree_spruce': [('spruce', 21), ('spruce', 22)], 'tree_birch': [('birch', 31), ('birch', 32)]}
_imp_tmp = tempfile.mkdtemp(prefix='rill_impostor_')
_lod0 = {'pine': [], 'spruce': [], 'birch': []}
for base, variants in TREE_VARIANTS.items():
    for k, (species, seed) in enumerate(variants):
        _, ob0 = build_tree(f'{base}_{"ab"[k]}', species, seed, ASSET_DIR, _imp_tmp)
        _lod0[species].append(ob0)

# =============================================================== far scenery
# Source-style backdrop beyond the playable area: masked fields/forest on the far
# terrain, lakes, rings of tree-line silhouette strips and distant tower blocks.
print('Building far scenery...')
from trees import render_treeline, TREELINE_W, TREELINE_H  # noqa: E402
render_treeline(_lod0, _imp_tmp)


BLOCK_SITES = [(20, 620), (35, 700), (75, 1350), (110, 900), (150, 520), (170, 1500), (205, 760), (240, 1100),
               (262, 1180), (300, 640), (318, 980), (345, 1450), (128, 1550), (58, 480)]
BLOCK_XY = [(math.cos(math.radians(a)) * d, math.sin(math.radians(a)) * d) for a, d in BLOCK_SITES]


def far_forest(x, y):
    n = noise.noise(Vector((x / 420.0, y / 420.0, 9.1))) + 0.5 * noise.noise(Vector((x / 150.0, y / 150.0, 3.3)))
    w = smoothstep(-0.3, 0.05, n)
    for lk in LAKES:
        w *= smoothstep(1.05, 1.3, lake_e(x, y, lk))
    for bx, by in BLOCK_XY:  # clearings around the tower blocks
        w *= smoothstep(45, 85, math.hypot(x - bx, y - by))
    return w


CANOPY_H = 15.0


def far_height(x, y):
    """Far terrain with the forest canopy shell raised over forested ground (faded in away from the map)."""
    return H(x, y) + CANOPY_H * far_forest(x, y) * smoothstep(210, 390, max(abs(x), abs(y)))


def far_normal(p):
    e = 2.0
    dx = (far_height(p.x + e, p.y) - far_height(p.x - e, p.y)) / (2 * e)
    dy = (far_height(p.x, p.y + e) - far_height(p.x, p.y - e)) / (2 * e)
    return Vector((-dx, -dy, 1)).normalized()


def in_lake(x, y, margin=1.0):
    return any(lake_e(x, y, lk) < margin for lk in LAKES)


def far_color(co, mat):
    return (far_forest(co.x, co.y), 0.0, 0.0, 1.0)


def graded(limit=2600.0, first=12.0, growth=1.13):
    out, x, step = [], 100.0, first
    while x < limit:
        x += step
        out.append(round(x, 2))
        step *= growth
    return out


pos = graded()
coords = sorted(set([-c for c in pos] + list(range(-100, 101, 10)) + pos))
b = MeshBuilder('landscape_far')
for j in range(len(coords) - 1):
    for i in range(len(coords) - 1):
        xa, xb, ya, yb = coords[i], coords[i + 1], coords[j], coords[j + 1]
        if -100 <= xa and xb <= 100 and -100 <= ya and yb <= 100:
            continue
        F = far_height
        b.quad((xa, ya, F(xa, ya)), (xb, ya, F(xb, ya)), (xb, yb, F(xb, yb)), (xa, yb, F(xa, yb)), 'landscape_far', smooth=True)
build(b, None, custom_normals=far_normal, vertex_color=far_color)
add_mesh_object('landscape_far', 'Distant landscape', 'landscape_far', 'terrain', collision=False, cast=False)

# Lakes: flat water ellipses slightly larger than the shoreline (the basin rises through them).
b = MeshBuilder('far_water')
for i, ((cx, cy), (ax, ay), rot) in enumerate(LAKES):
    wl = lake_level(i)
    ring = []
    for k in range(64):
        t = 2 * math.pi * k / 64
        u, v = math.cos(t) * ax * 1.12, math.sin(t) * ay * 1.12
        ring.append((cx + u * math.cos(rot) - v * math.sin(rot), cy + u * math.sin(rot) + v * math.cos(rot), wl))
    for k in range(64):
        p0, p1 = ring[k], ring[(k + 1) % 64]
        b.face([(cx, cy, wl), p0, p1], 'water_far')
build(b)
add_mesh_object('far_water', 'Distant lakes', 'far_water', 'water', collision=False, cast=False)

# Tree-line rings: tangential strips where the far mask is forest.
rnd_f = random.Random(77)
b = MeshBuilder('far_treeline')
R = 145.0
n_strips = 0
while R < 2100:
    seg = min(90.0, max(14.0, R / 14.0))
    n = int(2 * math.pi * R / seg)
    u_off = rnd_f.uniform(0, 1)
    jitter = [R * (1 + rnd_f.uniform(-0.035, 0.035)) for _ in range(n)]
    for k in range(n):
        t0, t1 = 2 * math.pi * k / n, 2 * math.pi * (k + 1) / n
        r0, r1 = jitter[k], jitter[(k + 1) % n]
        x0, y0 = math.cos(t0) * r0, math.sin(t0) * r0
        x1, y1 = math.cos(t1) * r1, math.sin(t1) * r1
        mx, my = (x0 + x1) / 2, (y0 + y1) / 2
        if far_forest(mx, my) < 0.55 or in_lake(mx, my, 1.25):
            continue
        hs = rnd_f.uniform(0.85, 1.15)
        top = TREELINE_H * hs
        za, zb = H(x0, y0) - 1.5, H(x1, y1) - 1.5
        ua = u_off + R * t0 / TREELINE_W
        ub = u_off + R * t1 / TREELINE_W
        # Front face points towards the map centre (double-sided material anyway).
        b.face([(x1, y1, zb), (x0, y0, za), (x0, y0, za + top), (x1, y1, zb + top)], 'treeline',
               uvs=[(ub, 0), (ua, 0), (ua, 1), (ub, 1)], smooth=True)
        n_strips += 1
    R *= 1.27


def strip_normal(co):
    d = Vector((-co.x, -co.y, 0))
    return (d.normalized() * 0.55 + Vector((0, 0, 0.85))).normalized() if d.length > 1e-3 else Vector((0, 0, 1))


obj, _ = b.finish(None, weld=False, foliage_normals=({'treeline'}, strip_normal))
export_glb(obj, os.path.join(ASSET_DIR, 'far_treeline.glb'))
add_mesh_object('far_treeline', 'Distant tree lines', 'far_treeline', 'vegetation', collision=False, cast=False)
print(f'  far_treeline: {n_strips} strips')

# Distant tower blocks on the hills (miljonprogram slabs and point houses).
b = MeshBuilder('far_buildings')
rnd_b = random.Random(91)
KINDS = [('slab', 12.0, 56.0, 8), ('slab', 12.0, 72.0, 9), ('point', 17.0, 17.0, 12), ('low', 11.0, 44.0, 4)]
FACADES = ['facade_far', 'facade_far_brick', 'facade_far_ochre']
placed_b = 0
for (az_deg, dist), (cx, cy) in zip(BLOCK_SITES, BLOCK_XY):
    az = math.radians(az_deg)
    if in_lake(cx, cy, 1.4):
        continue
    kind, w, l, floors = rnd_b.choice(KINDS)
    yaw = az + math.pi / 2 + rnd_b.uniform(-0.4, 0.4)
    c, s_ = math.cos(yaw), math.sin(yaw)
    hw, hl = l / 2, w / 2
    corners = [(cx + c * px - s_ * py, cy + s_ * px + c * py) for (px, py) in [(-hw, -hl), (hw, -hl), (hw, hl), (-hw, hl)]]
    base = min(H(x, y) for x, y in corners) - 1.0
    top = base + 1.0 + floors * 2.8 + 0.6
    fac = rnd_b.choice(FACADES)
    for i in range(4):
        (xa, ya), (xb, yb) = corners[i], corners[(i + 1) % 4]
        L = math.hypot(xb - xa, yb - ya)
        b.face([(xa, ya, base), (xb, yb, base), (xb, yb, top), (xa, ya, top)], fac, uvs=[(0, 0), (L, 0), (L, top - base), (0, top - base)])
    b.face([(x, y, top) for x, y in corners], 'asphalt', uvs=[(0, 0), (l, 0), (l, w), (0, w)])
    placed_b += 1
build(b)
add_mesh_object('far_buildings', 'Distant apartment blocks', 'far_buildings', 'building', collision=False, cast=False)
print(f'  far_buildings: {placed_b} blocks')

# =============================================================== placements
print('Placing props, trees, lights, decals...')
lights = []


def light(obj_id, pos, intensity, rng, color=(1.0, 0.78, 0.55), kind='spot', outer=65, inner=40, fog=1.0):
    q = [0, 0, 0, 1]
    objects.append({
        'id': obj_id, 'type': 'light', 'semantic': 'light', 'transform': {'position': to_engine(pos), 'rotation': q},
        'light': {'kind': kind, 'color': list(color), 'intensity': intensity, 'range': rng, 'outerAngle': outer, 'innerAngle': inner, 'sourceRadius': 0.15, 'fogScatter': fog},
    })


for i, x in enumerate([-87.5 + 25 * k for k in range(8)]):
    add_mesh_object(f'streetlight_{i}', f'Streetlight {i}', 'streetlight', 'streetlight', pos=(x, 5.6, 0.12), collision=True)
    light(f'streetlight_{i}_lamp', (x, 5.6 - 2.05, 7.85), 3000, 24, outer=56, inner=28)

path = path_polylines['path_forest']
for i, idx in enumerate(range(8, len(path) - 5, 18)):
    p = path[idx]
    d = (path[idx + 1] - path[idx - 1]).normalized()
    side = Vector((-d.y, d.x)) * 2.2
    px, py = p.x + side.x, p.y + side.y
    add_mesh_object(f'path_light_{i}', f'Path light {i}', 'path_light', 'streetlight', pos=(px, py, H(px, py) - 0.05))
    light(f'path_light_{i}_lamp', (px, py, H(px, py) + 3.95), 800, 14, color=(1.0, 0.72, 0.45), outer=68, inner=35)

for i, ly in enumerate((-3.5, 3.5)):
    light(f'underpass_lamp_{i}', (-12.0, ly, UP_CEIL - 0.1), 900, 14, color=(0.92, 0.97, 1.0), outer=80, inner=55, fog=0.5)

for i in range(8):
    add_mesh_object(f'bollard_{i}', f'Bollard {i}', 'bollard', 'bollard', pos=(-38 + i * 2.8, 7.4, 0.12))
for i, (x, y, yaw) in enumerate([(-35.5, 11.2, 0), (-20.5, 11.2, 0)]):
    add_mesh_object(f'bench_{i}', f'Bench {i}', 'bench', 'bench', pos=(x, y, 0.12), yaw=yaw)
for i, x in enumerate([-52.0, 3.0, 58.0]):
    add_mesh_object(f'utility_box_{i}', f'Utility box {i}', 'utility_box', 'utility', pos=(x, 6.6, 0.12))
for i in range(9):
    add_mesh_object(f'fence_{i}', f'Fence segment {i}', 'fence_segment', 'fence', pos=(-45.3, -30 + i * 2.5, 0.0), yaw=-90, collision=True)
for i, (bx, row) in enumerate([(-43.75, 0), (-38.75, 0), (-31.25, 0), (-28.75, 1), (-23.75, 1), (-41.25, 1)]):
    by = -10.5 if row == 0 else -21.5
    add_mesh_object(f'car_{i}', f'Placeholder car {i}', 'car_placeholder', 'vehicle', pos=(bx, by, 0.0), yaw=0 if row == 0 else 180)
add_mesh_object('human_ref_0', 'Scale reference 1.8 m', 'human_reference', 'reference', pos=(-17.0, 6.5, 0.12))
add_mesh_object('human_ref_1', 'Scale reference in underpass', 'human_reference', 'reference', pos=(-11.0, 1.5, UP_FLOOR))
add_mesh_object('human_ref_2', 'Scale reference at stairs', 'human_reference', 'reference', pos=(24.0, 7.2, 0.0))
add_mesh_object('human_ref_3', 'Scale reference under arcade', 'human_reference', 'reference', pos=(14.0, -21.5, 0.02))

# Material gallery on the plaza (engine builtins, materials swapped by override).
GALLERY = ['concrete_cast', 'concrete_aggregate', 'asphalt', 'plaster_ochre', 'brick_red', 'paving_slabs', 'tiles_white', 'rock_granite', 'metal_galvanized', 'metal_railing_green', 'glass_window', 'debug_grid']
for i, m in enumerate(GALLERY):
    x = -39.2 + i * 1.3
    objects.append({'id': f'gallery_pedestal_{i}', 'type': 'mesh', 'semantic': 'gallery', 'asset': 'builtin:box?x=0.6&y=0.8&z=0.6&material=concrete_cast',
                    'transform': {'position': to_engine((x, 9.8, 0.12))}, 'static': True})
    objects.append({'id': f'gallery_sphere_{i}', 'name': f'Material sample: {m}', 'type': 'mesh', 'semantic': 'gallery', 'asset': 'builtin:sphere?r=0.45',
                    'transform': {'position': to_engine((x, 9.8, 0.92))}, 'static': True, 'materialOverrides': {'default': m}})

# Rocks on the hill
rock_inst = {'rock_a': [], 'rock_b': [], 'rock_c': []}
rnd = random.Random(11)
for k in range(28):
    for _ in range(50):
        x, y = rnd.uniform(0, 98), rnd.uniform(22, 98)
        if not near_path(x, y, 4) and math.hypot(x - 62, y - 72) < 60:
            break
    which = rnd.choice(list(rock_inst))
    rock_inst[which].append([*to_engine((x, y, H(x, y))), round(rnd.uniform(0, 360), 1), round(rnd.uniform(0.7, 1.4), 2)])
for name, inst in rock_inst.items():
    objects.append({'id': f'rocks_{name}', 'name': f'Bedrock outcrops ({name})', 'type': 'instances', 'semantic': 'rock', 'asset': f'{ASSET_REL}/{name}.glb', 'castShadow': True, 'instances': inst})

# Trees (Poisson-ish rejection sampling)
trees = {'tree_pine': [], 'tree_spruce': [], 'tree_birch': []}
placed = []
rnd = random.Random(5)
regions = [((-6, 100, 17, 100), 420, (0.5, 0.4, 0.1)), ((-100, -45, 16, 100), 170, (0.45, 0.45, 0.1)),
           ((-100, -50, -100, -38), 110, (0.5, 0.35, 0.15)), ((55, 100, -100, -38), 110, (0.5, 0.35, 0.15)),
           ((-44, 58, -100, -40), 70, (0.4, 0.3, 0.3)), ((-40, -16, 24, 40), 12, (0.1, 0.1, 0.8))]
for (x0, x1, y0, y1), count, mix in regions:
    n = 0
    tries = 0
    while n < count and tries < count * 40:
        tries += 1
        x, y = rnd.uniform(x0, x1), rnd.uniform(y0, y1)
        if in_paved(x, y) or near_path(x, y, 3.2):
            continue
        if WALL_Y0 - 2 < y < WALL_Y1 + 2.5 and WALL_X0 - 2 < x < WALL_X1 + 2:
            continue
        if any((px - x) ** 2 + (py - y) ** 2 < 3.6 ** 2 for (px, py) in placed):
            continue
        r = rnd.random()
        kind = 'tree_pine' if r < mix[0] else ('tree_spruce' if r < mix[0] + mix[1] else 'tree_birch')
        placed.append((x, y))
        trees[kind].append([*to_engine((x, y, H(x, y) - 0.15)), round(rnd.uniform(0, 360), 1), round(rnd.uniform(0.75, 1.2), 2)])
        n += 1
# Birches by the buildings
for (x, y) in [(-33, 16), (-35, 20), (-14, 18), (2, -26), (53, -24), (-46, -4), (-48, -33), (-20, -35)]:
    trees['tree_birch'].append([*to_engine((x, y, H(x, y) - 0.1)), round(rnd.uniform(0, 360), 1), round(rnd.uniform(0.8, 1.1), 2)])
for name, inst in trees.items():
    for k in range(len(TREE_VARIANTS[name])):
        part = inst[k::len(TREE_VARIANTS[name])]
        v = f'{name}_{"ab"[k]}'
        objects.append({'id': f'trees_{v}', 'name': f'Trees ({v})', 'type': 'instances', 'semantic': 'vegetation', 'asset': f'{ASSET_REL}/{v}.model.json', 'castShadow': True, 'instances': part})
print('  trees:', {k: len(v) for k, v in trees.items()})


# Decals
def ground_decal(obj_id, mat, x, y, z, w, h, yaw=0.0, repeat=1.0, opacity=1.0, depth=0.3):
    qx = [-0.7071068, 0, 0, 0.7071068]   # local +Z -> engine +Y (up)
    q = quat_mul(yaw_quat(yaw), qx)
    objects.append({'id': obj_id, 'type': 'decal', 'semantic': 'decal', 'transform': {'position': to_engine((x, y, z)), 'rotation': [round(v, 6) for v in q]},
                    'decal': {'material': mat, 'size': [w, h, depth], 'repeat': repeat, 'opacity': opacity}})


def wall_decal(obj_id, mat, x, y, z, w, h, facing_yaw, opacity=1.0, depth=0.4):
    # Decal local +Z points out of the wall; facing_yaw is the compass direction the wall faces.
    q = yaw_quat(facing_yaw + 180)
    objects.append({'id': obj_id, 'type': 'decal', 'semantic': 'decal', 'transform': {'position': to_engine((x, y, z)), 'rotation': q},
                    'decal': {'material': mat, 'size': [w, h, depth], 'opacity': opacity}})


dn = 0
for k in range(17):
    x = -96 + k * 12
    ground_decal(f'decal_dash_{k}', 'decal_paint_line', x, 0.0, 0.0, 3.0, 0.12, yaw=90)
for s in (1, -1):
    for k in range(8):
        ground_decal(f'decal_edge_{"n" if s > 0 else "s"}{k}', 'decal_paint_line', -87.5 + 25 * k, 3.72 * s, 0.0, 25.0, 0.1, yaw=90, repeat=12.5)
for row, yc in enumerate((-10.5, -21.5)):
    for i in range(11):
        ground_decal(f'decal_bay_{row}_{i}', 'decal_paint_line', -45 + 2.5 + i * 2.5, yc, 0.0, 5.0, 0.1, yaw=0, repeat=2.5)
for i, (x, y, z) in enumerate([(-60, 1.5, 0), (10, -1.8, 0), (70, 2.0, 0), (-28, 9.5, 0.12), (-30, -16, 0), (-12, 0, UP_FLOOR)]):
    ground_decal(f'decal_manhole_{i}', 'decal_manhole', x, y, z, 0.7, 0.7, yaw=rnd.uniform(0, 360))
rnd = random.Random(3)
for i in range(16):
    x, y = rnd.uniform(-95, 95), rnd.uniform(-3.8, 3.8)
    ground_decal(f'decal_crack_road_{i}', 'decal_crack', x, y, 0.0, rnd.uniform(1.5, 3.5), rnd.uniform(1.0, 2.5), yaw=rnd.uniform(0, 360))
for i in range(6):
    x, y = rnd.uniform(-44, -19), rnd.uniform(-29, -8)
    ground_decal(f'decal_crack_park_{i}', 'decal_crack', x, y, 0.0, 2.5, 1.8, yaw=rnd.uniform(0, 360))
for i, (bx, row) in enumerate([(-43.75, 0), (-36.25, 0), (-26.25, 0), (-33.75, 1), (-21.25, 1), (-38.75, 1)]):
    ground_decal(f'decal_oil_{i}', 'decal_oil', bx + rnd.uniform(-0.3, 0.3), (-10.2 if row == 0 else -21.8), 0.0, 1.2, 1.6, yaw=rnd.uniform(0, 360), opacity=0.8)
for i in range(6):
    ground_decal(f'decal_stain_plaza_{i}', 'decal_stain', rnd.uniform(-39, -17), rnd.uniform(7.5, 11.5), 0.12, rnd.uniform(0.8, 2.0), rnd.uniform(0.8, 2.0), yaw=rnd.uniform(0, 360), opacity=0.6)
for i in range(8):
    ground_decal(f'decal_stain_walk_{i}', 'decal_stain', rnd.uniform(-95, 95), rnd.choice([rnd.uniform(4.3, 6.9), rnd.uniform(-6.9, -4.3)]), 0.12, rnd.uniform(0.6, 1.4), rnd.uniform(0.6, 1.4), yaw=rnd.uniform(0, 360), opacity=0.5)
for i, x in enumerate([-1.0, 6.0, 13.5, 28.0, 35.0, 44.0]):
    wall_decal(f'decal_streak_wall_{i}', 'decal_waterstreak', x, WALL_Y0, 3.3 - 1.4, rnd.uniform(1.0, 1.8), 2.8, 180)
for i, x in enumerate([2.0, 12.0, 38.0, 46.0]):
    wall_decal(f'decal_grime_wall_{i}', 'decal_grime_base', x + 4, WALL_Y0, 0.45, 9.0, 0.9, 180)
for i, x in enumerate([9.5, 17.5, 27.5, 41.5]):
    wall_decal(f'decal_streak_bldg_{i}', 'decal_waterstreak', x, -20.0, 13.5, 1.2, 4.0, 0)
for (i, wx, facing) in [(0, UP_IX0, 90), (1, UP_IX1, 270)]:
    for k, yc in enumerate([-4.0, 3.0]):
        wall_decal(f'decal_grime_tunnel_{i}_{k}', 'decal_grime_base', wx, yc, UP_FLOOR + 0.45, 5.0, 0.9, facing)

# Probe volume: ambient cubes for dynamic / instanced objects (baked with the lightmaps).
objects.append({'id': 'probes_main', 'name': 'Main probe volume', 'type': 'probeVolume', 'semantic': 'lighting',
                'transform': {'position': [0.0, 12.0, 0.0]}, 'volume': {'size': [200.0, 30.0, 200.0], 'spacing': [4.0, 3.0, 4.0]}})


# Reflection probes: captured in-engine; box = parallax volume + influence (Blender coords).
def refl_probe(pid, name, capture, bmin, bmax, blend=1.5, priority=0):
    lo = to_engine(bmin)
    hi = to_engine(bmax)
    emin = [min(lo[k], hi[k]) for k in range(3)]
    emax = [max(lo[k], hi[k]) for k in range(3)]
    objects.append({'id': pid, 'name': name, 'type': 'reflectionProbe', 'semantic': 'lighting',
                    'transform': {'position': to_engine(capture)},
                    'probe': {'boxMin': emin, 'boxMax': emax, 'blend': blend, 'priority': priority}})


refl_probe('rp_tunnel', 'Underpass tunnel', (-12, 0, UP_FLOOR + 1.5), (UP_IX0, -7.2, UP_FLOOR), (UP_IX1, 7.2, UP_CEIL), blend=1.0, priority=3)
refl_probe('rp_ramp_n', 'Underpass north ramp', (-12, 18, -0.6), (UP_IX0, 7, UP_FLOOR), (UP_IX1, 31, 4), blend=1.5, priority=2)
refl_probe('rp_ramp_s', 'Underpass south ramp', (-12, -18, -0.6), (UP_IX0, -31, UP_FLOOR), (UP_IX1, -7, 4), blend=1.5, priority=2)
refl_probe('rp_arcade', 'Arcade', (27.5, -21.6, 1.5), (5.3, -23, 0), (49.7, -20, 2.9), blend=0.8, priority=3)
refl_probe('rp_plaza', 'Plaza', (-28, 9, 1.7), (-46, 4.2, 0), (-9, 14, 9), blend=2.0, priority=1)
refl_probe('rp_road_w', 'Road west', (-72, 0, 1.7), (-100, -9, 0), (-45, 9, 12), blend=4.0)
refl_probe('rp_road_c', 'Road centre', (-20, 0, 1.7), (-46, -9, 0), (6, 9, 12), blend=4.0)
refl_probe('rp_road_e', 'Road east', (50, 0, 1.7), (5, -9, 0), (100, 9, 16), blend=4.0)
refl_probe('rp_parking', 'Parking', (-31, -18, 1.7), (-46, -31, 0), (-17, -6, 8), blend=2.0, priority=1)
refl_probe('rp_wall', 'Retaining wall strip', (21, 10, 1.7), (-6, 7, 0), (56, 16, 8), blend=2.0, priority=1)
refl_probe('rp_bldg_n', 'Slab block north side', (28, -14, 1.7), (5, -20, 0), (52, -9, 16), blend=2.0, priority=1)
refl_probe('rp_forest', 'Forest hill', (40, 45, H(40, 45) + 2), (-6, 16, -2), (100, 100, 40), blend=6.0)

# Viewpoints (bookmarks for testing / screenshots)
VIEWS = [
    ('Road grazing (long sightline)', (-95, -1.8, 0.0), 90, -1),
    ('Retaining wall', (-4.0, 9.5, 0.0), 75, 2),
    ('Stairs', (21.5, 6.0, 0.12), 0, 12),
    ('Underpass', (-12.0, -12.0, floor_z(-12)), 0, 0),
    ('Arcade (pilotis)', (7.5, -21.2, 0.02), 90, 4),
    ('Forest path', (35, 36, H(35, 36) + 0.04), 50, 4),
    ('Parking', (-19, -29, 0.0), 300, -2),
    ('Material gallery', (-33.0, 7.3, 0.12), 300, -12),
    ('Overview', (-60, -60, 45), 45, -25),
]
for i, (name, p, yaw, pitch) in enumerate(VIEWS):
    objects.append({'id': f'view_{i}', 'name': name, 'type': 'marker', 'semantic': 'viewpoint', 'transform': {'position': to_engine(p)}, 'yaw': yaw, 'pitch': pitch})

doc = {
    'format': 'rill.map',
    'version': 1,
    'name': 'testmap',
    'description': 'M1 engine test map: Stockholm-suburb-like layout with debug-scale content. Generated by tools/blender/build_testmap.py.',
    'environment': {'preset': 'clear'},
    'lightmaps': 'lightmaps/lightmapset.json',
    'spawn': {'position': to_engine((-24.0, 5.6, 0.12)), 'yaw': 95, 'pitch': 0},
    'objects': objects,
}
os.makedirs(os.path.dirname(MAP_PATH), exist_ok=True)
import json  # noqa: E402
with open(MAP_PATH, 'w') as f:
    json.dump(doc, f, indent=1)
print(f'Wrote {MAP_PATH}: {len(objects)} objects')
