"""Shared modelling + bake helpers for hand-built game assets (carbine, creatures).

Piece: bmesh accumulator with a material id per face (ids index `kit.IDS`).
Bake: smart-UV all parts into one atlas, bake AO / emission passes on the GPU,
compose textures with numpy (the caller's compose step).
"""

import math
import os

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

# Set by the builder before creating pieces: material id names and atlas size.
IDS = ['default']
ATLAS = 2048
SAMPLES = 96
_mats = {}


def configure(ids, atlas=2048, samples=96):
    global IDS, ATLAS, SAMPLES
    IDS = list(ids)
    ATLAS = atlas
    SAMPLES = samples
    _mats.clear()


def id_color(name):
    i = IDS.index(name)
    return ((i + 1) / 16.0, 0.0, 0.0)


def decode_ids(idm):
    return np.rint(idm[..., 0] * 16 - 1).astype(np.int32)


# ------------------------------------------------------------------ building blocks

class Piece:
    """bmesh accumulator with a material id per face."""

    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()

    def _tag(self, faces, mat):
        mi = IDS.index(mat)
        for f in faces:
            f.material_index = mi

    def _new_faces(self, before):
        return [f for f in self.bm.faces if f.index < 0 or f not in before]

    def box(self, c, s, mat, rot=None):
        before = set(self.bm.faces)
        M = Matrix.Translation(Vector(c)) @ (rot.to_4x4() if rot else Matrix()) @ Matrix.Diagonal((s[0], s[1], s[2], 1))
        bmesh.ops.create_cube(self.bm, size=1.0, matrix=M)
        self._tag([f for f in self.bm.faces if f not in before], mat)

    def cyl(self, p0, p1, r, mat, segs=24, r1=None):
        """Cylinder (or cone with r1) from p0 to p1."""
        before = set(self.bm.faces)
        p0, p1 = Vector(p0), Vector(p1)
        d = p1 - p0
        q = Vector((0, 0, 1)).rotation_difference(d.normalized())
        M = Matrix.Translation((p0 + p1) / 2) @ q.to_matrix().to_4x4()
        bmesh.ops.create_cone(self.bm, cap_ends=True, cap_tris=False, segments=segs, radius1=r, radius2=r if r1 is None else r1, depth=d.length, matrix=M)
        self._tag([f for f in self.bm.faces if f not in before], mat)

    def loft(self, rings, mat, caps=True):
        """Quads between consecutive rings (equal vertex counts, CCW seen from the end)."""
        before = set(self.bm.faces)
        vs = [[self.bm.verts.new(Vector(p)) for p in ring] for ring in rings]
        n = len(rings[0])
        for a, b in zip(vs, vs[1:]):
            for i in range(n):
                j = (i + 1) % n
                try:
                    self.bm.faces.new([a[i], a[j], b[j], b[i]])
                except ValueError:
                    pass
        if caps:
            try:
                self.bm.faces.new(list(reversed(vs[0])))
                self.bm.faces.new(vs[-1])
            except ValueError:
                pass
        self._tag([f for f in self.bm.faces if f not in before], mat)

    def to_object(self, origin=(0, 0, 0)):
        bm = self.bm
        bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-5)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        me = bpy.data.meshes.new(self.name)
        bm.to_mesh(me)
        bm.free()
        for n in IDS:
            me.materials.append(id_material(n))
        ob = bpy.data.objects.new(self.name, me)
        bpy.context.scene.collection.objects.link(ob)
        # Origin = pivot: move the mesh so (origin) becomes (0,0,0), then place the object there.
        o = Vector(origin)
        me.transform(Matrix.Translation(-o))
        ob.location = o
        return ob


def rounded_rect(cx, cz, hx, hz, r, y, n=4):
    """Ring in the x-z plane at y: rounded rectangle (corner radius r), CCW seen from +y."""
    pts = []
    corners = [(cx + hx - r, cz + hz - r, 0), (cx - hx + r, cz + hz - r, 90), (cx - hx + r, cz - hz + r, 180), (cx + hx - r, cz - hz + r, 270)]
    for (x, z, a0) in corners:
        for k in range(n + 1):
            a = math.radians(a0 + 90 * k / n)
            pts.append((x + math.cos(a) * r, y, z + math.sin(a) * r))
    return pts


def id_material(name):
    m = _mats.get(name)
    if m is None:
        m = bpy.data.materials.new(f'id_{name}')
        m.use_nodes = True
        _mats[name] = m
    return m


def boolean(ob, cutter, op='DIFFERENCE'):
    mod = ob.modifiers.new('bool', 'BOOLEAN')
    mod.operation = op
    mod.solver = 'EXACT'
    mod.object = cutter
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.modifier_apply(modifier=mod.name)


def cutter_box(c, s, rot=None):
    p = Piece('cutter')
    p.box(c, s, 'steel', rot)
    ob = p.to_object()
    ob.display_type = 'WIRE'
    return ob


