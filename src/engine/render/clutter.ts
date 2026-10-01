import type { GpuMesh } from './geometry';
import type { Material } from './materials';
import type { Plane } from './culling';
import { aabbVisible } from './culling';

/**
 * Ground clutter (Source "detail props"): small crossed-card tufts scattered at
 * load time over surfaces whose material lists `clutter` types, drawn only near
 * the camera. Instances are compact (32 B) in their own GPU buffer, sorted into
 * square cells; each frame the visible part of every cell row becomes one
 * instanced draw, so there is no per-instance CPU work. The vertex stage fades
 * instances out with the LOD dither towards maxDistance.
 */

export interface ClutterDef {
  /** GLB of the tuft (e.g. assets/testmap/clutter_grass.glb). */
  model: string;
  /** Instances per square metre on flat, uncovered ground. */
  density: number;
  scale?: [number, number];
  /** Fade-out end distance (m). */
  maxDistance?: number;
  /** Maximum ground slope (cos of the angle from vertical, default 0.75 = ~41 deg). */
  minNormalY?: number;
}

export interface ClutterSource {
  /** World-space triangle soup of one surface. */
  positions: Float32Array; // world xyz
  normals: Float32Array; // world xyz (unit)
  indices: Uint32Array;
  /** Blend-layer weight per vertex (vertex colour R), or null. */
  weights: Float32Array | null;
  /** Lightmap UVs (chart space) + the object's atlas scale/offset and page, or null. */
  uv1: Float32Array | null;
  lmST: ArrayLike<number> | null;
  lmPage: number;
  /** Clutter of layer A (weight 1 - w) and layer B (weight w). */
  layerA: ClutterDef[];
  layerB: ClutterDef[];
  seed: number;
}

export interface ClutterTypeGpu {
  key: string;
  mesh: GpuMesh;
  materials: Material[];
  buffer: GPUBuffer;
  params: GPUBuffer;
  bindGroup: GPUBindGroup;
  count: number;
  maxDistance: number;
  /** Cell start offsets (cells + 1), row-major over (cz, cx). */
  cellStart: Uint32Array;
}

export interface ClutterDraw {
  type: ClutterTypeGpu;
  first: number;
  count: number;
}

const CELL = 8;

