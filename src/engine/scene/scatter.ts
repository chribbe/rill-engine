import type { ScatterObject } from './mapformat';

/**
 * Deterministic scatter evaluation. The entity's local XZ plane is divided into
 * cells of one candidate each (cell size from the density); every cell derives
 * its jitter, acceptance, species, yaw and scale from a hash of (seed, cell), so
 * a result depends only on that cell: painting, erasing or removing one tree
 * never reshuffles the rest, and the same document always gives the same forest.
 */

export interface ScatterSpecies {
  /** Mesh / model reference (as entity assets). */
  asset: string;
  weight: number;
  /** Uniform scale range. */
  scale?: [number, number];
  /** Metres pushed into the ground (root flare, slopes). */
  sink?: number;
  /** Relative candidate density for this species (small shrubs fill more cells). */
  name?: string;
}

export interface ScatterPreset {
  format: 'rill.scatter';
  name: string;
  description?: string;
  species: ScatterSpecies[];
  /** Instances per 100 m². */
  density: number;
  /** 0 = even cover, 1 = strong clumps and glades. */
  clumping?: number;
  /** Clump size (m). */
  clumpScale?: number;
  /** Species form patches of this size (m); 0 = mixed per tree. */
  patchScale?: number;
  /** Density fades over this distance (m) inside the painted edge. */
  edgeFalloff?: number;
  surfaces?: string[];
  slopeMax?: number;
  semantic?: string;
  castShadow?: boolean;
}

export interface ScatterInstance {
  /** Cell key "ix,iz" (stable identity for removal / detaching). */
  key: string;
  species: number;
  position: [number, number, number];
  yawDeg: number;
  scale: number;
}

export interface GroundSample {
  height: number;
  owner: string;
  ny: number;
}

function hash(seed: number, x: number, z: number, salt: number): number {
  let h = (seed ^ Math.imul(x, 0x27d4eb2d) ^ Math.imul(z, 0x165667b1) ^ Math.imul(salt, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1]. */
function noise(seed: number, x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const s = (t: number) => t * t * (3 - 2 * t);
  const a = hash(seed, ix, iz, 7), b = hash(seed, ix + 1, iz, 7), c = hash(seed, ix, iz + 1, 7), d = hash(seed, ix + 1, iz + 1, 7);
  const u = s(fx), v = s(fz);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function inPolygon(x: number, z: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from (x, z) to the polygon boundary. */
function polyEdgeDist(x: number, z: number, poly: [number, number][]): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, az] = poly[j], [bx, bz] = poly[i];
    const vx = bx - ax, vz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz || 1)));
    best = Math.min(best, Math.hypot(x - ax - vx * t, z - az - vz * t));
  }
  return best;
}

/** Local bounds of everything painted or outlined. */
export function scatterBounds(s: ScatterObject['scatter']): { min: [number, number]; max: [number, number] } | null {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of s.area ?? []) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
  for (const [x, z, r, mode] of s.brush ?? []) if (mode) { x0 = Math.min(x0, x - r); z0 = Math.min(z0, z - r); x1 = Math.max(x1, x + r); z1 = Math.max(z1, z + r); }
  return Number.isFinite(x0) ? { min: [x0, z0], max: [x1, z1] } : null;
}

/**
 * Evaluates a scatter. `toWorld` maps local (x, z) to world (x, z); `ground` returns
 * the topmost surface there (null = none); `semanticOf` resolves the owner entity.
 */
