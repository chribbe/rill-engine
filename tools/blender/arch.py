"""Architecture helpers for map builders: facades with openings, roofs, shopfronts.

All walls are single planes (outside face) with recessed openings: reveals,
a frame ring, an optional mullion and the pane at the back. Opening kinds:
  'window'  glazed, frame + mullion when wide
  'panel'   shallow recess with a cladding panel (spandrel / bröstning)
  'glazed'  floor-to-ceiling glazing (glazed balconies, shop fronts), thin frame
  'door'    door leaf
  'shop'    shop window: deep frame, transom bar, pane material from `pane`
The pane material of each opening may be overridden per opening (lit windows).
"""

import math

from mathutils import Vector


def wall(b, o, u, length, height, openings, depth, wall_mat, plinth=0.0, plinth_mat='concrete_cast',
         bands=(), band_mat='concrete_cast', glass='glass_window', frame='window_frame', door='wood_door',
         u_start=0.0, chart=None):
    """Facade rectangle with rectangular openings.

    o: bottom-left corner seen from outside; u: unit vector along the wall to the
    right seen from outside. openings: (u0, z0, w, h, kind[, pane_material[, room_z]]).
    room_z: storey floor height (relative to o) for interior-mapped panes: their
    UV0 becomes room space (u along the wall, v up from that floor), the
    lightmap layout keeps the unfolded facade position.
    bands: (z0, z1[, material]) horizontal bands painted on the wall.

    UV0 is the wall plane in metres (u_start + distance along the wall, world z),
    so diagonal walls are not stretched and consecutive walls continue. Reveals
    are unfolded (mitred) into their opening and panes/frames fill the rest, so
    the whole facade is one non-overlapping lightmap chart (`chart`, new if None).
    Returns the chart id.
    """
    o = Vector(o)
    u = Vector((u[0], u[1], u[2] if len(u) > 2 else 0.0)).normalized()
    z = Vector((0, 0, 1))
    n = u.cross(z)  # outward
    ch = b.new_chart() if chart is None else chart
    UV = lambda a, c: (u_start + a, o.z + c)
    us = {0.0, length}
    zs = {0.0, height}
    if plinth > 0:
        zs.add(min(plinth, height))
    for bd in bands:
        zs.update([max(0.0, min(height, bd[0])), max(0.0, min(height, bd[1]))])
    ops = []
    for op in openings:
        u0, z0, w, h, kind = op[:5]
        # clamp into the wall
        u0, w = max(0.02, u0), min(w, length - max(0.02, u0) - 0.02)
        if w <= 0.05 or h <= 0.05 or z0 + h > height:
            continue
        ops.append((u0, z0, w, h, kind, op[5] if len(op) > 5 else None, op[6] if len(op) > 6 else None))
        us.update([u0, u0 + w])
        zs.update([z0, z0 + h])
    us, zs = sorted(us), sorted(zs)
    P = lambda a, c, dd=0.0: o + u * a + z * c - n * dd

    def Q(pts3, uvs, mat, luvs=None):
        b.quad(*pts3, mat, uvs=uvs, chart=ch, luvs=luvs)

    for j in range(len(zs) - 1):
        za, zb = zs[j], zs[j + 1]
        if zb - za < 1e-4:
            continue
        mz = (za + zb) / 2
        row = []
        for i in range(len(us) - 1):
            ua, ub = us[i], us[i + 1]
            if ub - ua < 1e-4:
                continue
            mu = (ua + ub) / 2
            if any(u0 < mu < u0 + w and z0 < mz < z0 + h for (u0, z0, w, h, _k, _p, _r) in ops):
                row.append(None)
                continue
            mat = wall_mat
            if mz < plinth:
                mat = plinth_mat
            else:
                for bd in bands:
                    if bd[0] <= mz <= bd[1]:
                        mat = bd[2] if len(bd) > 2 else band_mat
            row.append((ua, ub, mat))
        # merge horizontal runs of the same material (fewer, longer quads)
        run = None
        for cell in row + [None]:
            if cell is not None and run is not None and run[2] == cell[2] and abs(run[1] - cell[0]) < 1e-6:
                run = (run[0], cell[1], run[2])
                continue
            if run is not None:
                Q((P(run[0], za), P(run[1], za), P(run[1], zb), P(run[0], zb)),
                  [UV(run[0], za), UV(run[1], za), UV(run[1], zb), UV(run[0], zb)], run[2])
            run = cell
    for (u0, z0, w, h, kind, pane_mat, room_z) in ops:
        d = {'panel': 0.035, 'glazed': depth * 0.6, 'shop': depth * 0.8}.get(kind, depth)
        if kind == 'void':
            # open doorway / hole: reveals only (none on a zero-thickness lining)
            if d >= 0.01:
                f_ = min(d, 0.45 * min(w, h))
                Q((P(u0, z0), P(u0, z0, d), P(u0, z0 + h, d), P(u0, z0 + h)),
                  [UV(u0, z0), UV(u0 + f_, z0 + f_), UV(u0 + f_, z0 + h - f_), UV(u0, z0 + h)], wall_mat)
                Q((P(u0 + w, z0, d), P(u0 + w, z0), P(u0 + w, z0 + h), P(u0 + w, z0 + h, d)),
                  [UV(u0 + w - f_, z0 + f_), UV(u0 + w, z0), UV(u0 + w, z0 + h), UV(u0 + w - f_, z0 + h - f_)], wall_mat)
                Q((P(u0, z0 + h), P(u0, z0 + h, d), P(u0 + w, z0 + h, d), P(u0 + w, z0 + h)),
                  [UV(u0, z0 + h), UV(u0 + f_, z0 + h - f_), UV(u0 + w - f_, z0 + h - f_), UV(u0 + w, z0 + h)], wall_mat)
            continue
        f_ = min(d, 0.45 * min(w, h))          # fold width of the reveals in UV space
        # inner rectangle of the opening in UV space (panes, frames)
        IM = lambda a, c: UV(u0 + f_ + (a - u0) * (w - 2 * f_) / w, z0 + f_ + (c - z0) * (h - 2 * f_) / h)
        rv = wall_mat
        # reveals (mitred unfold into the opening)
        Q((P(u0, z0), P(u0, z0, d), P(u0, z0 + h, d), P(u0, z0 + h)),
          [UV(u0, z0), UV(u0 + f_, z0 + f_), UV(u0 + f_, z0 + h - f_), UV(u0, z0 + h)], rv)
        Q((P(u0 + w, z0, d), P(u0 + w, z0), P(u0 + w, z0 + h), P(u0 + w, z0 + h, d)),
          [UV(u0 + w - f_, z0 + f_), UV(u0 + w, z0), UV(u0 + w, z0 + h), UV(u0 + w - f_, z0 + h - f_)], rv)
        Q((P(u0, z0 + h), P(u0, z0 + h, d), P(u0 + w, z0 + h, d), P(u0 + w, z0 + h)),
          [UV(u0, z0 + h), UV(u0 + f_, z0 + h - f_), UV(u0 + w - f_, z0 + h - f_), UV(u0 + w, z0 + h)], rv)
        sill = 'metal_galvanized' if kind in ('window',) else rv
        Q((P(u0, z0, d), P(u0, z0), P(u0 + w, z0), P(u0 + w, z0, d)),
          [UV(u0 + f_, z0 + f_), UV(u0, z0), UV(u0 + w, z0), UV(u0 + w - f_, z0 + f_)], sill)

        def R(a0, c0, a1, c1, dd, mat):
            """Rectangle in the opening at depth dd (frames, mullions, panes)."""
            Q((P(a0, c0, dd), P(a1, c0, dd), P(a1, c1, dd), P(a0, c1, dd)), [IM(a0, c0), IM(a1, c0), IM(a1, c1), IM(a0, c1)], mat)

        if kind == 'panel':
            R(u0, z0, u0 + w, z0 + h, d, pane_mat or 'panel_ochre')
            continue
        pane = pane_mat or (door if kind == 'door' else glass)
        f = {'glazed': 0.05, 'shop': 0.08}.get(kind, 0.06)
        fd = d - 0.025
        frm = frame
        R(u0, z0, u0 + w, z0 + f, fd, frm)
        R(u0, z0 + h - f, u0 + w, z0 + h, fd, frm)
        R(u0, z0 + f, u0 + f, z0 + h - f, fd, frm)
        R(u0 + w - f, z0 + f, u0 + w, z0 + h - f, fd, frm)
        if kind == 'window' and w > 1.0:
            mid = u0 + w / 2
            R(mid - 0.03, z0 + f, mid + 0.03, z0 + h - f, fd, frm)
        if kind == 'glazed':
            # glazed balcony: mullions every ~0.9 m and a railing-height bar
            nm = max(1, int(round(w / 0.9)))
            for k in range(1, nm):
                m = u0 + w * k / nm
                R(m - 0.025, z0 + f, m + 0.025, z0 + h - f, fd, frm)
            zr = z0 + min(1.0, h * 0.42)
            R(u0 + f, zr - 0.03, u0 + w - f, zr + 0.03, fd, frm)
        if kind == 'shop':
            zt = z0 + h - min(0.6, h * 0.22)   # transom bar
            R(u0 + f, zt - 0.04, u0 + w - f, zt + 0.04, fd, frm)
            nm = max(1, int(round(w / 1.6)))
            for k in range(1, nm):
                m = u0 + w * k / nm
                R(m - 0.04, z0 + f, m + 0.04, z0 + h - f, fd, frm)
        if room_z is None:
            R(u0, z0, u0 + w, z0 + h, d, pane)
        else:
            RS = lambda a, c: (u_start + a, c - room_z)
            Q((P(u0, z0, d), P(u0 + w, z0, d), P(u0 + w, z0 + h, d), P(u0, z0 + h, d)),
              [RS(u0, z0), RS(u0 + w, z0), RS(u0 + w, z0 + h), RS(u0, z0 + h)], pane,
              luvs=[IM(u0, z0), IM(u0 + w, z0), IM(u0 + w, z0 + h), IM(u0, z0 + h)])
    return ch


