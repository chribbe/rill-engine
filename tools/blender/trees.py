"""Procedural Nordic trees: Scots pine, Norway spruce, silver birch.

Each tree is generated as a deterministic *skeleton* (trunk + limbs as
polylines, foliage cards as oriented spray quads) and then emitted at several
levels of detail from that same skeleton, so silhouettes match across LODs:

  LOD0  trunk, branch tubes, all spray cards (~1-9k triangles)
  LOD1  coarse trunk, main limbs only, every 3rd card scaled up to keep coverage
  LOD2  impostor: three crossed quads textured with an orthographic Cycles
        render of LOD0 (albedo + crown ambient occlusion)

Spray cards use the twig-base-at-bottom-centre convention of the foliage
textures. Foliage normals are bent away from the crown centre so the canopy
shades as a volume; trunks keep their real normals. Pine and birch trunks
carry a vertex-colour blend weight (orange upper pine bark, dark birch base).
"""
import json
import math
import os
import random

import bpy
import numpy as np
from mathutils import Matrix, Vector, noise

from common import MeshBuilder, PUBLIC, export_glb, material_def, smoothstep

UP = Vector((0, 0, 1))

FOLIAGE = {'pine': 'foliage_pine', 'spruce': 'foliage_spruce', 'birch': 'foliage_birch'}
BARK = {'pine': 'bark_pine_blend', 'spruce': 'bark_pine', 'birch': 'bark_birch_blend'}
# LOD switch distances (metres at instance scale 1).
LOD_DISTANCES = [0.0, 30.0, 95.0]


class Limb:
    __slots__ = ('pts', 'radii', 'level', 'dead')

    def __init__(self, pts, radii, level, dead=False):
        self.pts, self.radii, self.level, self.dead = pts, radii, level, dead


class Card:
    __slots__ = ('base', 'axis', 'side', 'length', 'width', 'flip')

    def __init__(self, base, axis, side, length, width, flip):
        self.base, self.axis, self.side, self.length, self.width, self.flip = base, axis, side, length, width, flip


class Skeleton:
    def __init__(self, species, height):
        self.species = species
        self.height = height
        self.trunk = None
        self.limbs = []
        self.cards = []
        self.crown_center = 0.0
        self.crown_squash = 0.6


def _rand_perp(rnd, v):
    a = v.cross(UP if abs(v.z) < 0.95 else Vector((1, 0, 0))).normalized()
    b = v.cross(a).normalized()
    t = rnd.uniform(0, 2 * math.pi)
    return (a * math.cos(t) + b * math.sin(t)).normalized()


def _rotate(v, axis, ang):
    """Rodrigues rotation of v around unit axis."""
    return v * math.cos(ang) + axis.cross(v) * math.sin(ang) + axis * axis.dot(v) * (1 - math.cos(ang))


def _poly(fn, n):
    return [fn(i / (n - 1)) for i in range(n)]


def _tangent(pts, i):
    a, b = pts[max(0, i - 1)], pts[min(len(pts) - 1, i + 1)]
    return (b - a).normalized()


def _sample(pts, t):
    """Point and tangent at parameter t (0..1) along a polyline (uniform in index)."""
    f = t * (len(pts) - 1)
    i = min(len(pts) - 2, int(f))
    u = f - i
    p = pts[i].lerp(pts[i + 1], u)
    return p, (pts[i + 1] - pts[i]).normalized()


def _trunk(rnd, sk, r_base, r_top, sweep, seed):
    H = sk.height
    n = max(8, int(H / 0.9))
    ph = rnd.uniform(0, 6.28)

    def at(t):
        z = -0.3 + (H + 0.3) * t
        off = Vector((math.sin(ph + t * 2.2), math.cos(ph * 1.3 + t * 1.7), 0)) * sweep * math.sin(math.pi * t * 0.9)
        off += Vector((noise.noise(Vector((t * 3, seed, 0.5))), noise.noise(Vector((seed, t * 3, 1.5))), 0)) * sweep * 0.3
        return Vector((off.x, off.y, z))
    pts = _poly(at, n + 1)
    radii = []
    for p in pts:
        t = min(1.0, max(0.0, p.z) / H)
        flare = 0.55 * r_base * math.exp(-max(0.0, p.z) / 0.35)
        radii.append(r_top + (r_base - r_top) * (1 - t) ** 0.85 + flare)
    sk.trunk = Limb(pts, radii, 0)
    return pts, radii


