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
IDS = ['paint', 'steel', 'polymer', 'alu', 'rubber']
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
    # Panel seam between upper and lower, and a sight-base groove.
    boolean(ob, cutter_box((0, 0.02, 0.0005), (0.05, 0.3, 0.0012)))
    return ob


def build_receiver():
    p = Piece('receiver')
    # Top rib carrying the rear sight.
    p.box((0, -0.03, 0.0515), (0.011, 0.19, 0.004), 'paint')
    # Lower receiver / magazine well with a flared lip.
    p.loft([section(y, 0.0172, 0.0168, -0.052, -0.0015, 0.003) for y in (-0.046, 0.104)], 'paint')
    p.box((0, 0.064, -0.047), (0.039, 0.088, 0.01), 'paint')
    # Winter trigger guard: a swept band.
    path = [(0.03, -0.05), (0.028, -0.061), (0.012, -0.071), (-0.012, -0.072), (-0.034, -0.066), (-0.046, -0.052)]
    p.loft([[(x, y, z + dz) for x, dz in ((0.0055, 0.002), (-0.0055, 0.002), (-0.0055, -0.002), (0.0055, -0.002))] for y, z in path], 'paint')
    # Pistol grip: tapered oval raked back ~20°, finger swell, capped.
    rings = []
    for k in range(8):
        t = k / 7
        y = -0.032 - 0.044 * t
        z = -0.035 - 0.096 * t
        hx = 0.0145 - 0.0015 * t
        hy = 0.0205 + 0.0035 * math.sin(t * math.pi * 1.3) - 0.001 * t
        rings.append([(math.cos(a) * hx, y + math.sin(a) * hy, z) for a in (2 * math.pi * i / 18 for i in range(18))])
    p.loft(rings, 'polymer')
    # Handguard: slimmer oval polymer tube with grooves (they catch AO), ends capped.
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
    # Barrel, gas tube, gas block / front sight with hood, flash hider.
    p.cyl((0, 0.16, 0.0), (0, 0.47, 0.0), 0.0088, 'steel', 24)
    p.cyl((0, 0.28, 0.024), (0, 0.345, 0.024), 0.0072, 'steel', 18)
    p.box((0, 0.343, 0.012), (0.019, 0.026, 0.036), 'steel')
    p.box((0, 0.352, 0.049), (0.0026, 0.0035, 0.022), 'steel')
    for side in (-1, 1):
        p.loft([[(side * 0.0095 + dx, y, z) for dx, z in ((-0.0014, 0.028), (0.0014, 0.028), (0.0014, 0.064), (-0.0014, 0.064))] for y in (0.344, 0.36)], 'steel')
    p.cyl((0, 0.462, 0.0), (0, 0.515, 0.0), 0.0112, 'steel', 24)
    # Rear diopter: small drum between two swept guards.
    p.cyl((-0.0085, -0.096, 0.061), (0.0085, -0.096, 0.061), 0.0066, 'steel', 20)
    for side in (-1, 1):
        x = side * 0.0115
        p.loft([[(x + dx, y, z) for y, z in ((-0.116, 0.053), (-0.078, 0.053), (-0.084, 0.069), (-0.11, 0.07))] for dx in (-0.0013, 0.0013)], 'paint')
    # Selector lever (left side).
    p.box((-0.0225, -0.012, 0.004), (0.004, 0.026, 0.008), 'steel')
    # Skeletal folding stock and rubber butt.
    p.cyl((0, -0.122, 0.034), (0, -0.405, 0.016), 0.0072, 'steel', 14)
    p.cyl((0, -0.115, -0.004), (0, -0.405, -0.078), 0.0072, 'steel', 14)
    p.box((0, -0.41, -0.03), (0.034, 0.016, 0.125), 'rubber')
    body = p.to_object()
    # Flash hider slots on a separate cylinder (clean manifold for the boolean).
    fh = Piece('hider')
    fh.cyl((0, 0.47, 0.0), (0, 0.515, 0.0), 0.0119, 'steel', 24)
    hider = fh.to_object()
    for k in range(5):
        a = math.radians(90 + 72 * k)
        boolean(hider, cutter_box((math.cos(a) * 0.012, 0.497, math.sin(a) * 0.012), (0.0045, 0.03, 0.0055), rot=Matrix.Rotation(-a + math.pi / 2, 3, 'Y')))
    upper = build_upper()
    for o in [o for o in bpy.data.objects if o.name.startswith('cutter')]:
        bpy.data.objects.remove(o)
    for o in bpy.context.selected_objects:
        o.select_set(False)
    for o in (body, hider, upper):
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

