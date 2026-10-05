"""First-person carbine for G1 (docs/GAME.md): an Ak 5-flavoured compact 5.56
carbine (Swedish service rifle of the period: olive-green finish, black steel
barrel and sights, reciprocating side charging handle, curved magazine).

Output
  public/assets/weapons/carbine.glb      rig parts as top-level nodes:
      receiver (static body), bolt (carrier + charging handle, slides back),
      trigger (pivots), magazine (reload later), and empties muzzle / eject.
  public/textures/weapons/carbine_albedo.png, carbine_orm.png
      one shared 2048² atlas: baked AO, a bevel-based edge mask and material
      ids composed into worn paint / steel / polymer (ORM = AO, roughness, metal).
  public/materials/weapon_carbine.json   the engine material using the atlas.

Run: npm run weapon   (Blender 5.x, Cycles on the GPU for the bakes)

Frame (Blender): x right, y forward (muzzle), z up; metres. The glTF export
converts to engine weapon space (x right, y up, -z forward). The part origins
are their pivots; the receiver origin is just above the trigger.
"""

import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import PUBLIC, reset_scene  # noqa: E402
import kit  # noqa: E402
from kit import Piece, boolean, cutter_box, finish_shading, rounded_rect, setup_cycles, unwrap, bake_pass, edge_emission, id_emission, pixels, blur, save_png  # noqa: E402

ATLAS = 2048
OUT_GLB = os.path.join(PUBLIC, 'assets', 'weapons', 'carbine.glb')
OUT_TEX = os.path.join(PUBLIC, 'textures', 'weapons')

# Bake ids (material slots while building) and their look.
IDS = ['paint', 'steel', 'polymer', 'alu', 'rubber', 'grip']
kit.configure(IDS, ATLAS, 96)


# ------------------------------------------------------------------ the parts

def section(y, top_hw, bot_hw, z0, z1, r):
    """Trapezoid ring (narrower top) with rounded corners, CCW seen from +y."""
    pts = []
    corners = [((top_hw - r, z1 - r), 0, 90), ((-top_hw + r, z1 - r), 90, 180), ((-bot_hw + r, z0 + r), 180, 270), ((bot_hw - r, z0 + r), 270, 360)]
    for (cx, cz), a0, a1 in corners:
        for k in range(4):
            a = math.radians(a0 + (a1 - a0) * k / 3)
            pts.append((cx + math.cos(a) * r, y, cz + math.sin(a) * r))
    return pts


def build_upper():
    """Upper receiver (manifold on its own, so the boolean cuts are clean)."""
    p = Piece('upper')
    rings = [section(y, tw, 0.0215, -0.002, top, 0.0045) for y, tw, top in ((-0.126, 0.0165, 0.05), (0.15, 0.0165, 0.05), (0.172, 0.014, 0.044))]
    p.loft(rings, 'paint')
    ob = p.to_object()
    boolean(ob, cutter_box((0.022, 0.056, 0.029), (0.014, 0.062, 0.024)))  # ejection port
    boolean(ob, cutter_box((0.021, 0.128, 0.039), (0.01, 0.078, 0.007)))  # charging-handle slot
    # Panel seams: upper / lower split, a line along each top edge, the receiver cover joint.
    boolean(ob, cutter_box((0, 0.02, 0.0005), (0.05, 0.3, 0.0012)))
    for side in (-1, 1):
        boolean(ob, cutter_box((side * 0.0172, 0.01, 0.0455), (0.0016, 0.26, 0.0012)))
    boolean(ob, cutter_box((0, 0.002, 0.05), (0.05, 0.0012, 0.004)))
    return ob


def build_handguard():
    """Ribbed polymer handguard with oval vents (separate manifold for the cuts)."""
    p = Piece('handguard')
    rings = []
    ys = [0.172, 0.18]
    y = 0.19
    while y < 0.29:
        ys += [y, y + 0.004, y + 0.012]
        y += 0.016
    ys += [0.295, 0.302]
    for i, y in enumerate(ys):
        g = 0.93 if (i >= 2 and (i - 2) % 3 == 1) else 1.0
        if i in (0, len(ys) - 1):
            g = 0.92
        rings.append(rounded_rect(0, 0.01, 0.0215 * g, 0.026 * g, 0.015 * g, y, n=5))
    p.loft(rings, 'polymer')
    ob = p.to_object()
    # Two rows of vents on each upper flank.
    for side in (-1, 1):
        for k in range(5):
            yy = 0.198 + k * 0.016
            for zz, ang in ((0.024, 40), (0.009, 12)):
                rot = Matrix.Rotation(math.radians(side * ang), 3, 'Y')
                boolean(ob, cutter_box((side * 0.021, yy, zz), (0.012, 0.0085, 0.0042), rot=rot))
    return ob


