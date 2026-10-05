/**
 * Static collision world: triangle soup in a uniform XZ grid. Used by the
 * first-person controller (sphere pushes + ground rays) and hitscan rays.
 * Not a physics engine.
 */

/** Surface class per triangle: an id from SURFACE_NAMES (scene/surfaces.ts); Default / Metal kept for old callers. */
export const Surface = { Default: 0, Metal: 1 } as const;
export type Surface = number;

export interface RayHit {
  t: number;
  point: [number, number, number];
  /** Unit geometric normal facing the ray origin. */
  normal: [number, number, number];
  surface: Surface;
  /** Entity that contributed the triangle (as passed to addMesh). */
  owner: string;
  tri: number;
}

/** Result of `groundProbe` (reused by the caller: no allocation per query). */
export interface GroundProbe {
  height: number;
  /** Face normal (unit, y > 0). */
  nx: number;
  ny: number;
  nz: number;
  surface: Surface;
  tri: number;
}

/** Contact normals written by `pushCapsule` (unit, pointing from the triangle to the capsule). */
export class CapsuleContacts {
  readonly n = new Float64Array(16 * 3);
  /** Penetration depth per contact (before the push). */
  readonly depth = new Float64Array(16);
  readonly surface = new Uint8Array(16);
  count = 0;
  add(nx: number, ny: number, nz: number, depth: number, surface: number) {
    if (this.count >= 16) return;
    const i = this.count++;
    this.n[i * 3] = nx; this.n[i * 3 + 1] = ny; this.n[i * 3 + 2] = nz;
    this.depth[i] = depth;
    this.surface[i] = surface;
  }
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
  /** Per-triangle stamp of the last query that tested it (dedup across cells without a Set). */
  private stamp = new Uint32Array(0);
  private stampId = 0;

  /** Removes every triangle (the editor rebuilds collision after scene edits). */
  clear() {
    this.tris.length = 0;
    this.surf.length = 0;
    this.own.length = 0;
    this.owners.length = 0;
    this.grid.clear();
    this.triangleCount = 0;
    this.stamp = new Uint32Array(0);
  }

  /** Starts a deduplicated walk over grid cells; returns the stamp to compare against. */
  private nextStamp() {
    if (this.stamp.length < this.surf.length) {
      const s = new Uint32Array(Math.max(this.surf.length, this.stamp.length * 2));
      s.set(this.stamp);
      this.stamp = s;
    }
    if (++this.stampId === 0xffffffff) {
      this.stamp.fill(0);
      this.stampId = 1;
    }
    return this.stampId;
  }

  /** Surface class of a triangle. */
  surfaceOf(tri: number): Surface {
    return this.surf[tri] as Surface;
  }

