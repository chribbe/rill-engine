"""G2 enemy (docs/GAME.md section 8): the tomato bug.

A bloated, glossy beefsteak tomato (~0.82 m across) on six thorny vine legs,
split horizontally into a lower jaw and a lid that hinges open at the back on
a wet cross-section mouth (pericarp ring, gel chambers, seeds, a dark throat)
with seed teeth along both rims. A sepal crown and stem sit on the lid.

Rig parts (pivots at the joints; parents in node extras `parent`):
  body                      lower half (jaw), pivot at the body centre
  lid (body)                upper half, pivot on the hinge at the back rim
  crown (lid)               sepals + stem
  leg_<k>_upper (body)      thigh, pivot at the hip     k = fl ml rl fr mr rr
  leg_<k>_lower (upper)     shin, pivot at the knee
Leg nodes carry extras `tip`: the segment's end in the part's frame (glTF axes), for IK.

Gib meshes (no parent, extras `gib`): skin shells, a wall chunk, pulp lumps. The lid,
crown and leg segments are thrown as gibs too (the game reuses their meshes).

Textures: one 2048 atlas (AO + material ids + height): glossy red skin with darker
grooves, green-gold shoulders and corky growth cracks near the stem; fibrous red
flesh; wet yellow-green gel; pale seeds; green hairy vine; brown thorn tips.

Output: public/assets/enemies/tomato.glb,
public/textures/enemies/tomato_{albedo,orm,normal}.png (public/materials/veg_tomato.json is hand-written).
Run: node tools/blender/run.ts tomato [-- --preview]

Frame (Blender): x right, y forward (the creature faces +y), z up, metres, ground at z = 0.
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
from kit import Piece, setup_cycles, unwrap, bake_pass, id_emission, pixels, blur, save_png  # noqa: E402

ATLAS = 2048
IDS = ['skin', 'flesh', 'gel', 'seed', 'core', 'dark', 'vine', 'thorn', 'sepal']
kit.configure(IDS, ATLAS, 96)
OUT_GLB = os.path.join(PUBLIC, 'assets', 'enemies', 'tomato.glb')
OUT_TEX = os.path.join(PUBLIC, 'textures', 'enemies')

C = Vector((0.0, 0.0, 0.56))   # body centre, standing
R = 0.41                       # body radius at the equator
H0, H1 = 0.25, 0.27            # half heights below / above the centre
SPLIT = 0.035                  # mouth plane (body local z)
NL = 7                         # lobes
SEGS = NL * 8                  # vertices around
LEGS = [('fl', -38), ('ml', -90), ('rl', -142), ('fr', 38), ('mr', 90), ('rr', 142)]
TO_GLTF = lambda v: [round(v[0], 5), round(v[2], 5), round(-v[1], 5)]


def rng_noise(seed):
    r = np.random.default_rng(seed)
    ph = r.random(6) * 6.283
    return lambda a, t: (math.sin(a * 2 + ph[0] + t * 3) * 0.5 + math.sin(a * 5 + ph[1] - t * 7) * 0.3 + math.sin(a * 11 + ph[2] + t * 13) * 0.2)


BODY_NOISE = rng_noise(7)


def body_point(a, phi):
    """Point on the lobed body surface (body local): a around z from +y (towards +x), phi latitude."""
    z = (H1 if phi >= 0 else H0) * math.sin(phi)
    r = R * max(0.0, math.cos(phi)) ** 0.82
    t = (phi + math.pi / 2) / math.pi  # 0 bottom .. 1 top
    # Beefsteak lobes: narrow grooves, deepest on the shoulders, faint low down.
    groove = ((1 - math.cos(NL * a)) * 0.5) ** 3
    depth = 0.035 + 0.11 * math.exp(-((t - 0.78) / 0.16) ** 2) + 0.04 * math.exp(-((t - 0.18) / 0.12) ** 2)
    r *= 1 - depth * groove
    r *= 1 + 0.018 * BODY_NOISE(a, t)
    return Vector((math.sin(a) * r, math.cos(a) * r, z))


def ring_at(phi):
    return [body_point(2 * math.pi * i / SEGS, phi) for i in range(SEGS)]


def phi_of(z):
    return math.asin(max(-1.0, min(1.0, z / (H1 if z >= 0 else H0))))


def faces_between(p, ra, rb, mat_of, closed=True):
    """Quads between two vertex rings (lists of BMVerts); mat_of(i) names each face's id."""
    n = len(ra)
    out = []
    for i in range(n if closed else n - 1):
        j = (i + 1) % n
        try:
            f = p.bm.faces.new([ra[i], ra[j], rb[j], rb[i]])
        except ValueError:
            continue
        f.material_index = IDS.index(mat_of(i))
        out.append(f)
    return out