def build_receiver():
    p = Piece('receiver')
    # Rear sight: base block on the receiver, swept protective wings, aperture drum on the base.
    p.loft([section(y, 0.0105, 0.0125, 0.0485, 0.0565, 0.0015) for y in (-0.122, -0.074)], 'paint')
    for side in (-1, 1):
        x = side * 0.0112
        p.loft([[(x + dx, y, z) for y, z in ((-0.12, 0.054), (-0.077, 0.054), (-0.083, 0.071), (-0.093, 0.075), (-0.108, 0.074))] for dx in (-0.0015, 0.0015)], 'paint')
    p.cyl((-0.0082, -0.096, 0.0628), (0.0082, -0.096, 0.0628), 0.0064, 'steel', 20)
    p.cyl((-0.0098, -0.096, 0.0628), (-0.0082, -0.096, 0.0628), 0.0045, 'steel', 14)  # adjuster hub
    # Receiver cover: a raised pressed spine along the top, rivets along both upper flanks.
    p.loft([section(y, 0.0058, 0.0072, 0.0485, 0.0526, 0.0012) for y in (-0.07, 0.142)], 'paint')
    for side in (-1, 1):
        # (the right flank has the ejection port and charging-handle slot further forward)
        for yy in ((-0.05, 0.0, 0.11, 0.14) if side < 0 else (-0.05, 0.0)):
            p.cyl((side * 0.0172, yy, 0.038), (side * 0.0184, yy, 0.038), 0.0017, 'steel', 10)
    # Brass deflector bump behind the ejection port.
    p.loft([[(x, y, z) for x, z in ((0.0214, 0.022), (0.0262, 0.026), (0.0262, 0.038), (0.0214, 0.042))] for y in (0.015, 0.024)], 'paint')
    # Lower receiver / magazine well with a flared lip.
    p.loft([section(y, 0.0172, 0.0168, -0.052, -0.0015, 0.003) for y in (-0.046, 0.104)], 'paint')
    p.box((0, 0.064, -0.047), (0.039, 0.088, 0.01), 'paint')
    # Takedown pins (both sides), magazine release button (right), selector hub + lever (left).
    for side in (-1, 1):
        for yy, zz in ((-0.036, -0.012), (0.098, -0.011)):
            p.cyl((side * 0.0168, yy, zz), (side * 0.0196, yy, zz), 0.0032, 'steel', 14)
    p.cyl((0.0165, 0.012, -0.022), (0.0205, 0.012, -0.022), 0.0042, 'steel', 14)
    p.cyl((-0.0165, -0.012, 0.006), (-0.0215, -0.012, 0.006), 0.0055, 'steel', 16)
    p.loft([[(-0.0228 + dx, y, z) for y, z in ((-0.012, 0.009), (-0.012, 0.003), (-0.034, 0.0), (-0.036, 0.005))] for dx in (-0.0012, 0.0012)], 'steel')
    # Winter trigger guard: a wider band, rounded.
    path = [(0.03, -0.05), (0.028, -0.062), (0.014, -0.072), (-0.012, -0.073), (-0.034, -0.067), (-0.046, -0.052)]
    p.loft([[(x, y, z + dz) for x, dz in ((0.0062, 0.0015), (0.0045, 0.0028), (-0.0045, 0.0028), (-0.0062, 0.0015), (-0.0062, -0.0015), (-0.0045, -0.0028), (0.0045, -0.0028), (0.0062, -0.0015))] for y, z in path], 'paint')
    # Pistol grip (stippled polymer): tapered oval raked back ~20 degrees, finger swells, capped.
    rings = []
    for k in range(12):
        t = k / 11
        y = -0.032 - 0.044 * t
        z = -0.035 - 0.096 * t
        hx = 0.0148 - 0.0016 * t
        hy = 0.0205 + 0.0032 * math.sin(t * math.pi * 1.3) - 0.001 * t
        # Finger grooves on the front strap.
        fy = -0.0018 * max(0.0, math.sin(t * math.pi * 3.0 + 0.5)) if 0.15 < t < 0.85 else 0.0
        ring = []
        for i in range(20):
            a = 2 * math.pi * i / 20
            yy = math.sin(a) * hy
            if yy > 0:
                yy += fy
            ring.append((math.cos(a) * hx, y + yy, z))
        rings.append(ring)
    p.loft(rings, 'grip')
    # Barrel, handguard cap ring, gas tube, front sight tower, flash hider.
    p.cyl((0, 0.16, 0.0), (0, 0.47, 0.0), 0.0088, 'steel', 28)
    p.cyl((0, 0.3, 0.008), (0, 0.309, 0.008), 0.0215, 'steel', 28)
    p.cyl((0, 0.28, 0.024), (0, 0.345, 0.024), 0.0072, 'steel', 20)
    p.loft([section(y, 0.0088, 0.0098, -0.006, 0.031, 0.0025) for y in (0.33, 0.356)], 'steel')  # gas block
    p.loft([section(y, 0.0054, 0.0068, 0.029, 0.041, 0.0012) for y in (0.341, 0.36)], 'steel')  # sight tower
    p.loft([section(y, 0.0013, 0.0016, 0.038, 0.0605, 0.0004) for y in (0.3505, 0.3545)], 'steel')  # post
    for side in (-1, 1):
        x = side * 0.0092
        p.loft([[(x + dx, y, z) for y, z in ((0.338, 0.028), (0.36, 0.028), (0.36, 0.06), (0.356, 0.066), (0.342, 0.066), (0.338, 0.062))] for dx in (-0.0016, 0.0016)], 'steel')
    p.box((0, 0.346, -0.011), (0.008, 0.02, 0.012), 'steel')  # bayonet lug
    # Sling swivel hanging under the bayonet lug (ring in the barrel's plane, joined by a stud).
    loop = [(0.0, 0.346 + math.cos(a) * 0.0068, -0.0255 + math.sin(a) * 0.0068) for a in (math.radians(d) for d in range(0, 361, 30))]
    for a, b in zip(loop, loop[1:]):
        p.cyl(a, b, 0.0013, 'steel', 8)
    p.cyl((0, 0.346, -0.0165), (0, 0.346, -0.0195), 0.0019, 'steel', 8)
    p.cyl((0, 0.462, 0.0), (0, 0.515, 0.0), 0.0112, 'steel', 28)
    # Skeletal folding stock and rubber butt.
    p.cyl((0, -0.122, 0.034), (0, -0.405, 0.016), 0.0072, 'steel', 14)
    p.cyl((0, -0.115, -0.004), (0, -0.405, -0.078), 0.0072, 'steel', 14)
    p.box((0, -0.41, -0.03), (0.034, 0.016, 0.125), 'rubber')
    body = p.to_object()
    # Flash hider slots on a separate cylinder (clean manifold for the boolean).
    fh = Piece('hider')
    fh.cyl((0, 0.47, 0.0), (0, 0.515, 0.0), 0.0119, 'steel', 28)
    hider = fh.to_object()
    for k in range(5):
        a = math.radians(90 + 72 * k)
        boolean(hider, cutter_box((math.cos(a) * 0.012, 0.497, math.sin(a) * 0.012), (0.0045, 0.03, 0.0055), rot=Matrix.Rotation(-a + math.pi / 2, 3, 'Y')))
    upper = build_upper()
    guard = build_handguard()
    for o in [o for o in bpy.data.objects if o.name.startswith('cutter')]:
        bpy.data.objects.remove(o)
    for o in bpy.context.selected_objects:
        o.select_set(False)
    for o in (body, hider, upper, guard):
        o.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    body.name = 'receiver'
    body.data.name = 'receiver'
    return body