def finish_shading(ob, bevel=0.0009):
    """Small bevels on hard edges (catch the light), smooth shading with hard edges kept."""
    bpy.context.view_layer.objects.active = ob
    for o in bpy.context.selected_objects:
        o.select_set(False)
    ob.select_set(True)
    bpy.ops.object.shade_smooth()
    mod = ob.modifiers.new('bevel', 'BEVEL')
    mod.width = bevel
    mod.segments = 2
    mod.limit_method = 'ANGLE'
    mod.angle_limit = math.radians(32)
    mod.harden_normals = True
    mod.miter_outer = 'MITER_ARC'
    bpy.ops.object.modifier_apply(modifier=mod.name)
    wn = ob.modifiers.new('wn', 'WEIGHTED_NORMAL')
    wn.keep_sharp = True
    wn.mode = 'FACE_AREA'
    bpy.ops.object.modifier_apply(modifier=wn.name)
    tri = ob.modifiers.new('tri', 'TRIANGULATE')
    if hasattr(tri, 'keep_custom_normals'):
        tri.keep_custom_normals = True
    bpy.ops.object.modifier_apply(modifier=tri.name)


# ------------------------------------------------------------------ bake

def setup_cycles():
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    prefs = bpy.context.preferences.addons['cycles'].preferences
    try:
        prefs.compute_device_type = 'METAL'
        prefs.refresh_devices()
        for d in prefs.devices:
            d.use = d.type == 'METAL'
        scene.cycles.device = 'GPU'
    except Exception as e:  # noqa: BLE001
        print('GPU unavailable, baking on the CPU:', e)
    scene.cycles.samples = SAMPLES
    if scene.world is None:
        scene.world = bpy.data.worlds.new('World')
    scene.world.light_settings.distance = 0.04


def unwrap(objs):
    for o in bpy.context.selected_objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(55), island_margin=0.002, scale_to_bounds=False)
    bpy.ops.uv.pack_islands(margin=0.004, rotate=True)
    bpy.ops.object.mode_set(mode='OBJECT')


def bake_pass(objs, image, kind, emission=None):
    """Bakes `kind` ('AO' or 'EMIT') of all objects into `image` (shared atlas)."""
    for name, m in _mats.items():
        nt = m.node_tree
        for n in list(nt.nodes):
            nt.nodes.remove(n)
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        if kind == 'EMIT':
            em = nt.nodes.new('ShaderNodeEmission')
            emission(nt, em, name)
            nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
        else:
            bsdf = nt.nodes.new('ShaderNodeBsdfDiffuse')
            nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
        tex = nt.nodes.new('ShaderNodeTexImage')
        tex.image = image
        nt.nodes.active = tex
    for o in bpy.context.selected_objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.bake(type=kind, margin=12, use_clear=True)


def edge_emission(nt, em, name):
    """Edge mask: how far a bevelled normal leans from the true one (worn corners)."""
    bev = nt.nodes.new('ShaderNodeBevel')
    bev.inputs['Radius'].default_value = 0.0018
    bev.samples = 8
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    dot = nt.nodes.new('ShaderNodeVectorMath')
    dot.operation = 'DOT_PRODUCT'
    nt.links.new(bev.outputs['Normal'], dot.inputs[0])
    nt.links.new(geo.outputs['Normal'], dot.inputs[1])
    inv = nt.nodes.new('ShaderNodeMath')
    inv.operation = 'SUBTRACT'
    inv.inputs[0].default_value = 1.0
    nt.links.new(dot.outputs['Value'], inv.inputs[1])
    mul = nt.nodes.new('ShaderNodeMath')
    mul.operation = 'MULTIPLY'
    mul.use_clamp = True
    mul.inputs[1].default_value = 14.0
    nt.links.new(inv.outputs['Value'], mul.inputs[0])
    nt.links.new(mul.outputs['Value'], em.inputs['Color'])
    em.inputs['Strength'].default_value = 1.0


def id_emission(nt, em, name):
    c = id_color(name)
    em.inputs['Color'].default_value = (c[0], c[1], c[2], 1.0)
    em.inputs['Strength'].default_value = 1.0


def pixels(image):
    a = np.empty(ATLAS * ATLAS * 4, dtype=np.float32)
    image.pixels.foreach_get(a)
    return a.reshape(ATLAS, ATLAS, 4)


def blur(x, r):
    """Separable box blur (r px), a few passes ~ gaussian."""
    for _ in range(3):
        k = 2 * r + 1
        c = np.cumsum(np.pad(x, ((r + 1, r), (0, 0)), mode='edge'), axis=0)
        x = (c[k:] - c[:-k]) / k
        c = np.cumsum(np.pad(x, ((0, 0), (r + 1, r)), mode='edge'), axis=1)
        x = (c[:, k:] - c[:, :-k]) / k
    return x


def save_png(arr, path, colorspace):
    img = bpy.data.images.new(os.path.basename(path), ATLAS, ATLAS, alpha=False, float_buffer=False)
    img.colorspace_settings.name = colorspace
    rgba = np.concatenate([arr, np.ones((ATLAS, ATLAS, 1), np.float32)], -1)
    img.pixels.foreach_set(rgba.astype(np.float32).ravel())
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()


