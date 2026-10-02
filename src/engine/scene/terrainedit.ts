import type { PrimitiveData } from '../render/geometry';
import type { TerrainLayerObject } from './mapformat';

/**
 * Terrain editing fields. Strokes of a TerrainLayerObject are replayed in order
 * into two world-XZ grids: D (height offset, m) and P (blend-layer weight offset).
 * Terrain vertices then move by D(x, z) and blend by P(x, z), so every mesh
 * sharing a seam vertex gets exactly the same result. Smooth and flatten act on
 * the current surface height y0 + D, where y0 is the original terrain
 * (`baseHeight`). Appending strokes is incremental; anything else recomputes.
 */

export type TerrainStroke = TerrainLayerObject['terrain']['strokes'][number];

export class TerrainFields {
  readonly nx: number;
  readonly nz: number;
  readonly D: Float32Array;
  readonly P: Float32Array;
  private y0: Float32Array;
  /** Strokes applied so far (prefix of the layer's list). */
  applied: TerrainStroke[] = [];
  /** World XZ box touched by any applied stroke. */
  touched: { x0: number; z0: number; x1: number; z1: number } | null = null;

  constructor(readonly x0: number, readonly z0: number, x1: number, z1: number, readonly cell: number, private baseHeight: (x: number, z: number) => number) {
    this.nx = Math.max(2, Math.ceil((x1 - x0) / cell) + 1);
    this.nz = Math.max(2, Math.ceil((z1 - z0) / cell) + 1);
    const n = this.nx * this.nz;
    this.D = new Float32Array(n);
    this.P = new Float32Array(n);
    this.y0 = new Float32Array(n).fill(NaN);
  }

  private base(i: number, k: number): number {
    const o = k * this.nx + i;
    let v = this.y0[o];
    if (Number.isNaN(v)) v = this.y0[o] = this.baseHeight(this.x0 + i * this.cell, this.z0 + k * this.cell);
    return v;
  }

  /** Applies strokes; returns the world box they touched (null if none). */
  apply(strokes: TerrainStroke[]): { x0: number; z0: number; x1: number; z1: number } | null {
    let box: { x0: number; z0: number; x1: number; z1: number } | null = null;
    for (const st of strokes) {
      const b = this.stroke(st);
      if (!b) continue;
      box = box ? { x0: Math.min(box.x0, b.x0), z0: Math.min(box.z0, b.z0), x1: Math.max(box.x1, b.x1), z1: Math.max(box.z1, b.z1) } : b;
      this.applied.push(st);
    }
    if (box) this.touched = this.touched ? { x0: Math.min(this.touched.x0, box.x0), z0: Math.min(this.touched.z0, box.z0), x1: Math.max(this.touched.x1, box.x1), z1: Math.max(this.touched.z1, box.z1) } : box;
    return box;
  }

