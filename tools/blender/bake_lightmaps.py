"""BakeBackend #1: Blender/Cycles lightmap baker.

  blender -b --factory-startup -P tools/blender/bake_lightmaps.py -- [--samples 256] [--size 2048] [--no-denoise] [--map testmap]

Pipeline:  map.json (BakeScene)  ->  Cycles  ->  LightmapSet (public/maps/<map>/lightmaps)

The bake scene is reconstructed from the engine's own map document and GLB
assets; nothing here depends on the Blender file used to author the assets,
and the runtime never depends on Blender.

Two linear components are baked per atlas page (both in Cycles' diffuse
"light" pass units, i.e. irradiance / PI):
  sky        uniform white sky of radiance 1 (upper hemisphere), direct + indirect
  sunBounce  sun of irradiance 1 from the reference direction, indirect only
The runtime multiplies them by the live sky radiance and sun illuminance.
"""

import json
import math
import os
import sys
import time

import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import PUBLIC, load_json  # noqa: E402

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def arg(name, default):
    if name in argv:
        i = argv.index(name)
        return type(default)(argv[i + 1]) if not isinstance(default, bool) else True
    return default


SAMPLES = arg('--samples', 256)
PAGE = arg('--size', 2048)
DENOISE = '--no-denoise' not in argv
MAP = arg('--map', 'testmap')
MAP_DIR = os.path.join(PUBLIC, 'maps', MAP)
OUT_DIR = os.path.join(MAP_DIR, 'lightmaps')
doc = load_json(os.path.join(MAP_DIR, 'map.json'))
manifest = load_json(os.path.join(PUBLIC, 'textures', 'manifest.json'))
t_start = time.time()


# ------------------------------------------------------------------ materials
def srgb_hex(h):
    h = h.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]


def material_def(name, depth=0):
    p = os.path.join(PUBLIC, 'materials', name + '.json')
    if not os.path.exists(p):
        return {}
    d = load_json(p)
    if 'inherits' in d and depth < 8:
        base = material_def(d['inherits'], depth + 1)
        base.update({k: v for k, v in d.items() if k != 'inherits'})
        d = base
    return d


def bake_albedo(name):
    d = material_def(name)
    if 'bake' in d and 'albedo' in d['bake']:
        return list(d['bake']['albedo'])[:3]
    f = d.get('baseColorFactor', [1, 1, 1])
    f = srgb_hex(f) if isinstance(f, str) else list(f)[:3]
    tex = d.get('baseColor')
    avg = [1, 1, 1]
    if tex:
        key = tex.replace('_albedo.png', '')
        avg = manifest.get(key, {}).get('averageAlbedo', [0.5, 0.5, 0.5])
    return [min(0.95, a * b) for a, b in zip(avg, f)]


bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
bake_mats = {}


