import { mat4, quat, vec3 } from 'wgpu-matrix';
import type { DecalObject } from '../scene/mapformat';
import type { TextureManager } from './textures';
import { parseColor, type Color } from './materials';

/**
 * Projected decals evaluated inside the forward material shader, before
 * lighting: they modify albedo / roughness / AO, so baked and dynamic lighting
 * apply to them naturally. Static decals are binned into a world-space XZ grid;
 * each pixel only loops over the decals of its cell. Runtime decals (bullet
 * holes) are appended to the same buffer and grid.
 */

export interface DecalMaterialDef {
  texture: string;
  tint?: Color;
  opacity?: number;
  /** Roughness written where the decal is opaque; omit to keep the surface's. */
  roughness?: number;
  /** Bullet-hole relief: strength of an analytic crater (pit + raised lip) normal. */
  crater?: number;
  /** Angle fade width (dot(normal, axis) range). */
  angleFade?: number;
}

export const DECAL_FLOATS = 24;
const LAYER_SIZE = 512;
/** Runtime decals (bullet holes) kept in a ring; the oldest is replaced. */
export const MAX_DYNAMIC_DECALS = 192;
const CELL = 8;

export interface DecalGrid { originX: number; originZ: number; cell: number; nx: number; nz: number; maxPer: number }

interface Box { min: number[]; max: number[] }

/**
 * All decals of a map: static ones from the map document plus a ring of
 * runtime decals. Rebuilding the XZ grid is cheap (CPU, only when a decal is
 * added), so static and dynamic decals share one buffer and one per-pixel loop.
 */
export class DecalSet {
  readonly atlas: GPUTextureView;
  readonly bytes: number;
  private staticPacked: Float32Array;
  private staticBoxes: Box[];
  private dynPacked = new Float32Array(MAX_DYNAMIC_DECALS * DECAL_FLOATS);
  private dynBoxes: Box[] = [];
  private dynNext = 0;

  constructor(atlas: GPUTextureView, bytes: number, private mats: Map<string, DecalMaterialDef>, private layerOf: Map<string, number>, staticDecals: DecalObject[]) {
    this.atlas = atlas;
    this.bytes = bytes;
    this.staticPacked = new Float32Array(staticDecals.length * DECAL_FLOATS);
    this.staticBoxes = staticDecals.map((d, i) => {
      const t = d.transform;
      return this.pack(this.staticPacked, i * DECAL_FLOATS, d.decal.material, t.position, t.rotation ?? [0, 0, 0, 1], d.decal.size, d.decal.opacity ?? 1, d.decal.repeat ?? 1);
    });
  }

  get count() {
    return this.staticBoxes.length + this.dynBoxes.length;
  }

  /** True when every decal's material is already in the atlas (else rebuild with `buildDecals`). */
  covers(decals: DecalObject[]) {
    return decals.every((d) => this.mats.has(d.decal.material));
  }

  /** Replaces the static (map) decals, e.g. after editor edits; runtime decals are kept. */
  setStatic(decals: DecalObject[]) {
    this.staticPacked = new Float32Array(decals.length * DECAL_FLOATS);
    this.staticBoxes = decals.map((d, i) => {
      const t = d.transform;
      return this.pack(this.staticPacked, i * DECAL_FLOATS, d.decal.material, t.position, t.rotation ?? [0, 0, 0, 1], d.decal.size, d.decal.opacity ?? 1, d.decal.repeat ?? 1);
    });
  }

  has(material: string) {
    return this.mats.has(material);
  }