def verts(p, pts):
    return [p.bm.verts.new(Vector(q)) for q in pts]


def ellipsoid(p, c, size, mat, rot=None, segs=8, rings=6):
    before = set(p.bm.faces)
    M = Matrix.Translation(Vector(c)) @ (rot.to_4x4() if rot else Matrix()) @ Matrix.Diagonal((size[0], size[1], size[2], 1))
    bmesh.ops.create_uvsphere(p.bm, u_segments=segs, v_segments=rings, radius=1.0, matrix=M)
    p._tag([f for f in p.bm.faces if f not in before], mat)


def cone(p, base, tip, r, mat, segs=7):
    p.cyl(base, tip, r, mat, segs, r1=0.0005)


def tube(p, pts, radii, mat, segs=10, caps=True, flutes=0, flute=0.0):
    """Tapered tube along a polyline (rings perpendicular to the path); optional lengthwise ridges."""
    pts = [Vector(q) for q in pts]
    rings, prev_n = [], None
    for i, c in enumerate(pts):
        d = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        ref = Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((1, 0, 0))
        n = d.cross(ref).normalized() if prev_n is None else (prev_n - d * prev_n.dot(d)).normalized()
        prev_n = n
        b = d.cross(n)
        fl = lambda k: 1 - flute * (0.5 - 0.5 * math.cos(flutes * 2 * math.pi * k / segs)) if flutes else 1
        rings.append([tuple(c + (n * math.cos(2 * math.pi * k / segs) + b * math.sin(2 * math.pi * k / segs)) * radii[i] * fl(k)) for k in range(segs)])
    p.loft(rings, mat, caps)


def bezier(a, b, c, n):
    a, b, c = Vector(a), Vector(b), Vector(c)
    return [tuple(a * (1 - t) ** 2 + b * 2 * t * (1 - t) + c * t * t) for t in (i / (n - 1) for i in range(n))]


# ------------------------------------------------------------------ body halves + mouth

def mouth_cap(p, rim, sign, seed):
    """Wet cross-section closing a half at the mouth plane: pericarp ring, gel chambers split by
    septa, a pale core around a dark throat, sunk into a bowl (sign -1 lower half, +1 lid)."""
    fr = [1.0, 0.93, 0.86, 0.72, 0.56, 0.4, 0.27, 0.16, 0.07]
    depth = 0.13
    rings = [rim]
    for f in fr[1:]:
        z = SPLIT + sign * depth * (1 - f * f) ** 0.8
        rings.append(verts(p, [(v.co.x * f, v.co.y * f, z) for v in rim]))

    def mat(k):
        def m(i):
            f0 = fr[k]
            if f0 > 0.87:
                return 'flesh'
            if f0 <= 0.16:
                return 'dark'
            if f0 <= 0.27:
                return 'core'
            s = i % 8
            return 'flesh' if s in (0, 7) else 'gel'
        return m
    for k in range(len(rings) - 1):
        faces_between(p, rings[k], rings[k + 1], mat(k))
    centre = p.bm.verts.new(Vector((0, 0, SPLIT + sign * depth)))
    for i in range(SEGS):
        j = (i + 1) % SEGS
        try:
            f = p.bm.faces.new([rings[-1][i], rings[-1][j], centre])
            f.material_index = IDS.index('dark')
        except ValueError:
            pass
    # Seeds in the gel chambers (two per chamber, on the bowl).
    rr = np.random.default_rng(seed)
    for lob in range(NL):
        for k in range(5):
            a = 2 * math.pi * (lob * 8 + 4 + (rr.random() - 0.5) * 4.0) / SEGS
            f = 0.36 + 0.42 * rr.random()
            z = SPLIT + sign * depth * (1 - f * f) ** 0.8
            base = body_point(a, phi_of(SPLIT))
            pos = Vector((base.x * f, base.y * f, z - sign * 0.004))
            rot = Matrix.Rotation(a, 3, 'Z')
            ellipsoid(p, pos, (0.016, 0.011, 0.006), 'seed', rot, 8, 5)
    # Teeth: oversized seeds standing on the rim (not at the hinge), pointing across the gap.
    nt = 22
    for k in range(nt):
        u = (k + 0.5) / nt
        a = math.radians(-145 + 290 * u)
        b = body_point(a, phi_of(SPLIT))
        inward = Vector((b.x, b.y, 0)).normalized()
        L = 0.05 + 0.025 * math.sin(u * math.pi) + 0.008 * rr.random()
        base = Vector((b.x, b.y, SPLIT)) - inward * 0.035
        tip = base + Vector((0, 0, -sign * L)) - inward * 0.012
        p.cyl(tuple(base), tuple(tip), 0.011 + 0.004 * math.sin(u * math.pi), 'seed', 7, r1=0.0015)