def _trunk_at(sk, z):
    pts, radii = sk.trunk.pts, sk.trunk.radii
    for i in range(len(pts) - 1):
        if pts[i + 1].z >= z:
            u = (z - pts[i].z) / max(1e-6, pts[i + 1].z - pts[i].z)
            return pts[i].lerp(pts[i + 1], u), radii[i] + (radii[i + 1] - radii[i]) * u
    return pts[-1], radii[-1]


def _card(rnd, sk, base, axis, length, width, roll=None, side=None):
    axis = axis.normalized()
    if side is None:
        side = axis.cross(UP)
        if side.length < 1e-3:
            side = _rand_perp(rnd, axis)
        side = side.normalized()
        side = _rotate(side, axis, roll if roll is not None else rnd.uniform(-0.5, 0.5))
    sk.cards.append(Card(base - axis * 0.06 * length, axis, side.normalized(), length, width, rnd.random() < 0.5))


# ------------------------------------------------------------ species
def spruce(seed, height=17.5):
    rnd = random.Random(seed)
    sk = Skeleton('spruce', height * rnd.uniform(0.92, 1.08))
    H = sk.height
    _trunk(rnd, sk, 0.23, 0.015, 0.06, seed)
    dead_h = rnd.uniform(1.6, 4.2)
    z = 0.6
    while z < H - 0.35:
        k = (H - z) / H
        dead = z < dead_h
        nb = rnd.randint(2, 4) if dead else rnd.randint(4, 6)
        az0 = rnd.uniform(0, 2 * math.pi)
        c, rz = _trunk_at(sk, z)
        for i in range(nb):
            az = az0 + 2 * math.pi * i / nb + rnd.uniform(-0.3, 0.3)
            d = Vector((math.cos(az), math.sin(az), 0))
            L = (0.35 + 3.05 * k ** 0.85) * rnd.uniform(0.85, 1.1)
            if dead:
                L *= rnd.uniform(0.35, 0.75)
            elev = -0.5 + 0.75 * (z / H) ** 1.3 + rnd.uniform(-0.08, 0.08)
            sag = 0.10 + 0.14 * k
            start = c + d * rz * 0.7

            def at(t, d=d, L=L, elev=elev, sag=sag, start=start, dead=dead):
                up = L * t * math.sin(elev) - sag * L * math.sin(math.pi * t) * 0.5 + (0 if dead else 0.12 * L * t ** 3)
                return start + d * (L * t * math.cos(elev)) + UP * up
            pts = _poly(at, 4)
            r0 = 0.010 + 0.024 * L / 3.4
            sk.limbs.append(Limb(pts, [r0, r0 * 0.7, r0 * 0.45, 0.004], 1, dead))
            if dead:
                continue
            step = 0.36
            t = 0.18
            while t <= 1.0:
                p, tan = _sample(pts, t)
                ln = rnd.uniform(0.7, 1.0) * (0.65 + 0.35 * min(1.0, L / 2.0))
                ax = (tan + Vector((rnd.uniform(-0.2, 0.2), rnd.uniform(-0.2, 0.2), rnd.uniform(-0.15, 0.05)))).normalized()
                _card(rnd, sk, p, ax, ln, ln * 0.78)
                if k > 0.2 and rnd.random() < 0.4:
                    hang = (-UP + tan * 0.35 + Vector((rnd.uniform(-0.2, 0.2), rnd.uniform(-0.2, 0.2), 0))).normalized()
                    side = UP.cross(tan).normalized()
                    hl = rnd.uniform(0.45, 0.8)
                    _card(rnd, sk, p, hang, hl, hl * 0.6, side=side)
                t += step / max(0.4, L)
            pt, tt = _sample(pts, 1.0)
            _card(rnd, sk, pt - tt * 0.15, tt, 0.5, 0.4)
        z += rnd.uniform(0.32, 0.45)
    top = sk.trunk.pts[-1]
    for k in range(3):
        a = k * math.pi / 3
        _card(rnd, sk, top - UP * 1.1, UP + Vector((rnd.uniform(-0.1, 0.1), rnd.uniform(-0.1, 0.1), 0)), 1.4, 0.7,
              side=Vector((math.cos(a), math.sin(a), 0)))
    sk.crown_center = H * 0.45
    sk.crown_squash = 0.45
    return sk


