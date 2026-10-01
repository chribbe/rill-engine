"""Street surfaces from centrelines: signed distance fields + marching squares.

Every surface class (road, parking, kerb, pavement, path) is a signed distance
field on one regular grid. Junction kerbs get round fillets (smooth union
between different streets), classes are made exclusive by priority
(A minus B = max(dA, -dB)), and each class is contoured with marching squares
(sub-cell accurate edges, shared edge points identical across classes). Interior
cells are emitted as row runs, so meshes stay small after a limited dissolve.
"""

import math

import numpy as np


class Grid:
    def __init__(self, x0, y0, x1, y1, res):
        self.x0, self.y0, self.res = x0, y0, res
        self.nx = int(math.ceil((x1 - x0) / res))
        self.ny = int(math.ceil((y1 - y0) / res))
        self.xs = x0 + np.arange(self.nx + 1) * res
        self.ys = y0 + np.arange(self.ny + 1) * res

    def full(self, v=1e9):
        return np.full((self.ny + 1, self.nx + 1), v, dtype=np.float64)

    def window(self, xmin, ymin, xmax, ymax):
        i0 = max(0, int((xmin - self.x0) / self.res))
        i1 = min(self.nx, int((xmax - self.x0) / self.res) + 1)
        j0 = max(0, int((ymin - self.y0) / self.res))
        j1 = min(self.ny, int((ymax - self.y0) / self.res) + 1)
        return i0, i1, j0, j1


