import { mat4, type Mat4 } from 'wgpu-matrix';
import type { PrimitiveData } from '../render/geometry';
import type { SplineObject } from './mapformat';

/**
 * Spline geometry: a centripetal Catmull-Rom curve through the control points,
 * resampled by arc length, draped onto the ground, and turned into parts from a
 * preset (public/splines/<name>.json):
 *   ribbon  - a flat strip (paths, roads); subdivided across so it follows the ground
 *   profile - a 2D cross-section swept along the curve (kerbs, rails, low walls)
 *   wall    - a vertical strip (fence mesh panels)
 *   repeat  - an asset every N metres along the curve (fence segments, posts, sleepers)
 * Output is world-space geometry with UV0 in metres and a lightmap chart (UV1)
 * covering the ribbon / profile parts, so splines bake like any static mesh.
 */

export interface SplinePart {
  kind: 'ribbon' | 'profile' | 'wall' | 'repeat';
  material?: string;
  /** Ribbon width (m); `widthFromSpline` lets the entity's width override it. */
  width?: number;
  widthFromSpline?: boolean;
  /** Lateral offset (m, + = left of the direction of travel). With `edge`, measured from the ribbon edge. */
  offset?: number;
  edge?: boolean;
  /** Mirrored copies (e.g. [-1, 1] for kerbs on both sides). */
  sides?: number[];
  /** Height above the ground (m). */
  y?: number;
  /** Profile polyline [across, up] (m), drawn left to right as seen along the curve. */
  profile?: [number, number][];
  /** Wall height (m). */
  height?: number;
  asset?: string;
  spacing?: number;
  /** Repeat: orient each copy along the chord to the next one (segments that must join up). */
  chord?: boolean;
  /** Part of the lightmap chart (default true for ribbon / profile, false for wall / repeat). */
  lightmap?: boolean;
}

export interface SplinePreset {
  format: 'rill.spline';
  name: string;
  description?: string;
  semantic?: string;
  parts: SplinePart[];
  /** Default ribbon width (m) for parts with widthFromSpline. */
  width?: number;
  /** Curve resampling step (m). */
  sampleSpacing?: number;
  /** Lightmap texels per metre. */
  texelDensity?: number;
  collision?: boolean;
  castShadow?: boolean;
}

export interface SplineBuild {
  primitives: PrimitiveData[];
  /** Repeated assets: world matrices. */
  instances: { asset: string; matrix: Mat4 }[];
  /** Lightmap chart size (texels) of the generated mesh, null when nothing is lightmapped. */
  lightmapResolution: [number, number] | null;
  length: number;
  /** World-space centreline (for overlays). */
  centreline: [number, number, number][];
}

type V3 = [number, number, number];

/** Centripetal Catmull-Rom point between p1 and p2. */
function catmull(p0: V3, p1: V3, p2: V3, p3: V3, t: number): V3 {
  // Knot spacing |p_i+1 - p_i|^0.5 (centripetal: no cusps or self-intersections).
  const d = (a: V3, b: V3) => Math.max(1e-4, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])));
  const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
  const u = t1 + (t2 - t1) * t;
  const lerp = (A: V3, B: V3, ta: number, tb: number): V3 => {
    const w = (u - ta) / (tb - ta);
    return [A[0] + (B[0] - A[0]) * w, A[1] + (B[1] - A[1]) * w, A[2] + (B[2] - A[2]) * w];
  };
  const A1 = lerp(p0, p1, t0, t1), A2 = lerp(p1, p2, t1, t2), A3 = lerp(p2, p3, t2, t3);
  const B1 = lerp(A1, A2, t0, t2), B2 = lerp(A2, A3, t1, t3);
  return lerp(B1, B2, t1, t2);
}