def build_bolt():
    p = Piece('bolt')
    p.box((0.0105, 0.056, 0.029), (0.012, 0.06, 0.02), 'alu')  # bright carrier face in the port
    p.box((0.0172, 0.04, 0.029), (0.0016, 0.014, 0.008), 'steel')  # extractor detail
    p.cyl((0.012, 0.128, 0.039), (0.034, 0.128, 0.039), 0.0032, 'steel', 14)  # handle stem
    p.cyl((0.032, 0.128, 0.039), (0.044, 0.128, 0.039), 0.0062, 'steel', 18, r1=0.0055)  # knob
    return p.to_object((0, 0, 0))


def build_trigger():
    p = Piece('trigger')
    path = [(0.006, -0.03), (0.007, -0.043), (0.004, -0.053), (-0.002, -0.061)]
    rings = []
    for y, z in path:
        rings.append([(x, y + dy, z) for x, dy in ((0.003, 0.002), (-0.003, 0.002), (-0.003, -0.002), (0.003, -0.002))])
    p.loft(rings, 'steel')
    return p.to_object((0, 0.006, -0.03))


def build_magazine():
    p = Piece('magazine')
    rings = []
    n = 9
    for k in range(n):
        t = k / (n - 1)
        a = math.radians(18 * t)
        # Arc: curves forward towards the bottom.
        cy, cz = 0.062 + 0.17 * (1 - math.cos(a)) * 1.6 + 0.04 * t, -0.04 - 0.165 * t
        hy = 0.0315
        ring = []
        for x, dy in ((0.0118, hy), (-0.0118, hy), (-0.0118, -hy), (0.0118, -hy)):
            ring.append((x, cy + dy * math.cos(a), cz + dy * math.sin(a)))
        rings.append(ring)
    p.loft(rings, 'alu')
    last = rings[-1]
    cy = sum(v[1] for v in last) / 4
    cz = sum(v[2] for v in last) / 4
    p.box((0, cy, cz - 0.004), (0.028, 0.072, 0.009), 'alu', rot=Matrix.Rotation(math.radians(18), 3, 'X'))  # floor plate
    for side in (-1, 1):
        for k in range(3):
            t = 0.25 + 0.25 * k
            a = math.radians(18 * t)
            cy, cz = 0.062 + 0.17 * (1 - math.cos(a)) * 1.6 + 0.04 * t, -0.04 - 0.165 * t
            p.box((side * 0.0122, cy, cz), (0.0016, 0.05, 0.004), 'alu', rot=Matrix.Rotation(a, 3, 'X'))
    return p.to_object((0, 0.062, -0.04))