def get_bake_material(name):
    """Diffuse-only proxy (bounce albedo); alpha-masked materials keep their cutout."""
    if name in bake_mats:
        return bake_mats[name]
    d = material_def(name)
    m = bpy.data.materials.new('bake_' + name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    dif = nt.nodes.new('ShaderNodeBsdfDiffuse')
    alb = bake_albedo(name)
    dif.inputs['Color'].default_value = (*alb, 1)
    if d.get('alphaMode') == 'mask' and d.get('baseColor'):
        img = bpy.data.images.load(os.path.join(PUBLIC, 'textures', d['baseColor']), check_existing=True)
        img.alpha_mode = 'STRAIGHT'
        tex = nt.nodes.new('ShaderNodeTexImage')
        tex.image = img
        tex.interpolation = 'Closest'
        # Hard cutout at the material threshold.
        cmp = nt.nodes.new('ShaderNodeMath')
        cmp.operation = 'GREATER_THAN'
        cmp.inputs[1].default_value = d.get('alphaCutoff', 0.5)
        mix = nt.nodes.new('ShaderNodeMixShader')
        tr = nt.nodes.new('ShaderNodeBsdfTransparent')
        nt.links.new(tex.outputs['Alpha'], cmp.inputs[0])
        nt.links.new(cmp.outputs[0], mix.inputs[0])
        nt.links.new(tr.outputs[0], mix.inputs[1])
        # Thin leaves/needles transmit part of the light (the cards are also a
        # coarse, fully opaque stand-in for real canopy gaps).
        leaf = nt.nodes.new('ShaderNodeMixShader')
        leaf.inputs[0].default_value = 0.35
        trl = nt.nodes.new('ShaderNodeBsdfTranslucent')
        trl.inputs['Color'].default_value = (*[min(1.0, c * 1.6) for c in alb], 1)
        nt.links.new(dif.outputs[0], leaf.inputs[1])
        nt.links.new(trl.outputs[0], leaf.inputs[2])
        nt.links.new(leaf.outputs[0], mix.inputs[2])
        nt.links.new(mix.outputs[0], out.inputs['Surface'])
    else:
        nt.links.new(dif.outputs[0], out.inputs['Surface'])
    bake_mats[name] = m
    return m


# ------------------------------------------------------------------ scene
def engine_to_blender_matrix(t):
    p = t.get('position', [0, 0, 0])
    q = t.get('rotation', [0, 0, 0, 1])
    s = t.get('scale', [1, 1, 1])
    loc = Vector((p[0], -p[2], p[1]))
    rot = Quaternion((q[3], q[0], -q[2], q[1]))
    sc = Matrix.Diagonal((s[0], s[2], s[1], 1.0))
    return Matrix.Translation(loc) @ rot.to_matrix().to_4x4() @ sc


asset_cache = {}


def import_asset(rel):
    if rel in asset_cache:
        return asset_cache[rel]
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(PUBLIC, rel))
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == 'MESH']
    for o in new:
        if o.type != 'MESH':
            bpy.data.objects.remove(o)
    src = meshes[0]
    # Bake materials by engine slot name.
    for i, slot in enumerate(src.material_slots):
        nm = slot.material.name.split('.')[0] if slot.material else 'default'
        src.data.materials[i] = get_bake_material(nm)
    src.matrix_world = Matrix.Identity(4)
    for c in list(src.users_collection):
        c.objects.unlink(src)
    asset_cache[rel] = src
    return src


lightmapped = []   # (object, map id, (W, H))
n_objects = 0
for o in doc['objects']:
    if o['type'] == 'mesh' and not o['asset'].startswith('builtin:'):
        src = import_asset(o['asset'])
        lm = o.get('lightmap')
        # Lightmapped objects get their own mesh copy (UV1 is rewritten per atlas placement).
        ob = src.copy()
        if lm:
            ob.data = src.data.copy()
        ob.name = o['id']
        ob.matrix_world = engine_to_blender_matrix(o['transform'])
        scene.collection.objects.link(ob)
        n_objects += 1
        if lm:
            lightmapped.append((ob, o['id'], tuple(lm['resolution'])))
    elif o['type'] == 'instances':
        src = import_asset(o['asset'])
        for k, (x, y, z, yaw, s) in enumerate(o['instances']):
            ob = src.copy()
            ob.name = f"{o['id']}#{k}"
            ob.matrix_world = Matrix.Translation((x, -z, y)) @ Matrix.Rotation(math.radians(-yaw), 4, 'Z') @ Matrix.Diagonal((s, s, s, 1))
            scene.collection.objects.link(ob)
            n_objects += 1
print(f'[bake] scene: {n_objects} objects, {len(lightmapped)} lightmapped, import {time.time() - t_start:.1f}s')

# ------------------------------------------------------------------ atlas packing
rects = sorted(lightmapped, key=lambda it: -it[2][1])
pages = []  # list of placements per page
placement = {}
cur = {'x': 0, 'y': 0, 'shelf': 0, 'items': []}
for ob, oid, (w, h) in rects:
    if w > PAGE or h > PAGE:
        raise SystemExit(f'{oid}: chart {w}x{h} larger than page {PAGE}')
    if cur['x'] + w > PAGE:
        cur['x'] = 0
        cur['y'] += cur['shelf']
        cur['shelf'] = 0
    if cur['y'] + h > PAGE:
        pages.append(cur['items'])
        cur = {'x': 0, 'y': 0, 'shelf': 0, 'items': []}
    placement[oid] = (len(pages), cur['x'], cur['y'], w, h)
    cur['items'].append(oid)
    cur['x'] += w
    cur['shelf'] = max(cur['shelf'], h)
