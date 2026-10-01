"""Shared helpers for Rill's Blender tooling (asset build + lightmap bake).

Coordinate conventions
  Blender: right-handed, Z up, +Y = north, +X = east. Metres.
  Engine:  right-handed, Y up, -Z = north, +X = east. Metres.
  The glTF exporter converts Blender (x, y, z) -> engine (x, z, -y).

UV conventions
  UV0: world metres (box-projected), materials declare their physical size.
  UV1: lightmap chart layout in [0,1]^2 over a W x H texel rectangle; the bake
       places each object's rectangle into an atlas page (per-instance scale/offset).
"""

import json
import math
import os

import bmesh
import bpy
from bpy_extras import bmesh_utils
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
PUBLIC = os.path.join(ROOT, 'public')


def to_engine(p):
    return [round(p[0], 4), round(p[2], 4), round(-p[1], 4)]


def yaw_quat(yaw_deg):
    """Engine quaternion for a compass yaw (clockwise from north, looking down)."""
    a = -math.radians(yaw_deg) / 2
    return [0.0, round(math.sin(a), 6), 0.0, round(math.cos(a), 6)]


def quat_mul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ]


def smoothstep(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def load_json(path):
    with open(path) as f:
        return json.load(f)


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


_materials = {}


def material(name):
    """Blender material placeholder named after the engine material (export keeps the name)."""
    m = _materials.get(name)
    if m is None:
        m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
        _materials[name] = m
    return m


class MeshBuilder:
    """Accumulates faces with per-face materials into a bmesh.

    Faces use their own vertices while building; `finish` welds coincident
    vertices so coplanar neighbours become connected UV islands.
    """

    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.uv0 = self.bm.loops.layers.uv.new('UVMap')
        self.mats = []
        self.explicit_uv = {}
        self.smooth_faces = set()
        # Lightmap chart groups: faces with the same id are packed as one chart
        # (their UV0 layout must not overlap), 0 = automatic (UV0 islands).
        self.chart = self.bm.faces.layers.int.new('chart')
        self._charts = 0
        # Optional lightmap layout coordinates (when UV0 is not a valid layout,
        # e.g. room-space UVs on interior-mapped panes). Removed before export.
        self.uvl = self.bm.loops.layers.uv.new('Layout')
        self.has_layout = self.bm.faces.layers.int.new('has_layout')

    def new_chart(self):
        self._charts += 1
        return self._charts

    def mat(self, name):
        if name not in self.mats:
            self.mats.append(name)
        return self.mats.index(name)

    def face(self, pts, mat, uvs=None, smooth=False, chart=0, luvs=None):
        vs = [self.bm.verts.new(Vector(p)) for p in pts]
        try:
            f = self.bm.faces.new(vs)
        except ValueError:
            return None
        f.material_index = self.mat(mat)
        f.smooth = smooth
        f[self.chart] = chart
        if luvs is not None:
            for loop, uv in zip(f.loops, luvs):
                loop[self.uvl].uv = uv
            f[self.has_layout] = 1
        if uvs is not None:
            for loop, uv in zip(f.loops, uvs):
                loop[self.uv0].uv = uv
            self.explicit_uv[f.index if f.index >= 0 else id(f)] = True
            f.tag = True
        else:
            f.tag = False
        return f

    def quad(self, a, b, c, d, mat, uvs=None, smooth=False, chart=0, luvs=None):
        """CCW when seen from the front (normal by right-hand rule)."""
        return self.face([a, b, c, d], mat, uvs, smooth, chart, luvs)

    def box(self, x0, x1, y0, y1, z0, z1, mat, skip=(), mats=None):
        m = lambda k: (mats or {}).get(k, mat)
        if '+z' not in skip:
            self.quad((x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1), m('+z'))
        if '-z' not in skip:
            self.quad((x0, y1, z0), (x1, y1, z0), (x1, y0, z0), (x0, y0, z0), m('-z'))
        if '-y' not in skip:
            self.quad((x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1), m('-y'))
        if '+y' not in skip:
            self.quad((x1, y1, z0), (x0, y1, z0), (x0, y1, z1), (x1, y1, z1), m('+y'))
        if '+x' not in skip:
            self.quad((x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1), m('+x'))
        if '-x' not in skip:
            self.quad((x0, y1, z0), (x0, y0, z0), (x0, y0, z1), (x0, y1, z1), m('-x'))

    def tube(self, p0, p1, r0, r1, mat, sides=8, caps=True):
        p0, p1 = Vector(p0), Vector(p1)
        axis = (p1 - p0).normalized()
        ref = Vector((0, 0, 1)) if abs(axis.z) < 0.9 else Vector((1, 0, 0))
        t = axis.cross(ref).normalized()
        b = axis.cross(t)
        length = (p1 - p0).length
        ring = lambda p, r: [p + (t * math.cos(2 * math.pi * i / sides) + b * math.sin(2 * math.pi * i / sides)) * r for i in range(sides)]
        A, B = ring(p0, r0), ring(p1, r1)
        circ = 2 * math.pi * max(r0, r1)
        for i in range(sides):
            j = (i + 1) % sides
            u0, u1 = circ * i / sides, circ * (i + 1) / sides
            self.face([A[i], A[j], B[j], B[i]], mat, uvs=[(u0, 0), (u1, 0), (u1, length), (u0, length)], smooth=True)
        if caps:
            self.face(list(reversed(A)), mat)
            self.face(B, mat)

    # ------------------------------------------------------------ finish

    def _box_project(self):
        uv = self.uv0
        for f in self.bm.faces:
            if f.tag:
                continue
            n = f.normal
            ax = max(range(3), key=lambda k: abs(n[k]))
            for loop in f.loops:
                p = loop.vert.co
                if ax == 2:
                    u, v = p.x, (p.y if n.z > 0 else -p.y)
                elif ax == 0:
                    u, v = (p.y if n.x > 0 else -p.y), p.z
                else:
                    u, v = (-p.x if n.y > 0 else p.x), p.z
                loop[uv].uv = (u, v)

    def finish(self, lightmap_tpm=None, weld=True, custom_normals=None, vertex_color=None, color_max_edge=None, foliage_normals=None):
        """vertex_color(co, material_name) -> (r, g, b, a) linear; r = blend weight.
        color_max_edge: subdivide faces of blend materials until edges are at most
        this long (metres), so painted weights have vertices to live on."""
        bm = self.bm
        bm.normal_update()
        self._box_project()
        if weld:
            bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=0.0005)
        if vertex_color is not None and color_max_edge:
            blend_idx = {i for i, m in enumerate(self.mats) if is_blend_material(m)}
            for _ in range(10):
                long_edges = [e for e in bm.edges if e.calc_length() > color_max_edge * 1.001
                              and any(f.material_index in blend_idx for f in e.link_faces)]
                if not long_edges:
                    break
                bmesh.ops.subdivide_edges(bm, edges=long_edges, cuts=1, use_grid_fill=True)
        # Triangulate n-gons (caps) so MikkTSpace tangents can be computed on export.
        bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
        bm.normal_update()
        if vertex_color is not None:
            col = bm.loops.layers.float_color.new('Col')
            rng = {}
            for f in bm.faces:
                mname = self.mats[f.material_index]
                for loop in f.loops:
                    c = (vertex_color(loop.vert.co, mname, loop.vert.normal) if getattr(vertex_color, 'wants_normal', False)
                         else vertex_color(loop.vert.co, mname))
                    loop[col] = c
                    lo, hi = rng.get(mname, (9.0, -9.0))
                    rng[mname] = (min(lo, c[0]), max(hi, c[0]))
            print(f'  {self.name}: vertex colour R ' + ', '.join(f'{k} {lo:.2f}..{hi:.2f}' for k, (lo, hi) in rng.items()))
        res = None
        for f in bm.faces:
            if not f[self.has_layout]:
                for loop in f.loops:
                    loop[self.uvl].uv = loop[self.uv0].uv
        if lightmap_tpm:
            uv1 = bm.loops.layers.uv.new('Lightmap')
            res = pack_lightmap_uvs(bm, self.uvl, uv1, lightmap_tpm)
        bm.loops.layers.uv.remove(self.uvl)
        me = bpy.data.meshes.new(self.name)
        bm.to_mesh(me)
        bm.free()
        for m in self.mats:
            me.materials.append(material(m))
        if vertex_color is not None and 'Col' in me.color_attributes:
            ca = me.color_attributes
            ca.active_color = ca['Col']
            ca.render_color_index = list(ca.keys()).index('Col')
        if foliage_normals is not None:
            # (material names, fn(co) -> normal): bent normals on foliage faces only,
            # every other corner keeps its smooth/flat normal.
            fol_mats, fn = foliage_normals
            fol_idx = {i for i, m in enumerate(self.mats) if m in fol_mats}
            cn = [tuple(c.vector) for c in me.corner_normals]
            loops = list(cn)
            for poly in me.polygons:
                if poly.material_index in fol_idx:
                    for li in poly.loop_indices:
                        loops[li] = tuple(fn(me.vertices[me.loops[li].vertex_index].co))
            me.normals_split_custom_set(loops)
        if custom_normals is not None:
            try:
                normals = [custom_normals(v.co) for v in me.vertices]
                me.normals_split_custom_set_from_vertices(normals)
            except Exception as e:  # noqa: BLE001
                print('custom normals unavailable:', e)
        obj = bpy.data.objects.new(self.name, me)
        bpy.context.scene.collection.objects.link(obj)
        obj['lightmap_resolution'] = list(res) if res else None
        return obj, res


