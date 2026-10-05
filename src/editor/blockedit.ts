import { mat4, vec3, type Mat4 } from 'wgpu-matrix';
import { blockExtent, FACE_AXIS } from '../engine/scene/blocks';
import type { BlockObject, Transform } from '../engine/scene/mapformat';
import { transformMatrix } from '../engine/scene/world';
import type { V3 } from './xform';

/**
 * Blockout geometry edits on block entities, as pure functions: face resize
 * (push / pull), box subtraction (openings, hollowing) and face frames for the
 * viewport handles. Blocks are boxes in their own frame (origin at the bottom
 * centre); subtraction works between boxes that share axes (any multiple of 90°
 * apart), which is what grid-based blockout produces.
 */

const EPS = 1e-3;
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const MIN_SIZE = 0.01;

export interface BlockFrame {
  /** Block transform without scale. */
  M: Mat4;
  inv: Mat4;
  size: V3;
  transform: Transform;
}

export function blockFrame(e: BlockObject): BlockFrame {
  const { size, transform } = blockExtent(e);
  const M = transformMatrix(transform);
  return { M, inv: mat4.inverse(M), size, transform };
}

const v3 = (a: ArrayLike<number>): V3 => [a[0], a[1], a[2]];

/** Local axis k of the block in world space (unit). */
export function blockAxis(f: BlockFrame, k: number): V3 {
  return v3(vec3.normalize([f.M[k * 4], f.M[k * 4 + 1], f.M[k * 4 + 2]]));
}

/** World centre and outward normal of a box face ('px' ... 'nz'). */
export function faceFrame(e: BlockObject, face: string): { center: V3; normal: V3; axis: number; sign: number } | null {
  const fa = FACE_AXIS[face];
  if (!fa) return null;
  const f = blockFrame(e);
  const [axis, sign] = fa;
  const c: V3 = [0, f.size[1] / 2, 0];
  c[axis] = axis === 1 ? (sign > 0 ? f.size[1] : 0) : (sign * f.size[axis]) / 2;
  const n = blockAxis(f, axis).map((x) => x * sign) as V3;
  return { center: v3(vec3.transformMat4(c, f.M)), normal: n, axis, sign };
}

/** Moves one face along its outward normal by `d` metres (the opposite face stays). */
export function resizeFace(e: BlockObject, face: string, d: number): { size: V3; transform: Transform } {
  const f = blockFrame(e);
  const [axis, sign] = FACE_AXIS[face];
  const size = [...f.size] as V3;
  const nd = Math.max(MIN_SIZE, size[axis] + d) - size[axis];
  size[axis] += nd;
  // Origin shift in local space: bottom-centre origin.
  const shift: V3 = [0, 0, 0];
  if (axis === 1) shift[1] = sign > 0 ? 0 : -nd;
  else shift[axis] = (sign * nd) / 2;
  const p = vec3.transformMat4(shift, f.M);
  const t: Transform = { position: [r4(p[0]), r4(p[1]), r4(p[2])] };
  if (f.transform.rotation) t.rotation = [...f.transform.rotation] as Transform['rotation'];
  return { size: size.map(r4) as V3, transform: t };
}

/** Local-space AABB of a box block: [min, max]. */
function localBox(size: V3): [V3, V3] {
  return [[-size[0] / 2, 0, -size[2] / 2], [size[0] / 2, size[1], size[2] / 2]];
}