  ownerOf(tri: number): string {
    return this.owners[this.own[tri]];
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
   * `filter` skips triangles (e.g. glass a bullet passes through); `out` is
   * filled instead of allocating a result.
   */
  raycast(o: ArrayLike<number>, d: ArrayLike<number>, maxT: number, filter?: (s: Surface, tri: number) => boolean, out?: RayHit): RayHit | null {
    const T = this.tris;
    const stamp = this.nextStamp(), S = this.stamp;
    let bt = -1, bT = Infinity, bnx = 0, bny = 0, bnz = 0;
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
          if (S[t] === stamp) continue;
          S[t] = stamp;
          if (filter && !filter(this.surf[t] as Surface, t)) continue;
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
          if (th <= 1e-4 || th > maxT || th >= bT) continue;
          bT = th; bt = t;
          bnx = e1y * e2z - e1z * e2y; bny = e1z * e2x - e1x * e2z; bnz = e1x * e2y - e1y * e2x;
        }
      }
      // A hit inside the cells walked so far cannot be beaten by later cells.
      if (bt >= 0 && bT <= Math.min(tx, tz)) break;
      if (tx < tz) { tCell = tx; tx += idx; ix += sx; } else { tCell = tz; tz += idz; iz += sz; }
    }
    if (bt < 0) return null;
    const nl = Math.hypot(bnx, bny, bnz);
    let nx = bnx / nl, ny = bny / nl, nz = bnz / nl;
    if (nx * d[0] + ny * d[1] + nz * d[2] > 0) { nx = -nx; ny = -ny; nz = -nz; }
    const hit = out ?? ({ point: [0, 0, 0], normal: [0, 0, 0] } as unknown as RayHit);
    hit.t = bT;
    hit.point[0] = o[0] + d[0] * bT; hit.point[1] = o[1] + d[1] * bT; hit.point[2] = o[2] + d[2] * bT;
    hit.normal[0] = nx; hit.normal[1] = ny; hit.normal[2] = nz;
    hit.surface = this.surf[bt] as Surface;
    hit.owner = this.owners[this.own[bt]];
    hit.tri = bt;
    return hit;
  }

  /**
   * Topmost upward-facing triangle under (x, z) between y and y - maxDrop whose
   * normal is at least `minNy` upright (walkable). Fills `out`; false if none.
   */
  groundProbe(x: number, y: number, z: number, maxDrop: number, minNy: number, out: GroundProbe): boolean {
    const set = this.query(x, z, x, z, this.tmp);
    let best = -Infinity, bt = -1, bnx = 0, bny = 1, bnz = 0;
    const T = this.tris;
    for (const t of set) {
      const o = t * 9;
      const ax = T[o], ay = T[o + 1], az = T[o + 2];
      const bx = T[o + 3], by = T[o + 4], bz = T[o + 5];
      const cx = T[o + 6], cy = T[o + 7], cz = T[o + 8];
      if (ay < y - maxDrop && by < y - maxDrop && cy < y - maxDrop) continue;
      const v0x = bx - ax, v0z = bz - az, v1x = cx - ax, v1z = cz - az, v2x = x - ax, v2z = z - az;
      const den = v0x * v1z - v1x * v0z;
      if (Math.abs(den) < 1e-9) continue;
      const u = (v2x * v1z - v1x * v2z) / den;
      const v = (v0x * v2z - v2x * v0z) / den;
      if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) continue;
      const h = ay + u * (by - ay) + v * (cy - ay);
      if (h > y + 1e-3 || h < y - maxDrop || h <= best) continue;
      const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (ny <= 0) continue;
      const l = Math.hypot(nx, ny, nz);
      if (ny / l < minNy) continue;
      best = h; bt = t; bnx = nx / l; bny = ny / l; bnz = nz / l;
    }
    if (bt < 0) return false;
    out.height = best; out.nx = bnx; out.ny = bny; out.nz = bnz; out.surface = this.surf[bt] as Surface; out.tri = bt;
    return true;
  }

  /**
   * Pushes a vertical capsule (axis from p.y + y0 to p.y + y1 at p.x / p.z,
   * radius r) out of the triangles it penetrates, one triangle at a time so
   * coplanar triangles don't add up. Pushes are horizontal only, except those
   * pointing down (ceilings, overhangs), which move it fully; walkable ground
   * is the caller's business (ground probes). Normals of every push go to
   * `contacts`; `hint` (previous base position) orients the normal when the
   * axis crosses a triangle. Triangles within `skin` beyond the radius are
   * reported as touching (depth 0) without a push, so a character sliding
   * along a wall keeps seeing it.
   */
  pushCapsule(p: number[], y0: number, y1: number, r: number, contacts: CapsuleContacts, hint?: ArrayLike<number>, iterations = 3, skin = 0.01): number {
    contacts.count = 0;
    const rs = r + skin;
    const T = this.tris;
    const set = this.query(p[0] - r - 0.05, p[2] - r - 0.05, p[0] + r + 0.05, p[2] + r + 0.05, this.tmp);
    const q = SCRATCH;
    for (let iter = 0; iter < iterations; iter++) {
      let any = false;
      for (const t of set) {
        const o = t * 9;
        const x = p[0], z = p[2], ya = p[1] + y0, yb = p[1] + y1;
        // Bounds reject (most triangles of a 4 m cell are far away).
        if (Math.min(T[o], T[o + 3], T[o + 6]) > x + rs || Math.max(T[o], T[o + 3], T[o + 6]) < x - rs) continue;
        if (Math.min(T[o + 2], T[o + 5], T[o + 8]) > z + rs || Math.max(T[o + 2], T[o + 5], T[o + 8]) < z - rs) continue;
        if (Math.min(T[o + 1], T[o + 4], T[o + 7]) > yb + rs || Math.max(T[o + 1], T[o + 4], T[o + 7]) < ya - rs) continue;
        const d2 = segmentTriangle(x, ya, z, x, yb, z, T, o, q);
        if (!(d2 < rs * rs)) continue;
        let nx: number, ny: number, nz: number, depth: number;
        const d = Math.sqrt(d2);
        if (d > 1e-6) {
          nx = (q[0] - q[3]) / d; ny = (q[1] - q[4]) / d; nz = (q[2] - q[5]) / d;
          depth = r - d;
          // Touching within the skin: reported (velocity clipping, slide direction) but not pushed.
          if (depth <= 0) {
            if (iter === 0) contacts.add(nx, ny, nz, 0, this.surf[t]);
            continue;
          }
        } else {
          // Axis crosses the triangle: face normal, towards where the capsule came from.
          const e1x = T[o + 3] - T[o], e1y = T[o + 4] - T[o + 1], e1z = T[o + 5] - T[o + 2];
          const e2x = T[o + 6] - T[o], e2y = T[o + 7] - T[o + 1], e2z = T[o + 8] - T[o + 2];
          nx = e1y * e2z - e1z * e2y; ny = e1z * e2x - e1x * e2z; nz = e1x * e2y - e1y * e2x;
          const l = Math.hypot(nx, ny, nz);
          if (l < 1e-12) continue;
          nx /= l; ny /= l; nz /= l;
          const hx = (hint ? hint[0] : x) - T[o], hy = (hint ? hint[1] : p[1]) + (y0 + y1) / 2 - T[o + 1], hz = (hint ? hint[2] : z) - T[o + 2];
          if (nx * hx + ny * hy + nz * hz < 0) { nx = -nx; ny = -ny; nz = -nz; }
          depth = r;
        }
        if (ny < -0.2) {
          p[0] += nx * depth; p[1] += ny * depth; p[2] += nz * depth;
        } else {
          const h = Math.hypot(nx, nz);
          if (h < 1e-4) continue;
          p[0] += nx * depth; p[2] += nz * depth;
        }
        contacts.add(nx, ny, nz, depth, this.surf[t]);
        any = true;
      }
      if (!any) break;
    }
    return contacts.count;
  }

  /**
   * Pushes a sphere fully out of the triangles it penetrates (all directions,
   * one triangle at a time). Allocation-free. Returns the deepest contact's
   * unit normal in `n` (and its depth), or 0 when nothing was touched.
   */
  pushSphereOut(p: number[], r: number, n: [number, number, number], iterations = 2): number {
    const T = this.tris;
    const set = this.query(p[0] - r, p[2] - r, p[0] + r, p[2] + r, this.tmp);
    const q = SCRATCH;
    let deepest = 0;
    for (let iter = 0; iter < iterations; iter++) {
      let any = false;
      for (const t of set) {
        const o = t * 9;
        if (Math.min(T[o], T[o + 3], T[o + 6]) > p[0] + r || Math.max(T[o], T[o + 3], T[o + 6]) < p[0] - r) continue;
        if (Math.min(T[o + 2], T[o + 5], T[o + 8]) > p[2] + r || Math.max(T[o + 2], T[o + 5], T[o + 8]) < p[2] - r) continue;
        if (Math.min(T[o + 1], T[o + 4], T[o + 7]) > p[1] + r || Math.max(T[o + 1], T[o + 4], T[o + 7]) < p[1] - r) continue;
        closestOnTriangle(p[0], p[1], p[2], T, o, q, 0);
        const dx = p[0] - q[0], dy = p[1] - q[1], dz = p[2] - q[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (!(d2 < r * r) || d2 < 1e-12) continue;
        const d = Math.sqrt(d2), depth = r - d;
        p[0] += (dx / d) * depth; p[1] += (dy / d) * depth; p[2] += (dz / d) * depth;
        if (depth > deepest) { deepest = depth; n[0] = dx / d; n[1] = dy / d; n[2] = dz / d; }
        any = true;
      }
      if (!any) break;
    }
    return deepest;
  }

  /** True if the vertical capsule (as in pushCapsule) overlaps any triangle by more than `tolerance`. */
  capsuleBlocked(p: ArrayLike<number>, y0: number, y1: number, r: number, tolerance = 0.01): boolean {
    const T = this.tris;
    const set = this.query(p[0] - r, p[2] - r, p[0] + r, p[2] + r, this.tmp);
    const x = p[0], z = p[2], ya = p[1] + y0, yb = p[1] + y1, rr = (r - tolerance) * (r - tolerance);
    for (const t of set) {
      const o = t * 9;
      if (Math.min(T[o], T[o + 3], T[o + 6]) > x + r || Math.max(T[o], T[o + 3], T[o + 6]) < x - r) continue;
      if (Math.min(T[o + 2], T[o + 5], T[o + 8]) > z + r || Math.max(T[o + 2], T[o + 5], T[o + 8]) < z - r) continue;
      if (Math.min(T[o + 1], T[o + 4], T[o + 7]) > yb + r || Math.max(T[o + 1], T[o + 4], T[o + 7]) < ya - r) continue;
      if (segmentTriangle(x, ya, z, x, yb, z, T, o, SCRATCH) < rr) return true;
    }
    return false;
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

// ------------------------------------------------------------------ closest-point helpers (allocation-free)

const SCRATCH = new Float64Array(6);
const TMP = new Float64Array(6);

/** Closest point on triangle T[o..o+9] to p, written to out[k..k+3]. */
function closestOnTriangle(px: number, py: number, pz: number, T: number[], o: number, out: Float64Array, k: number) {
  const ax = T[o], ay = T[o + 1], az = T[o + 2];
  const abx = T[o + 3] - ax, aby = T[o + 4] - ay, abz = T[o + 5] - az;
  const acx = T[o + 6] - ax, acy = T[o + 7] - ay, acz = T[o + 8] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let rx: number, ry: number, rz: number;
  if (d1 <= 0 && d2 <= 0) { rx = ax; ry = ay; rz = az; }
  else {
    const bpx = px - T[o + 3], bpy = py - T[o + 4], bpz = pz - T[o + 5];
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    const cpx = px - T[o + 6], cpy = py - T[o + 7], cpz = pz - T[o + 8];
    const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) { rx = T[o + 3]; ry = T[o + 4]; rz = T[o + 5]; }
    else if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); rx = ax + abx * v; ry = ay + aby * v; rz = az + abz * v; }
    else if (d6 >= 0 && d5 <= d6) { rx = T[o + 6]; ry = T[o + 7]; rz = T[o + 8]; }
    else if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); rx = ax + acx * w; ry = ay + acy * w; rz = az + acz * w; }
    else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
      rx = T[o + 3] + (T[o + 6] - T[o + 3]) * w; ry = T[o + 4] + (T[o + 7] - T[o + 4]) * w; rz = T[o + 5] + (T[o + 8] - T[o + 5]) * w;
    } else {
      const sum = va + vb + vc;
      if (Math.abs(sum) < 1e-20) { rx = ax; ry = ay; rz = az; }
      else { const v = vb / sum, w = vc / sum; rx = ax + abx * v + acx * w; ry = ay + aby * v + acy * w; rz = az + abz * v + acz * w; }
    }
  }
  out[k] = rx; out[k + 1] = ry; out[k + 2] = rz;
}