def empty(name, loc):
    ob = bpy.data.objects.new(name, None)
    ob.location = loc
    bpy.context.scene.collection.objects.link(ob)
    return ob


# ------------------------------------------------------------------ texture composition

def scratches(rng, n, length, width, density_mask=None):
    """Random thin line scratches in atlas space: height (0..1 depth) field."""
    H = np.zeros((ATLAS, ATLAS), np.float32)
    for _ in range(n):
        x0, y0 = rng.random() * ATLAS, rng.random() * ATLAS
        a = rng.random() * math.pi
        L = length * (0.3 + rng.random())
        steps = int(L)
        dx, dy = math.cos(a), math.sin(a)
        w = width * (0.6 + rng.random() * 0.8)
        depth = 0.4 + rng.random() * 0.6
        for i in range(steps):
            t = i / max(1, steps - 1)
            # Slight curve, tapering ends.
            x = int(x0 + dx * i + math.sin(t * 3.1) * 2) % ATLAS
            y = int(y0 + dy * i) % ATLAS
            k = depth * math.sin(math.pi * t) ** 0.5
            H[y, x] = max(H[y, x], k)
            if w > 1.2:
                H[y, (x + 1) % ATLAS] = max(H[y, (x + 1) % ATLAS], k * 0.6)
    return H


def cells(rng, scale):
    """Cellular bumps (stippling): distance to jittered grid points, 0 at centres."""
    g = ATLAS // scale
    jx = rng.random((g + 2, g + 2)).astype(np.float32)
    jy = rng.random((g + 2, g + 2)).astype(np.float32)
    yy, xx = np.mgrid[0:ATLAS, 0:ATLAS].astype(np.float32) / scale
    ix, iy = np.floor(xx).astype(np.int32), np.floor(yy).astype(np.int32)
    best = np.full((ATLAS, ATLAS), 9.0, np.float32)
    for ox in (-1, 0, 1):
        for oy in (-1, 0, 1):
            cx = np.clip(ix + ox, 0, g + 1)
            cy = np.clip(iy + oy, 0, g + 1)
            px = cx + jx[cy, cx]
            py = cy + jy[cy, cx]
            best = np.minimum(best, (xx - px) ** 2 + (yy - py) ** 2)
    return np.sqrt(best)