def build_halves():
    phis = [math.radians(d) for d in (-88, -80, -70, -60, -50, -40, -30, -21, -13, -6)] + [phi_of(SPLIT)]
    lower = Piece('body')
    rings = [verts(lower, ring_at(f)) for f in phis]
    for a, b in zip(rings, rings[1:]):
        faces_between(lower, a, b, lambda i: 'skin')
    bottom = lower.bm.verts.new(body_point(0, math.radians(-90)))
    for i in range(SEGS):
        try:
            f = lower.bm.faces.new([rings[0][(i + 1) % SEGS], rings[0][i], bottom])
            f.material_index = IDS.index('skin')
        except ValueError:
            pass
    mouth_cap(lower, rings[-1], -1, 11)

    lid = Piece('lid')
    phis = [phi_of(SPLIT)] + [math.radians(d) for d in (14, 22, 31, 40, 49, 58, 66, 73, 79)]
    rings = [verts(lid, ring_at(f)) for f in phis]
    for a, b in zip(rings, rings[1:]):
        faces_between(lid, a, b, lambda i: 'skin')
    # Shoulders roll into the stem cavity.
    top = H1 * math.sin(math.radians(79))
    cav = [verts(lid, [(v.co.x * f, v.co.y * f, top - d) for v in rings[-1]]) for f, d in ((0.62, 0.006), (0.34, 0.02), (0.14, 0.035))]
    prev = rings[-1]
    for ring in cav:
        faces_between(lid, prev, ring, lambda i: 'skin')
        prev = ring
    centre = lid.bm.verts.new(Vector((0, 0, top - 0.04)))
    for i in range(SEGS):
        try:
            f = lid.bm.faces.new([prev[i], prev[(i + 1) % SEGS], centre])
            f.material_index = IDS.index('skin')
        except ValueError:
            pass
    mouth_cap(lid, rings[0], +1, 23)
    hinge = Vector((0, -R * 0.93, SPLIT))
    # Built about the body centre; move into creature space before setting the pivots.
    for piece in (lower, lid):
        bmesh.ops.translate(piece.bm, verts=piece.bm.verts[:], vec=C)
    return lower.to_object(C), lid.to_object(C + hinge), top


def build_crown(top):
    p = Piece('crown')
    base = C + Vector((0, 0, top - 0.035))
    # Stem: a short thick bent stub with a cut end.
    tube(p, bezier(base, base + Vector((0.01, -0.01, 0.06)), base + Vector((0.035, -0.02, 0.1)), 5), [0.032, 0.03, 0.027, 0.025, 0.024], 'vine', 10)
    # Sepals: six spiky blades lying over the shoulders, tips curling up.
    for k in range(6):
        a = 2 * math.pi * k / 6 + 0.2
        out = Vector((math.sin(a), math.cos(a), 0))
        side = Vector((math.cos(a), -math.sin(a), 0))
        L = 0.24 + 0.04 * (k % 2)
        rings = []
        n = 8
        for i in range(n):
            t = i / (n - 1)
            # Lies on the shoulder (just above the skin), then the tip lifts away.
            r = L * t
            surf = lambda rr_: H1 * math.sin(math.acos(min(1.0, rr_ / R) ** (1 / 0.82)))
            zc = surf(r) + 0.014 if r > 0.09 else 0.235 + (surf(0.09) + 0.014 - 0.235) * (r / 0.09)
            zc += 0.07 * max(0.0, (t - 0.7) / 0.3) ** 2
            c = C + out * r + Vector((0, 0, zc))
            w = 0.05 * math.sin(math.pi * min(0.97, 0.12 + t * 0.85)) * (1 - 0.6 * t)
            th = 0.006 * (1 - 0.7 * t)
            up = out.cross(side) * -1
            rings.append([tuple(c + side * w), tuple(c + up * th), tuple(c - side * w), tuple(c - up * th)])
        p.loft(rings, 'sepal')
    return p.to_object(base)