/** Closest points of segments p1q1 / p2q2 (Ericson 5.1.9) into out[0..3] / out[3..6]; returns the squared distance. */
function segmentSegment(p1x: number, p1y: number, p1z: number, q1x: number, q1y: number, q1z: number,
  p2x: number, p2y: number, p2z: number, q2x: number, q2y: number, q2z: number, out: Float64Array): number {
  const d1x = q1x - p1x, d1y = q1y - p1y, d1z = q1z - p1z;
  const d2x = q2x - p2x, d2y = q2y - p2y, d2z = q2z - p2z;
  const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z, f = d2x * rx + d2y * ry + d2z * rz;
  let s: number, t: number;
  if (a <= 1e-12 && e <= 1e-12) { s = t = 0; }
  else if (a <= 1e-12) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
  else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= 1e-12) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z, den = a * e - b * b;
      s = den > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
      else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  out[0] = p1x + d1x * s; out[1] = p1y + d1y * s; out[2] = p1z + d1z * s;
  out[3] = p2x + d2x * t; out[4] = p2y + d2y * t; out[5] = p2z + d2z * t;
  const dx = out[0] - out[3], dy = out[1] - out[4], dz = out[2] - out[5];
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Squared distance between segment AB and triangle T[o..o+9]; out[0..3] is the
 * point on the segment, out[3..6] on the triangle (equal when they intersect).
 */
