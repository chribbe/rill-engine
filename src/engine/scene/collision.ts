/**
 * Static collision world: triangle soup in a uniform XZ grid. Used by the
 * first-person controller (sphere pushes + ground rays) and hitscan rays.
 * Not a physics engine.
 */

/** Coarse surface class per triangle (impact effects). */
export const Surface = { Default: 0, Metal: 1 } as const;
export type Surface = (typeof Surface)[keyof typeof Surface];

export interface RayHit {
  t: number;
  point: [number, number, number];
  /** Unit geometric normal facing the ray origin. */
  normal: [number, number, number];
  surface: Surface;
}

export class CollisionWorld {
  private tris: number[] = []; // 9 floats per triangle
  private surf: Surface[] = [];
  /** Per triangle: index into `owners` (the entity that contributed it). */
  private own: number[] = [];
  private owners: string[] = [];
  private grid = new Map<number, number[]>();
  readonly cell = 4;
  triangleCount = 0;

  /** Removes every triangle (the editor rebuilds collision after scene edits). */
  clear() {
    this.tris.length = 0;
    this.surf.length = 0;
    this.own.length = 0;
    this.owners.length = 0;
    this.grid.clear();
    this.triangleCount = 0;
  }

  private key(ix: number, iz: number) {
    return (ix + 32768) * 65536 + (iz + 32768);
  }

  /** Adds world-space triangles from positions (xyz) + indices, transformed by a column-major matrix. */
  addMesh(pos: Float32Array, idx: Uint32Array, m: ArrayLike<number>, surface: Surface = Surface.Default, owner = '') {
    const oi = this.owners.length;
    this.owners.push(owner);
    const wp = new Float32Array(pos.length);
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2];
      wp[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
      wp[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      wp[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    }
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      // Skip zero-area triangles (sphere poles, welded slivers): closest-point maths divides by their area.
      const ux = wp[b] - wp[a], uy = wp[b + 1] - wp[a + 1], uz = wp[b + 2] - wp[a + 2];
      const vx = wp[c] - wp[a], vy = wp[c + 1] - wp[a + 1], vz = wp[c + 2] - wp[a + 2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      if (cx * cx + cy * cy + cz * cz < 1e-14) continue;
      const ti = this.tris.length / 9;
      this.tris.push(wp[a], wp[a + 1], wp[a + 2], wp[b], wp[b + 1], wp[b + 2], wp[c], wp[c + 1], wp[c + 2]);
      this.surf.push(surface);
      this.own.push(oi);
      const minX = Math.min(wp[a], wp[b], wp[c]), maxX = Math.max(wp[a], wp[b], wp[c]);
      const minZ = Math.min(wp[a + 2], wp[b + 2], wp[c + 2]), maxZ = Math.max(wp[a + 2], wp[b + 2], wp[c + 2]);
      for (let ix = Math.floor(minX / this.cell); ix <= Math.floor(maxX / this.cell); ix++) {
        for (let iz = Math.floor(minZ / this.cell); iz <= Math.floor(maxZ / this.cell); iz++) {
          const k = this.key(ix, iz);
          let l = this.grid.get(k);
          if (!l) this.grid.set(k, (l = []));
          l.push(ti);
        }
      }
      this.triangleCount++;
    }
  }

  private query(minX: number, minZ: number, maxX: number, maxZ: number, out: Set<number>) {
    out.clear();
    for (let ix = Math.floor(minX / this.cell); ix <= Math.floor(maxX / this.cell); ix++) {
      for (let iz = Math.floor(minZ / this.cell); iz <= Math.floor(maxZ / this.cell); iz++) {
        const l = this.grid.get(this.key(ix, iz));
        if (l) for (const t of l) out.add(t);
      }
    }
    return out;
  }
  private tmp = new Set<number>();

  /** Downward ray from (x, y, z): returns hit height or -Infinity. Only upward-facing surfaces count. */
  groundHeight(x: number, y: number, z: number, maxDrop: number): number {
    const set = this.query(x, z, x, z, this.tmp);
    let best = -Infinity;
    const T = this.tris;
    for (const t of set) {
      const o = t * 9;
      const ax = T[o], ay = T[o + 1], az = T[o + 2];
      const bx = T[o + 3], by = T[o + 4], bz = T[o + 5];
      const cx = T[o + 6], cy = T[o + 7], cz = T[o + 8];
      // Barycentric in XZ.
      const v0x = bx - ax, v0z = bz - az, v1x = cx - ax, v1z = cz - az, v2x = x - ax, v2z = z - az;
      const den = v0x * v1z - v1x * v0z;
      if (Math.abs(den) < 1e-9) continue;
      const u = (v2x * v1z - v1x * v2z) / den;
      const v = (v0x * v2z - v2x * v0z) / den;
      if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) continue;
      // Normal y (face must point up).
      const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      if (ny <= 0) continue;
      const h = ay + u * (by - ay) + v * (cy - ay);
      if (h <= y + 1e-3 && h >= y - maxDrop && h > best) best = h;
    }
    return best;
  }

