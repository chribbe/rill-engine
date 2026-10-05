"""First test enemy for G1 (docs/GAME.md): a beetroot walker ("Rödbetan").

A ~1.75 m root-vegetable creature as rigid rig parts with pivots at the joints:
  body (root, pivot at the hips) - the beet bulb
  head (neck)            - smaller bulb, slit mouth, sunken eyes, leaf crown
  arm_l / arm_r          (shoulders)  forearm_l / forearm_r (elbows, root fingers)
  leg_l / leg_r          (hips)       shin_l / shin_r       (knees, splayed root toes)
Parents are stored in node extras (`parent`), read by the engine's GLB parts loader.

Textures: one 1024² atlas baked like the carbine (AO + material ids + a height
pass): waxy red-purple skin with pores and dusty soil low down, earthy roots,
magenta stems, green leaves, wet dark mouth.

Output: public/assets/enemies/beet.glb, public/textures/enemies/beet_{albedo,orm}.png,
public/materials/veg_beet.json is hand-written.
Run: node tools/blender/run.ts beet [-- --preview]

Frame (Blender): x right, y forward (the creature faces +y), z up, metres.
"""

import math
import os
import sys

import bpy
import numpy as np
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import PUBLIC, reset_scene  # noqa: E402
import kit  # noqa: E402
from kit import Piece, setup_cycles, unwrap, bake_pass, id_emission, pixels, blur, save_png  # noqa: E402

ATLAS = 1024
IDS = ['skin', 'root', 'stem', 'leaf', 'dark']
kit.configure(IDS, ATLAS, 96)
OUT_GLB = os.path.join(PUBLIC, 'assets', 'enemies', 'beet.glb')
OUT_TEX = os.path.join(PUBLIC, 'textures', 'enemies')


def hashnoise(a, z, seed):
    """Smooth-ish periodic bump field over (angle, height)."""
    return (math.sin(a * 3 + seed) * 0.5 + math.sin(a * 7 + z * 11 + seed * 2) * 0.3 + math.sin(a * 13 - z * 23 + seed * 3) * 0.2)


def lathe(p, profile, mat, segs=28, cx=0.0, cy=0.0, bump=0.0, seed=0.0, lean=(0.0, 0.0)):
    """Surface of revolution about z through (cx, cy): profile [(z, r)], bottom to top, capped."""
    rings = []
    z0, z1 = profile[0][0], profile[-1][0]
    for z, r in profile:
        t = (z - z0) / max(1e-6, z1 - z0)
        ox, oy = cx + lean[0] * t, cy + lean[1] * t
        ring = []
        for i in range(segs):
            a = 2 * math.pi * i / segs
            rr = r * (1 + bump * hashnoise(a, z, seed))
            ring.append((ox + math.cos(a) * rr, oy + math.sin(a) * rr, z))
        rings.append(ring)
    p.loft(rings, mat)


def tube(p, pts, radii, mat, segs=10):
    """Tapered tube along a polyline (rings perpendicular to the path), capped."""
    pts = [Vector(q) for q in pts]
    rings = []
    prev_n = None
    for i, c in enumerate(pts):
        d = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        ref = Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((1, 0, 0))
        n = d.cross(ref).normalized() if prev_n is None else (prev_n - d * prev_n.dot(d)).normalized()
        prev_n = n
        b = d.cross(n)
        r = radii[i]
        rings.append([tuple(c + (n * math.cos(2 * math.pi * k / segs) + b * math.sin(2 * math.pi * k / segs)) * r) for k in range(segs)])
    p.loft(rings, mat)


def curve(a, b, bend, n=5):
    """Points from a to b bowed sideways by `bend` (vector) at the middle."""
    a, b, bend = Vector(a), Vector(b), Vector(bend)
    return [tuple(a.lerp(b, i / (n - 1)) + bend * math.sin(math.pi * i / (n - 1))) for i in range(n)]