/** Dense curve through the points, then uniform arc-length samples (XZ length). */
export function sampleCurve(pts: V3[], closed: boolean, step: number): { p: V3[]; s: number[] } {
  if (pts.length < 2) return { p: pts.slice(), s: pts.map(() => 0) };
  const P = closed ? [pts[pts.length - 1], ...pts, pts[0], pts[1]] : [pts[0], ...pts, pts[pts.length - 1]];
  const dense: V3[] = [];
  const segs = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segs; i++) {
    const n = 24;
    for (let k = 0; k < n; k++) dense.push(catmull(P[i], P[i + 1], P[i + 2], P[i + 3], k / n));
  }
  dense.push(closed ? pts[0] : pts[pts.length - 1]);
  const cum = [0];
  for (let i = 1; i < dense.length; i++) cum.push(cum[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][2] - dense[i - 1][2]));
  const L = cum[cum.length - 1];
  const n = Math.max(1, Math.round(L / step));
  const out: V3[] = [], s: number[] = [];
  let j = 0;
  for (let i = 0; i <= n; i++) {
    const target = (L * i) / n;
    while (j < cum.length - 2 && cum[j + 1] < target) j++;
    const w = cum[j + 1] > cum[j] ? (target - cum[j]) / (cum[j + 1] - cum[j]) : 0;
    const a = dense[j], b = dense[j + 1];
    out.push([a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w]);
    s.push(target);
  }
  return { p: out, s };
}

class Prim {
  pos: number[] = []; nrm: number[] = []; uv0: number[] = []; uv1: number[] = []; idx: number[] = [];
  vert(p: V3, u0: number, v0: number, u1: number, v1: number) {
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(0, 0, 0);
    this.uv0.push(u0, v0);
    this.uv1.push(u1, v1);
    return this.pos.length / 3 - 1;
  }
  /** Grid of rows (along) x cols (across) vertices starting at `base`, quads between. */
  grid(base: number, rows: number, cols: number, flip: boolean) {
    for (let i = 0; i < rows - 1; i++) {
      for (let k = 0; k < cols - 1; k++) {
        const a = base + i * cols + k, b = a + 1, c = a + cols, d = c + 1;
        if (flip) this.idx.push(a, c, b, b, c, d);
        else this.idx.push(a, b, c, b, d, c);
      }
    }
  }
}

function finishNormals(p: Prim) {
  const P = p.pos, N = p.nrm, I = p.idx;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const o of [a, b, c]) { N[o] += nx; N[o + 1] += ny; N[o + 2] += nz; }
  }
  for (let i = 0; i < N.length; i += 3) {
    const l = Math.hypot(N[i], N[i + 1], N[i + 2]) || 1;
    N[i] /= l; N[i + 1] /= l; N[i + 2] /= l;
  }
}

/**
 * Builds the spline's geometry. `toWorld` maps local (x, y, z) to world; `ground`
 * returns the surface height under a world (x, z) (the spline itself excluded).
 */