function segmentTriangle(ax: number, ay: number, az: number, bx: number, by: number, bz: number, T: number[], o: number, out: Float64Array): number {
  // Segment crossing the triangle's plane inside the triangle: distance 0.
  const e1x = T[o + 3] - T[o], e1y = T[o + 4] - T[o + 1], e1z = T[o + 5] - T[o + 2];
  const e2x = T[o + 6] - T[o], e2y = T[o + 7] - T[o + 1], e2z = T[o + 8] - T[o + 2];
  const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  const da = nx * (ax - T[o]) + ny * (ay - T[o + 1]) + nz * (az - T[o + 2]);
  const db = nx * (bx - T[o]) + ny * (by - T[o + 1]) + nz * (bz - T[o + 2]);
  if (da * db <= 0 && da !== db) {
    const s = da / (da - db);
    const px = ax + (bx - ax) * s, py = ay + (by - ay) * s, pz = az + (bz - az) * s;
    closestOnTriangle(px, py, pz, T, o, TMP, 3);
    const dx = TMP[3] - px, dy = TMP[4] - py, dz = TMP[5] - pz;
    if (dx * dx + dy * dy + dz * dz < 1e-10) {
      out[0] = out[3] = px; out[1] = out[4] = py; out[2] = out[5] = pz;
      return 0;
    }
  }
  // Endpoints against the face, then the segment against the three edges.
  closestOnTriangle(ax, ay, az, T, o, out, 3);
  out[0] = ax; out[1] = ay; out[2] = az;
  let best = (out[3] - ax) ** 2 + (out[4] - ay) ** 2 + (out[5] - az) ** 2;
  closestOnTriangle(bx, by, bz, T, o, TMP, 3);
  let d2 = (TMP[3] - bx) ** 2 + (TMP[4] - by) ** 2 + (TMP[5] - bz) ** 2;
  if (d2 < best) { best = d2; out[0] = bx; out[1] = by; out[2] = bz; out[3] = TMP[3]; out[4] = TMP[4]; out[5] = TMP[5]; }
  for (let i = 0; i < 3; i++) {
    const u = o + i * 3, v = o + ((i + 1) % 3) * 3;
    d2 = segmentSegment(ax, ay, az, bx, by, bz, T[u], T[u + 1], T[u + 2], T[v], T[v + 1], T[v + 2], TMP);
    if (d2 < best) { best = d2; out.set(TMP); }
  }
  return best;
}