def leaf(p, base, direction, length, width):
    """Flat-ish blade: a thin slab bent along its length (two-sided by thickness)."""
    base, d = Vector(base), Vector(direction).normalized()
    side = d.cross(Vector((0, 0, 1)))
    if side.length < 1e-3:
        side = Vector((1, 0, 0))
    side.normalize()
    up = side.cross(d)
    rings = []
    n = 6
    for i in range(n):
        t = i / (n - 1)
        c = base + d * (length * t) + up * (math.sin(t * math.pi) * length * 0.12) - Vector((0, 0, 1)) * (t * t * length * 0.25)
        w = width * math.sin(math.pi * min(0.98, t * 0.9 + 0.08))
        th = 0.004
        rings.append([tuple(c + side * w), tuple(c + up * th), tuple(c - side * w), tuple(c - up * th)])
    p.loft(rings, 'leaf')


# ------------------------------------------------------------------ parts

def build_body():
    p = Piece('body')
    prof = [(0.66, 0.06), (0.7, 0.14), (0.76, 0.22), (0.86, 0.285), (0.98, 0.31), (1.1, 0.3), (1.2, 0.265), (1.28, 0.2), (1.34, 0.12), (1.37, 0.05)]
    lathe(p, prof, 'skin', segs=32, bump=0.05, seed=1.3, lean=(0.0, 0.03))
    # Little taproot tail at the back.
    tube(p, curve((0, -0.12, 0.74), (0.02, -0.26, 0.42), (0, -0.04, 0.0), 5), [0.035, 0.03, 0.022, 0.014, 0.005], 'root', 8)
    # Lateral rootlets (hairs) on the bulb.
    for k, (a, z) in enumerate(((0.6, 0.82), (2.4, 0.9), (3.6, 0.78), (5.0, 0.86), (1.4, 1.02))):
        r = 0.29
        base = (math.cos(a) * r, math.sin(a) * r + 0.02, z)
        tip = (math.cos(a) * (r + 0.12), math.sin(a) * (r + 0.12), z - 0.1)
        tube(p, curve(base, tip, (0, 0, -0.02), 4), [0.01, 0.007, 0.004, 0.001], 'root', 6)
    return p.to_object((0, 0, 0.84))


def build_head():
    p = Piece('head')
    prof = [(1.3, 0.05), (1.34, 0.1), (1.4, 0.145), (1.47, 0.155), (1.54, 0.13), (1.6, 0.08), (1.63, 0.03)]
    lathe(p, prof, 'skin', segs=24, bump=0.06, seed=4.1, cy=0.02)
    # Face: slit mouth and sunken eyes (dark, wet).
    p.box((0, 0.165, 1.43), (0.12, 0.03, 0.022), 'dark')
    for side in (-1, 1):
        p.cyl((side * 0.052, 0.13, 1.5), (side * 0.058, 0.165, 1.5), 0.022, 'dark', 12)
    # Leaf crown: magenta stems with green blades.
    for k in range(7):
        a = 2 * math.pi * k / 7 + 0.3
        out = Vector((math.cos(a), math.sin(a) - 0.15, 0)).normalized()
        base = Vector((0, 0.01, 1.61))
        mid = base + out * 0.08 + Vector((0, 0, 0.14 + 0.03 * (k % 2)))
        tip = base + out * 0.2 + Vector((0, 0, 0.24 + 0.04 * (k % 3)))
        tube(p, [tuple(base), tuple(base.lerp(mid, 0.5) + Vector((0, 0, 0.02))), tuple(mid), tuple(tip)], [0.014, 0.011, 0.008, 0.005], 'stem', 7)
        leaf(p, tuple(tip), tuple(out + Vector((0, 0, 0.9))), 0.24 + 0.05 * (k % 2), 0.065)
    return p.to_object((0, 0.02, 1.33))