def quad_facing(b, pts, outward, mat):
    """Adds a quad/face whose normal points along `outward` (winding fixed up)."""
    p = [Vector(q) for q in pts]
    nrm = (p[1] - p[0]).cross(p[2] - p[0])
    if nrm.dot(Vector(outward)) < 0:
        p = p[::-1]
    b.face([tuple(q) for q in p], mat)


def polygon_roof(b, ring, z, mat):
    """Flat roof face over a (possibly concave) CCW ring."""
    b.face([(x, y, z) for (x, y) in ring], mat)


def roof_edge(b, ring, z, h, mat):
    """Thin roof fascia band (metal flashing) at the top of the walls."""
    n = len(ring)
    for i in range(n):
        a, c = Vector((*ring[i], 0)), Vector((*ring[(i + 1) % n], 0))
        b.quad((a.x, a.y, z - h), (c.x, c.y, z - h), (c.x, c.y, z), (a.x, a.y, z), mat)


def oriented_rect(ring):
    """(centre, axis_u, axis_v, half_u, half_v) of a near-rectangular ring (long axis u), or None."""
    if len(ring) != 4:
        return None
    pts = [Vector((p[0], p[1])) for p in ring]
    e = [pts[(i + 1) % 4] - pts[i] for i in range(4)]
    for i in range(4):
        c = abs(e[i].normalized().dot(e[(i + 1) % 4].normalized()))
        if c > 0.08:
            return None
    i = 0 if e[0].length >= e[1].length else 1
    u = e[i].normalized()
    v = Vector((-u.y, u.x))
    centre = sum(pts, Vector((0, 0))) / 4
    hu = max(abs((p - centre).dot(u)) for p in pts)
    hv = max(abs((p - centre).dot(v)) for p in pts)
    return centre, u, v, hu, hv