def compose(ao, edge, idm):
    rng = np.random.default_rng(1986)
    ids = kit.decode_ids(idm)
    ao = np.clip(ao[..., 0], 0, 1)
    edge = np.clip(edge[..., 0], 0, 1)
    nz = lambda r: (lambda x: (x - x.mean()) / (x.std() + 1e-6))(blur(rng.random((ATLAS, ATLAS)).astype(np.float32), r))
    n_fine, n_mid, n_low, n_xlow = nz(1), nz(3), nz(16), nz(48)
    grain = rng.random((ATLAS, ATLAS)).astype(np.float32) - 0.5

    srgb = lambda c: (np.array(c, np.float32) / 255.0) ** 2.2
    paint, steel, poly, alu, rubber, grip = (ids == i for i in range(6))
    # Convex edges (exposed: they wear) vs concave creases (shaded: grime collects).
    convex = np.clip(edge * np.clip((ao - 0.55) * 3, 0, 1), 0, 1)
    crease = np.clip(edge * np.clip((0.8 - ao) * 3, 0, 1) + (1 - ao) * 0.6, 0, 1)
    # Wear: convex edges, broken up, plus scuffs on broad surfaces where hands rub.
    wear = np.clip((convex * 1.5 + n_mid * 0.22 + n_fine * 0.08 - 0.45) * 3.0, 0, 1)
    scuff = np.clip((n_low * 0.6 + n_xlow * 0.5 - 1.25) * 1.6, 0, 1) * 0.6
    # Scratches: many faint scuffs through the clear / top layer, a few deep ones to the metal.
    sc_light = np.clip(scratches(rng, 420, 50, 1.0), 0, 1)
    sc_deep = np.clip(scratches(rng, 60, 120, 1.4), 0, 1)
    sc = np.clip(sc_light * 0.6 + sc_deep, 0, 1)

    alb = np.zeros((ATLAS, ATLAS, 3), np.float32)
    rough = np.zeros((ATLAS, ATLAS), np.float32)
    metal = np.zeros((ATLAS, ATLAS), np.float32)
    H = np.zeros((ATLAS, ATLAS), np.float32)
    def put(mask, color, r, m):
        alb[mask] = color
        rough[mask] = r
        metal[mask] = m

    # Paint (matte olive drab enamel over phosphated steel): orange peel, chips through to dark
    # bare steel on exposed edges and deep scratches, light scuffs that only dull / lighten the paint.
    put(paint, srgb((47, 53, 37)), 0.74, 0.0)
    rough = rough + paint * n_mid * 0.05
    pw = np.clip(wear + sc_deep * 0.85, 0, 1) * paint
    sf = np.clip(scuff * 0.6 + sc_light * 0.5, 0, 1) * paint * (1 - pw)
    alb = alb * (1 - sf[..., None] * 0.35) + srgb((78, 82, 66)) * sf[..., None] * 0.35
    rough = rough - sf * 0.12
    H += paint * (n_fine * 0.05 + grain * 0.03)
    H -= pw * 0.35 + sf * 0.06
    bare = pw[..., None]
    alb = alb * (1 - bare) + srgb((86, 86, 84)) * bare
    rough = rough * (1 - pw) + 0.42 * pw
    metal = metal * (1 - pw) + pw
    # Primer halo around chips (a lighter rim before the metal shows).
    halo = np.clip(blur(pw, 2) - pw, 0, 1) * paint * 1.5
    alb = alb * (1 - halo[..., None] * 0.3) + srgb((92, 96, 80)) * halo[..., None] * 0.3

    # Steel (parkerised / blued): matte grain, polished on edges and in scratches.
    put(steel, srgb((36, 37, 39)), 0.56, 0.9)
    sw = np.clip(wear * 0.8 + sc_deep * 0.7 + sc_light * 0.25, 0, 1) * steel
    H += steel * (grain * 0.12 + n_fine * 0.05)
    H -= sw * 0.25
    alb = alb * (1 - sw[..., None] * 0.55) + srgb((118, 118, 116)) * sw[..., None] * 0.55
    rough = rough - sw * 0.2 - steel * n_mid * 0.04

    # Handguard polymer: fine mould texture, handling polish, light scratches whitened.
    put(poly, srgb((45, 51, 36)), 0.76, 0.0)
    H += poly * (n_fine * 0.06)
    polish = np.clip(n_low * 0.4 + 0.2, 0, 1) * poly
    rough = rough - polish * 0.14
    pscr = np.clip(sc * 0.45 + wear * 0.4, 0, 1) * poly
    alb = alb * (1 - pscr[..., None] * 0.3) + srgb((80, 84, 68)) * pscr[..., None] * 0.3
    H -= pscr * 0.15

    # Grip: stippled polymer.
    put(grip, srgb((40, 44, 32)), 0.84, 0.0)
    st = cells(rng, 9)
    H += grip * np.clip(0.55 - st, 0, 1) * 0.9
    gw = np.clip(wear * 0.6, 0, 1) * grip
    rough = rough - gw * 0.2

    # Magazine (alloy / steel, dark finish) and bolt face (bright steel).
    put(alu, srgb((58, 59, 61)), 0.42, 0.75)
    aw = np.clip(wear + sc * 0.8, 0, 1) * alu
    H += alu * grain * 0.06
    alb = alb * (1 - aw[..., None] * 0.7) + srgb((165, 165, 160)) * aw[..., None] * 0.7
    rough = rough - aw * 0.2

    put(rubber, srgb((24, 24, 24)), 0.88, 0.0)
    H += rubber * n_mid * 0.2

    # Grime in creases and cavities, dust on top of it, overall handling variation.
    alb *= (1 - crease * 0.55)[..., None]
    dust = np.clip(crease * 0.8 + n_mid * 0.1 - 0.35, 0, 1) * (1 - metal * 0.5)
    alb = alb * (1 - dust[..., None] * 0.25) + srgb((96, 92, 82)) * dust[..., None] * 0.25
    rough = rough + crease * 0.18 + dust * 0.1 + n_low * 0.04
    alb *= (1 + n_xlow * 0.05 + grain * 0.03)[..., None]
    rough = np.clip(rough + grain * 0.03, 0.08, 1)
    metal = np.clip(metal, 0, 1)

    # Tangent-space normal map from the height field (OpenGL: +Y = +v = up in Blender's image rows).
    Hs = blur(H, 0) if False else H
    dx = (np.roll(Hs, -1, 1) - np.roll(Hs, 1, 1)) * 0.5
    dy = (np.roll(Hs, -1, 0) - np.roll(Hs, 1, 0)) * 0.5
    strength = 2.2
    nx, ny, nzz = -dx * strength, -dy * strength, np.ones_like(dx)
    l = np.sqrt(nx * nx + ny * ny + nzz * nzz)
    normal = np.stack([nx / l, ny / l, nzz / l], -1) * 0.5 + 0.5

    alb = np.clip(alb, 0, 1) ** (1 / 2.2)
    orm = np.stack([ao, rough, metal], -1)
    return alb, orm, normal.astype(np.float32)