def build_limbs():
    out = []
    for side, s in (('l', -1), ('r', 1)):
        sh = (s * 0.25, 0.0, 1.2)
        el = (s * 0.42, 0.06, 0.94)
        wr = (s * 0.46, 0.2, 0.7)
        a = Piece(f'arm_{side}')
        tube(a, curve(sh, el, (s * 0.03, 0, 0.02), 5), [0.065, 0.06, 0.055, 0.05, 0.046], 'skin', 12)
        out.append((a.to_object(sh), 'body'))
        f = Piece(f'forearm_{side}')
        tube(f, curve(el, wr, (s * 0.02, 0.02, 0), 5), [0.046, 0.042, 0.038, 0.033, 0.028], 'root', 10)
        for k in range(3):
            ang = (k - 1) * 0.5
            tip = (wr[0] + s * 0.04 + math.sin(ang) * 0.06, wr[1] + 0.1 + math.cos(ang) * 0.03, wr[2] - 0.14)
            tube(f, curve(wr, tip, (s * 0.02, 0.03, 0.02), 5), [0.022, 0.017, 0.012, 0.007, 0.002], 'root', 8)
        out.append((f.to_object(el), f'arm_{side}'))
        hip = (s * 0.12, 0.0, 0.78)
        kn = (s * 0.15, 0.04, 0.44)
        an = (s * 0.16, -0.01, 0.08)
        l = Piece(f'leg_{side}')
        tube(l, curve(hip, kn, (s * 0.02, 0.02, 0), 5), [0.09, 0.085, 0.078, 0.07, 0.064], 'skin', 12)
        out.append((l.to_object(hip), 'body'))
        sn = Piece(f'shin_{side}')
        tube(sn, curve(kn, an, (0, 0.02, 0), 5), [0.064, 0.058, 0.052, 0.048, 0.045], 'root', 10)
        for k in range(3):
            ang = (k - 1) * 0.7
            toe = (an[0] + math.sin(ang) * 0.14, an[1] + math.cos(ang) * 0.14, 0.005)
            tube(sn, curve(an, toe, (0, 0, 0.02), 4), [0.04, 0.028, 0.016, 0.004], 'root', 8)
        out.append((sn.to_object(kn), f'leg_{side}'))
    return out


# ------------------------------------------------------------------ textures

def height_emission(nt, em, name):
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    nt.links.new(geo.outputs['Position'], sep.inputs['Vector'])
    m = nt.nodes.new('ShaderNodeMath')
    m.operation = 'MULTIPLY'
    m.inputs[1].default_value = 1 / 1.9
    nt.links.new(sep.outputs['Z'], m.inputs[0])
    nt.links.new(m.outputs['Value'], em.inputs['Color'])
    em.inputs['Strength'].default_value = 1.0