def pine(seed, height=19.5):
    rnd = random.Random(seed)
    sk = Skeleton('pine', height * rnd.uniform(0.92, 1.08))
    H = sk.height
    _trunk(rnd, sk, 0.27, 0.035, rnd.uniform(0.12, 0.35), seed)
    cb = rnd.uniform(0.58, 0.68) * H
    # Self-pruned stubs on the bare trunk.
    for _ in range(rnd.randint(4, 8)):
        z = rnd.uniform(3.0, cb - 0.5)
        c, rz = _trunk_at(sk, z)
        az = rnd.uniform(0, 2 * math.pi)
        d = Vector((math.cos(az), math.sin(az), rnd.uniform(-0.25, 0.2))).normalized()
        L = rnd.uniform(0.25, 0.8)
        sk.limbs.append(Limb([c + d * rz * 0.6, c + d * (rz + L)], [0.03, 0.012], 1, True))

    def tuft(p, d, scale=1.0):
        # Scots pine foliage sits in dense clumps around the shoot ends.
        for _ in range(rnd.randint(11, 15)):
            ax = (d * 0.8 + Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-0.5, 1))) * 0.85 + UP * 0.35).normalized()
            ln = rnd.uniform(0.85, 1.3) * scale
            _card(rnd, sk, p, ax, ln, ln * 0.85, roll=rnd.uniform(-1.2, 1.2))

    n = rnd.randint(10, 14)
    for i in range(n):
        z = cb + (H - 0.9 - cb) * ((i + rnd.random() * 0.7) / n)
        t = (z - cb) / (H - cb)
        c, rz = _trunk_at(sk, z)
        az = i * 2.39996 + rnd.uniform(-0.4, 0.4)
        d = Vector((math.cos(az), math.sin(az), 0))
        L = (0.7 + 2.5 * (1 - t ** 1.5)) * rnd.uniform(0.75, 1.15)
        elev = 0.35 + 0.6 * t + rnd.uniform(-0.15, 0.15)
        start = c + d * rz * 0.7
        wig = Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1), 0)) * 0.15

        def at(u, d=d, L=L, elev=elev, start=start, wig=wig):
            return start + d * (L * u * math.cos(elev)) + UP * (L * u * math.sin(elev) + 0.2 * L * u * u) + wig * L * math.sin(math.pi * u)
        pts = _poly(at, 5)
        r0 = 0.02 + 0.055 * L / 3.2
        sk.limbs.append(Limb(pts, [r0, r0 * 0.75, r0 * 0.55, r0 * 0.35, 0.01], 1))
        tip, ttan = _sample(pts, 1.0)
        tuft(tip, ttan, 1.1)
        u = 0.45
        while u < 0.95:
            p, tan = _sample(pts, u)
            tuft(p + UP * 0.15, (tan + UP * 0.5).normalized(), 0.85)
            u += 0.55 / max(0.6, L)
        for _ in range(rnd.randint(3, 5) if L > 0.8 else 1):
            u = rnd.uniform(0.35, 0.8)
            p, tan = _sample(pts, u)
            sd = _rotate(tan, UP, rnd.choice([-1, 1]) * rnd.uniform(0.5, 0.95))
            sd = (sd + UP * 0.3).normalized()
            sl = L * (1 - u) * rnd.uniform(0.45, 0.7) + 0.3
            q = [p, p + sd * sl * 0.5 + UP * 0.05 * sl, p + sd * sl + UP * 0.15 * sl]
            sk.limbs.append(Limb(q, [r0 * 0.5, r0 * 0.35, 0.008], 2))
            tuft(q[-1], sd, 0.95)
            if sl > 0.9:
                tuft(q[1], sd, 0.75)
    tuft(sk.trunk.pts[-1], UP, 1.0)
    sk.crown_center = (cb + H) * 0.5
    sk.crown_squash = 0.7
    return sk


