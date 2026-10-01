"""Ground clutter models (Source-style detail props): tiny crossed-card tufts.

Each model is 2-3 crossed vertical cards (optionally bent once) around the origin,
UV 0..1 with the texture's base at v = 0. Vertex AO (colour G) darkens towards
the root; normals point mostly up so a tuft shades like the ground it grows from.
"""
import math
import os

from mathutils import Vector

from common import MeshBuilder, export_glb
from trees import card_octagon

KINDS = {
    # name: (material, cards, height m, width m, lean)
    'clutter_grass': ('tuft_grass', 3, 0.42, 0.5, 0.12),
    'clutter_dwarf': ('tuft_dwarf', 3, 0.32, 0.45, 0.05),
    'clutter_fern': ('tuft_fern', 2, 0.55, 0.85, 0.25),
}


def build_clutter(name, asset_dir):
    mat, cards, h, w, lean = KINDS[name]
    b = MeshBuilder(name)
    for k in range(cards):
        a = math.pi * k / cards
        d = Vector((math.cos(a), math.sin(a), 0))
        side = Vector((-d.y, d.x, 0))
        # Card trimmed to the texture's opaque outline; the upper half leans (no flat billboards).
        def at(u, v, d=d, side=side):
            lean_off = side * lean * (0.2 * min(v, 0.5) / 0.5 + max(0.0, v - 0.5) / 0.5)
            return Vector((0, 0, -0.03)) + d * w * (u - 0.5) + Vector((0, 0, h * v)) + lean_off
        poly = card_octagon(mat)
        b.face([at(u, v) for u, v in poly], mat, uvs=list(poly), smooth=True)

    def vc(co, m):
        return (0.0, 0.45 + 0.55 * min(1.0, max(0.0, (co.z + 0.03) / h)), 0.0, 1.0)

    def up_normal(co):
        r = Vector((co.x, co.y, 0))
        return (Vector((0, 0, 1)) + (r.normalized() * 0.35 if r.length > 1e-4 else Vector())).normalized()
    obj, _ = b.finish(None, weld=False, vertex_color=vc, foliage_normals=({mat}, up_normal))
    export_glb(obj, os.path.join(asset_dir, name + '.glb'))
    print(f'  {name:24s} {len(obj.data.polygons) * 2:4d} tris')
