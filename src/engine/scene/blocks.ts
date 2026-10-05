import type { Mat4 } from 'wgpu-matrix';
import type { PrimitiveData } from '../render/geometry';
import type { BlockObject, Transform } from './mapformat';

/**
 * Blockout geometry: parametric shapes (box, wedge / ramp, stairs, cylinder) in
 * the block's local frame (origin at the bottom centre: x and z centred, y from
 * 0 to the height). Every face has an ID (px nx py ny pz nz, or side / top /
 * bottom for cylinders) so materials can be set per face and picking can tell
 * which face was hit. UV0 is world-aligned (planar per face, in metres) so dev
 * grids and real materials continue seamlessly across neighbouring blocks; UV1
 * packs every face into one lightmap chart.
 */

export type BlockShape = BlockObject['block']['shape'];
type V3 = [number, number, number];

interface Face {
  id: string;
  /** Polygon (convex, counter-clockwise seen from outside), local space. */
  pts: V3[];
  /** Outward normal, local space. */
  n: V3;
}

export interface BlockBuild {
  primitives: PrimitiveData[];
  /** Per primitive, per triangle: the face ID. */
  faceOfTri: string[][];
  lightmapResolution: [number, number];
  /** Face IDs this shape has (for the inspector). */
  faces: string[];
}

/** Material of faces without one (light measured dev grid). */
export const BLOCK_MATERIAL = 'dev_wall';

/** Default rise of a stair step (m): comfortable, and walkable by the player controller. */
export const STAIR_RISE = 0.17;

function quad(id: string, a: V3, b: V3, c: V3, d: V3, n: V3): Face {
  return { id, pts: [a, b, c, d], n };
}

/** Faces of a shape. Size [sx, sy, sz]; local frame as described above. */
export function blockFaces(shape: BlockShape, size: number[], opts: { steps?: number; segments?: number } = {}): Face[] {
  const [sx, sy, sz] = size;
  const x0 = -sx / 2, x1 = sx / 2, z0 = -sz / 2, z1 = sz / 2;
  const F: Face[] = [];
  if (shape === 'box') {
    F.push(quad('py', [x0, sy, z1], [x1, sy, z1], [x1, sy, z0], [x0, sy, z0], [0, 1, 0]));
    F.push(quad('ny', [x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1], [0, -1, 0]));
    F.push(quad('pz', [x0, 0, z1], [x1, 0, z1], [x1, sy, z1], [x0, sy, z1], [0, 0, 1]));
    F.push(quad('nz', [x1, 0, z0], [x0, 0, z0], [x0, sy, z0], [x1, sy, z0], [0, 0, -1]));
    F.push(quad('px', [x1, 0, z1], [x1, 0, z0], [x1, sy, z0], [x1, sy, z1], [1, 0, 0]));
    F.push(quad('nx', [x0, 0, z0], [x0, 0, z1], [x0, sy, z1], [x0, sy, z0], [-1, 0, 0]));
  } else if (shape === 'wedge') {
    // Ramp rising towards -Z: low edge at +Z, full height at -Z.
    const l = Math.hypot(sy, sz) || 1;
    F.push(quad('py', [x0, 0, z1], [x1, 0, z1], [x1, sy, z0], [x0, sy, z0], [0, sz / l, sy / l]));
    F.push(quad('ny', [x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1], [0, -1, 0]));
    F.push(quad('nz', [x1, 0, z0], [x0, 0, z0], [x0, sy, z0], [x1, sy, z0], [0, 0, -1]));
    F.push({ id: 'px', pts: [[x1, 0, z1], [x1, 0, z0], [x1, sy, z0]], n: [1, 0, 0] });
    F.push({ id: 'nx', pts: [[x0, 0, z0], [x0, 0, z1], [x0, sy, z0]], n: [-1, 0, 0] });
  } else if (shape === 'stairs') {
    // Steps climbing towards -Z.
    const n = Math.max(1, Math.round(opts.steps ?? Math.max(1, Math.round(sy / STAIR_RISE))));
    const h = sy / n, d = sz / n;
    for (let k = 0; k < n; k++) {
      const zf = z1 - k * d, zb = zf - d, y0 = k * h, y1 = (k + 1) * h;
      F.push(quad('pz', [x0, y0, zf], [x1, y0, zf], [x1, y1, zf], [x0, y1, zf], [0, 0, 1]));
      F.push(quad('py', [x0, y1, zf], [x1, y1, zf], [x1, y1, zb], [x0, y1, zb], [0, 1, 0]));
      // Sides: one column per step, from the ground to its tread.
      F.push(quad('px', [x1, 0, zf], [x1, 0, zb], [x1, y1, zb], [x1, y1, zf], [1, 0, 0]));
      F.push(quad('nx', [x0, 0, zb], [x0, 0, zf], [x0, y1, zf], [x0, y1, zb], [-1, 0, 0]));
    }
    F.push(quad('nz', [x1, 0, z0], [x0, 0, z0], [x0, sy, z0], [x1, sy, z0], [0, 0, -1]));
    F.push(quad('ny', [x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1], [0, -1, 0]));
  } else if (shape === 'cylinder') {
    const seg = Math.max(6, Math.round(opts.segments ?? 16));
    const ring = (y: number) => Array.from({ length: seg }, (_, i) => {
      const a = (i / seg) * Math.PI * 2;
      return [Math.cos(a) * sx / 2, y, -Math.sin(a) * sz / 2] as V3;
    });
    const lo = ring(0), hi = ring(sy);
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      const a = ((i + 0.5) / seg) * Math.PI * 2;
      F.push(quad('side', lo[i], lo[j], hi[j], hi[i], [Math.cos(a), 0, -Math.sin(a)]));
    }
    F.push({ id: 'py', pts: hi.slice(), n: [0, 1, 0] });
    F.push({ id: 'ny', pts: lo.slice().reverse(), n: [0, -1, 0] });
  }
  return F;
}