def birch(seed, height=15.0):
    rnd = random.Random(seed)
    sk = Skeleton('birch', height * rnd.uniform(0.9, 1.1))
    H = sk.height
    _trunk(rnd, sk, 0.17, 0.02, rnd.uniform(0.1, 0.22), seed)
    cb = rnd.uniform(0.3, 0.4) * H

    def hang_cards(pts, L, density=0.2):
        u = 0.25
        while u <= 1.0:
            p, tan = _sample(pts, u)
            ax = (-UP + tan * 0.3 + Vector((rnd.uniform(-0.3, 0.3), rnd.uniform(-0.3, 0.3), 0))).normalized()
            ln = rnd.uniform(1.0, 1.6)
            side = _rotate(UP.cross(tan).normalized(), ax, rnd.uniform(-0.7, 0.7)) if abs(tan.z) < 0.97 else None
            _card(rnd, sk, p, ax, ln, ln * 0.7, side=side)
            if rnd.random() < 0.5:
                ln2 = rnd.uniform(0.7, 1.1)
                _card(rnd, sk, p, (tan + UP * 0.2 + _rand_perp(rnd, tan) * 0.4).normalized(), ln2, ln2 * 0.85)
            u += density / max(0.5, L)

    n = rnd.randint(13, 17)
    for i in range(n):
        z = cb + (H * 0.93 - cb) * ((i + rnd.random() * 0.7) / n)
        t = (z - cb) / (H - cb)
        c, rz = _trunk_at(sk, z)
        az = i * 2.39996 + rnd.uniform(-0.4, 0.4)
        d = Vector((math.cos(az), math.sin(az), 0))
        L = (1.1 + 2.0 * math.sin(math.pi * (1 - t) * 0.85 + 0.1)) * rnd.uniform(0.8, 1.15)
        elev = 0.8 + 0.35 * t + rnd.uniform(-0.12, 0.12)
        start = c + d * rz * 0.7

        def at(u, d=d, L=L, elev=elev, start=start):
            return start + d * (L * u * math.cos(elev) * (0.7 + 0.5 * u)) + UP * (L * u * math.sin(elev) - 0.35 * L * u * u)
        pts = _poly(at, 5)
        r0 = 0.015 + 0.035 * L / 3.0
        sk.limbs.append(Limb(pts, [r0, r0 * 0.7, r0 * 0.5, r0 * 0.3, 0.006], 1))
        hang_cards(pts, L)
        for _ in range(rnd.randint(2, 4)):
            u = rnd.uniform(0.3, 0.8)
            p, tan = _sample(pts, u)
            sd = (_rotate(tan, UP, rnd.choice([-1, 1]) * rnd.uniform(0.5, 0.9)) + UP * 0.1).normalized()
            sl = L * (1 - u) * rnd.uniform(0.5, 0.8) + 0.4
            q = [p, p + sd * sl * 0.5, p + sd * sl - UP * 0.25 * sl]
            sk.limbs.append(Limb(q, [r0 * 0.45, r0 * 0.3, 0.006], 2))
            hang_cards(q, sl, 0.25)
    top = sk.trunk.pts[-1]
    for k in range(2):
        a = k * math.pi / 2 + rnd.uniform(0, 1)
        _card(rnd, sk, top - UP * 0.9, UP, 1.2, 0.8, side=Vector((math.cos(a), math.sin(a), 0)))
    sk.crown_center = (cb + H) * 0.5
    sk.crown_squash = 0.6
    return sk


SPECIES = {'pine': pine, 'spruce': spruce, 'birch': birch}


# ------------------------------------------------------------ geometry
def path_tube(b, pts, radii, mat, sides, repeats=None):
    """Continuous tube along a polyline (parallel-transported frames, metre UVs along the length)."""
    n = len(pts)
    tans = [_tangent(pts, i) for i in range(n)]
    ref = UP if abs(tans[0].z) < 0.9 else Vector((1, 0, 0))
    nrm = tans[0].cross(ref).normalized()
    rings, vlen = [], [0.0]
    for i in range(n):
        if i > 0:
            nrm = (nrm - tans[i] * nrm.dot(tans[i])).normalized()
            vlen.append(vlen[-1] + (pts[i] - pts[i - 1]).length)
        bi = tans[i].cross(nrm)
        rings.append([pts[i] + (nrm * math.cos(2 * math.pi * k / sides) + bi * math.sin(2 * math.pi * k / sides)) * radii[i] for k in range(sides)])
    if repeats is None:
        repeats = max(1, round(2 * math.pi * sum(radii) / n))
    for i in range(n - 1):
        for k in range(sides):
            j = k + 1
            u0, u1 = repeats * k / sides, repeats * j / sides
            b.face([rings[i][k], rings[i][j % sides], rings[i + 1][j % sides], rings[i + 1][k]], mat,
                   uvs=[(u0, vlen[i]), (u1, vlen[i]), (u1, vlen[i + 1]), (u0, vlen[i + 1])], smooth=True)