/** The 8 corners of an AABB transformed by M. */
export function boxCorners(min: V3, max: V3, M: Mat4): V3[] {
  const out: V3[] = [];
  for (let i = 0; i < 8; i++) {
    const p: V3 = [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
    out.push(v3(vec3.transformMat4(p, M)));
  }
  return out;
}

export interface Piece {
  /** World bottom-centre position, same rotation as the source block. */
  position: V3;
  size: V3;
  /** Where the piece sits relative to the cut box (for naming): 'ny' below, 'py' above, 'nx' / 'px' / 'nz' / 'pz' beside. */
  side: string;
  volume: number;
}

/**
 * Block minus a box given by its 8 world corners. 'none' when they do not
 * overlap, 'unaligned' when the box is rotated relative to the block (not a
 * multiple of 90°), else the remaining pieces: split along Y first (floors and
 * ceilings span the whole footprint, walls stand on them), then X, then Z.
 */
export function subtractBox(e: BlockObject, cutter: V3[]): Piece[] | 'none' | 'unaligned' {
  const f = blockFrame(e);
  const lc = cutter.map((p) => v3(vec3.transformMat4(p, f.inv)));
  const cmin = [0, 1, 2].map((k) => Math.min(...lc.map((p) => p[k]))) as V3;
  const cmax = [0, 1, 2].map((k) => Math.max(...lc.map((p) => p[k]))) as V3;
  // Aligned: the corners' AABB has the cutter's own volume (edge lengths from the corners).
  const edge = (a: number, b: number) => vec3.distance(cutter[a], cutter[b]);
  const vol = edge(0, 1) * edge(0, 2) * edge(0, 4);
  const aabbVol = (cmax[0] - cmin[0]) * (cmax[1] - cmin[1]) * (cmax[2] - cmin[2]);
  const [bmin, bmax] = localBox(f.size);
  const lo = [0, 1, 2].map((k) => Math.max(bmin[k], cmin[k])) as V3;
  const hi = [0, 1, 2].map((k) => Math.min(bmax[k], cmax[k])) as V3;
  if ([0, 1, 2].some((k) => hi[k] - lo[k] < EPS)) return 'none';
  if (Math.abs(aabbVol - vol) > Math.max(1e-4, vol * 0.01)) return 'unaligned';
  const pieces: Piece[] = [];
  const add = (mn: V3, mx: V3, side: string) => {
    const size: V3 = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
    if (size.some((s) => s < EPS)) return;
    const p = vec3.transformMat4([(mn[0] + mx[0]) / 2, mn[1], (mn[2] + mx[2]) / 2], f.M);
    pieces.push({ position: [r4(p[0]), r4(p[1]), r4(p[2])], size: size.map(r4) as V3, side, volume: size[0] * size[1] * size[2] });
  };
  // Y: below / above, full footprint.
  add(bmin, [bmax[0], lo[1], bmax[2]], 'ny');
  add([bmin[0], hi[1], bmin[2]], bmax, 'py');
  // X: beside, full depth, within the cut's height.
  add([bmin[0], lo[1], bmin[2]], [lo[0], hi[1], bmax[2]], 'nx');
  add([hi[0], lo[1], bmin[2]], [bmax[0], hi[1], bmax[2]], 'px');
  // Z: in front / behind, within the cut's width and height.
  add([lo[0], lo[1], bmin[2]], [hi[0], hi[1], lo[2]], 'nz');
  add([lo[0], lo[1], hi[2]], [hi[0], hi[1], bmax[2]], 'pz');
  return pieces;
}

/**
 * The wall a face belongs to, for openings: the block plus every box block
 * connected to it in the same plane and thickness (the pieces an earlier
 * opening left), in the block's frame. Openings are placed relative to the
 * whole wall, so "a window 0.9 m above the floor" means the same thing on
 * every piece.
 */
export interface WallFrame {
  M: Mat4;
  inv: Mat4;
  /** Face axis and sign (outward). */
  axis: number;
  sign: number;
  /** Horizontal in-plane axis (walls: to the right seen from outside). */
  uAxis: number;
  uSign: number;
  /** Local AABB of the wall. */
  min: V3;
  max: V3;
  ids: string[];
}

export function wallFrame(e: BlockObject, face: string, others: BlockObject[]): WallFrame {
  const f = blockFrame(e);
  const [axis, sign] = FACE_AXIS[face];
  const [bmin, bmax] = localBox(f.size);
  const cand = others.filter((o) => o.id !== e.id && o.block.shape === 'box')
    .map((o) => ({ id: o.id, box: aabbIn(o, f.inv) }))
    .filter((o): o is { id: string; box: [V3, V3] } => !!o.box && Math.abs(o.box[0][axis] - bmin[axis]) < 0.01 && Math.abs(o.box[1][axis] - bmax[axis]) < 0.01);
  const min = [...bmin] as V3, max = [...bmax] as V3;
  const ids = [e.id];
  const boxes: [V3, V3][] = [[bmin, bmax]];
  // Grow the connected component (touching within 1 cm in the plane).
  for (let grew = true; grew;) {
    grew = false;
    for (let i = cand.length - 1; i >= 0; i--) {
      const [mn, mx] = cand[i].box;
      if (!boxes.some(([a, b]) => [0, 1, 2].every((k) => k === axis || (mn[k] <= b[k] + 0.01 && mx[k] >= a[k] - 0.01)))) continue;
      boxes.push(cand[i].box);
      ids.push(cand[i].id);
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], mn[k]); max[k] = Math.max(max[k], mx[k]); }
      cand.splice(i, 1);
      grew = true;
    }
  }
  // Right as seen from outside: cross(up, n). n = +Z -> +X, -Z -> -X, +X -> -Z, -X -> +Z.
  const uAxis = axis === 1 ? 0 : axis === 2 ? 0 : 2;
  const uSign = axis === 1 ? 1 : axis === 2 ? sign : -sign;
  return { M: f.M, inv: f.inv, axis, sign, uAxis, uSign, min, max, ids };
}