export function faceIds(shape: BlockShape): string[] {
  if (shape === 'cylinder') return ['side', 'py', 'ny'];
  if (shape === 'wedge') return ['py', 'ny', 'nz', 'px', 'nx'];
  return ['py', 'ny', 'pz', 'nz', 'px', 'nx'];
}

export const FACE_LABELS: Record<string, string> = {
  py: 'Top', ny: 'Bottom', pz: 'Front (+Z)', nz: 'Back (−Z)', px: 'Right (+X)', nx: 'Left (−X)', side: 'Side',
};

/** Shelf-packs rectangles (texels) into a near-square chart; returns placements and the chart size. */
function pack(rects: { w: number; h: number }[]): { W: number; H: number; at: [number, number][] } {
  const pad = 2;
  const area = rects.reduce((a, r) => a + (r.w + pad) * (r.h + pad), 0);
  const maxW = rects.reduce((a, r) => Math.max(a, r.w + pad), 0);
  const W = Math.max(maxW, Math.ceil(Math.sqrt(area) * 1.15));
  const order = rects.map((_, i) => i).sort((a, b) => rects[b].h - rects[a].h);
  const at: [number, number][] = rects.map(() => [0, 0]);
  let x = pad, y = pad, shelf = 0;
  for (const i of order) {
    const r = rects[i];
    if (x + r.w + pad > W + pad) { x = pad; y += shelf + pad; shelf = 0; }
    at[i] = [x, y];
    x += r.w + pad;
    shelf = Math.max(shelf, r.h);
  }
  return { W: W + pad, H: y + shelf + pad, at };
}

/**
 * A block's transform scale folds into its size (so scaled blocks keep their
 * texel density and lightmap charts): the effective size, and the transform
 * without scale that the mesh is built and placed with.
 */
export function blockExtent(e: BlockObject): { size: V3; transform: Transform } {
  const s = e.transform.scale ?? [1, 1, 1];
  const size: V3 = [Math.abs(e.block.size[0] * s[0]), Math.abs(e.block.size[1] * s[1]), Math.abs(e.block.size[2] * s[2])];
  const { scale: _scale, ...transform } = e.transform;
  return { size, transform };
}

/**
 * Builds the block's mesh in local space. `model` (the block's transform
 * without scale, see blockExtent) only drives the world-aligned UV0, so moving
 * a block keeps its texture locked to the world.
 */