# ------------------------------------------------------------------ legs

def leg_points(deg):
    th = math.radians(deg)
    d = Vector((math.sin(th), math.cos(th), 0))
    hip = C + d * 0.3 + Vector((0, 0, -0.06))
    knee = hip + d * 0.3 + Vector((0, 0, 0.3))
    foot = Vector((hip.x + d.x * 0.56, hip.y + d.y * 0.56, 0.0))
    return d, hip, knee, foot


def build_leg(key, deg, seed):
    rr = np.random.default_rng(seed)
    d, hip, knee, foot = leg_points(deg)
    side = d.cross(Vector((0, 0, 1))).normalized()
    up = Piece(f'leg_{key}_upper')
    bow = (hip + knee) / 2 + Vector((0, 0, 0.05)) + side * 0.015
    tube(up, bezier(hip, bow, knee, 8), [0.043, 0.039, 0.034, 0.03, 0.028, 0.029, 0.033, 0.036], 'vine', 15, flutes=5, flute=0.22)
    # Knee spur: a hard thorn pointing back off the joint.
    cone(up, tuple(knee + Vector((0, 0, 0.02)) - d * 0.01), tuple(knee + Vector((0, 0, 0.09)) - d * 0.06), 0.014, 'thorn')
    # Thorns along the top and sides of the thigh, raked back.
    for k in range(5):
        t = 0.15 + 0.17 * k
        c = Vector(bezier(hip, bow, knee, 11)[int(t * 10)])
        n = (Vector((0, 0, 1)) * 0.8 + side * (1 if k % 2 else -1) * 0.6 - d * 0.35).normalized()
        cone(up, tuple(c + n * 0.03), tuple(c + n * (0.075 + 0.02 * rr.random())), 0.011, 'thorn')
    # A tendril curl off the thigh (vine character).
    t0 = Vector(bezier(hip, bow, knee, 11)[4])
    curl = [t0 + side * 0.02 * i + Vector((0, 0, 0.012 * i)) + d * 0.01 * math.sin(i * 0.9) * i for i in range(7)]
    tube(up, [tuple(q) for q in curl], [0.008, 0.007, 0.006, 0.005, 0.004, 0.003, 0.0015], 'vine', 6)
    upper = up.to_object(hip)
    upper['parent'] = 'body'
    upper['tip'] = TO_GLTF(knee - hip)

    lo = Piece(f'leg_{key}_lower')
    mid = (knee + foot) / 2 + d * 0.06 + Vector((0, 0, 0.04))
    pts = bezier(knee, mid, foot + Vector((0, 0, 0.05)), 8)
    tube(lo, pts, [0.036, 0.031, 0.027, 0.023, 0.019, 0.015, 0.012, 0.01], 'vine', 15, flutes=5, flute=0.2)
    for k in range(6):
        c = Vector(pts[1 + k])
        n = (d * 0.7 + Vector((0, 0, 0.5)) + side * (0.5 if k % 2 else -0.5)).normalized()
        cone(lo, tuple(c + n * 0.02), tuple(c + n * (0.06 + 0.015 * rr.random())), 0.009, 'thorn')
    # Hooked claw: the vine ends in a hard thorn that bites into the ground.
    claw = bezier(foot + Vector((0, 0, 0.05)), foot + d * 0.05 + Vector((0, 0, 0.0)), foot + d * 0.02 + Vector((0, 0, -0.012)), 5)
    tube(lo, claw, [0.013, 0.011, 0.008, 0.005, 0.0015], 'thorn', 7)
    lower = lo.to_object(knee)
    lower['parent'] = f'leg_{key}_upper'
    lower['tip'] = TO_GLTF(foot - knee)
    return [upper, lower]


# ------------------------------------------------------------------ gibs