def compose(ao, idm, hgt):
    rng = np.random.default_rng(1993)
    ids = kit.decode_ids(idm)
    ao = np.clip(ao[..., 0], 0, 1)
    h = np.clip(hgt[..., 0], 0, 1)
    nz = lambda r: (lambda x: (x - x.mean()) / (x.std() + 1e-6))(blur(rng.random((ATLAS, ATLAS)).astype(np.float32), r))
    n_fine, n_mid, n_low = nz(1), nz(4), nz(18)
    srgb = lambda c: (np.array(c) / 255.0) ** 2.2
    base = {0: (srgb((70, 13, 33)), 0.42), 1: (srgb((128, 78, 70)), 0.78), 2: (srgb((150, 28, 72)), 0.5), 3: (srgb((44, 78, 30)), 0.62), 4: (srgb((22, 6, 12)), 0.22)}
    alb = np.zeros((ATLAS, ATLAS, 3), np.float32)
    rough = np.zeros((ATLAS, ATLAS), np.float32)
    for i, (c, r) in base.items():
        sel = ids == i
        alb[sel] = c
        rough[sel] = r
    skin = ids == 0
    # Skin: mottled purple-red, darker pores, a lighter waxy bloom on top.
    alb *= (1 + n_mid * 0.12 + n_fine * 0.05)[..., None]
    pores = np.clip((n_fine - 1.6) * 2, 0, 1) * skin
    alb *= (1 - pores * 0.5)[..., None]
    bloom = np.clip(n_low * 0.5 + 0.2, 0, 1) * skin * 0.25
    alb = alb * (1 - bloom[..., None]) + srgb((96, 44, 70)) * bloom[..., None]
    # Soil residue low on the body and roots: dusty, rougher.
    dirt = np.clip((0.45 - h) * 3 + n_mid * 0.25, 0, 1) * (ids <= 1)
    alb = alb * (1 - dirt[..., None] * 0.55) + srgb((88, 72, 58)) * dirt[..., None] * 0.55
    rough = rough + dirt * 0.3
    # Leaves: lighter towards the tips (height), slight yellowing noise.
    lf = ids == 3
    alb[lf] *= (1 + n_mid[lf] * 0.15)[..., None]
    # Cavity darkening and wet crevices.
    alb *= (0.55 + 0.45 * ao)[..., None]
    rough = np.clip(rough - (1 - ao) * 0.15 * skin + n_fine * 0.03, 0.08, 1)
    alb = np.clip(alb, 0, 1) ** (1 / 2.2)
    orm = np.stack([ao, rough, np.zeros_like(ao)], -1)
    return alb, orm


def main():
    reset_scene()
    setup_cycles()
    parts = [(build_body(), None), (build_head(), 'body')] + build_limbs()
    objs = [o for o, _ in parts]
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
    alb, orm = compose(pixels(imgs['ao']), pixels(imgs['id']), pixels(imgs['h']))
    os.makedirs(OUT_TEX, exist_ok=True)
    save_png(alb, os.path.join(OUT_TEX, 'beet_albedo.png'), 'sRGB')
    save_png(orm, os.path.join(OUT_TEX, 'beet_orm.png'), 'Non-Color')
    final = bpy.data.materials.new('veg_beet')
    for ob, parent in parts:
        ob.data.materials.clear()
        ob.data.materials.append(final)
        if parent:
            ob['parent'] = parent
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
    tris = sum(len(o.data.polygons) for o in objs)
    print(f'beet: {len(objs)} parts, {tris} triangles -> {OUT_GLB}')
    if '--preview' in sys.argv:
        preview(objs)


def preview(objs):
    mat = bpy.data.materials['veg_beet']
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    alb = nt.nodes.new('ShaderNodeTexImage')
    alb.image = bpy.data.images.load(os.path.join(OUT_TEX, 'beet_albedo.png'))
    orm = nt.nodes.new('ShaderNodeTexImage')
    orm.image = bpy.data.images.load(os.path.join(OUT_TEX, 'beet_orm.png'))
    orm.image.colorspace_settings.name = 'Non-Color'
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(orm.outputs['Color'], sep.inputs['Color'])
    nt.links.new(alb.outputs['Color'], bsdf.inputs['Base Color'])
    nt.links.new(sep.outputs['Green'], bsdf.inputs['Roughness'])
    nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    scene = bpy.context.scene
    scene.render.resolution_x, scene.render.resolution_y = 900, 1000
    scene.cycles.samples = 48
    world = scene.world
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.4, 0.42, 0.45, 1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.7
    sun = bpy.data.objects.new('key', bpy.data.lights.new('key', 'SUN'))
    sun.data.energy = 3.0
    sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(200))
    scene.collection.objects.link(sun)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.data.lens = 50
    shots_dir = os.path.join(os.path.dirname(PUBLIC), 'screenshots')
    for name, eye in {'front': (0.8, 3.2, 1.2), 'side': (3.3, 0.4, 1.1)}.items():
        cam.location = eye
        d = Vector((0, 0, 0.9)) - Vector(eye)
        cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = os.path.join(shots_dir, f'beet_preview_{name}.png')
        bpy.ops.render.render(write_still=True)


main()