def _hull(pts):
    """Convex hull (monotone chain), CCW."""
    pts = sorted(set(pts))
    if len(pts) < 3:
        return pts
    cross = lambda o, a, b: (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, hi = [], []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0:
            lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(hi) >= 2 and cross(hi[-2], hi[-1], p) <= 0:
            hi.pop()
        hi.append(p)
    return lo[:-1] + hi[:-1]


def _min_rect(pts):
    """(area, angle) of the minimum-area bounding rectangle (rotating calipers over the hull)."""
    h = _hull(pts)
    if len(h) < 3:
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        return (max(xs) - min(xs)) * (max(ys) - min(ys)), 0.0
    best = (float('inf'), 0.0)
    for i in range(len(h)):
        ex, ey = h[(i + 1) % len(h)][0] - h[i][0], h[(i + 1) % len(h)][1] - h[i][1]
        ang = math.atan2(ey, ex)
        c, s_ = math.cos(-ang), math.sin(-ang)
        us = [p[0] * c - p[1] * s_ for p in h]
        vs = [p[0] * s_ + p[1] * c for p in h]
        area = (max(us) - min(us)) * (max(vs) - min(vs))
        if area < best[0]:
            best = (area, ang)
    return best


def _uv_area(f, uv0):
    pts = [l[uv0].uv for l in f.loops]
    return abs(sum(pts[i - 1].x * pts[i].y - pts[i].x * pts[i - 1].y for i in range(len(pts)))) / 2


def _split_sparse(isl, uv0, min_fill=0.55):
    """Greedy region growing: splits an island whose faces fill its best bounding
    rectangle poorly (e.g. a ribbon around a corner) into well-filled charts.
    Deterministic: faces are visited in index order (never in set/hash order)."""
    order = sorted(isl, key=lambda f: f.index)
    pos = {f: k for k, f in enumerate(order)}
    area = {f: _uv_area(f, uv0) for f in order}
    pts = {f: [(l[uv0].uv.x, l[uv0].uv.y) for l in f.loops] for f in order}
    left = dict.fromkeys(order)
    charts = []
    nbrs = lambda f: sorted((g for e in f.edges for g in e.link_faces if g in left), key=lambda g: pos[g])
    while left:
        seed = max(left, key=lambda f: (area[f], -pos[f]))
        group, gpts, garea = [seed], list(pts[seed]), area[seed]
        del left[seed]
        frontier = nbrs(seed)
        while frontier:
            f = frontier.pop(0)
            if f not in left:
                continue
            ra, _ = _min_rect(gpts + pts[f])
            if ra > 1e-12 and (garea + area[f]) / ra < min_fill:
                continue
            group.append(f)
            gpts += pts[f]
            garea += area[f]
            del left[f]
            frontier += nbrs(f)
        charts.append(group)
    return charts


def pack_lightmap_uvs(bm, uv0, uv1, tpm, pad=2):
    """Texel-exact lightmap chart packing.

    Islands come from the metre-space UV0 layout, so chart texel density is
    uniform (tpm texels per metre). Each chart is turned to its minimum-area
    bounding rectangle (diagonal walls and roofs pack tight), sparse islands
    are split into well-filled charts, every chart gets `pad` texels of padding
    on every side, and charts are rotated to landscape and shelf-packed.
    Returns (W, H) in texels; UV1 is normalised to that rectangle.
    """
    bm.faces.index_update()
    islands = bmesh_utils.bmesh_linked_uv_islands(bm, uv0)
    # Islands sharing an explicit chart id are packed together (union-find).
    lay = bm.faces.layers.int.get('chart')
    parent = list(range(len(islands)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    owner = {}
    for i, isl in enumerate(islands):
        for f in isl:
            cid = f[lay] if lay is not None else 0
            if cid:
                if cid in owner:
                    parent[find(i)] = find(owner[cid])
                else:
                    owner[cid] = i
    groups = {}
    for i, isl in enumerate(islands):
        groups.setdefault(find(i), []).extend(isl)
    explicit = {r for r in groups if lay is not None and any(f[lay] for f in groups[r])}
    charts = []
    for r, isl in groups.items():
        if r in explicit:
            charts.append(isl)
            continue
        pts = [(l[uv0].uv.x, l[uv0].uv.y) for f in isl for l in f.loops]
        ra, _ang = _min_rect(pts)
        fill = sum(_uv_area(f, uv0) for f in isl) / ra if ra > 1e-12 else 1.0
        if fill < 0.45 and 1 < len(isl) <= 600:
            charts += _split_sparse(isl, uv0)
        else:
            charts.append(isl)
    items = []
    for isl in charts:
        pts = [(l[uv0].uv.x, l[uv0].uv.y) for f in isl for l in f.loops]
        ra, ang = _min_rect(pts)
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        if ra >= (max(xs) - min(xs)) * (max(ys) - min(ys)) * 0.98:
            ang = 0.0          # axis-aligned is (nearly) as good: keep texels on the world grid
        c, s_ = math.cos(-ang), math.sin(-ang)
        loc = lambda u, v, c=c, s_=s_: (u * c - v * s_, u * s_ + v * c)   # bind this chart's rotation
        lus = [loc(*p) for p in pts]
        u0, u1 = min(p[0] for p in lus), max(p[0] for p in lus)
        v0, v1 = min(p[1] for p in lus), max(p[1] for p in lus)
        w = max(1, math.ceil((u1 - u0) * tpm)) + 2 * pad
        h = max(1, math.ceil((v1 - v0) * tpm)) + 2 * pad
        rot = h > w
        if rot:
            w, h = h, w
        items.append({'faces': isl, 'loc': loc, 'u0': u0, 'u1': u1, 'v0': v0, 'v1': v1, 'w': w, 'h': h, 'rot': rot})
    if not items:
        return (4, 4)
    items.sort(key=lambda it: (-it['h'], -it['w']))
    area = sum(it['w'] * it['h'] for it in items)
    wmax = max(it['w'] for it in items)

    def shelf(W, place=False):
        x = y = shelf_h = 0
        for it in items:
            if x + it['w'] > W:
                x = 0
                y += shelf_h
                shelf_h = 0
            if place:
                it['x'], it['y'] = x, y
            x += it['w']
            shelf_h = max(shelf_h, it['h'])
        return y + shelf_h

    # Shelf-pack at a few atlas widths and keep the smallest rectangle.
    cands = {wmax} | {max(wmax, int(math.ceil(math.sqrt(area * k)))) for k in (1.0, 1.08, 1.2, 1.4, 1.7, 2.0, 2.6, 3.5)}
    W = min(cands, key=lambda w: (w * shelf(w), abs(w - shelf(w))))
    H = shelf(W, place=True)
    if os.environ.get('RILL_LMDEBUG') and W * H > 300000:
        used = sum(sum(_uv_area(f, uv0) for f in it['faces']) * tpm * tpm for it in items)
        print(f'    lightmap {W}x{H}: {len(items)} charts, faces cover {used / (W * H):.0%}')
        for it in sorted(items, key=lambda it: -it['w'] * it['h'])[:6]:
            fa = sum(_uv_area(f, uv0) for f in it['faces']) * tpm * tpm
            print(f"      chart {it['w']}x{it['h']} faces={len(it['faces'])} fill={fa / (it['w'] * it['h']):.2f}")
    for it in items:
        for f in it['faces']:
            for l in f.loops:
                u, v = it['loc'](l[uv0].uv.x, l[uv0].uv.y)
                if it['rot']:
                    tx = (v - it['v0']) * tpm
                    ty = (it['u1'] - u) * tpm
                else:
                    tx = (u - it['u0']) * tpm
                    ty = (v - it['v0']) * tpm
                l[uv1].uv = ((it['x'] + pad + tx) / W, (it['y'] + pad + ty) / H)
    bad = sum(1 for f in bm.faces for l in f.loops if not (-1e-4 <= l[uv1].uv.x <= 1.0001 and -1e-4 <= l[uv1].uv.y <= 1.0001))
    if bad:
        raise RuntimeError(f'lightmap packing produced {bad} UVs outside the atlas')
    return (W, H)


def split_by_material(obj):
    """One single-material object per slot (same name prefix). Works around the
    Blender 5.2 glTF exporter writing white COLOR_0 for every material after the
    first in a multi-material mesh."""
    parts = []
    for mi, mat in enumerate(obj.data.materials):
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index != mi], context='FACES')
        if not bm.faces:
            bm.free()
            continue
        for f in bm.faces:
            f.material_index = 0
        me = bpy.data.meshes.new(f'{obj.name}.{mi}')
        bm.to_mesh(me)
        bm.free()
        me.materials.append(mat)
        ca = me.color_attributes
        if 'Col' in ca:
            ca.active_color = ca['Col']
            ca.render_color_index = list(ca.keys()).index('Col')
        part = bpy.data.objects.new(f'{obj.name}.{mi}', me)
        bpy.context.scene.collection.objects.link(part)
        parts.append(part)
    return parts


def material_def(name, depth=0):
    """Resolved engine material JSON (inherits applied), {} when missing."""
    p = os.path.join(PUBLIC, 'materials', name + '.json')
    if not os.path.exists(p):
        return {}
    d = load_json(p)
    if 'inherits' in d and depth < 8:
        base = material_def(d['inherits'], depth + 1)
        base.update({k: v for k, v in d.items() if k != 'inherits'})
        d = base
    return d


_blend_cache = {}


def is_blend_material(name):
    """True when public/materials/<name>.json (or a parent) declares a blend layer."""
    if name not in _blend_cache:
        d, depth = {}, 0
        n = name
        while n and depth < 8:
            p = os.path.join(PUBLIC, 'materials', n + '.json')
            if not os.path.exists(p):
                break
            d = load_json(p)
            if 'blend' in d:
                break
            n, depth = d.get('inherits'), depth + 1
        _blend_cache[name] = 'blend' in d
    return _blend_cache[name]


def export_glb(obj, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    parts = [obj]
    if len(obj.data.materials) > 1 and len(obj.data.color_attributes) > 0:
        parts = split_by_material(obj)
    bpy.ops.object.select_all(action='DESELECT')
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        use_selection=True,
        export_yup=True,
        export_texcoords=True,
        export_normals=True,
        export_tangents=True,
        export_materials='EXPORT',
        export_image_format='NONE',
        export_extras=False,
        export_apply=False,
        export_vertex_color='ACTIVE',
    )
    if parts[0] is not obj:
        for p in parts:
            me = p.data
            bpy.data.objects.remove(p)
            bpy.data.meshes.remove(me)