# ------------------------------------------------------------------ main

def main():
    reset_scene()
    setup_cycles()
    parts = [build_receiver(), build_bolt(), build_trigger(), build_magazine()]
    for ob in parts:
        finish_shading(ob)
    unwrap(parts)
    imgs = {k: bpy.data.images.new(k, ATLAS, ATLAS, alpha=False, float_buffer=True) for k in ('ao', 'edge', 'id')}
    for im in imgs.values():
        im.colorspace_settings.name = 'Non-Color'
    bake_pass(parts, imgs['ao'], 'AO')
    bake_pass(parts, imgs['edge'], 'EMIT', edge_emission)
    bake_pass(parts, imgs['id'], 'EMIT', id_emission)
    alb, orm, nrm = compose(pixels(imgs['ao']), pixels(imgs['edge']), pixels(imgs['id']))
    os.makedirs(OUT_TEX, exist_ok=True)
    save_png(alb, os.path.join(OUT_TEX, 'carbine_albedo.png'), 'sRGB')
    save_png(orm, os.path.join(OUT_TEX, 'carbine_orm.png'), 'Non-Color')
    save_png(nrm, os.path.join(OUT_TEX, 'carbine_normal.png'), 'Non-Color')

    # One engine material for every part (the atlas carries paint / steel / polymer).
    final = bpy.data.materials.new('weapon_carbine')
    for ob in parts:
        ob.data.materials.clear()
        ob.data.materials.append(final)
    markers = [empty('muzzle', (0, 0.515, 0.0)), empty('eject', (0.024, 0.06, 0.032))]
    os.makedirs(os.path.dirname(OUT_GLB), exist_ok=True)
    for o in bpy.context.selected_objects:
        o.select_set(False)
    for o in parts + markers:
        o.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.export_scene.gltf(
        filepath=OUT_GLB, export_format='GLB', use_selection=True, export_yup=True,
        export_texcoords=True, export_normals=True, export_tangents=True,
        export_materials='EXPORT', export_image_format='NONE', export_extras=False, export_apply=True,
    )
    tris = sum(sum(len(p.vertices) - 2 for p in ob.data.polygons) for ob in parts)
    print(f'carbine: {len(parts)} parts, {tris} triangles -> {OUT_GLB}')
    if '--preview' in sys.argv:
        preview(parts)