export function buildSpline(e: SplineObject, preset: SplinePreset, toWorld: (p: V3) => V3, ground: (x: number, z: number, nearY: number) => number | null): SplineBuild {
  const sp = e.spline;
  const drape = sp.drape !== false;
  const pts = sp.points.map((p) => toWorld([p[0], p[1], p[2]]));
  const step = Math.max(0.2, preset.sampleSpacing ?? 0.75);
  const empty: SplineBuild = { primitives: [], instances: [], lightmapResolution: null, length: 0, centreline: pts };
  if (pts.length < 2) return empty;
  const curve = sampleCurve(pts, !!sp.closed, step);
  // C: curve points; y = the reference height (draping searches the ground just below it).
  const C = curve.p;
  const yOff = C.map(() => 0);
  const S = curve.s, L = S[S.length - 1];
  if (L < 0.05) return empty;
  const n = C.length;
  // Left normals in XZ.
  const T: [number, number][] = C.map((_, i) => {
    const a = C[Math.max(0, i - 1)], b = C[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0], dz = b[2] - a[2], l = Math.hypot(dx, dz) || 1;
    return [dx / l, dz / l];
  });
  const left = (i: number): [number, number] => [T[i][1], -T[i][0]];
  // Ground near the curve's height at sample i (fallback: the curve itself).
  const ghi = (x: number, z: number, i: number) => (drape ? ground(x, z, C[i][1]) ?? C[i][1] : C[i][1]);
  const W = sp.width ?? preset.width ?? 2.5;

  // Lightmap chart rows: one per lightmapped part / side.
  const td0 = Math.max(0.5, sp.texelDensity ?? preset.texelDensity ?? 5);
  const td = Math.min(td0, 2040 / Math.max(1, L));
  const rows: { part: SplinePart; side: number; h: number }[] = [];
  const perim = (pr: [number, number][]) => pr.reduce((a, p, i) => (i ? a + Math.hypot(p[0] - pr[i - 1][0], p[1] - pr[i - 1][1]) : 0), 0);
  for (const part of preset.parts) {
    const lm = part.lightmap ?? (part.kind === 'ribbon' || part.kind === 'profile');
    if (!lm) continue;
    for (const side of part.sides ?? [1]) {
      const h = part.kind === 'ribbon' ? (part.widthFromSpline ? W : part.width ?? W) : part.kind === 'profile' ? perim(part.profile ?? []) : part.height ?? 1;
      rows.push({ part, side, h });
    }
  }
  const Wt = Math.max(4, Math.ceil(L * td));
  const rowTex = rows.map((r) => Math.max(2, Math.ceil(r.h * td)));
  const Ht = rowTex.reduce((a, h) => a + h + 2, 0);
  const res: [number, number] | null = rows.length ? [Wt + 2, Math.max(4, Ht)] : null;
  let rowStart = 0;
  const rowOf = new Map<string, { v0: number; vh: number }>();
  rows.forEach((r, i) => {
    rowOf.set(`${preset.parts.indexOf(r.part)}:${r.side}`, { v0: (rowStart + 1) / Ht, vh: rowTex[i] / Ht });
    rowStart += rowTex[i] + 2;
  });
  const u1 = (s: number) => (1 + (s / L) * Wt) / (Wt + 2);

  const prims = new Map<string, Prim>();
  const prim = (m: string) => prims.get(m) ?? prims.set(m, new Prim()).get(m)!;
  const instances: SplineBuild['instances'] = [];
  const groundAt = C.map((c, i) => ghi(c[0], c[2], i));

  preset.parts.forEach((part, pi) => {
    for (const side of part.sides ?? [1]) {
      const row = rowOf.get(`${pi}:${side}`);
      const lat = (extra: number) => side * ((part.edge ? W / 2 : 0) + (part.offset ?? 0)) + extra;
      if (part.kind === 'ribbon') {
        const w = part.widthFromSpline ? W : part.width ?? W;
        const cols = Math.max(2, Math.ceil(w / 1.25) + 1);
        const p = prim(part.material ?? 'asphalt_path');
        const b = p.pos.length / 3;
        for (let i = 0; i < n; i++) {
          const [lx, lz] = left(i);
          for (let k = 0; k < cols; k++) {
            const a = -w / 2 + (w * k) / (cols - 1);
            const o = lat(a);
            const x = C[i][0] + lx * o, z = C[i][2] + lz * o;
            const y = ghi(x, z, i) + yOff[i] + (part.y ?? 0.03);
            p.vert([x, y, z], a, S[i], u1(S[i]), row ? row.v0 + ((a + w / 2) / w) * row.vh : 0);
          }
        }
        // Rows run along the curve, columns leftwards: this winding faces up.
        p.grid(b, n, cols, true);
      } else if (part.kind === 'profile' || part.kind === 'wall') {
        const pr: [number, number][] = part.kind === 'wall' ? [[0, 0], [0, part.height ?? 1]] : part.profile ?? [[0, 0], [0, 0.1]];
        const total = perim(pr) || 1;
        const p = prim(part.material ?? 'concrete_cast');
        const gx = pr.reduce((a, q) => a + q[0], 0) / pr.length, gy = pr.reduce((a, q) => a + q[1], 0) / pr.length;
        // Flat-shaded strips: own vertices per profile segment.
        let acc = 0;
        for (let j = 0; j < pr.length - 1; j++) {
          const seg = Math.hypot(pr[j + 1][0] - pr[j][0], pr[j + 1][1] - pr[j][1]);
          const b = p.pos.length / 3;
          // Winding that faces away from the profile's centroid (outward), whatever the profile's direction.
          const [lx0, lz0] = left(0);
          const ex = side * (pr[j + 1][0] - pr[j][0]), ey = pr[j + 1][1] - pr[j][1];
          const ox = side * ((pr[j][0] + pr[j + 1][0]) / 2 - gx), oy = (pr[j][1] + pr[j + 1][1]) / 2 - gy;
          // Unflipped normal = (segment across/up) x forward; forward = (-lz, 0, lx) in XZ.
          const ux = lx0 * ex, uy = ey, uz = lz0 * ex, fx = -lz0, fz = lx0;
          const nx = uy * fz, ny = uz * fx - ux * fz, nz = -uy * fx;
          const outward = nx * lx0 * ox + ny * oy + nz * lz0 * ox;
          const flip = part.kind === 'wall' ? side > 0 : outward < 0;
          for (let i = 0; i < n; i++) {
            const [lx, lz] = left(i);
            const cx = C[i][0] + lx * lat(0), cz = C[i][2] + lz * lat(0);
            const gy = ghi(cx, cz, i) + yOff[i] + (part.y ?? 0);
            for (const q of [j, j + 1]) {
              const ax = side * pr[q][0];
              const v = (q === j ? acc : acc + seg);
              p.vert([cx + lx * ax, gy + pr[q][1], cz + lz * ax], S[i], v, u1(S[i]), row ? row.v0 + (v / total) * row.vh : 0);
            }
          }
          p.grid(b, n, 2, flip);
          acc += seg;
        }
      } else if (part.kind === 'repeat' && part.asset) {
        const spacing = Math.max(0.2, part.spacing ?? 2.5);
        const count = Math.floor(L / spacing + 1e-6);
        const at = (s: number): V3 => {
          let i = 0;
          while (i < n - 2 && S[i + 1] < s) i++;
          const w = S[i + 1] > S[i] ? (s - S[i]) / (S[i + 1] - S[i]) : 0;
          const [lx, lz] = left(i);
          const x = C[i][0] + (C[i + 1][0] - C[i][0]) * w + lx * lat(0), z = C[i][2] + (C[i + 1][2] - C[i][2]) * w + lz * lat(0);
          return [x, ghi(x, z, i) + yOff[i] + (part.y ?? 0), z];
        };
        for (let k = 0; k <= count; k++) {
          const s = part.chord ? k * spacing : Math.min(L, k * spacing);
          if (part.chord && s + spacing > L + 1e-3) break;
          const a = at(s), b = at(part.chord ? s + spacing : Math.min(L, s + 0.5));
          let dx = b[0] - a[0], dz = b[2] - a[2];
          const l = Math.hypot(dx, dz) || 1;
          dx /= l; dz /= l;
          // Local +X along the curve (chord), +Y up, +Z = X x Y.
          const m = mat4.create(dx, 0, dz, 0, 0, 1, 0, 0, -dz, 0, dx, 0, a[0], a[1], a[2], 1);
          if (part.chord) {
            // Stretch to the chord so consecutive segments meet.
            const sx = Math.hypot(b[0] - a[0], b[2] - a[2]) / spacing;
            mat4.scale(m, [sx, 1, 1], m);
            // Shear in Y so the far end follows the ground.
            m[1] = (b[1] - a[1]) / spacing;
          }
          instances.push({ asset: part.asset, matrix: m });
        }
      }
    }
  });

  const primitives: PrimitiveData[] = [];
  for (const [material, p] of prims) {
    if (!p.idx.length) continue;
    finishNormals(p);
    primitives.push({ positions: new Float32Array(p.pos), normals: new Float32Array(p.nrm), uv0: new Float32Array(p.uv0), uv1: new Float32Array(p.uv1), indices: new Uint32Array(p.idx), material });
  }
  const centre = C.map((c, i) => [c[0], groundAt[i] + yOff[i], c[2]] as V3);
  return { primitives, instances, lightmapResolution: primitives.length ? res : null, length: L, centreline: centre };
}