/** Smooth value noise in [0, 1] (clumping of tufts, ~3 m features). */
function clumpNoise(x: number, z: number, seed: number) {
  const h = (i: number, j: number) => {
    let n = Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(seed, 2147483647);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const xi = Math.floor(x), zi = Math.floor(z), fx = x - xi, fz = z - zi;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = h(xi, zi), b = h(xi + 1, zi), c = h(xi, zi + 1), d = h(xi + 1, zi + 1);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class ClutterSystem {
  readonly types: ClutterTypeGpu[] = [];
  origin = [0, 0];
  nx = 0;
  nz = 0;
  minY = 0;
  maxY = 0;
  instances = 0;
  buildMs = 0;
  /** Draws issued last frame / instances in them. */
  stats = { draws: 0, instances: 0 };

  /**
   * Scatters all sources. `covered(x, y, z)` rejects points under roads, paths or
   * buildings; `loadModel` resolves a tuft GLB to GPU mesh + materials.
   */
  async build(device: GPUDevice, layout: GPUBindGroupLayout, sources: ClutterSource[], dummySlot: number, pageSlot0: number,
    covered: (x: number, y: number, z: number) => boolean,
    loadModel: (ref: string) => Promise<{ mesh: GpuMesh; materials: Material[] }>) {
    const t0 = performance.now();
    const pts = new Map<string, { def: ClutterDef; data: number[] }>();
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const src of sources) {
      const P = src.positions, N = src.normals, I = src.indices, W = src.weights, U = src.uv1, ST = src.lmST;
      const rand = rng(src.seed);
      for (let t = 0; t < I.length; t += 3) {
        const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
        const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
        const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
        const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
        const cl = Math.hypot(cx, cy, cz);
        const area = cl * 0.5;
        if (area < 1e-6) continue;
        const ny = Math.abs(cy / cl);
        for (const [defs, layerB] of [[src.layerA, false], [src.layerB, true]] as const) {
          for (const def of defs) {
            if (ny < (def.minNormalY ?? 0.75)) continue;
            // Clumped: scatter twice the density, keep by a smooth noise (patches and gaps).
            const expected = area * def.density * 2;
            let n = Math.floor(expected);
            if (rand() < expected - n) n++;
            if (n === 0) continue;
            let entry = pts.get(def.model + '|' + (def.maxDistance ?? 30));
            if (!entry) pts.set(def.model + '|' + (def.maxDistance ?? 30), (entry = { def, data: [] }));
            for (let k = 0; k < n; k++) {
              let r1 = rand(), r2 = rand();
              if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
              const w0 = 1 - r1 - r2;
              // Per-point layer weight (vertex colour R) decides lawn vs forest-floor clutter.
              if (W) {
                const w = W[I[t]] * w0 + W[I[t + 1]] * r1 + W[I[t + 2]] * r2;
                if (rand() > (layerB ? w : 1 - w)) continue;
              } else if (layerB) continue;
              const x = P[a] * w0 + P[b] * r1 + P[c] * r2;
              const y = P[a + 1] * w0 + P[b + 1] * r1 + P[c + 1] * r2;
              const z = P[a + 2] * w0 + P[b + 2] * r1 + P[c + 2] * r2;
              const clump = clumpNoise(x / 3.1, z / 3.1, 7) * 0.65 + clumpNoise(x / 0.9, z / 0.9, 11) * 0.35;
              if (rand() > Math.pow(clump, 2.2) * 2.2) continue;
              if (covered(x, y, z)) continue;
              const s = def.scale ?? [0.8, 1.2];
              // The ground's lightmap UV at the root: tufts are lit (and snow-buried) like the ground.
              let lu = 0, lv = 0, page = 0;
              if (U && ST && src.lmPage >= 0) {
                const ia = I[t] * 2, ib = I[t + 1] * 2, ic = I[t + 2] * 2;
                lu = (U[ia] * w0 + U[ib] * r1 + U[ic] * r2) * ST[0] + ST[2];
                lv = (U[ia + 1] * w0 + U[ib + 1] * r1 + U[ic + 1] * r2) * ST[1] + ST[3];
                page = src.lmPage + 1;
              }
              entry.data.push(x, y - 0.01, z, rand() * Math.PI * 2, s[0] + rand() * (s[1] - s[0]), lu, lv, page);
              minX = Math.min(minX, x); maxX = Math.max(maxX, x);
              minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
              minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            }
          }
        }
        void N;
      }
    }
    if (!isFinite(minX)) return;
    this.origin = [Math.floor(minX / CELL) * CELL, Math.floor(minZ / CELL) * CELL];
    this.nx = Math.floor((maxX - this.origin[0]) / CELL) + 1;
    this.nz = Math.floor((maxZ - this.origin[1]) / CELL) + 1;
    this.minY = minY - 1;
    this.maxY = maxY + 2;
    const cells = this.nx * this.nz;
    for (const [key, { def, data }] of pts) {
      const count = data.length / 8;
      // Counting sort by cell.
      const cellOf = new Uint32Array(count);
      const cellStart = new Uint32Array(cells + 1);
      for (let i = 0; i < count; i++) {
        const cx = Math.min(this.nx - 1, Math.floor((data[i * 8] - this.origin[0]) / CELL));
        const cz = Math.min(this.nz - 1, Math.floor((data[i * 8 + 2] - this.origin[1]) / CELL));
        cellOf[i] = cz * this.nx + cx;
        cellStart[cellOf[i] + 1]++;
      }
      for (let c = 0; c < cells; c++) cellStart[c + 1] += cellStart[c];
      const cursor = cellStart.slice(0, cells);
      const sorted = new Float32Array(count * 8);
      for (let i = 0; i < count; i++) {
        const o = cursor[cellOf[i]]++;
        for (let k = 0; k < 8; k++) sorted[o * 8 + k] = data[i * 8 + k];
      }
      const { mesh, materials } = await loadModel(def.model);
      const buffer = device.createBuffer({ label: `clutter:${key}`, size: Math.max(32, sorted.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buffer, 0, sorted);
      const maxDistance = def.maxDistance ?? 30;
      const params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const pa = new ArrayBuffer(16);
      new Uint32Array(pa, 0, 2).set([dummySlot, pageSlot0]);
      new Float32Array(pa, 8, 2).set([maxDistance * 0.7, maxDistance]);
      device.queue.writeBuffer(params, 0, pa);
      const bindGroup = device.createBindGroup({
        label: `clutter:${key}`,
        layout,
        entries: [{ binding: 0, resource: { buffer } }, { binding: 1, resource: { buffer: params } }],
      });
      this.types.push({ key, mesh, materials, buffer, params, bindGroup, count, maxDistance, cellStart });
      this.instances += count;
    }
    this.buildMs = performance.now() - t0;
  }

  /** One draw per visible row segment of cells within each type's range. */
  collect(eye: ArrayLike<number>, planes: Plane[], scale: number, out: ClutterDraw[]) {
    out.length = 0;
    let inst = 0;
    const mn = new Float32Array(3), mx = new Float32Array(3);
    for (const T of this.types) {
      const R = T.maxDistance * scale;
      const cz0 = Math.max(0, Math.floor((eye[2] - R - this.origin[1]) / CELL));
      const cz1 = Math.min(this.nz - 1, Math.floor((eye[2] + R - this.origin[1]) / CELL));
      for (let cz = cz0; cz <= cz1; cz++) {
        const z0 = this.origin[1] + cz * CELL, z1 = z0 + CELL;
        const dz = Math.max(0, z0 - eye[2], eye[2] - z1);
        if (dz > R) continue;
        const half = Math.sqrt(R * R - dz * dz);
        const cx0 = Math.max(0, Math.floor((eye[0] - half - this.origin[0]) / CELL));
        const cx1 = Math.min(this.nx - 1, Math.floor((eye[0] + half - this.origin[0]) / CELL));
        if (cx1 < cx0) continue;
        const first = T.cellStart[cz * this.nx + cx0];
        const last = T.cellStart[cz * this.nx + cx1 + 1];
        if (last <= first) continue;
        mn[0] = this.origin[0] + cx0 * CELL; mn[1] = this.minY; mn[2] = z0;
        mx[0] = this.origin[0] + (cx1 + 1) * CELL; mx[1] = this.maxY; mx[2] = z1;
        if (!aabbVisible(planes, mn, mx)) continue;
        out.push({ type: T, first, count: last - first });
        inst += last - first;
      }
    }
    this.stats.draws = out.length;
    this.stats.instances = inst;
  }

  get bytes() {
    return this.instances * 32;
  }
}