def compose(ao, edge, idm):
    rng = np.random.default_rng(1986)
    ids = kit.decode_ids(idm)
    ao = np.clip(ao[..., 0], 0, 1)
    edge = np.clip(edge[..., 0], 0, 1)
    # Wear breakup noise (mid frequency) and handling grime (low frequency).
    n_mid = blur(rng.random((ATLAS, ATLAS)).astype(np.float32), 3)
    n_mid = (n_mid - n_mid.mean()) / (n_mid.std() + 1e-6)
    n_low = blur(rng.random((ATLAS, ATLAS)).astype(np.float32), 24)
    n_low = (n_low - n_low.mean()) / (n_low.std() + 1e-6)
    grain = rng.random((ATLAS, ATLAS)).astype(np.float32) - 0.5

    srgb = lambda c: (np.array(c) / 255.0) ** 2.2
    base = {
        0: (srgb((62, 68, 50)), 0.62, 0.0),    # olive paint
        1: (srgb((38, 39, 41)), 0.42, 0.85),   # blued / parkerised steel
        2: (srgb((58, 64, 47)), 0.72, 0.0),    # green polymer
        3: (srgb((52, 53, 55)), 0.5, 0.6),     # magazine
        4: (srgb((24, 24, 24)), 0.85, 0.0),    # rubber
    }
    alb = np.zeros((ATLAS, ATLAS, 3), np.float32)
    rough = np.zeros((ATLAS, ATLAS), np.float32)
    metal = np.zeros((ATLAS, ATLAS), np.float32)
    for i, (c, r, m) in base.items():
        sel = ids == i
        alb[sel] = c
        rough[sel] = r
        metal[sel] = m
    # Edge wear: paint and polymer rub through to dark metal / lighter polymer; steel edges polish.
    wear = np.clip((edge * 1.4 + n_mid * 0.18 - 0.55) * 2.6, 0, 1)
    paint = (ids == 0)
    w = wear * paint
    alb = alb * (1 - w[..., None]) + srgb((92, 92, 90)) * w[..., None]
    rough = rough * (1 - w) + 0.32 * w
    metal = metal * (1 - w) + 1.0 * w
    poly = (ids == 2)
    wp = wear * poly * 0.6
    alb = alb * (1 - wp[..., None]) + srgb((84, 88, 72)) * wp[..., None]
    rough = rough - wp * 0.15
    steel = (ids == 1) | (ids == 3)
    ws = wear * steel
    alb = alb * (1 - ws[..., None] * 0.55) + srgb((118, 118, 116)) * ws[..., None] * 0.55
    rough = rough - ws * 0.14
    # Grime in cavities, handling variation, fine grain.
    dirt = np.clip((1 - ao) * 1.4, 0, 1)
    alb *= (1 - dirt * 0.45)[..., None] * (1 + n_low * 0.06)[..., None] * (1 + grain * 0.05)[..., None]
    rough = np.clip(rough + dirt * 0.12 + n_low * 0.05 + grain * 0.04, 0.05, 1)
    alb = np.clip(alb, 0, 1) ** (1 / 2.2)
    orm = np.stack([ao, rough, metal], -1)
    return alb, orm


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
    alb, orm = compose(pixels(imgs['ao']), pixels(imgs['edge']), pixels(imgs['id']))
    os.makedirs(OUT_TEX, exist_ok=True)
    save_png(alb, os.path.join(OUT_TEX, 'carbine_albedo.png'), 'sRGB')
    save_png(orm, os.path.join(OUT_TEX, 'carbine_orm.png'), 'Non-Color')

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
    shots = {'side': ((0.9, 0.05, 0.08), (0, 0.05, -0.02)), 'pov': ((0.08, -0.28, 0.11), (0.0, 0.3, -0.0)), 'quarter': ((0.55, -0.45, 0.3), (0, 0.05, -0.03))}
    shots_dir = os.path.join(os.path.dirname(PUBLIC), 'screenshots')
    for name, (eye, at) in shots.items():
        cam.location = eye
        d = Vector(at) - Vector(eye)
        cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = os.path.join(shots_dir, f'carbine_preview_{name}.png')
        bpy.ops.render.render(write_still=True)


main()