def emit(sk, name, lod):
    b = MeshBuilder(name)
    bark, leaf = BARK[sk.species], FOLIAGE[sk.species]
    tr = sk.trunk
    if lod == 0:
        path_tube(b, tr.pts, tr.radii, bark, 12)
    else:
        idx = list(range(0, len(tr.pts), 2))
        if idx[-1] != len(tr.pts) - 1:
            idx.append(len(tr.pts) - 1)
        path_tube(b, [tr.pts[i] for i in idx], [tr.radii[i] for i in idx], bark, 6)
    for limb in sk.limbs:
        if lod == 0:
            sides = 4 if limb.dead or limb.level == 1 and limb.radii[0] > 0.04 else 3
            path_tube(b, limb.pts, limb.radii, bark if sk.species != 'spruce' else 'bark_pine', sides, repeats=1)
        elif (limb.level == 1 and (limb.dead or sk.species != 'spruce') and limb.radii[0] > 0.025):
            path_tube(b, [limb.pts[0], limb.pts[-1]], [limb.radii[0], limb.radii[-1]], bark if sk.species != 'spruce' else 'bark_pine', 3, repeats=1)
    for i, c in enumerate(sk.cards):
        scale = 1.0
        if lod == 1:
            if i % 3:
                continue
            scale = 1.65
        s = c.side * (c.width * scale * 0.5)
        a = c.axis * (c.length * scale)
        q = [c.base - s, c.base + s, c.base + s + a, c.base - s + a]
        uvs = [(1, 0), (0, 0), (0, 1), (1, 1)] if c.flip else [(0, 0), (1, 0), (1, 1), (0, 1)]
        b.face(q, leaf, uvs=uvs, smooth=True)
    return b


def bent_normal_fn(sk):
    zc, sq = sk.crown_center, sk.crown_squash

    def fn(co):
        v = Vector((co.x, co.y, (co.z - zc) * sq))
        if v.length < 1e-4:
            return UP
        return (v.normalized() * 0.8 + UP * 0.35).normalized()
    return fn


def bark_weight_fn(sk):
    H, species = sk.height, sk.species
    seed = hash(species) % 97

    def fn(co, mat):
        if mat == 'bark_pine_blend':
            w = smoothstep(0.42 * H, 0.62 * H, co.z) + 0.25 * noise.noise(Vector((co.x * 2, co.y * 2, co.z * 0.7 + seed)))
        elif mat == 'bark_birch_blend':
            w = 1.0 - smoothstep(0.3, 2.4, co.z) + 0.3 * noise.noise(Vector((co.x * 3, co.y * 3, co.z + seed)))
        else:
            w = 0.0
        return (min(1.0, max(0.0, w)), 0.0, 0.0, 1.0)
    return fn


# ------------------------------------------------------------ impostor rendering
def _cycles(scene, samples):
    scene.render.engine = 'CYCLES'
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type = 'METAL'
    prefs.refresh_devices()
    for d in prefs.devices:
        d.use = d.type == 'METAL'
    scene.cycles.device = 'GPU'
    scene.cycles.samples = samples
    scene.cycles.use_adaptive_sampling = False
    scene.cycles.use_denoising = False
    scene.cycles.max_bounces = 0
    scene.cycles.transparent_max_bounces = 32
    scene.render.film_transparent = True
    scene.render.filter_size = 1.0


def _image(path, non_color=False):
    img = bpy.data.images.load(path, check_existing=True)
    img.alpha_mode = 'STRAIGHT'
    if non_color:
        img.colorspace_settings.name = 'Non-Color'
    return img


