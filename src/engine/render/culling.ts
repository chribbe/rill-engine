import type { Mat4 } from 'wgpu-matrix';

/** Plane as (nx, ny, nz, d): inside when n.p + d >= 0. */
export type Plane = [number, number, number, number];

/**
 * Gribb/Hartmann plane extraction for WebGPU clip space (x,y in [-w,w], z in [0,w]).
 * With reverse-Z the "near" plane is z <= w and "far" is z >= 0.
 */
export function extractPlanes(m: Mat4, opts: { near: boolean; far: boolean; zeroToOne: boolean; reverseZ?: boolean }): Plane[] {
  // Column-major: row r = (m[r], m[4+r], m[8+r], m[12+r])
  const row = (r: number): Plane => [m[r], m[4 + r], m[8 + r], m[12 + r]];
  const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
  const add = (a: Plane, b: Plane): Plane => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
  const sub = (a: Plane, b: Plane): Plane => [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]];
  const planes: Plane[] = [add(r3, r0), sub(r3, r0), add(r3, r1), sub(r3, r1)];
  const zMin = r2; // z >= 0
  const zMax = sub(r3, r2); // z <= w
  if (opts.reverseZ) {
    if (opts.near) planes.push(zMax);
    if (opts.far) planes.push(zMin);
  } else {
    if (opts.near) planes.push(zMin);
    if (opts.far) planes.push(zMax);
  }
  for (const p of planes) {
    const l = Math.hypot(p[0], p[1], p[2]);
    p[0] /= l; p[1] /= l; p[2] /= l; p[3] /= l;
  }
  return planes;
}

/** AABB vs planes (p-vertex test). */
export function aabbVisible(planes: Plane[], min: ArrayLike<number>, max: ArrayLike<number>): boolean {
  for (let i = 0; i < planes.length; i++) {
    const p = planes[i];
    const x = p[0] >= 0 ? max[0] : min[0];
    const y = p[1] >= 0 ? max[1] : min[1];
    const z = p[2] >= 0 ? max[2] : min[2];
    if (p[0] * x + p[1] * y + p[2] * z + p[3] < 0) return false;
  }
  return true;
}

/** Transforms a local AABB by a column-major affine matrix (Arvo's method). */
export function transformAabb(m: ArrayLike<number>, min: ArrayLike<number>, max: ArrayLike<number>, outMin: Float32Array | number[], outMax: Float32Array | number[]) {
  for (let i = 0; i < 3; i++) {
    let lo = m[12 + i], hi = m[12 + i];
    for (let j = 0; j < 3; j++) {
      const a = m[j * 4 + i] * min[j];
      const b = m[j * 4 + i] * max[j];
      lo += Math.min(a, b);
      hi += Math.max(a, b);
    }
    outMin[i] = lo;
    outMax[i] = hi;
  }
}