def shell(name, size, thick, curve_r, seed, at):
    """A ragged piece of the tomato wall: glossy skin outside, flesh inside and on the torn edge."""
    p = Piece(name)
    rr = np.random.default_rng(seed)
    n = 22
    ph = rr.random(3) * 6.28
    # Torn edge: lobes plus sharp spikes where the skin split.
    edge = [size * (1 + 0.24 * math.sin(3 * 2 * math.pi * i / n + ph[0]) + 0.12 * math.sin(7 * 2 * math.pi * i / n + ph[1]) + (0.32 if rr.random() < 0.18 else 0) * rr.random() + 0.08 * (rr.random() - 0.5)) for i in range(n)]
    def surf(f, inset):
        out = []
        for i in range(n):
            a = 2 * math.pi * i / n
            x, y = math.cos(a) * edge[i] * f, math.sin(a) * edge[i] * f * 0.85
            z = -(x * x + y * y) / (2 * curve_r) - inset
            out.append((x, y, z))
        return out
    fs = [1.0, 0.75, 0.45, 0.18]
    outer = [verts(p, surf(f, 0)) for f in fs]
    inner = [verts(p, surf(f, thick * (0.7 + 0.3 * (1 - f)))) for f in fs]
    for a, b in zip(outer, outer[1:]):
        faces_between(p, b, a, lambda i: 'skin')
    for k, (a, b) in enumerate(zip(inner, inner[1:])):
        faces_between(p, a, b, (lambda i: 'flesh') if k == 0 else (lambda i: 'gel' if (i * 7 + k * 3) % 5 < 2 else 'flesh'))
    c0 = p.bm.verts.new(Vector((0, 0, 0)))
    c1 = p.bm.verts.new(Vector((0, 0, -thick)))
    for i in range(n):
        j = (i + 1) % n
        for ring, c, rev, m in ((outer[-1], c0, True, 'skin'), (inner[-1], c1, False, 'flesh')):
            try:
                f = p.bm.faces.new([ring[j], ring[i], c] if rev else [ring[i], ring[j], c])
                f.material_index = IDS.index(m)
            except ValueError:
                pass
    faces_between(p, outer[0], inner[0], lambda i: 'flesh')
    # A few seeds stuck on the inside.
    for k in range(3):
        a = rr.random() * 6.28
        f = 0.3 + 0.4 * rr.random()
        x, y = math.cos(a) * size * f, math.sin(a) * size * f * 0.85
        ellipsoid(p, (x, y, -(x * x + y * y) / (2 * curve_r) - thick - 0.002), (0.014, 0.01, 0.005), 'seed', Matrix.Rotation(a, 3, 'Z'), 7, 5)
    ob = p.to_object((0, 0, -thick * 0.5))
    ob.location = Vector(at)
    ob['gib'] = 'shell'
    return ob


def pulp(name, size, seed, at):
    """A wobbly lump of gel and torn flesh with seeds in it."""
    p = Piece(name)
    rr = np.random.default_rng(seed)
    before = set(p.bm.faces)
    bmesh.ops.create_icosphere(p.bm, subdivisions=2, radius=size)
    ph = rr.random(4) * 6.28
    for v in p.bm.verts:
        q = v.co.normalized()
        k = 1 + 0.25 * math.sin(q.x * 3 + ph[0]) * math.sin(q.y * 4 + ph[1]) + 0.18 * math.sin(q.z * 5 + ph[2]) + 0.08 * (rr.random() - 0.5)
        v.co = Vector((q.x * size * k * 1.2, q.y * size * k * 0.95, q.z * size * k * 0.8))
    for f in [f for f in p.bm.faces if f not in before]:
        c = f.calc_center_median()
        f.material_index = IDS.index('gel' if math.sin(c.x * 25 + ph[3]) * math.sin(c.y * 22) > 0.55 else 'flesh')
    for k in range(4):
        a, b = rr.random() * 6.28, rr.random() * 3.14
        d = Vector((math.cos(a) * math.sin(b), math.sin(a) * math.sin(b), math.cos(b)))
        ellipsoid(p, tuple(d * size * 0.9), (0.014, 0.01, 0.006), 'seed', d.to_track_quat('Z', 'Y').to_matrix(), 7, 5)
    ob = p.to_object((0, 0, 0))
    ob.location = Vector(at)
    ob['gib'] = 'pulp'
    return ob


