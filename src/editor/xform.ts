import { mat4, quat, vec3, type Mat4 } from 'wgpu-matrix';
import type { Transform } from '../engine/scene/mapformat';

/**
 * Transform maths for editor operations. Entities store world-space TRS
 * (position, quaternion, scale); edits are expressed as a world-space delta
 * matrix D applied to every affected entity: M' = D · M (descendants follow
 * their parent by receiving the same D).
 *
 * Euler angles (inspector, tools) are degrees, applied Y (yaw) then X (pitch)
 * then Z (roll): q = qY · qX · qZ. Standard right-handed: +Y rotation turns
 * counter-clockwise seen from above.
 */

export type V3 = [number, number, number];
export type Q4 = [number, number, number, number];

const DEG = Math.PI / 180;

export function toMatrix(t: Transform): Mat4 {
  const m = mat4.translation(t.position);
  if (t.rotation) mat4.multiply(m, mat4.fromQuat(t.rotation), m);
  if (t.scale) mat4.scale(m, t.scale, m);
  return m;
}

/** Splits an affine matrix into TRS (shear is dropped). Omits identity rotation / scale. */
export function fromMatrix(m: Mat4, keepRotation = false, keepScale = false): Transform {
  const sx = Math.hypot(m[0], m[1], m[2]), sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10]);
  const r = mat4.create(m[0] / sx, m[1] / sx, m[2] / sx, 0, m[4] / sy, m[5] / sy, m[6] / sy, 0, m[8] / sz, m[9] / sz, m[10] / sz, 0, 0, 0, 0, 1);
  // A mirrored basis: fold the reflection into the scale.
  let fx = sx;
  if (mat4.determinant(r) < 0) {
    fx = -sx;
    r[0] = -r[0]; r[1] = -r[1]; r[2] = -r[2];
  }
  const q = quat.fromMat(r);
  if (q[3] < 0) quat.scale(q, -1, q);
  const t: Transform = { position: [clean(m[12]), clean(m[13]), clean(m[14])] };
  const rot: Q4 = [cleanQ(q[0]), cleanQ(q[1]), cleanQ(q[2]), cleanQ(q[3])];
  if (keepRotation || Math.abs(rot[3]) < 1 - 1e-9) t.rotation = rot;
  const sc: V3 = [cleanS(fx), cleanS(sy), cleanS(sz)];
  if (keepScale || sc.some((v) => Math.abs(v - 1) > 1e-6)) t.scale = sc;
  return t;
}

const clean = (v: number) => Math.round(v * 1e5) / 1e5;
const cleanQ = (v: number) => Math.round(v * 1e7) / 1e7;
const cleanS = (v: number) => Math.round(v * 1e5) / 1e5;

export function applyDelta(D: Mat4, t: Transform): Transform {
  return fromMatrix(mat4.multiply(D, toMatrix(t)), !!t.rotation, !!t.scale);
}

/** Rotation by quaternion `q` about world point `p`. */
export function rotationAbout(q: ArrayLike<number>, p: ArrayLike<number>): Mat4 {
  const m = mat4.translation(p);
  mat4.multiply(m, mat4.fromQuat(q), m);
  return mat4.translate(m, [-p[0], -p[1], -p[2]], m);
}

/** Scaling about world point `p` along the axes of rotation `q` (identity = world axes). */
export function scaleAbout(s: ArrayLike<number>, p: ArrayLike<number>, q: ArrayLike<number> = [0, 0, 0, 1]): Mat4 {
  const R = mat4.fromQuat(q);
  const m = mat4.translation(p);
  mat4.multiply(m, R, m);
  mat4.scale(m, s, m);
  mat4.multiply(m, mat4.transpose(R), m);
  return mat4.translate(m, [-p[0], -p[1], -p[2]], m);
}

export function eulerToQuat(e: ArrayLike<number>): Q4 {
  const qx = quat.fromAxisAngle([1, 0, 0], e[0] * DEG), qy = quat.fromAxisAngle([0, 1, 0], e[1] * DEG), qz = quat.fromAxisAngle([0, 0, 1], e[2] * DEG);
  // Hamilton product: R(a·b) = R(a)·R(b), so this is Ry · Rx · Rz.
  const q = quat.multiply(quat.multiply(qy, qx), qz);
  if (q[3] < 0) quat.scale(q, -1, q);
  return [q[0], q[1], q[2], q[3]];
}

/** Inverse of `eulerToQuat` (degrees, Y-X-Z). */
export function quatToEuler(qq: ArrayLike<number> | undefined): V3 {
  if (!qq) return [0, 0, 0];
  const m = mat4.fromQuat(qq);
  // R = Ry · Rx · Rz: m[9] = -sin(x) (row 1, column 2 in column-major storage).
  const sx = -m[9];
  const x = Math.asin(Math.max(-1, Math.min(1, sx)));
  let y: number, z: number;
  if (Math.abs(sx) < 0.99999) {
    y = Math.atan2(m[8], m[10]);
    z = Math.atan2(m[1], m[5]);
  } else {
    y = Math.atan2(-m[2], m[0]);
    z = 0;
  }
  const r = (v: number) => Math.round((v / DEG) * 1e4) / 1e4 + 0;
  return [r(x), r(y), r(z)];
}

export function axisAngleQuat(axis: ArrayLike<number>, deg: number): Q4 {
  const q = quat.fromAxisAngle(vec3.normalize(vec3.fromValues(axis[0], axis[1], axis[2])), deg * DEG);
  return [q[0], q[1], q[2], q[3]];
}

export function snap(v: number, step: number) {
  return step > 0 ? Math.round(v / step) * step : v;
}