def segment_dist(X, Y, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    if L2 < 1e-12:
        return np.hypot(X - ax, Y - ay)
    t = np.clip(((X - ax) * dx + (Y - ay) * dy) / L2, 0.0, 1.0)
    return np.hypot(X - (ax + t * dx), Y - (ay + t * dy))


def polyline_field(g, pts, half):
    """Exact distance - half width for one polyline (capsule chain), on its window only."""
    f = None
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    m = half + 2.0
    i0, i1, j0, j1 = g.window(min(xs) - m, min(ys) - m, max(xs) + m, max(ys) + m)
    if i1 <= i0 or j1 <= j0:
        return None
    X, Y = np.meshgrid(g.xs[i0:i1 + 1], g.ys[j0:j1 + 1])
    d = np.full(X.shape, 1e9)
    for a, b in zip(pts, pts[1:]):
        d = np.minimum(d, segment_dist(X, Y, a[0], a[1], b[0], b[1]))
    return (i0, i1, j0, j1), d - half


def smin(a, b, k):
    if k <= 0:
        return np.minimum(a, b)
    h = np.maximum(k - np.abs(a - b), 0.0) / k
    return np.minimum(a, b) - h * h * k * 0.25


def union_polylines(g, items, fillet=0.0, base=None):
    """items: [(pts, half)] -> field. Different items blend with a round fillet."""
    f = g.full() if base is None else base
    for pts, half in items:
        r = polyline_field(g, pts, half)
        if r is None:
            continue
        (i0, i1, j0, j1), d = r
        f[j0:j1 + 1, i0:i1 + 1] = smin(f[j0:j1 + 1, i0:i1 + 1], d, fillet)
    return f


def polygon_field(g, rings, base=None, pad=2.0):
    """Signed distance to polygons (negative inside), union over rings."""
    f = g.full() if base is None else base
    for ring in rings:
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        i0, i1, j0, j1 = g.window(min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad)
        if i1 <= i0 or j1 <= j0:
            continue
        X, Y = np.meshgrid(g.xs[i0:i1 + 1], g.ys[j0:j1 + 1])
        d = np.full(X.shape, 1e9)
        inside = np.zeros(X.shape, dtype=bool)
        n = len(ring)
        for k in range(n):
            ax, ay = ring[k]
            bx, by = ring[(k + 1) % n]
            d = np.minimum(d, segment_dist(X, Y, ax, ay, bx, by))
            if ay != by:
                cond = (ay > Y) != (by > Y)
                xc = ax + (Y - ay) / (by - ay) * (bx - ax)
                inside ^= cond & (X < xc)
        s = np.where(inside, -d, d)
        f[j0:j1 + 1, i0:i1 + 1] = np.minimum(f[j0:j1 + 1, i0:i1 + 1], s)
    return f


def subtract(a, b):
    """Region A minus region B."""
    return np.maximum(a, -b)


def march(g, f):
    """Marching squares of f < 0. Returns (polygons, boundary segments).

    Polygons are CCW lists of (x, y); interior cells are merged into row runs.
    Boundary segments are oriented with the inside on the left.
    """
    res, x0, y0 = g.res, g.x0, g.y0
    inside = f < 0
    c00 = inside[:-1, :-1]
    c10 = inside[:-1, 1:]
    c11 = inside[1:, 1:]
    c01 = inside[1:, :-1]
    case = c00.astype(np.uint8) | (c10.astype(np.uint8) << 1) | (c11.astype(np.uint8) << 2) | (c01.astype(np.uint8) << 3)
    polys = []
    # interior row runs
    full = case == 15
    for j in range(g.ny):
        row = full[j]
        if not row.any():
            continue
        idx = np.flatnonzero(row)
        starts = idx[np.r_[True, np.diff(idx) > 1]]
        ends = idx[np.r_[np.diff(idx) > 1, True]] + 1
        ya, yb = y0 + j * res, y0 + (j + 1) * res
        for s, e in zip(starts, ends):
            xa, xb = x0 + s * res, x0 + e * res
            polys.append([(xa, ya), (xb, ya), (xb, yb), (xa, yb)])
    segs = []
    mixed = np.argwhere((case > 0) & (case < 15))
    for j, i in mixed:
        v = (f[j, i], f[j, i + 1], f[j + 1, i + 1], f[j + 1, i])
        P = ((x0 + i * res, y0 + j * res), (x0 + (i + 1) * res, y0 + j * res),
             (x0 + (i + 1) * res, y0 + (j + 1) * res), (x0 + i * res, y0 + (j + 1) * res))

        # Edge crossing, always interpolated from the lower to the higher grid
        # coordinate so neighbouring cells produce bit-identical points.
        def cross(a, b):
            ka, kb = (a, b) if (P[a][0], P[a][1]) <= (P[b][0], P[b][1]) else (b, a)
            fa, fb = v[ka], v[kb]
            t = fa / (fa - fb)
            return (P[ka][0] + (P[kb][0] - P[ka][0]) * t, P[ka][1] + (P[kb][1] - P[ka][1]) * t)

        ins = [v[k] < 0 for k in range(4)]
        cs = int(case[j, i])
        centre_in = (v[0] + v[1] + v[2] + v[3]) * 0.25 < 0
        pieces = []
        if cs in (5, 10) and not centre_in:
            # saddle with an outside centre: two separate corner pieces
            for k in range(4):
                if ins[k]:
                    pieces.append([cross((k + 3) % 4, k), P[k], cross(k, (k + 1) % 4)])
        else:
            poly = []
            for k in range(4):
                if ins[k]:
                    poly.append(P[k])
                if ins[k] != ins[(k + 1) % 4]:
                    poly.append(cross(k, (k + 1) % 4))
            pieces.append(poly)
        for poly in pieces:
            if len(poly) >= 3:
                polys.append(poly)
        # Boundary segments (inside on the left): from the crossing where the CCW
        # walk leaves the region to the one where it re-enters.
        E = {k: cross(k, (k + 1) % 4) for k in range(4) if ins[k] != ins[(k + 1) % 4]}
        if cs in (5, 10):
            if cs == 5:   # corners 0 and 2 inside
                pairs = [(0, 3), (2, 1)] if not centre_in else [(0, 1), (2, 3)]
            else:         # corners 1 and 3 inside
                pairs = [(1, 0), (3, 2)] if not centre_in else [(1, 2), (3, 0)]
            for ea, eb in pairs:
                segs.append((E[ea], E[eb]))
        else:
            out_e = [k for k in E if ins[k]]        # inside -> outside along the CCW walk
            in_e = [k for k in E if not ins[k]]     # outside -> inside
            segs.append((E[out_e[0]], E[in_e[0]]))
    return polys, segs


def sample(g, f, x, y):
    """Bilinear sample of a field at world (x, y)."""
    fx = (x - g.x0) / g.res
    fy = (y - g.y0) / g.res
    i = int(min(max(math.floor(fx), 0), g.nx - 1))
    j = int(min(max(math.floor(fy), 0), g.ny - 1))
    tx, ty = fx - i, fy - j
    return (f[j, i] * (1 - tx) * (1 - ty) + f[j, i + 1] * tx * (1 - ty) + f[j + 1, i] * (1 - tx) * ty + f[j + 1, i + 1] * tx * ty)


def chain_segments(segs, tol=1e-4):
    """Oriented boundary segments -> polylines (open chains first, then closed loops
    whose last point repeats the first)."""
    key = lambda p: (round(p[0] / tol), round(p[1] / tol))
    by_start = {}
    ends = set()
    for i, (a, b) in enumerate(segs):
        by_start.setdefault(key(a), []).append(i)
        ends.add(key(b))
    used = [False] * len(segs)

    def walk(i):
        chain = [segs[i][0], segs[i][1]]
        used[i] = True
        while True:
            nxt = [j for j in by_start.get(key(chain[-1]), []) if not used[j]]
            if not nxt:
                return chain
            used[nxt[0]] = True
            chain.append(segs[nxt[0]][1])
            if key(chain[-1]) == key(chain[0]):
                return chain

    chains = [walk(i) for i, (a, _b) in enumerate(segs) if key(a) not in ends and not used[i]]
    chains += [walk(i) for i in range(len(segs)) if not used[i]]
    return chains


def rdp(pts, tol):
    """Douglas-Peucker simplification of an open polyline."""
    if len(pts) < 3:
        return list(pts)
    ax, ay = pts[0]
    bx, by = pts[-1]
    dx, dy = bx - ax, by - ay
    ln = math.hypot(dx, dy)
    best, bi = -1.0, 0
    for i in range(1, len(pts) - 1):
        px, py = pts[i][0] - ax, pts[i][1] - ay
        d = math.hypot(px, py) if ln < 1e-9 else abs(dx * py - dy * px) / ln
        if d > best:
            best, bi = d, i
    if best <= tol:
        return [pts[0], pts[-1]]
    return rdp(pts[:bi + 1], tol)[:-1] + rdp(pts[bi:], tol)


def _area2(pts):
    return sum(pts[i - 1][0] * pts[i][1] - pts[i][0] * pts[i - 1][1] for i in range(len(pts))) / 2.0


def contour_loops(g, f, tol=0.03):
    """Closed, simplified boundary loops of f < 0 (interior on the left: outer
    boundaries CCW, holes CW). No repeated closing point."""
    _polys, segs = march(g, f)
    out = []
    for ch in chain_segments(segs):
        if len(ch) < 4 or math.dist(ch[0], ch[-1]) > 1e-3:
            continue
        ring = ch[:-1]
        far = max(range(len(ring)), key=lambda i: math.dist(ring[0], ring[i]))
        loop = rdp(ring[:far + 1], tol)[:-1] + rdp(ring[far:] + [ring[0]], tol)[:-1]
        if len(loop) >= 3 and abs(_area2(loop)) > 0.01:
            out.append(loop)
    return out


def offset_loop(loop, d, max_miter=3.0):
    """Offsets a loop by d towards its interior (left side), mitred corners."""
    n = len(loop)
    out = []
    for i in range(n):
        p0, p1, p2 = loop[i - 1], loop[i], loop[(i + 1) % n]
        t0 = (p1[0] - p0[0], p1[1] - p0[1])
        t1 = (p2[0] - p1[0], p2[1] - p1[1])
        l0, l1 = math.hypot(*t0) or 1.0, math.hypot(*t1) or 1.0
        n0 = (-t0[1] / l0, t0[0] / l0)
        n1 = (-t1[1] / l1, t1[0] / l1)
        mx, my = n0[0] + n1[0], n0[1] + n1[1]
        ml = math.hypot(mx, my)
        if ml < 1e-6:
            mx, my = n1
        else:
            mx, my = mx / ml, my / ml
        k = d / max(mx * n1[0] + my * n1[1], 1.0 / max_miter)
        out.append((p1[0] + mx * k, p1[1] + my * k))
    return out