def build_gibs():
    return [
        shell('gib_shell_a', 0.15, 0.032, 0.24, 1, (1.6, 0.0, 0.3)),
        shell('gib_shell_b', 0.11, 0.03, 0.22, 2, (1.6, 0.5, 0.3)),
        shell('gib_shell_c', 0.075, 0.028, 0.2, 3, (1.6, -0.5, 0.3)),
        shell('gib_chunk', 0.08, 0.07, 0.3, 4, (2.1, 0.0, 0.3)),
        pulp('gib_pulp_a', 0.07, 5, (2.1, 0.5, 0.3)),
        pulp('gib_pulp_b', 0.045, 6, (2.1, -0.5, 0.3)),
    ]


# ------------------------------------------------------------------ textures

def height_emission(nt, em, name):
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    nt.links.new(geo.outputs['Position'], sep.inputs['Vector'])
    m = nt.nodes.new('ShaderNodeMath')
    m.operation = 'MULTIPLY'
    m.inputs[1].default_value = 1 / 1.0
    nt.links.new(sep.outputs['Z'], m.inputs[0])
    nt.links.new(m.outputs['Value'], em.inputs['Color'])
    em.inputs['Strength'].default_value = 1.0


def compose(ao, idm, hgt):
    rng = np.random.default_rng(2026)
    ids = kit.decode_ids(idm)
    ao = np.clip(ao[..., 0], 0, 1)
    h = np.clip(hgt[..., 0], 0, 2)
    nz = lambda r: (lambda x: (x - x.mean()) / (x.std() + 1e-6))(blur(rng.random((ATLAS, ATLAS)).astype(np.float32), r))
    n_fine, n_mid, n_low, n_xl = nz(1), nz(4), nz(16), nz(48)
    srgb = lambda c: (np.array(c, np.float32) / 255.0) ** 2.2
    M = {k: ids == IDS.index(k) for k in IDS}
    base = {'skin': ((158, 12, 7), 0.26), 'flesh': ((196, 26, 16), 0.28), 'gel': ((188, 112, 44), 0.05), 'seed': ((236, 218, 150), 0.34),
            'core': ((238, 136, 104), 0.32), 'dark': ((40, 3, 5), 0.1), 'vine': ((44, 74, 26), 0.6), 'thorn': ((104, 80, 44), 0.45), 'sepal': ((50, 104, 36), 0.5)}
    alb = np.zeros((ATLAS, ATLAS, 3), np.float32)
    rough = np.zeros((ATLAS, ATLAS), np.float32)
    H = np.zeros((ATLAS, ATLAS), np.float32)
    for k, (c, r) in base.items():
        alb[M[k]] = srgb(c)
        rough[M[k]] = r
    sk = M['skin']
    # Skin: deep red with a slow mottle; greenish-gold shoulders near the stem; corky growth cracks;
    # sparse pale specks; a glossy, slightly uneven sheen.
    alb *= (1 + (n_mid * 0.06 + n_low * 0.08) * sk)[..., None]
    shoulder = np.clip((h - 0.72) / 0.12, 0, 1) * sk
    alb = alb * (1 - shoulder[..., None] * 0.55) + srgb((170, 96, 22)) * shoulder[..., None] * 0.4 + srgb((96, 104, 30)) * shoulder[..., None] * 0.15
    cracks = np.clip((np.abs(n_fine * 0.6 + n_mid) < 0.08) * 1.0 * np.clip((h - 0.76) / 0.06, 0, 1) * sk, 0, 1)
    cracks = blur(cracks, 1)
    alb = alb * (1 - cracks[..., None] * 0.8) + srgb((120, 82, 48)) * cracks[..., None] * 0.8
    rough += cracks * 0.5
    specks = np.clip((n_fine - 3.0) * 3, 0, 1) * sk * 0.5
    alb = alb * (1 - specks[..., None] * 0.35) + srgb((230, 160, 120)) * specks[..., None] * 0.35
    rough += sk * (n_low * 0.04 + n_fine * 0.015)
    H += sk * (n_mid * 0.012 + cracks * -0.08)
    # Flesh: fibrous, wetter towards the gel.
    fl = M['flesh']
    fib = blur(rng.random((ATLAS, ATLAS)).astype(np.float32), 2)
    alb *= (1 + fl * (n_fine * 0.08 + (fib - 0.5) * 0.3))[..., None]
    H += fl * (n_fine * 0.04)
    # Gel: glassy, faint green veins, very smooth.
    g = M['gel']
    alb = alb * (1 - g[..., None] * np.clip(n_mid * 0.2, 0, 0.3)[..., None]) + srgb((120, 150, 50)) * (g * np.clip(n_mid * 0.2, 0, 0.3))[..., None]
    # Vine: fine hairs (stipple), darker stripes along, lighter on the outside.
    v = M['vine'] | M['sepal']
    alb *= (1 + v * (n_mid * 0.12 + n_fine * 0.07))[..., None]
    hairs = np.clip((n_fine - 1.6) * 2, 0, 1) * v
    alb = alb * (1 - hairs[..., None] * 0.14) + srgb((120, 140, 90)) * hairs[..., None] * 0.14
    H += v * (hairs * 0.06 + n_fine * 0.02)
    # Thorns: darker, glossier at the tips (no tip info: use AO as a proxy).
    th = M['thorn']
    alb *= (1 - th * 0.3 * (1 - ao))[..., None]
    # Cavity darkening; wet creases are glossier.
    alb *= (0.5 + 0.5 * ao)[..., None]
    rough = np.clip(rough - (1 - ao) * 0.08 * (sk | fl | g) + n_fine * 0.02, 0.04, 1)
    dx = (np.roll(H, -1, 1) - np.roll(H, 1, 1)) * 0.5
    dy = (np.roll(H, -1, 0) - np.roll(H, 1, 0)) * 0.5
    nx, ny, nzz = -dx * 1.2, -dy * 1.2, np.ones_like(dx)
    l = np.sqrt(nx * nx + ny * ny + nzz * nzz)
    normal = np.stack([nx / l, ny / l, nzz / l], -1) * 0.5 + 0.5
    alb = np.clip(alb, 0, 1) ** (1 / 2.2)
    orm = np.stack([ao, rough, np.zeros_like(ao)], -1)
    return alb, orm, normal.astype(np.float32)