  /**
   * Topmost upward-facing surface below (x, y, z) within maxDrop: height, the owning
   * entity ID (as passed to addMesh) and the face normal's Y (1 = flat). Scatter and
   * spline draping use it to keep to terrain and off roads and roofs.
   */
  groundHit(x: number, y: number, z: number, maxDrop: number, ignore?: string): { height: number; owner: string; ny: number } | null {
    const set = this.query(x, z, x, z, this.tmp);
    let best = -Infinity, bt = -1, bny = 1;
    const T = this.tris;
    for (const t of set) {
      if (ignore !== undefined && this.owners[this.own[t]] === ignore) continue;
      const o = t * 9;
      const ax = T[o], ay = T[o + 1], az = T[o + 2];
      const bx = T[o + 3], by = T[o + 4], bz = T[o + 5];
      const cx = T[o + 6], cy = T[o + 7], cz = T[o + 8];
      const v0x = bx - ax, v0z = bz - az, v1x = cx - ax, v1z = cz - az, v2x = x - ax, v2z = z - az;
      const den = v0x * v1z - v1x * v0z;
      if (Math.abs(den) < 1e-9) continue;
      const u = (v2x * v1z - v1x * v2z) / den;
      const v = (v0x * v2z - v2x * v0z) / den;
      if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) continue;
      const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (ny <= 0) continue;
      const h = ay + u * (by - ay) + v * (cy - ay);
      if (h <= y + 1e-3 && h >= y - maxDrop && h > best) {
        best = h;
        bt = t;
        bny = ny / Math.hypot(nx, ny, nz);
      }
    }
    return bt < 0 ? null : { height: best, owner: this.owners[this.own[bt]], ny: bny };
  }

  /**
   * Nearest hit along a ray (dir normalised) within maxT: walks the XZ grid
   * cells the ray crosses (2D DDA) and tests their triangles (Moller-Trumbore).
   */
  raycast(o: ArrayLike<number>, d: ArrayLike<number>, maxT: number): RayHit | null {
    const T = this.tris;
    const tested = new Set<number>();
    let best: RayHit | null = null;
    const C = this.cell;
    let ix = Math.floor(o[0] / C), iz = Math.floor(o[2] / C);
    const sx = d[0] > 0 ? 1 : -1, sz = d[2] > 0 ? 1 : -1;
    const idx = Math.abs(d[0]) > 1e-9 ? C / Math.abs(d[0]) : Infinity;
    const idz = Math.abs(d[2]) > 1e-9 ? C / Math.abs(d[2]) : Infinity;
    let tx = Math.abs(d[0]) > 1e-9 ? ((sx > 0 ? (ix + 1) * C - o[0] : o[0] - ix * C) / Math.abs(d[0])) : Infinity;
    let tz = Math.abs(d[2]) > 1e-9 ? ((sz > 0 ? (iz + 1) * C - o[2] : o[2] - iz * C) / Math.abs(d[2])) : Infinity;
    let tCell = 0;
    for (let step = 0; step < 4096 && tCell <= maxT; step++) {
      const l = this.grid.get(this.key(ix, iz));
      if (l) {
        for (const t of l) {
          if (tested.has(t)) continue;
          tested.add(t);
          const k = t * 9;
          const e1x = T[k + 3] - T[k], e1y = T[k + 4] - T[k + 1], e1z = T[k + 5] - T[k + 2];
          const e2x = T[k + 6] - T[k], e2y = T[k + 7] - T[k + 1], e2z = T[k + 8] - T[k + 2];
          const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
          const det = e1x * px + e1y * py + e1z * pz;
          if (Math.abs(det) < 1e-12) continue;
          const inv = 1 / det;
          const sxv = o[0] - T[k], syv = o[1] - T[k + 1], szv = o[2] - T[k + 2];
          const u = (sxv * px + syv * py + szv * pz) * inv;
          if (u < 0 || u > 1) continue;
          const qx = syv * e1z - szv * e1y, qy = szv * e1x - sxv * e1z, qz = sxv * e1y - syv * e1x;
          const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
          if (v < 0 || u + v > 1) continue;
          const th = (e2x * qx + e2y * qy + e2z * qz) * inv;
          if (th <= 1e-4 || th > maxT || (best && th >= best.t)) continue;
          let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
          const nl = Math.hypot(nx, ny, nz);
          nx /= nl; ny /= nl; nz /= nl;
          if (nx * d[0] + ny * d[1] + nz * d[2] > 0) { nx = -nx; ny = -ny; nz = -nz; }
          best = { t: th, point: [o[0] + d[0] * th, o[1] + d[1] * th, o[2] + d[2] * th], normal: [nx, ny, nz], surface: this.surf[t] as Surface };
        }
      }
      // A hit inside the cells walked so far cannot be beaten by later cells.
      if (best && best.t <= Math.min(tx, tz)) break;
      if (tx < tz) { tCell = tx; tx += idx; ix += sx; } else { tCell = tz; tz += idz; iz += sz; }
    }
    return best;
  }

  /**
   * Pushes a sphere out of all triangles it penetrates. Returns the summed push
   * vector (horizontal components are what the controller uses against walls).
   */
  pushSphere(p: [number, number, number], r: number): [number, number, number] {
    const set = this.query(p[0] - r, p[2] - r, p[0] + r, p[2] + r, this.tmp);
    const T = this.tris;
    const push: [number, number, number] = [0, 0, 0];
    for (let iter = 0; iter < 3; iter++) {
      let any = false;
      for (const t of set) {
        const o = t * 9;
        const q = closestPointOnTriangle(p, T, o);
        const dx = p[0] - q[0], dy = p[1] - q[1], dz = p[2] - q[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        // Written so NaN (degenerate input) also skips.
        if (!(d2 < r * r) || d2 < 1e-12) continue;
        const d = Math.sqrt(d2);
        const k = (r - d) / d;
        p[0] += dx * k; p[1] += dy * k; p[2] += dz * k;
        push[0] += dx * k; push[1] += dy * k; push[2] += dz * k;
        any = true;
      }
      if (!any) break;
    }
    return push;
  }
}