pages.append(cur['items'])
used = sum(w * h for _, _, (w, h) in lightmapped)
print(f'[bake] atlas: {len(pages)} page(s) of {PAGE}^2, {used / 1e6:.2f} Mtexels used ({100 * used / (len(pages) * PAGE * PAGE):.0f}%)')

# Rewrite UV1 into atlas space and make it the active (bake) UV map.
for ob, oid, _ in lightmapped:
    page, X, Y, W, H = placement[oid]
    me = ob.data
    uv1 = me.uv_layers[1]
    n = len(uv1.data)
    buf = np.empty(n * 2, dtype=np.float32)
    uv1.data.foreach_get('uv', buf)
    buf[0::2] = (buf[0::2] * W + X) / PAGE
    buf[1::2] = (buf[1::2] * H + Y) / PAGE
    uv1.data.foreach_set('uv', buf)
    me.uv_layers.active = uv1

# ------------------------------------------------------------------ cycles setup
scene.render.engine = 'CYCLES'
prefs = bpy.context.preferences.addons['cycles'].preferences
prefs.compute_device_type = 'METAL'
prefs.refresh_devices()
for d in prefs.devices:
    d.use = d.type == 'METAL'
scene.cycles.device = 'GPU'
scene.cycles.samples = SAMPLES
scene.cycles.use_adaptive_sampling = False
scene.cycles.max_bounces = 6
scene.cycles.diffuse_bounces = 4
scene.cycles.glossy_bounces = 0
scene.cycles.transmission_bounces = 0
scene.cycles.transparent_max_bounces = 12
scene.cycles.sample_clamp_indirect = 8.0
scene.render.bake.margin = 2
scene.render.bake.margin_type = 'EXTEND'

world = bpy.data.worlds.new('bake_world')
scene.world = world
world.use_nodes = True
wn = world.node_tree
bg = wn.nodes['Background']
tc = wn.nodes.new('ShaderNodeTexCoord')
sep = wn.nodes.new('ShaderNodeSeparateXYZ')
mr = wn.nodes.new('ShaderNodeMapRange')
mr.inputs['From Min'].default_value = -0.02
mr.inputs['From Max'].default_value = 0.02
mr.inputs['To Min'].default_value = 0.1   # distant ground below the horizon
mr.inputs['To Max'].default_value = 1.0
wn.links.new(tc.outputs['Generated'], sep.inputs[0])
wn.links.new(sep.outputs['Z'], mr.inputs['Value'])
wn.links.new(mr.outputs['Result'], bg.inputs['Strength'])
bg.inputs['Color'].default_value = (1, 1, 1, 1)

env = load_json(os.path.join(PUBLIC, 'environments', doc['environment']['preset'] + '.json'))
az, el = env['sun']['azimuth'], env['sun']['elevation']
to_sun = Vector((math.sin(math.radians(az)) * math.cos(math.radians(el)), math.cos(math.radians(az)) * math.cos(math.radians(el)), math.sin(math.radians(el))))
sun_data = bpy.data.lights.new('bake_sun', 'SUN')
sun_data.energy = 1.0
sun_data.angle = math.radians(0.53)
sun = bpy.data.objects.new('bake_sun', sun_data)
sun.rotation_mode = 'QUATERNION'
sun.rotation_quaternion = to_sun.to_track_quat('Z', 'Y')
scene.collection.objects.link(sun)

# One image target per page; every bake material gets an (active) image node.
images = {}


def set_target(img):
    for m in bake_mats.values():
        nt = m.node_tree
        node = nt.nodes.get('bake_target') or nt.nodes.new('ShaderNodeTexImage')
        node.name = 'bake_target'
        node.image = img
        for n in nt.nodes:
            n.select = False
        node.select = True
        nt.nodes.active = node