const isFloor = (w: WallFrame) => w.axis === 1;
const centre = (w: WallFrame, k: number) => (w.min[k] + w.max[k]) / 2;

/** Wall: [along from the wall's centre (+ right seen from outside), height above its base]. Floor: [x, z] from its centre. */
export function wallCoords(w: WallFrame, p: V3): [number, number] {
  const l = vec3.transformMat4(p, w.inv);
  if (isFloor(w)) return [l[0] - centre(w, 0), l[2] - centre(w, 2)];
  return [(l[w.uAxis] - centre(w, w.uAxis)) * w.uSign, l[1] - w.min[1]];
}

/** Wall: [width, height]. Floor: [x, z] extents. */
export function wallSize(w: WallFrame): [number, number] {
  if (isFloor(w)) return [w.max[0] - w.min[0], w.max[2] - w.min[2]];
  return [w.max[w.uAxis] - w.min[w.uAxis], w.max[1] - w.min[1]];
}

/** Keeps an opening of `size` inside the wall: the clamped offset (wallCoords convention; walls: bottom). */
export function clampOpening(w: WallFrame, size: [number, number], off: [number, number]): [number, number] {
  const [fw, fh] = wallSize(w);
  if (isFloor(w)) {
    const hx = Math.min(size[0], fw) / 2, hz = Math.min(size[1], fh) / 2;
    return [Math.max(-fw / 2 + hx, Math.min(fw / 2 - hx, off[0])), Math.max(-fh / 2 + hz, Math.min(fh / 2 - hz, off[1]))];
  }
  const hw = Math.min(size[0], fw) / 2;
  return [Math.max(-fw / 2 + hw, Math.min(fw / 2 - hw, off[0])), Math.max(0, Math.min(fh - Math.min(size[1], fh), off[1]))];
}

/** The opening's box in the wall frame (spanning the wall's thickness, a hair more). Walls: offset [along, bottom]. */
export function openingBox(w: WallFrame, size: [number, number], off: [number, number]): [V3, V3] {
  const min = [...w.min] as V3, max = [...w.max] as V3;
  min[w.axis] -= 2e-4;
  max[w.axis] += 2e-4;
  if (isFloor(w)) {
    min[0] = centre(w, 0) + off[0] - size[0] / 2; max[0] = min[0] + size[0];
    min[2] = centre(w, 2) + off[1] - size[1] / 2; max[2] = min[2] + size[1];
  } else {
    const c = centre(w, w.uAxis) + off[0] * w.uSign;
    min[w.uAxis] = c - size[0] / 2; max[w.uAxis] = c + size[0] / 2;
    min[1] = w.min[1] + off[1]; max[1] = min[1] + size[1];
  }
  return [min, max];
}

/** Another block's box in a frame (M^-1 given): local AABB, or null when not axis-aligned with it. */
export function aabbIn(e: BlockObject, inv: Mat4): [V3, V3] | null {
  const c = blockCorners(e).map((p) => v3(vec3.transformMat4(p, inv)));
  const mn = [0, 1, 2].map((k) => Math.min(...c.map((p) => p[k]))) as V3;
  const mx = [0, 1, 2].map((k) => Math.max(...c.map((p) => p[k]))) as V3;
  const f = blockFrame(e);
  const vol = f.size[0] * f.size[1] * f.size[2];
  const av = (mx[0] - mn[0]) * (mx[1] - mn[1]) * (mx[2] - mn[2]);
  return Math.abs(av - vol) > Math.max(1e-4, vol * 0.01) ? null : [mn, mx];
}

/** World corners of a block's box (any shape: its bounding box). */
export function blockCorners(e: BlockObject): V3[] {
  const f = blockFrame(e);
  const [mn, mx] = localBox(f.size);
  return boxCorners(mn, mx, f.M);
}
