"""Parametric period cars (Stockholm, early 1990s) for map builders.

Fictional lookalikes of the common Swedish cars of the time. Each body is a
loft of cross-sections along the car (x from the rear bumper to the front),
driven by side-profile lines (roof/deck top, beltline, underside) and a plan
width; wheel arches are cut by lifting the underside around the axles.
Greenhouse faces between the beltline and the roof become glass except at the
pillars; the windscreen and rear window are the steep roof-line spans.

Local frame (Blender): x along the car (rear 0 -> front L), y left, z up,
origin on the ground at the car's centre (the builder recentres).
"""

import math

from mathutils import Vector

# name: spec (metres). top/belt/bot/width: piecewise-linear (x, value) lists.
SPECS = {
    # Volvo 240 saloon lookalike: three-box, flat bonnet, upright glass, big bumpers.
    'volta244': dict(
        L=4.79, half=0.855, axles=(1.23, 3.87), r=0.315, track=1.46,
        top=[(0, 0.97), (0.06, 1.0), (1.0, 1.02), (1.52, 1.39), (1.7, 1.425), (2.95, 1.43), (3.05, 1.41), (3.64, 1.0), (4.7, 0.95), (4.79, 0.92)],
        belt=[(0, 0.93), (0.9, 0.97), (3.64, 0.98), (4.79, 0.9)],
        bot=[(0, 0.36), (0.3, 0.3), (4.5, 0.3), (4.79, 0.38)],
        width=[(0, 0.83), (0.25, 0.85), (4.55, 0.855), (4.79, 0.825)],
        cabin=(1.0, 3.64), glass_top=[(1.03, 1.5), (3.06, 3.62)],
        pillars=[(1.0, 1.62), (2.32, 2.44), (3.46, 3.64)],
        tumble=0.15, bumper=(0.16, 0.36, 0.56), lights='square',
    ),
    # Volvo 240 estate lookalike: same nose, long roof, near-vertical tailgate.
    'volta245': dict(
        L=4.79, half=0.855, axles=(1.23, 3.87), r=0.315, track=1.46,
        top=[(0, 1.38), (0.05, 1.44), (0.3, 1.46), (2.95, 1.45), (3.05, 1.41), (3.64, 1.0), (4.7, 0.95), (4.79, 0.92)],
        belt=[(0, 0.95), (0.9, 0.97), (3.64, 0.98), (4.79, 0.9)],
        bot=[(0, 0.36), (0.3, 0.3), (4.5, 0.3), (4.79, 0.38)],
        width=[(0, 0.835), (0.25, 0.85), (4.55, 0.855), (4.79, 0.825)],
        cabin=(0.0, 3.64), glass_top=[(3.06, 3.62)], rear_glass=True,
        pillars=[(0.0, 0.12), (0.92, 1.06), (2.32, 2.44), (3.46, 3.64)],
        tumble=0.13, bumper=(0.16, 0.36, 0.56), lights='square',
    ),
    # Volvo 740 saloon lookalike: sharper wedge, raked rear glass, higher deck.
    'volta744': dict(
        L=4.79, half=0.875, axles=(1.12, 3.89), r=0.315, track=1.47,
        top=[(0, 1.0), (0.06, 1.05), (0.95, 1.07), (1.5, 1.38), (1.7, 1.41), (2.95, 1.41), (3.08, 1.38), (3.7, 0.99), (4.72, 0.88), (4.79, 0.84)],
        belt=[(0, 0.97), (0.9, 1.0), (3.7, 0.97), (4.79, 0.84)],
        bot=[(0, 0.38), (0.3, 0.3), (4.5, 0.3), (4.79, 0.36)],
        width=[(0, 0.85), (0.25, 0.87), (4.55, 0.875), (4.79, 0.85)],
        cabin=(0.95, 3.7), glass_top=[(0.98, 1.46), (3.1, 3.68)],
        pillars=[(0.95, 1.5), (2.3, 2.42), (3.5, 3.7)],
        tumble=0.15, bumper=(0.14, 0.34, 0.54), lights='wide',
    ),
    # Saab 900 three-door lookalike: long sloping nose, wraparound windscreen, hatch.
    'saga900': dict(
        L=4.74, half=0.845, axles=(1.17, 3.69), r=0.31, track=1.43,
        top=[(0, 0.96), (0.05, 1.02), (0.3, 1.05), (1.3, 1.38), (1.55, 1.425), (2.6, 1.43), (2.8, 1.4), (3.6, 0.96), (4.3, 0.84), (4.62, 0.74), (4.74, 0.66)],
        belt=[(0, 0.95), (0.8, 0.98), (3.6, 0.92), (4.74, 0.64)],
        bot=[(0, 0.4), (0.3, 0.3), (4.4, 0.3), (4.74, 0.36)],
        width=[(0, 0.8), (0.35, 0.845), (4.2, 0.845), (4.55, 0.82), (4.74, 0.74)],
        cabin=(0.3, 3.6), glass_top=[(0.34, 1.28), (2.84, 3.58)],
        pillars=[(0.3, 1.22), (2.1, 2.22), (3.5, 3.6)],
        tumble=0.2, bumper=(0.13, 0.33, 0.52), lights='saab',
    ),
    # VW Golf II lookalike: two-box hatch.
    'gulf': dict(
        L=3.99, half=0.835, axles=(0.77, 3.24), r=0.29, track=1.42,
        top=[(0, 1.0), (0.04, 1.06), (0.16, 1.37), (0.3, 1.41), (2.38, 1.41), (2.5, 1.37), (3.12, 0.97), (3.92, 0.86), (3.99, 0.82)],
        belt=[(0, 0.95), (0.6, 0.97), (3.12, 0.95), (3.99, 0.84)],
        bot=[(0, 0.36), (0.2, 0.3), (3.8, 0.3), (3.99, 0.36)],
        width=[(0, 0.8), (0.2, 0.83), (3.75, 0.835), (3.99, 0.8)],
        cabin=(0.04, 3.12), glass_top=[(2.52, 3.1)], rear_glass=True,
        pillars=[(0.04, 0.62), (1.5, 1.62), (2.96, 3.12)],
        tumble=0.15, bumper=(0.12, 0.33, 0.5), lights='round',
    ),
}