def bake(page, kind, pass_filter, fill=None):
    img = bpy.data.images.new(f'lm_{page}_{kind}', PAGE, PAGE, alpha=True, float_buffer=True)
    if fill is not None:
        img.pixels.foreach_set(np.tile(np.array(fill, dtype=np.float32), PAGE * PAGE))
    set_target(img)
    bpy.ops.object.select_all(action='DESELECT')
    objs = [ob for ob, oid, _ in lightmapped if placement[oid][0] == page]
    for ob in objs:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    t = time.time()
    btype = kind if kind in ('POSITION', 'NORMAL') else 'DIFFUSE'
    bpy.ops.object.bake(type=btype, pass_filter=pass_filter, use_clear=fill is None, target='IMAGE_TEXTURES',
                        normal_space='OBJECT' if btype == 'NORMAL' else 'TANGENT')
    print(f'[bake] page {page} {kind}: {time.time() - t:.1f}s')
    px = np.empty(PAGE * PAGE * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    return px.reshape(PAGE, PAGE, 4)  # rows bottom-to-top


# ------------------------------------------------------------------ denoise
def atrous_denoise(color, pos, nrm, valid, iterations=5, sigma_p=0.12, sigma_n=64.0, sigma_l=4.0):
    """Edge-aware a-trous wavelet filter guided by world position and normal.
    Chart boundaries separate naturally (different world positions)."""
    h = np.array([1 / 16, 1 / 4, 3 / 8, 1 / 4, 1 / 16], dtype=np.float32)
    c = color.copy()
    ys, xs = np.nonzero(valid)
    if len(ys) == 0:
        return c
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    c = c[y0:y1, x0:x1]
    P = pos[y0:y1, x0:x1]
    N = nrm[y0:y1, x0:x1]
    V = valid[y0:y1, x0:x1].astype(np.float32)
    for it in range(iterations):
        step = 1 << it
        lum = c @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
        acc = np.zeros_like(c)
        wsum = np.zeros(c.shape[:2], dtype=np.float32)
        sp2 = (sigma_p * (1 + 0.5 * it)) ** 2
        for j in range(5):
            for i in range(5):
                dy, dx = (j - 2) * step, (i - 2) * step
                k = h[i] * h[j]
                cs = np.roll(c, (dy, dx), axis=(0, 1))
                ps = np.roll(P, (dy, dx), axis=(0, 1))
                ns = np.roll(N, (dy, dx), axis=(0, 1))
                vs = np.roll(V, (dy, dx), axis=(0, 1))
                ls = np.roll(lum, (dy, dx), axis=(0, 1))
                wp = np.exp(-np.sum((P - ps) ** 2, axis=2) / sp2)
                wn = np.clip(np.sum(N * ns, axis=2), 0, 1) ** sigma_n
                wl = np.exp(-np.abs(lum - ls) / (sigma_l * (np.sqrt(np.maximum(lum, 1e-4)) * 0.25 + 0.02)))
                w = k * wp * wn * wl * vs
                acc += cs * w[..., None]
                wsum += w
        c = np.where(wsum[..., None] > 1e-6, acc / np.maximum(wsum, 1e-6)[..., None], c)
    out = color.copy()
    out[y0:y1, x0:x1] = np.where(V[..., None] > 0, c, out[y0:y1, x0:x1])
    return out


# ------------------------------------------------------------------ RGBE writer
def write_hdr(path, rgb_top_down):
    """Radiance RGBE with new-style RLE. rgb_top_down: (H, W, 3) float32, row 0 = top."""
    H, W, _ = rgb_top_down.shape
    v = np.maximum(rgb_top_down, 0)
    m = v.max(axis=2)
    e = np.zeros((H, W), dtype=np.int32)
    mant = np.zeros((H, W, 3), dtype=np.float32)
    nz = m > 1e-32
    fr, ex = np.frexp(m[nz])
    e[nz] = ex + 128
    scale = np.zeros((H, W), dtype=np.float32)
    scale[nz] = fr * 256.0 / m[nz]
    mant = v * scale[..., None]
    rgbe = np.zeros((H, W, 4), dtype=np.uint8)
    rgbe[..., :3] = np.clip(mant, 0, 255).astype(np.uint8)
    rgbe[..., 3] = np.clip(e, 0, 255).astype(np.uint8)
    out = bytearray(b'#?RADIANCE\nFORMAT=32-bit_rle_rgbe\nSOFTWARE=rill-bake\n\n' + f'-Y {H} +X {W}\n'.encode())
    for y in range(H):
        out += bytes((2, 2, W >> 8, W & 255))
        for ch in range(4):
            row = rgbe[y, :, ch]
            x = 0
            while x < W:
                # run?
                r = 1
                while x + r < W and r < 127 and row[x + r] == row[x]:
                    r += 1
                if r >= 4:
                    out += bytes((128 + r, int(row[x])))
                    x += r
                    continue
                s = x
                while x < W and x - s < 128:
                    if x + 3 < W and row[x] == row[x + 1] == row[x + 2] == row[x + 3]:
                        break
                    x += 1
                out += bytes((x - s,)) + row[s:x].tobytes()
    with open(path, 'wb') as f:
        f.write(out)


# ------------------------------------------------------------------ run
os.makedirs(OUT_DIR, exist_ok=True)
page_files = []
t_bake = time.time()
for p in range(len(pages)):
    # Guides first (cheap, deterministic): world position + normal with an "empty" sentinel.
    scene.cycles.samples = 1
    pos = bake(p, 'POSITION', {'COLOR'}, fill=[1e5, 1e5, 1e5, 0])
    nrm = bake(p, 'NORMAL', {'COLOR'}, fill=[0, 0, 0, 0])
    valid = pos[..., 0] < 5e4
    scene.cycles.samples = SAMPLES
    # Sky: world on, sun off.
    bg.mute = False
    sun.hide_render = True
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 1.0
    sky = bake(p, 'sky', {'DIRECT', 'INDIRECT'})
    # Sun bounce: world black, sun on.
    wn.links.remove(wn.links[[l.to_socket for l in wn.links].index(bg.inputs['Strength'])])
    bg.inputs['Strength'].default_value = 0.0
    sun.hide_render = False
    sunb = bake(p, 'sunBounce', {'INDIRECT'})
    wn.links.new(mr.outputs['Result'], bg.inputs['Strength'])
    files = {}
    for kind, img in (('sky', sky), ('sunBounce', sunb)):
        rgb = img[..., :3]
        if DENOISE:
            t = time.time()
            # Normals from the bake are in [0,1] (object space for identity transforms = world).
            n = nrm[..., :3] * 2 - 1
            rgb = atrous_denoise(rgb, pos[..., :3], n, valid)
            print(f'[bake] denoise {kind}: {time.time() - t:.1f}s')
        name = f'lm_{p}_{"sky" if kind == "sky" else "sun"}.hdr'
        write_hdr(os.path.join(OUT_DIR, name), rgb[::-1].copy())
        files[kind] = name
        # Diagnostics: open-sky reference texel values.
        vv = rgb[valid]
        print(f'[bake] {kind}: mean {vv.mean(axis=0).round(4).tolist()}  p99 {np.percentile(vv.max(axis=1), 99):.3f}')
    page_files.append(files)

objects_out = {}
for ob, oid, _ in lightmapped:
    page, X, Y, W, H = placement[oid]
    objects_out[oid] = {'page': page, 'scaleOffset': [W / PAGE, H / PAGE, X / PAGE, 1 - (H + Y) / PAGE]}

lms = {
    'format': 'rill.lightmapset',
    'version': 1,
    'backend': f'blender-cycles {bpy.app.version_string}',
    'bakedAt': time.strftime('%Y-%m-%dT%H:%M:%S'),
    'atlasSize': [PAGE, PAGE],
    'components': ['sky', 'sunBounce'],
    'referenceSun': {'azimuth': az, 'elevation': el},
    'pages': page_files,
    'objects': objects_out,
    'stats': {'samples': SAMPLES, 'denoise': DENOISE, 'bakeSeconds': round(time.time() - t_bake, 1), 'texelsUsed': used, 'objects': len(lightmapped)},
}
with open(os.path.join(OUT_DIR, 'lightmapset.json'), 'w') as f:
    json.dump(lms, f, indent=1)
print(f'[bake] done in {time.time() - t_start:.1f}s -> {OUT_DIR}')
