/**
 * Analytic shape queries for dynamic things that are not in the static
 * collision soup (characters, hitboxes). Allocation-free.
 */

/**
 * Ray (origin o, unit direction d) against a capsule (segment a-b, radius r):
 * distance to the first hit, or -1. Inigo Quilez's capsule intersection.
 */
export function rayCapsule(o: ArrayLike<number>, d: ArrayLike<number>, a: ArrayLike<number>, b: ArrayLike<number>, r: number): number {
  const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
  const oax = o[0] - a[0], oay = o[1] - a[1], oaz = o[2] - a[2];
  const baba = bax * bax + bay * bay + baz * baz;
  const bard = bax * d[0] + bay * d[1] + baz * d[2];
  const baoa = bax * oax + bay * oay + baz * oaz;
  const rdoa = d[0] * oax + d[1] * oay + d[2] * oaz;
  const oaoa = oax * oax + oay * oay + oaz * oaz;
  const A = baba - bard * bard;
  let B = baba * rdoa - baoa * bard;
  let C = baba * oaoa - baoa * baoa - r * r * baba;
  let h = B * B - A * C;
  if (h >= 0 && A > 1e-12) {
    const t = (-B - Math.sqrt(h)) / A;
    const y = baoa + t * bard;
    if (y > 0 && y < baba) return t >= 0 ? t : -1;
    // Caps.
    const cx = y <= 0 ? oax : o[0] - b[0], cy = y <= 0 ? oay : o[1] - b[1], cz = y <= 0 ? oaz : o[2] - b[2];
    B = d[0] * cx + d[1] * cy + d[2] * cz;
    C = cx * cx + cy * cy + cz * cz - r * r;
    h = B * B - C;
    if (h > 0) {
      const t2 = -B - Math.sqrt(h);
      return t2 >= 0 ? t2 : -1;
    }
    return -1;
  }
  // Degenerate (ray parallel to the axis): treat as a sphere at the nearer end.
  const cx = oax, cy = oay, cz = oaz;
  B = d[0] * cx + d[1] * cy + d[2] * cz;
  C = cx * cx + cy * cy + cz * cz - r * r;
  h = B * B - C;
  if (h > 0) {
    const t = -B - Math.sqrt(h);
    return t >= 0 ? t : -1;
  }
  return -1;
}

/** Closest point on segment a-b to p (out). */
export function closestOnSegment(p: ArrayLike<number>, a: ArrayLike<number>, b: ArrayLike<number>, out: [number, number, number]) {
  const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2];
  const l = bx * bx + by * by + bz * bz;
  const t = l > 1e-12 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * bx + (p[1] - a[1]) * by + (p[2] - a[2]) * bz) / l)) : 0;
  out[0] = a[0] + bx * t; out[1] = a[1] + by * t; out[2] = a[2] + bz * t;
  return out;
}

/** Ray against a sphere: distance or -1 (broadphase). */
export function raySphere(o: ArrayLike<number>, d: ArrayLike<number>, c: ArrayLike<number>, r: number): number {
  const ox = o[0] - c[0], oy = o[1] - c[1], oz = o[2] - c[2];
  const b = ox * d[0] + oy * d[1] + oz * d[2];
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const h = b * b - cc;
  if (h < 0) return -1;
  const s = Math.sqrt(h);
  return -b - s >= 0 ? -b - s : -b + s >= 0 ? 0 : -1;
}