PAINTS = {
    'red': '#8a1c16', 'darkblue': '#1b2a44', 'white': '#d9d8d0', 'silver': '#8b9094', 'beige': '#b3a27e',
    'green': '#22402f', 'black': '#141516', 'brown': '#4a3022', 'lightblue': '#5d7a96', 'yellow': '#c9a227',
}


def lerp_line(line, x):
    if x <= line[0][0]:
        return line[0][1]
    for (x0, v0), (x1, v1) in zip(line, line[1:]):
        if x <= x1:
            t = (x - x0) / (x1 - x0) if x1 > x0 else 0.0
            return v0 + (v1 - v0) * t
    return line[-1][1]


def build_car(b, spec):
    """Adds the car to MeshBuilder `b` (car centred on the origin, front towards +x)."""
    Lc = spec['L']
    r = spec['r']
    ra = r + 0.055
    tum = spec['tumble']
    cab0, cab1 = spec['cabin']

    xs = set([0.0, Lc])
    k = 0.0
    while k < Lc:
        xs.add(round(k, 4))
        k += 0.12
    for ax in spec['axles']:
        for i in range(-12, 13):
            xs.add(round(ax + ra * i / 12, 4))
    for (a, c) in spec['pillars'] + spec.get('glass_top', []):
        xs.update([a, c])
    for (x, _z) in spec['top']:
        xs.add(x)
    xs.update([cab0, cab1])
    xs = sorted(x for x in xs if 0.0 <= x <= Lc)
    # dedupe near-coincident stations
    st = [xs[0]]
    for x in xs[1:]:
        if x - st[-1] > 0.01:
            st.append(x)
    xs = st

    def section(x):
        zt = lerp_line(spec['top'], x)
        zbelt = min(lerp_line(spec['belt'], x), zt - 0.005)
        zb = lerp_line(spec['bot'], x)
        for ax in spec['axles']:
            dx = x - ax
            if abs(dx) < ra:
                zb = max(zb, r + math.sqrt(ra * ra - dx * dx))
        w = lerp_line(spec['width'], x)
        in_cab = cab0 - 1e-4 <= x <= cab1 + 1e-4
        gh = zt - zbelt
        wr = w - tum * min(1.0, gh / 0.4) if in_cab else w * 0.97
        # half section (y >= 0), bottom centre -> roof centre
        return [
            (0.0, zb),
            (w * 0.9, zb),
            (w, min(zb + 0.1, zbelt - 0.02)),
            (w, zbelt - 0.05),
            (w * 0.99, zbelt),
            (wr, zt - min(0.05, gh * 0.4)),
            (wr - 0.07, zt),
            (0.0, zt),
        ]

    secs = [section(x) for x in xs]
    N = len(secs[0])

    def glass_side(x0, x1):
        xm = (x0 + x1) / 2
        if not (cab0 <= xm <= cab1):
            return False
        return not any(a <= xm <= c for (a, c) in spec['pillars'])

    def glass_top(x0, x1):
        xm = (x0 + x1) / 2
        return any(a <= xm <= c for (a, c) in spec.get('glass_top', []))

    for i in range(len(xs) - 1):
        x0, x1 = xs[i], xs[i + 1]
        s0, s1 = secs[i], secs[i + 1]
        for side in (1, -1):
            for j in range(N - 1):
                if j == 0:
                    mat = 'car_under'
                elif j == 4:
                    mat = 'car_glass' if glass_side(x0, x1) else 'car_paint'
                elif j == 5:
                    mat = 'car_glass' if glass_top(x0, x1) else 'car_paint'
                elif j == 6:
                    mat = 'car_glass' if glass_top(x0, x1) else 'car_paint'
                else:
                    mat = 'car_paint'
                a = (x0, s0[j][0] * side, s0[j][1])
                bb = (x1, s1[j][0] * side, s1[j][1])
                c = (x1, s1[j + 1][0] * side, s1[j + 1][1])
                d = (x0, s0[j + 1][0] * side, s0[j + 1][1])
                q = [d, c, bb, a] if side > 0 else [a, bb, c, d]
                # normal check: outward from the car's centre line
                if math.dist(a, d) < 1e-6 and math.dist(bb, c) < 1e-6:
                    continue
                b.face(q, mat)
    # end caps: lower (paint) and upper (glass for estates / hatches) parts
    for (x, sec, sgn) in ((xs[0], secs[0], -1), (xs[-1], secs[-1], 1)):
        lower = [(x, p[0], p[1]) for p in sec[:5]] + [(x, -p[0], p[1]) for p in reversed(sec[1:5])]
        upper = [(x, p[0], p[1]) for p in sec[4:]] + [(x, -p[0], p[1]) for p in reversed(sec[4:-1])]
        for poly, mat in ((lower, 'car_paint'), (upper, 'car_glass' if (sgn < 0 and spec.get('rear_glass')) else 'car_paint')):
            pts = poly if sgn > 0 else poly[::-1]
            # winding: CCW seen from outside (+x at the front, -x at the rear)
            n = (Vector(pts[1]) - Vector(pts[0])).cross(Vector(pts[2]) - Vector(pts[0]))
            if n.x * sgn < 0:
                pts = pts[::-1]
            b.face(pts, mat)

    # side rubbing strips and door shut lines (thin dark quads just proud of the side)
    zs0, zs1 = spec['bumper'][1] + 0.12, spec['bumper'][1] + 0.18
    for i in range(len(xs) - 1):
        x0, x1 = xs[i], xs[i + 1]
        if x0 < 0.3 or x1 > Lc - 0.3:
            continue
        if any(abs((x0 + x1) / 2 - ax) < ra for ax in spec['axles']):
            continue
        for side in (1, -1):
            w0, w1 = secs[i][2][0] + 0.006, secs[i + 1][2][0] + 0.006
            q = [(x0, w0 * side, zs0), (x1, w1 * side, zs0), (x1, w1 * side, zs1), (x0, w0 * side, zs1)]
            b.face(q[::-1] if side > 0 else q, 'car_trim')
    cuts = [spec['pillars'][-1][0] + 0.02]                  # front door leading edge (A pillar)
    if len(spec['pillars']) > 2:
        cuts.append((spec['pillars'][-2][0] + spec['pillars'][-2][1]) / 2)   # B pillar
    if len(spec['pillars']) > 3 or spec.get('rear_glass'):
        cuts.append(spec['pillars'][-3][1] - 0.03)          # rear door trailing edge
    for xc in cuts:
        i = min(range(len(xs)), key=lambda k: abs(xs[k] - xc))
        sec = secs[i]
        for side in (1, -1):
            w = sec[3][0] + 0.004
            zlo, zhi = sec[2][1] + 0.02, sec[4][1]
            q = [(xc - 0.006, w * side, zlo), (xc + 0.006, w * side, zlo), (xc + 0.006, w * side, zhi), (xc - 0.006, w * side, zhi)]
            b.face(q[::-1] if side > 0 else q, 'car_trim')

    # bumpers (black rubber / aluminium-capped boxes), wrapping the corners
    bd, bz0, bz1 = spec['bumper']
    w = lerp_line(spec['width'], 0.2) + 0.03
    for (xa, xb) in ((-bd, 0.25), (Lc - 0.25, Lc + bd)):
        b.box(xa, xb, -w, w, bz0, bz1, 'car_trim')
        b.box(xa + 0.02 if xa < 0 else xa, xb - 0.02 if xb > Lc else xb, -w + 0.01, w - 0.01, bz1 - 0.05, bz1 + 0.005, 'car_chrome')

    # lights, grille, plates
    zf = lerp_line(spec['belt'], Lc)
    wf = lerp_line(spec['width'], Lc)
    xf = Lc + 0.004
    lights = spec['lights']
    if lights == 'square':
        hl = [(0.5, 0.2, 0.2)]          # (centre y, width, height)
        grille = (0.33, 0.17)
    elif lights == 'wide':
        hl = [(0.52, 0.3, 0.14)]
        grille = (0.3, 0.13)
    elif lights == 'saab':
        hl = [(0.5, 0.28, 0.12)]
        grille = (0.24, 0.1)
    else:
        hl = [(0.55, 0.18, 0.18)]
        grille = (0.38, 0.12)
    zc = zf - 0.13
    for (yc, hw, hh) in hl:
        for s in (1, -1):
            y0, y1 = s * (yc * wf / 0.85 - hw / 2), s * (yc * wf / 0.85 + hw / 2)
            ya, yb = (y0, y1) if s > 0 else (y1, y0)
            b.quad((xf, ya, zc - hh / 2), (xf, yb, zc - hh / 2), (xf, yb, zc + hh / 2), (xf, ya, zc + hh / 2), 'car_headlight')
    gw, gh = grille
    b.quad((xf, -gw, zc - gh / 2), (xf, gw, zc - gh / 2), (xf, gw, zc + gh / 2), (xf, -gw, zc + gh / 2), 'car_grille')
    zr = lerp_line(spec['belt'], 0.0) - 0.15
    wr_ = lerp_line(spec['width'], 0.0)
    xr = -0.004
    for s in (1, -1):
        y0, y1 = s * (wr_ - 0.06), s * (wr_ - 0.36)
        ya, yb = (y1, y0) if s > 0 else (y0, y1)
        b.quad((xr, yb, zr - 0.09), (xr, ya, zr - 0.09), (xr, ya, zr + 0.09), (xr, yb, zr + 0.09), 'car_taillight')

    # wheels: tyre, sidewall, hub cap
    for ax in spec['axles']:
        for s in (1, -1):
            yo, yi = s * (spec['track'] / 2 + 0.095), s * (spec['track'] / 2 - 0.095)
            b.tube((ax, yi, r), (ax, yo, r), r, r, 'car_tyre', sides=16, caps=False)
            ring_o = [(ax + r * math.cos(2 * math.pi * i / 16), yo, r + r * math.sin(2 * math.pi * i / 16)) for i in range(16)]
            ring_h = [(ax + r * 0.62 * math.cos(2 * math.pi * i / 16), yo + s * 0.012, r + r * 0.62 * math.sin(2 * math.pi * i / 16)) for i in range(16)]
            for i in range(16):
                i2 = (i + 1) % 16
                q = [ring_o[i], ring_o[i2], ring_h[i2], ring_h[i]]
                b.face(q if s < 0 else q[::-1], 'car_tyre')
            b.face(ring_h if s < 0 else ring_h[::-1], 'car_hub')

    # mirrors
    xm = cab1 - 0.08
    zm = lerp_line(spec['belt'], xm) + 0.12
    wm = lerp_line(spec['width'], xm)
    for s in (1, -1):
        b.box(xm - 0.07, xm + 0.04, s * wm if s > 0 else -wm - 0.13, wm + 0.13 if s > 0 else -wm, zm - 0.06, zm + 0.06, 'car_trim')


def plate_positions(spec):
    """(front centre, rear centre) of the licence plates in the car frame (x, y, z)."""
    bd, bz0, bz1 = spec['bumper']
    zc = (bz0 + bz1) / 2
    return (spec['L'] + bd + 0.006, 0.0, zc), (-bd - 0.006, 0.0, zc)