def gable_roof(b, rect, z, pitch_deg, overhang, roof_mat, gable_mat, fascia_mat='wood_door'):
    """Pitched roof over an oriented rectangle: ridge along u, gable walls at the ends."""
    c, u, v, hu, hv = rect
    rise = math.tan(math.radians(pitch_deg)) * hv
    U = lambda a, bb, zz: (c.x + u.x * a + v.x * bb, c.y + u.y * a + v.y * bb, zz)
    ho, vo = hu + overhang, hv + overhang
    zo = z - math.tan(math.radians(pitch_deg)) * overhang
    zr = z + rise
    # roof planes (both sides), eave overhang included
    b.quad(U(-ho, -vo, zo), U(ho, -vo, zo), U(ho, 0, zr), U(-ho, 0, zr), roof_mat)
    b.quad(U(ho, vo, zo), U(-ho, vo, zo), U(-ho, 0, zr), U(ho, 0, zr), roof_mat)
    # undersides of the overhang
    b.quad(U(ho, -vo, zo), U(-ho, -vo, zo), U(-hu, -hv, z), U(hu, -hv, z), fascia_mat)
    b.quad(U(-ho, vo, zo), U(ho, vo, zo), U(hu, hv, z), U(-hu, hv, z), fascia_mat)
    # gable triangles (walls)
    b.face([U(-hu, hv, z), U(-hu, -hv, z), U(-hu, 0, zr)], gable_mat)
    b.face([U(hu, -hv, z), U(hu, hv, z), U(hu, 0, zr)], gable_mat)
    # verge boards along the sloped gable edges, and fascia boards along the eaves
    for s in (-1, 1):
        out = (u.x * s, u.y * s, 0)
        for side in (-1, 1):
            quad_facing(b, [U(s * ho, side * vo, zo - 0.18), U(s * ho, 0, zr - 0.18), U(s * ho, 0, zr), U(s * ho, side * vo, zo)], out, fascia_mat)
        quad_facing(b, [U(-ho, s * vo, zo - 0.18), U(ho, s * vo, zo - 0.18), U(ho, s * vo, zo), U(-ho, s * vo, zo)], (v.x * s, v.y * s, 0), fascia_mat)
    return zr


def bays(length, bay, margin):
    """Centres of evenly spaced bays along a wall (none if it is too short)."""
    usable = length - 2 * margin
    if usable < bay * 0.6:
        return []
    n = max(1, int(usable / bay))
    step = usable / n
    return [margin + step * (k + 0.5) for k in range(n)]