def _render_material(mname, mode):
    """Emission-only proxy of an engine material: albedo (linear) or crown AO, with alpha cutout."""
    d = material_def(mname)
    m = bpy.data.materials.new(f'imp_{mode}_{mname}')
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    emit_n = nt.nodes.new('ShaderNodeEmission')
    uv = nt.nodes.new('ShaderNodeUVMap')
    uv.uv_map = 'UVMap'

    def tex_color(md):
        ps = md.get('physicalSize', 1)
        ps = ps if isinstance(ps, list) else [ps, ps]
        mp = nt.nodes.new('ShaderNodeMapping')
        mp.inputs['Scale'].default_value = (1 / ps[0], 1 / ps[1], 1)
        nt.links.new(uv.outputs['UV'], mp.inputs['Vector'])
        if not md.get('baseColor'):
            return None, None
        tx = nt.nodes.new('ShaderNodeTexImage')
        tx.image = _image(os.path.join(PUBLIC, 'textures', md['baseColor']))
        tx.interpolation = 'Closest' if md.get('alphaMode') == 'mask' else 'Linear'
        nt.links.new(mp.outputs['Vector'], tx.inputs['Vector'])
        return tx.outputs['Color'], tx.outputs['Alpha']

    col, alpha = tex_color(d)
    if d.get('blend') and col is not None:
        bcol, _ = tex_color(material_def(d['blend']['material']))
        attr = nt.nodes.new('ShaderNodeAttribute')
        attr.attribute_name = 'Col'
        sep = nt.nodes.new('ShaderNodeSeparateColor')
        rng = nt.nodes.new('ShaderNodeMapRange')
        rng.inputs['From Min'].default_value = 0.35
        rng.inputs['From Max'].default_value = 0.65
        mix = nt.nodes.new('ShaderNodeMix')
        mix.data_type = 'RGBA'
        nt.links.new(attr.outputs['Color'], sep.inputs[0])
        nt.links.new(sep.outputs[0], rng.inputs['Value'])
        nt.links.new(rng.outputs['Result'], mix.inputs['Factor'])
        nt.links.new(col, mix.inputs['A'])
        nt.links.new(bcol, mix.inputs['B'])
        col = mix.outputs['Result']
    if mode == 'albedo':
        if col is not None:
            nt.links.new(col, emit_n.inputs['Color'])
    else:
        ao = nt.nodes.new('ShaderNodeAmbientOcclusion')
        ao.samples = 16
        ao.inputs['Distance'].default_value = 1.6
        nt.links.new(ao.outputs['AO'], emit_n.inputs['Color'])
    shader = emit_n.outputs[0]
    if d.get('alphaMode') == 'mask' and alpha is not None:
        cmp = nt.nodes.new('ShaderNodeMath')
        cmp.operation = 'GREATER_THAN'
        cmp.inputs[1].default_value = d.get('alphaCutoff', 0.5)
        mixs = nt.nodes.new('ShaderNodeMixShader')
        tr = nt.nodes.new('ShaderNodeBsdfTransparent')
        nt.links.new(alpha, cmp.inputs[0])
        nt.links.new(cmp.outputs[0], mixs.inputs[0])
        nt.links.new(tr.outputs[0], mixs.inputs[1])
        nt.links.new(shader, mixs.inputs[2])
        shader = mixs.outputs[0]
    nt.links.new(shader, out.inputs['Surface'])
    return m


def _dilate(rgb, alpha, iterations=48):
    filled = alpha > 0.02
    rgb = rgb.copy()
    for _ in range(iterations):
        if filled.all():
            break
        acc = np.zeros_like(rgb)
        cnt = np.zeros(filled.shape, dtype=np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            f = np.roll(filled, (dy, dx), axis=(0, 1))
            acc += np.roll(rgb, (dy, dx), axis=(0, 1)) * f[..., None]
            cnt += f
        grow = (~filled) & (cnt > 0)
        rgb[grow] = acc[grow] / cnt[grow][..., None]
        filled = filled | grow
    if not filled.all():
        rgb[~filled] = rgb[filled].mean(axis=0)
    return rgb


def _save_png(path, rgba_top_down):
    h, w, _ = rgba_top_down.shape
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=True)
    img.pixels.foreach_set(np.ascontiguousarray(np.clip(rgba_top_down[::-1], 0, 1)).reshape(-1).astype(np.float32))
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)