# ------------------------------------------------------------------ main

def main():
    reset_scene()
    setup_cycles()
    body, lid, top = build_halves()
    lid['parent'] = 'body'
    crown = build_crown(top)
    crown['parent'] = 'lid'
    legs = []
    for i, (k, deg) in enumerate(LEGS):
        legs += build_leg(k, deg, 40 + i)
    gibs = build_gibs()
    objs = [body, lid, crown] + legs + gibs
    for ob in objs:
        bpy.context.view_layer.objects.active = ob
        for o in bpy.context.selected_objects:
            o.select_set(False)
        ob.select_set(True)
        bpy.ops.object.shade_smooth()
        tri = ob.modifiers.new('tri', 'TRIANGULATE')
        bpy.ops.object.modifier_apply(modifier=tri.name)
    unwrap(objs)
    imgs = {k: bpy.data.images.new(k, ATLAS, ATLAS, alpha=False, float_buffer=True) for k in ('ao', 'id', 'h')}
    for im in imgs.values():
        im.colorspace_settings.name = 'Non-Color'
    bake_pass(objs, imgs['ao'], 'AO')
    bake_pass(objs, imgs['id'], 'EMIT', id_emission)
    bake_pass(objs, imgs['h'], 'EMIT', height_emission)
    alb, orm, nrm = compose(pixels(imgs['ao']), pixels(imgs['id']), pixels(imgs['h']))
    os.makedirs(OUT_TEX, exist_ok=True)
    save_png(alb, os.path.join(OUT_TEX, 'tomato_albedo.png'), 'sRGB')
    save_png(orm, os.path.join(OUT_TEX, 'tomato_orm.png'), 'Non-Color')
    save_png(nrm, os.path.join(OUT_TEX, 'tomato_normal.png'), 'Non-Color')
    # Rig pieces that fly off whole on death, as gibs centred on their bounds (the rig parts pivot at
    # their joints). Mesh copies after the bake: same UVs, same texels.
    def gib_copy(src, name, at):
        me = src.data.copy()
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        lo = Vector([min(v.co[i] for v in me.vertices) for i in range(3)])
        hi = Vector([max(v.co[i] for v in me.vertices) for i in range(3)])
        me.transform(Matrix.Translation(-(lo + hi) / 2))
        ob.location = Vector(at)
        ob['gib'] = 'part'
        return ob
    copies = [gib_copy(lid, 'gib_lid', (2.7, 0.0, 0.4)), gib_copy(crown, 'gib_crown', (2.7, 0.6, 0.4)),
              gib_copy(legs[6], 'gib_leg_upper', (3.2, 0.0, 0.4)), gib_copy(legs[7], 'gib_leg_lower', (3.2, 0.6, 0.4))]
    objs += copies
    gibs += copies
    final = bpy.data.materials.new('veg_tomato')
    for ob in objs:
        ob.data.materials.clear()
        ob.data.materials.append(final)
    for o in bpy.context.selected_objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    os.makedirs(os.path.dirname(OUT_GLB), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=OUT_GLB, export_format='GLB', use_selection=True, export_yup=True,
        export_texcoords=True, export_normals=True, export_tangents=True,
        export_materials='EXPORT', export_image_format='NONE', export_extras=True, export_apply=True,
    )
    tris = {o.name: len(o.data.polygons) for o in objs}
    rig = sum(v for k, v in tris.items() if not k.startswith('gib_'))
    print(f'tomato: {len(objs) - len(gibs)} rig parts ({rig} triangles), {len(gibs)} gibs -> {OUT_GLB}')
    if '--preview' in sys.argv:
        preview(objs, lid)