function closestPointOnTriangle(p: [number, number, number], T: number[], o: number): [number, number, number] {
  const ax = T[o], ay = T[o + 1], az = T[o + 2];
  const abx = T[o + 3] - ax, aby = T[o + 4] - ay, abz = T[o + 5] - az;
  const acx = T[o + 6] - ax, acy = T[o + 7] - ay, acz = T[o + 8] - az;
  const apx = p[0] - ax, apy = p[1] - ay, apz = p[2] - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return [ax, ay, az];
  const bpx = p[0] - T[o + 3], bpy = p[1] - T[o + 4], bpz = p[2] - T[o + 5];
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return [T[o + 3], T[o + 4], T[o + 5]];
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return [ax + abx * v, ay + aby * v, az + abz * v];
  }
  const cpx = p[0] - T[o + 6], cpy = p[1] - T[o + 7], cpz = p[2] - T[o + 8];
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return [T[o + 6], T[o + 7], T[o + 8]];
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return [ax + acx * w, ay + acy * w, az + acz * w];
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return [T[o + 3] + (T[o + 6] - T[o + 3]) * w, T[o + 4] + (T[o + 7] - T[o + 4]) * w, T[o + 5] + (T[o + 8] - T[o + 5]) * w];
  }
  const sum = va + vb + vc;
  if (Math.abs(sum) < 1e-20) return [ax, ay, az];
  const denom = 1 / sum;
  const v = vb * denom, w = vc * denom;
  return [ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w];
}