export function buildBlock(e: BlockObject, model: Mat4): BlockBuild {
  const b = e.block;
  const faces = blockFaces(b.shape, blockExtent(e).size, { steps: b.steps, segments: b.segments });
  const mat = (id: string) => b.faces?.[id] ?? b.material ?? BLOCK_MATERIAL;
  // Lightmap chart: each face's extent in its own plane, at the texel density.
  const charts = faces.map((f) => {
    const n = f.n;
    // In-plane axes: u horizontal-ish, v perpendicular.
    const ref: V3 = Math.abs(n[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = norm(cross(ref, n)), v = cross(n, u);
    const o = f.pts[0];
    const uv = f.pts.map((p) => [dot(sub(p, o), u), dot(sub(p, o), v)] as [number, number]);
    const u0 = Math.min(...uv.map((q) => q[0])), v0 = Math.min(...uv.map((q) => q[1]));
    const u1 = Math.max(...uv.map((q) => q[0])), v1 = Math.max(...uv.map((q) => q[1]));
    return { uv, u0, v0, w: u1 - u0, h: v1 - v0 };
  });
  let td = b.texelDensity ?? 8;
  let packed = pack(charts.map((c) => ({ w: Math.max(1, Math.ceil(c.w * td)), h: Math.max(1, Math.ceil(c.h * td)) })));
  while ((packed.W > 2040 || packed.H > 2040) && td > 0.5) {
    td *= 0.8;
    packed = pack(charts.map((c) => ({ w: Math.max(1, Math.ceil(c.w * td)), h: Math.max(1, Math.ceil(c.h * td)) })));
  }
  const groups = new Map<string, { pos: number[]; nrm: number[]; uv0: number[]; uv1: number[]; idx: number[]; tri: string[] }>();
  const m = model;
  faces.forEach((f, fi) => {
    const g = groups.get(mat(f.id)) ?? groups.set(mat(f.id), { pos: [], nrm: [], uv0: [], uv1: [], idx: [], tri: [] }).get(mat(f.id))!;
    const base = g.pos.length / 3;
    // World normal decides the planar projection (texture lock).
    const wn = norm([m[0] * f.n[0] + m[4] * f.n[1] + m[8] * f.n[2], m[1] * f.n[0] + m[5] * f.n[1] + m[9] * f.n[2], m[2] * f.n[0] + m[6] * f.n[1] + m[10] * f.n[2]]);
    const ax = Math.abs(wn[0]), ay = Math.abs(wn[1]), az = Math.abs(wn[2]);
    const c = charts[fi], [px, py] = packed.at[fi];
    f.pts.forEach((p, k) => {
      g.pos.push(p[0], p[1], p[2]);
      g.nrm.push(f.n[0], f.n[1], f.n[2]);
      const w = [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
      // Floors: (x, z); walls: (along, -y) so image-up is world-up.
      if (ay >= ax && ay >= az) g.uv0.push(w[0], w[2]);
      else if (ax >= az) g.uv0.push(w[2] * Math.sign(wn[0] || 1) * -1, -w[1]);
      else g.uv0.push(w[0] * Math.sign(wn[2] || 1), -w[1]);
      const lu = (px + (c.uv[k][0] - c.u0) * td) / packed.W, lv = (py + (c.uv[k][1] - c.v0) * td) / packed.H;
      g.uv1.push(lu, lv);
    });
    // Fan triangulation (faces are convex).
    for (let k = 1; k < f.pts.length - 1; k++) {
      g.idx.push(base, base + k, base + k + 1);
      g.tri.push(f.id);
    }
  });
  const primitives: PrimitiveData[] = [];
  const faceOfTri: string[][] = [];
  for (const [material, g] of groups) {
    primitives.push({ material, positions: new Float32Array(g.pos), normals: new Float32Array(g.nrm), uv0: new Float32Array(g.uv0), uv1: new Float32Array(g.uv1), indices: new Uint32Array(g.idx) });
    faceOfTri.push(g.tri);
  }
  return { primitives, faceOfTri, lightmapResolution: [packed.W, packed.H], faces: faceIds(b.shape) };
}

function sub(a: number[], b: number[]): V3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dot(a: number[], b: number[]) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a: number[], b: number[]): V3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a: number[]): V3 { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

/** Local face normal of a box-like face ID (resize handles). */
export const FACE_AXIS: Record<string, [number, number]> = { px: [0, 1], nx: [0, -1], py: [1, 1], ny: [1, -1], pz: [2, 1], nz: [2, -1] };