def render_ortho(items, out_name, tmp_dir, x0, x1, z0, z1, res):
    """Orthographic Cycles render of `items` [(obj, matrix_world)] looking along +Y, framing
    x0..x1 / z0..z1 -> textures/<out_name>_{albedo,orm}.png (albedo dilated into empty
    texels, ORM = crown AO). Returns the top-down alpha array."""
    scene = bpy.data.scenes.new(f'imp_{out_name}')
    _cycles(scene, 48)
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'OPEN_EXR'
    scene.render.image_settings.color_depth = '32'
    scene.view_settings.view_transform = 'Standard'
    world = bpy.data.worlds.new(f'imp_{out_name}')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.0
    scene.world = world
    cam_data = bpy.data.cameras.new(f'imp_{out_name}')
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = max(x1 - x0, z1 - z0)
    cam_data.clip_end = 400
    cam = bpy.data.objects.new(f'imp_{out_name}', cam_data)
    cam.location = ((x0 + x1) / 2, -150, (z0 + z1) / 2)
    cam.rotation_euler = (math.pi / 2, 0, 0)
    scene.collection.objects.link(cam)
    scene.camera = cam
    copies = []
    for obj, mw in items:
        ob = obj.copy()
        ob.data = obj.data.copy()
        ob.matrix_world = mw
        scene.collection.objects.link(ob)
        copies.append((ob, [m.name for m in obj.data.materials]))
    rmats = {}
    passes = {}
    for mode in ('albedo', 'ao'):
        for ob, names in copies:
            for i, mn in enumerate(names):
                key = (mn, mode)
                if key not in rmats:
                    rmats[key] = _render_material(mn, mode)
                ob.data.materials[i] = rmats[key]
        path = os.path.join(tmp_dir, f'imp_{out_name}_{mode}.exr')
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True, scene=scene.name)
        img = bpy.data.images.load(path)
        px = np.empty(res[0] * res[1] * 4, dtype=np.float32)
        img.pixels.foreach_get(px)
        bpy.data.images.remove(img)
        passes[mode] = px.reshape(res[1], res[0], 4)[::-1]  # top-down
    a = passes['albedo'][..., 3]
    straight = passes['albedo'][..., :3] / np.maximum(a, 1e-4)[..., None]
    lin = _dilate(straight, a)
    srgb = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * np.power(np.maximum(lin, 0), 1 / 2.4) - 0.055)
    tex = os.path.join(PUBLIC, 'textures')
    _save_png(os.path.join(tex, f'{out_name}_albedo.png'), np.dstack([srgb, a]))
    aa = passes['ao'][..., 3]
    ao = passes['ao'][..., 0] / np.maximum(aa, 1e-4)
    ao = _dilate(np.dstack([ao, ao, ao]), aa)[..., 0]
    orm = np.dstack([np.clip(ao * 1.1, 0, 1), np.full_like(ao, 0.65), np.zeros_like(ao), np.full_like(ao, 0.5)])
    _save_png(os.path.join(tex, f'{out_name}_orm.png'), orm)
    for ob, _ in copies:
        me = ob.data
        bpy.data.objects.remove(ob)
        bpy.data.meshes.remove(me)
    for m in rmats.values():
        bpy.data.materials.remove(m)
    bpy.data.objects.remove(cam)
    bpy.data.cameras.remove(cam_data)
    bpy.data.worlds.remove(world)
    bpy.data.scenes.remove(scene)
    return a


def render_impostor(obj, name, tmp_dir, res=(512, 1024)):
    """Side view of one tree -> textures/impostor_<name>_*. Returns (half width, z0, z1, bands)."""
    xs = [v.co for v in obj.data.vertices]
    max_r = max(math.hypot(v.x, v.y) for v in xs) + 0.2
    z0, z1 = min(v.z for v in xs) - 0.1, max(v.z for v in xs) + 0.2
    half_w = max(max_r, (z1 - z0) * res[0] / res[1] / 2)
    z1 = max(z1, z0 + 2 * half_w * res[1] / res[0])
    a = render_ortho([(obj, Matrix.Identity(4))], f'impostor_{name}', tmp_dir, -half_w, half_w, z0, z1, res)
    return half_w, z0, z1, alpha_bands(a)


TREELINE_W, TREELINE_H = 64.0, 26.0


def render_treeline(trees, tmp_dir, seed=7, res=(2048, 832)):
    """Tileable strip of forest edge (three depth rows of the real tree models, wrapped at the
    edges) -> textures/treeline_{albedo,orm}.png, covering TREELINE_W x TREELINE_H metres.
    `trees` = {species: [lod0 objects]}."""
    rnd = random.Random(seed)
    W = TREELINE_W
    items = []
    mix = [('spruce', 0.45), ('pine', 0.4), ('birch', 0.15)]
    for row, (n, depth) in enumerate([(9, 0.0), (8, 6.0), (7, 12.0)]):
        for i in range(n):
            x = (i + rnd.uniform(0.1, 0.9)) * W / n
            r = rnd.random()
            sp = 'spruce' if r < mix[0][1] else ('pine' if r < mix[0][1] + mix[1][1] else 'birch')
            obj = rnd.choice(trees[sp])
            s = rnd.uniform(0.8, 1.12)
            yaw = rnd.uniform(0, 2 * math.pi)
            for wrap in (-W, 0.0, W):
                xx = x + wrap
                if -10 < xx < W + 10:
                    m = Matrix.Translation((xx, depth + rnd.uniform(-1.5, 1.5), -0.4)) @ Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Diagonal((s, s, s, 1))
                    items.append((obj, m))
    return render_ortho(items, 'treeline', tmp_dir, 0.0, W, -0.6, TREELINE_H - 0.6, res)