def preview(parts):
    """Studio renders of the textured model (screenshots/carbine_preview_*.png) for review."""
    mat = bpy.data.materials['weapon_carbine']
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    alb = nt.nodes.new('ShaderNodeTexImage')
    alb.image = bpy.data.images.load(os.path.join(OUT_TEX, 'carbine_albedo.png'))
    orm = nt.nodes.new('ShaderNodeTexImage')
    orm.image = bpy.data.images.load(os.path.join(OUT_TEX, 'carbine_orm.png'))
    orm.image.colorspace_settings.name = 'Non-Color'
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(orm.outputs['Color'], sep.inputs['Color'])
    nt.links.new(alb.outputs['Color'], bsdf.inputs['Base Color'])
    nt.links.new(sep.outputs['Green'], bsdf.inputs['Roughness'])
    nt.links.new(sep.outputs['Blue'], bsdf.inputs['Metallic'])
    nrm = nt.nodes.new('ShaderNodeTexImage')
    nrm.image = bpy.data.images.load(os.path.join(OUT_TEX, 'carbine_normal.png'))
    nrm.image.colorspace_settings.name = 'Non-Color'
    nmap = nt.nodes.new('ShaderNodeNormalMap')
    nt.links.new(nrm.outputs['Color'], nmap.inputs['Color'])
    nt.links.new(nmap.outputs['Normal'], bsdf.inputs['Normal'])
    nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    scene = bpy.context.scene
    scene.render.resolution_x, scene.render.resolution_y = 1200, 700
    scene.cycles.samples = 48
    world = scene.world
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.35, 0.37, 0.4, 1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.6
    sun = bpy.data.objects.new('key', bpy.data.lights.new('key', 'SUN'))
    sun.data.energy = 3.5
    sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(140))
    scene.collection.objects.link(sun)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.data.lens = 50
    shots = {
        'side': ((0.9, 0.05, 0.08), (0, 0.05, -0.02), 39.6),
        'quarter': ((0.55, -0.45, 0.3), (0, 0.05, -0.03), 39.6),
        'detail': ((0.16, 0.25, 0.12), (0, 0.36, 0.03), 39.6),
        # The player's eye relative to the gun (viewmodel offset), weapon FOV 52 degrees vertical.
        'eye': ((-0.13, -0.22, 0.125), (-0.13, 2.0, 0.07), 52.0),
    }
    shots_dir = os.path.join(os.path.dirname(PUBLIC), 'screenshots')
    for name, (eye, at, fov) in shots.items():
        cam.location = eye
        d = Vector(at) - Vector(eye)
        cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
        cam.data.sensor_fit = 'VERTICAL'
        cam.data.angle_y = math.radians(fov)
        scene.render.resolution_x, scene.render.resolution_y = (1280, 720) if name == 'eye' else (1200, 700)
        scene.render.filepath = os.path.join(shots_dir, f'carbine_preview_{name}.png')
        bpy.ops.render.render(write_still=True)


main()