def preview(objs, lid):
    mat = bpy.data.materials['veg_tomato']
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    alb = nt.nodes.new('ShaderNodeTexImage')
    alb.image = bpy.data.images.load(os.path.join(OUT_TEX, 'tomato_albedo.png'))
    orm = nt.nodes.new('ShaderNodeTexImage')
    orm.image = bpy.data.images.load(os.path.join(OUT_TEX, 'tomato_orm.png'))
    orm.image.colorspace_settings.name = 'Non-Color'
    nrm = nt.nodes.new('ShaderNodeTexImage')
    nrm.image = bpy.data.images.load(os.path.join(OUT_TEX, 'tomato_normal.png'))
    nrm.image.colorspace_settings.name = 'Non-Color'
    nmap = nt.nodes.new('ShaderNodeNormalMap')
    nt.links.new(nrm.outputs['Color'], nmap.inputs['Color'])
    nt.links.new(nmap.outputs['Normal'], bsdf.inputs['Normal'])
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(orm.outputs['Color'], sep.inputs['Color'])
    nt.links.new(alb.outputs['Color'], bsdf.inputs['Base Color'])
    nt.links.new(sep.outputs['Green'], bsdf.inputs['Roughness'])
    nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    scene = bpy.context.scene
    scene.render.resolution_x, scene.render.resolution_y = 1000, 800
    scene.cycles.samples = 64
    world = scene.world
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.42, 0.44, 0.47, 1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.8
    sun = bpy.data.objects.new('key', bpy.data.lights.new('key', 'SUN'))
    sun.data.energy = 2.5
    sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(200))
    scene.collection.objects.link(sun)
    floor = bpy.data.objects.new('floor', bpy.data.meshes.new('floor'))
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=6)
    bm.to_mesh(floor.data)
    bm.free()
    fm = bpy.data.materials.new('floor')
    fm.use_nodes = True
    fm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.32, 0.32, 0.33, 1)
    floor.data.materials.append(fm)
    scene.collection.objects.link(floor)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.data.lens = 45
    shots_dir = os.path.join(os.path.dirname(PUBLIC), 'screenshots')
    def shoot(name, eye, at):
        cam.location = eye
        cam.rotation_euler = (Vector(at) - Vector(eye)).to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = os.path.join(shots_dir, f'tomato_preview_{name}.png')
        bpy.ops.render.render(write_still=True)
    shoot('quarter', (1.9, 2.3, 1.25), (0, 0, 0.5))
    shoot('side', (2.9, 0.1, 0.8), (0, 0, 0.5))
    # Maw open: the lid swings up about its hinge.
    crown = bpy.data.objects['crown']
    crown.parent = lid
    crown.matrix_parent_inverse = lid.matrix_world.inverted()
    lid.rotation_euler = (math.radians(48), 0, 0)
    shoot('maw', (0.5, 1.9, 1.15), (0, 0, 0.55))
    lid.rotation_euler = (0, 0, 0)
    shoot('gibs', (1.85, 1.6, 1.3), (1.85, 0, 0.25))


main()