  private stroke([op, x, z, r, s, v]: TerrainStroke) {
    const c = this.cell, nx = this.nx, nz = this.nz;
    r = Math.max(c, r);
    const i0 = Math.max(0, Math.floor((x - r - this.x0) / c)), i1 = Math.min(nx - 1, Math.ceil((x + r - this.x0) / c));
    const k0 = Math.max(0, Math.floor((z - r - this.z0) / c)), k1 = Math.min(nz - 1, Math.ceil((z + r - this.z0) / c));
    if (i0 > i1 || k0 > k1) return null;
    const fall = (i: number, k: number) => {
      const d = Math.hypot(this.x0 + i * c - x, this.z0 + k * c - z) / r;
      return d >= 1 ? 0 : (1 - d * d) * (1 - d * d);
    };
    const D = this.D, P = this.P;
    if (op === 'smooth') {
      // Box blur of the current height over a kernel scaled to the brush, blended in by falloff.
      const kr = Math.max(1, Math.round(r / (5 * c)));
      const w = i1 - i0 + 1, h = k1 - k0 + 1;
      const H = new Float32Array(w * h);
      for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) H[(k - k0) * w + (i - i0)] = this.base(i, k) + D[k * nx + i];
      const out = new Float32Array(w * h);
      for (let k = 0; k < h; k++) {
        for (let i = 0; i < w; i++) {
          let sum = 0, n = 0;
          for (let dk = -kr; dk <= kr; dk++) for (let di = -kr; di <= kr; di++) {
            const ii = i + di, kk = k + dk;
            if (ii < 0 || kk < 0 || ii >= w || kk >= h) continue;
            sum += H[kk * w + ii];
            n++;
          }
          out[k * w + i] = sum / n;
        }
      }
      for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
        const f = fall(i, k) * Math.min(1, s);
        if (f > 0) D[k * nx + i] += (out[(k - k0) * w + (i - i0)] - H[(k - k0) * w + (i - i0)]) * f;
      }
    } else {
      for (let k = k0; k <= k1; k++) {
        for (let i = i0; i <= i1; i++) {
          const f = fall(i, k);
          if (f <= 0) continue;
          const o = k * nx + i;
          switch (op) {
            case 'raise': D[o] += s * f; break;
            case 'lower': D[o] -= s * f; break;
            case 'flatten': D[o] += ((v ?? 0) - (this.base(i, k) + D[o])) * Math.min(1, s) * f; break;
            case 'paint': P[o] = Math.min(1, P[o] + s * f); break;
            case 'unpaint': P[o] = Math.max(-1, P[o] - s * f); break;
          }
        }
      }
    }
    return { x0: this.x0 + i0 * c, z0: this.z0 + k0 * c, x1: this.x0 + i1 * c, z1: this.z0 + k1 * c };
  }

  /** Bilinear D, its XZ gradient and P at a world point (zero outside the grid). */
  sample(x: number, z: number): [number, number, number, number] {
    const c = this.cell;
    const fx = (x - this.x0) / c, fz = (z - this.z0) / c;
    const i = Math.floor(fx), k = Math.floor(fz);
    if (i < 0 || k < 0 || i >= this.nx - 1 || k >= this.nz - 1) return [0, 0, 0, 0];
    const u = fx - i, v = fz - k, nx = this.nx;
    const o = k * nx + i;
    const d00 = this.D[o], d10 = this.D[o + 1], d01 = this.D[o + nx], d11 = this.D[o + nx + 1];
    const d = d00 * (1 - u) * (1 - v) + d10 * u * (1 - v) + d01 * (1 - u) * v + d11 * u * v;
    const dx = ((d10 - d00) * (1 - v) + (d11 - d01) * v) / c;
    const dz = ((d01 - d00) * (1 - u) + (d11 - d10) * u) / c;
    const p00 = this.P[o], p10 = this.P[o + 1], p01 = this.P[o + nx], p11 = this.P[o + nx + 1];
    const p = p00 * (1 - u) * (1 - v) + p10 * u * (1 - v) + p01 * (1 - u) * v + p11 * u * v;
    return [d, dx, dz, p];
  }
}

/**
 * The terrain primitive moved by the fields: y += D, normals tilted by D's
 * gradient (exact for height-field surfaces, unchanged where D is flat), blend
 * weight (colour R) += P. `tx`, `tz`: the entity's translation (terrain is
 * world-anchored). Returns null when the fields don't touch it.
 */
export function deformPrimitive(base: PrimitiveData, f: TerrainFields, tx: number, tz: number): PrimitiveData | null {
  const P = base.positions, N = base.normals, n = P.length / 3;
  const pos = new Float32Array(P);
  const nrm = new Float32Array(N);
  const col = base.colors ? new Float32Array(base.colors) : null;
  let touched = false;
  for (let v = 0; v < n; v++) {
    const [d, dx, dz, p] = f.sample(P[v * 3] + tx, P[v * 3 + 2] + tz);
    if (d === 0 && dx === 0 && dz === 0 && p === 0) continue;
    touched = true;
    pos[v * 3 + 1] += d;
    const ny = Math.max(0.2, N[v * 3 + 1]);
    const ax = N[v * 3] / ny - dx, az = N[v * 3 + 2] / ny - dz;
    const l = Math.hypot(ax, 1, az);
    nrm[v * 3] = ax / l; nrm[v * 3 + 1] = 1 / l; nrm[v * 3 + 2] = az / l;
    if (col) col[v * 4] = Math.max(0, Math.min(1, col[v * 4] + p));
  }
  if (!touched) return null;
  // Tangents are recomputed from the new geometry on upload.
  return { positions: pos, normals: nrm, uv0: base.uv0, uv1: base.uv1, colors: col ?? undefined, indices: base.indices, material: base.material };
}