  private pack(out: Float32Array, o: number, material: string, position: ArrayLike<number>, q: ArrayLike<number>, size: ArrayLike<number>, opacity: number, repeat: number): Box {
    const m = mat4.translation(position);
    mat4.multiply(m, mat4.fromQuat(q), m);
    mat4.scale(m, size, m);
    const inv = mat4.inverse(m);
    // rows of the world -> box affine
    for (let r = 0; r < 3; r++) out.set([inv[r], inv[4 + r], inv[8 + r], inv[12 + r]], o + r * 4);
    const mat = this.mats.get(material) ?? { texture: '' };
    const layer = this.layerOf.get(mat.texture) ?? 0;
    out.set([layer, opacity * (mat.opacity ?? 1), mat.crater ?? 0, mat.roughness ?? -1], o + 12);
    const tint = parseColor(mat.tint, [1, 1, 1, 1]);
    out.set([tint[0], tint[1], tint[2], repeat], o + 16);
    const axis = vec3.transformQuat([0, 0, 1], quat.fromValues(q[0], q[1], q[2], q[3]));
    out.set([axis[0], axis[1], axis[2], mat.angleFade ?? 0.3], o + 20);
    // World AABB of the box corners.
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 8; c++) {
      const p = vec3.transformMat4([(c & 1 ? 0.5 : -0.5), (c & 2 ? 0.5 : -0.5), (c & 4 ? 0.5 : -0.5)], m);
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
    }
    return { min, max };
  }

  /**
   * Adds a runtime decal projected along -normal onto the surface at `point`.
   * `size` is the footprint (m); depth is a few cm so it only touches the hit surface.
   */
  addDynamic(material: string, point: ArrayLike<number>, normal: ArrayLike<number>, size: number, angle = Math.random() * Math.PI * 2, depth = 0.06) {
    // Box +Z = surface normal (projection axis), rolled by `angle` around it.
    const z = vec3.normalize(vec3.fromValues(normal[0], normal[1], normal[2]));
    const ref = Math.abs(z[1]) < 0.9 ? vec3.fromValues(0, 1, 0) : vec3.fromValues(1, 0, 0);
    const x0 = vec3.normalize(vec3.cross(ref, z));
    const y0 = vec3.cross(z, x0);
    const c = Math.cos(angle), s = Math.sin(angle);
    const x = vec3.add(vec3.scale(x0, c), vec3.scale(y0, s));
    const y = vec3.cross(z, x);
    const q = quat.fromMat(mat4.create(x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, 0, 0, 0, 1));
    const i = this.dynNext;
    this.dynNext = (this.dynNext + 1) % MAX_DYNAMIC_DECALS;
    this.dynBoxes[i] = this.pack(this.dynPacked, i * DECAL_FLOATS, material, point, q, [size, size, depth], 1, 1);
  }

  clearDynamic() {
    this.dynBoxes.length = 0;
    this.dynNext = 0;
  }

  /** Packed decal structs (static then dynamic) and the XZ grid of per-cell lists. */
  build(): { packed: Float32Array; count: number; cells: Uint32Array; grid: DecalGrid } {
    const ns = this.staticBoxes.length, nd = this.dynBoxes.length;
    const packed = new Float32Array(Math.max(1, ns + nd) * DECAL_FLOATS);
    packed.set(this.staticPacked);
    packed.set(this.dynPacked.subarray(0, nd * DECAL_FLOATS), ns * DECAL_FLOATS);
    const boxes = [...this.staticBoxes, ...this.dynBoxes];
    let gx0 = Infinity, gz0 = Infinity, gx1 = -Infinity, gz1 = -Infinity;
    for (const b of boxes) { gx0 = Math.min(gx0, b.min[0]); gz0 = Math.min(gz0, b.min[2]); gx1 = Math.max(gx1, b.max[0]); gz1 = Math.max(gz1, b.max[2]); }
    if (boxes.length === 0) { gx0 = gz0 = 0; gx1 = gz1 = CELL; }
    gx0 = Math.floor(gx0 / CELL) * CELL;
    gz0 = Math.floor(gz0 / CELL) * CELL;
    const nx = Math.max(1, Math.ceil((gx1 - gx0) / CELL));
    const nz = Math.max(1, Math.ceil((gz1 - gz0) / CELL));
    const lists: number[][] = Array.from({ length: nx * nz }, () => []);
    boxes.forEach((b, i) => {
      for (let x = Math.floor((b.min[0] - gx0) / CELL); x <= Math.floor((b.max[0] - gx0) / CELL); x++) {
        for (let z = Math.floor((b.min[2] - gz0) / CELL); z <= Math.floor((b.max[2] - gz0) / CELL); z++) {
          if (x >= 0 && z >= 0 && x < nx && z < nz) lists[z * nx + x].push(i);
        }
      }
    });
    const maxPer = Math.max(1, ...lists.map((l) => l.length));
    const cells = new Uint32Array(nx * nz * (maxPer + 1));
    lists.forEach((l, c) => {
      cells[c * (maxPer + 1)] = l.length;
      l.forEach((v, k) => (cells[c * (maxPer + 1) + 1 + k] = v));
    });
    return { packed, count: ns + nd, cells, grid: { originX: gx0, originZ: gz0, cell: CELL, nx, nz, maxPer } };
  }
}

/** Loads decal materials (the map's plus `extraMaterials` for runtime decals) into one texture array. */
export async function buildDecals(device: GPUDevice, textures: TextureManager, decals: DecalObject[], extraMaterials: string[] = [], materialBase = '/materials/', textureBase = '/textures/'): Promise<DecalSet | null> {
  const matNames = [...new Set([...decals.map((d) => d.decal.material), ...extraMaterials])];
  if (matNames.length === 0) return null;
  const mats = new Map<string, DecalMaterialDef>();
  await Promise.all(
    matNames.map(async (n) => {
      const r = await fetch(`${materialBase}${n}.json`);
      mats.set(n, r.ok ? await r.json() : { texture: '' });
    }),
  );
  const texNames = [...new Set([...mats.values()].map((m) => m.texture).filter(Boolean))];
  const layerOf = new Map<string, number>();
  const mips = Math.log2(LAYER_SIZE) + 1;
  const atlasTex = device.createTexture({
    label: 'decalAtlas',
    size: [LAYER_SIZE, LAYER_SIZE, Math.max(1, texNames.length)],
    format: 'rgba8unorm-srgb',
    mipLevelCount: mips,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const handles = await Promise.all(texNames.map((t) => textures.load(textureBase + t, 'color', { wrap: false })));
  const enc = device.createCommandEncoder({ label: 'decalAtlas' });
  handles.forEach((h, i) => {
    layerOf.set(texNames[i], i);
    if (h.width !== LAYER_SIZE || h.height !== LAYER_SIZE) {
      console.warn(`[decals] ${texNames[i]} must be ${LAYER_SIZE}x${LAYER_SIZE}`);
      return;
    }
    for (let m = 0; m < mips; m++) {
      const s = LAYER_SIZE >> m;
      enc.copyTextureToTexture({ texture: h.texture, mipLevel: m }, { texture: atlasTex, mipLevel: m, origin: [0, 0, i] }, [s, s, 1]);
    }
  });
  device.queue.submit([enc.finish()]);
  let bytes = 0;
  for (let m = 0; m < mips; m++) bytes += (LAYER_SIZE >> m) ** 2 * 4 * texNames.length;
  return new DecalSet(atlasTex.createView({ dimension: '2d-array' }), bytes, mats, layerOf, decals);
}