def alpha_bands(alpha_top_down, n=8, pad=3):
    """Horizontal bands trimmed to the rendered coverage, as UV rects (u0, u1, v0, v1), v up.
    Cuts the transparent area the alpha test has to reject (a pine is mostly bare trunk)."""
    h, w = alpha_top_down.shape
    rows = alpha_top_down[::-1] > 0.05  # bottom-up
    bands = []
    edges = np.linspace(0, h, n + 1).astype(int)
    for i in range(n):
        r0, r1 = edges[i], edges[i + 1]
        cols = np.where(rows[r0:r1].any(axis=0))[0]
        if len(cols) == 0:
            continue
        c0, c1 = max(0, cols[0] - pad), min(w, cols[-1] + 1 + pad)
        bands.append((c0 / w, c1 / w, r0 / h, r1 / h))
    return bands


def impostor_mesh(sk, name, frame):
    """Three crossed vertical planes through the trunk axis, each cut into coverage-fitted bands."""
    half_w, z0, z1, bands = frame
    mat = f'impostor_{name}'
    b = MeshBuilder(f'{name}_lod2')
    for k in range(3):
        a = k * math.pi / 3
        d = Vector((math.cos(a), math.sin(a), 0))
        for (u0, u1, v0, v1) in bands:
            x0, x1 = (u0 * 2 - 1) * half_w, (u1 * 2 - 1) * half_w
            za, zb = z0 + (z1 - z0) * v0, z0 + (z1 - z0) * v1
            b.face([d * x0 + Vector((0, 0, za)), d * x1 + Vector((0, 0, za)), d * x1 + Vector((0, 0, zb)), d * x0 + Vector((0, 0, zb))], mat,
                   uvs=[(u0, v0), (u1, v0), (u1, v1), (u0, v1)], smooth=True)
    return b


def write_impostor_material(name, species):
    src = material_def(FOLIAGE[species])
    d = {
        'shader': 'foliage', 'alphaMode': 'mask', 'alphaCutoff': 0.45, 'doubleSided': True,
        'baseColor': f'impostor_{name}_albedo.png', 'orm': f'impostor_{name}_orm.png', 'physicalSize': 1,
        'roughness': 1, 'translucency': src.get('translucency', 0.3), 'porosity': 0,
        'bake': {'exclude': True}, 'notes': f'Generated by tools/blender/trees.py (LOD2 impostor of {name}).',
    }
    with open(os.path.join(PUBLIC, 'materials', f'impostor_{name}.json'), 'w') as f:
        json.dump(d, f, indent=1)


def build_tree(name, species, seed, asset_dir, tmp_dir):
    """Builds <name>.glb (LOD0), <name>_lod1.glb, <name>_lod2.glb, impostor textures and <name>.model.json."""
    sk = SPECIES[species](seed)
    fol = ({FOLIAGE[species]}, bent_normal_fn(sk))
    vc = bark_weight_fn(sk) if BARK[species].endswith('_blend') else None
    tris = []
    lod0 = None
    for lod in (0, 1):
        b = emit(sk, name if lod == 0 else f'{name}_lod1', lod)
        obj, _ = b.finish(None, weld=True, vertex_color=vc, foliage_normals=fol)
        export_glb(obj, os.path.join(asset_dir, b.name + '.glb'))
        tris.append(sum(len(p.vertices) - 2 for p in obj.data.polygons))
        if lod == 0:
            lod0 = obj
    frame = render_impostor(lod0, name, tmp_dir)
    write_impostor_material(name, species)
    b = impostor_mesh(sk, name, frame)
    obj, _ = b.finish(None, weld=False, foliage_normals=({f'impostor_{name}'}, bent_normal_fn(sk)))
    export_glb(obj, os.path.join(asset_dir, b.name + '.glb'))
    tris.append(len(obj.data.polygons) * 2)
    model = {
        'format': 'rill.model', 'version': 1, 'name': name, 'semantic': 'vegetation',
        'lods': [{'mesh': f'{name}.glb', 'distance': LOD_DISTANCES[0]},
                 {'mesh': f'{name}_lod1.glb', 'distance': LOD_DISTANCES[1]},
                 {'mesh': f'{name}_lod2.glb', 'distance': LOD_DISTANCES[2]}],
        'notes': f'{species} (seed {seed}); LOD distances in metres at scale 1, scaled by instance size.',
    }
    with open(os.path.join(asset_dir, f'{name}.model.json'), 'w') as f:
        json.dump(model, f, indent=1)
    print(f'  {name:24s} {species:6s} LOD tris {tris}  height {sk.height:.1f} m  cards {len(sk.cards)}')
    return model, lod0