export function evaluateScatter(
  e: ScatterObject,
  preset: ScatterPreset,
  toWorld: (x: number, z: number) => [number, number],
  ground: (x: number, z: number) => GroundSample | null,
  semanticOf: (id: string) => string | undefined,
  maxInstances = 20000,
): ScatterInstance[] {
  const s = e.scatter;
  const b = scatterBounds(s);
  if (!b || !preset.species.length) return [];
  const density = Math.max(0.01, s.density ?? preset.density);
  const cell = 10 / Math.sqrt(density);
  const seed = s.seed >>> 0;
  const surfaces = new Set(s.surfaces ?? preset.surfaces ?? ['terrain']);
  const minNy = Math.cos(((s.slopeMax ?? preset.slopeMax ?? 40) * Math.PI) / 180);
  const exclude = new Set(s.exclude ?? []);
  const clump = preset.clumping ?? 0, clumpScale = preset.clumpScale ?? 25;
  const patch = preset.patchScale ?? 0;
  const fall = preset.edgeFalloff ?? 0;
  const brush = s.brush ?? [], area = s.area && s.area.length >= 3 ? s.area : null;
  const wsum = preset.species.reduce((a, sp) => a + Math.max(0, sp.weight), 0) || 1;
  const out: ScatterInstance[] = [];
  const ix0 = Math.floor(b.min[0] / cell), ix1 = Math.floor(b.max[0] / cell);
  const iz0 = Math.floor(b.min[1] / cell), iz1 = Math.floor(b.max[1] / cell);
  for (let iz = iz0; iz <= iz1; iz++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const key = `${ix},${iz}`;
      if (exclude.has(key)) continue;
      const lx = (ix + 0.15 + 0.7 * hash(seed, ix, iz, 1)) * cell;
      const lz = (iz + 0.15 + 0.7 * hash(seed, ix, iz, 2)) * cell;
      // Inside: decided by the last brush circle containing the point, else the area polygon.
      // depth = distance to the painted edge (soft edges).
      let depth = -Infinity;
      if (area && inPolygon(lx, lz, area)) depth = fall > 0 ? polyEdgeDist(lx, lz, area) : Infinity;
      let last = -1;
      for (let i = brush.length - 1; i >= 0; i--) {
        const [x, z, r] = brush[i];
        if (Math.hypot(lx - x, lz - z) < r) { last = i; break; }
      }
      if (last >= 0) {
        if (!brush[last][3]) continue;
        // Depth through the run of paint circles that contain the point.
        depth = Math.max(depth, 0);
        for (let i = last; i >= 0; i--) {
          const [x, z, r, mode] = brush[i];
          const d = Math.hypot(lx - x, lz - z);
          if (d < r && mode) depth = Math.max(depth, r - d);
        }
      }
      if (depth <= 0) continue;
      // Acceptance: clumps / glades and the soft edge.
      let p = 1;
      if (clump > 0) p *= Math.max(0, Math.min(1, 1 - clump + clump * 1.8 * (noise(seed + 17, lx / clumpScale, lz / clumpScale) - 0.25)));
      if (fall > 0 && depth < fall) p *= depth / fall;
      if (hash(seed, ix, iz, 3) >= p) continue;
      // Species: weighted; with patches, each species' weight is modulated by its own noise
      // field so groves form while the overall mix keeps the preset's proportions.
      const r = hash(seed, ix, iz, 4);
      let k = 0;
      if (patch > 0) {
        let tot = 0;
        const w = preset.species.map((sp, i) => {
          const v = Math.max(0, sp.weight) * (0.15 + 1.7 * noise(seed + 31 + i * 101, lx / patch, lz / patch));
          tot += v;
          return v;
        });
        let acc = 0;
        for (; k < w.length - 1; k++) {
          acc += w[k] / tot;
          if (r < acc) break;
        }
      } else {
        let acc = 0;
        for (; k < preset.species.length - 1; k++) {
          acc += Math.max(0, preset.species[k].weight) / wsum;
          if (r < acc) break;
        }
      }
      const sp = preset.species[k];
      const [wx, wz] = toWorld(lx, lz);
      const g = ground(wx, wz);
      if (!g || g.ny < minNy) continue;
      if (surfaces.size && !surfaces.has(semanticOf(g.owner) ?? '')) continue;
      const [s0, s1] = sp.scale ?? [1, 1];
      const scale = s0 + (s1 - s0) * hash(seed, ix, iz, 5);
      out.push({ key, species: k, position: [wx, g.height - (sp.sink ?? 0) * scale, wz], yawDeg: hash(seed, ix, iz, 6) * 360, scale });
      if (out.length >= maxInstances) return out;
    }
  }
  return out;
}
