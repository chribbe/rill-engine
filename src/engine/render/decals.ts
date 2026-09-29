import { mat4, quat, vec3 } from 'wgpu-matrix';
import type { DecalObject } from '../scene/mapformat';
import type { TextureManager } from './textures';
import { parseColor, type Color } from './materials';

/**
 * Projected decals evaluated inside the forward material shader, before
 * lighting: they modify albedo / roughness / AO, so baked and dynamic lighting
 * apply to them naturally. Static decals are binned into a world-space XZ grid;
 * each pixel only loops over the decals of its cell.
 */

export interface DecalMaterialDef {
  texture: string;
  tint?: Color;
  opacity?: number;
  /** Roughness written where the decal is opaque; omit to keep the surface's. */
  roughness?: number;
  normalStrength?: number;
  /** Angle fade width (dot(normal, axis) range). */
  angleFade?: number;
}

export const DECAL_FLOATS = 24;
const LAYER_SIZE = 512;

export interface DecalBuild {
  packed: Float32Array;
  count: number;
  cells: Uint32Array;
  grid: { originX: number; originZ: number; cell: number; nx: number; nz: number; maxPer: number };
  atlas: GPUTextureView;
  bytes: number;
}

export async function buildDecals(device: GPUDevice, textures: TextureManager, decals: DecalObject[], materialBase = '/materials/', textureBase = '/textures/'): Promise<DecalBuild | null> {
  if (decals.length === 0) return null;
  const matNames = [...new Set(decals.map((d) => d.decal.material))];
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

  const packed = new Float32Array(decals.length * DECAL_FLOATS);
  const boxes: { min: number[]; max: number[] }[] = [];
  decals.forEach((d, i) => {
    const t = d.transform;
    const q = t.rotation ?? [0, 0, 0, 1];
    const s = d.decal.size;
    const m = mat4.translation(t.position);
    mat4.multiply(m, mat4.fromQuat(q), m);
    mat4.scale(m, s, m);
    const inv = mat4.inverse(m);
    const o = i * DECAL_FLOATS;
    // rows of the world -> box affine
    for (let r = 0; r < 3; r++) packed.set([inv[r], inv[4 + r], inv[8 + r], inv[12 + r]], o + r * 4);
    const mat = mats.get(d.decal.material)!;
    const layer = layerOf.get(mat.texture) ?? 0;
    packed.set([layer, (d.decal.opacity ?? 1) * (mat.opacity ?? 1), mat.normalStrength ?? 0, mat.roughness ?? -1], o + 12);
    const tint = parseColor(mat.tint, [1, 1, 1, 1]);
    packed.set([tint[0], tint[1], tint[2], d.decal.repeat ?? 1], o + 16);
    const axis = vec3.transformQuat([0, 0, 1], quat.fromValues(q[0], q[1], q[2], q[3]));
    packed.set([axis[0], axis[1], axis[2], mat.angleFade ?? 0.3], o + 20);
    // World AABB of the box corners.
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 8; c++) {
      const p = vec3.transformMat4([(c & 1 ? 0.5 : -0.5), (c & 2 ? 0.5 : -0.5), (c & 4 ? 0.5 : -0.5)], m);
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
    }
    boxes.push({ min, max });
  });
  const cell = 8;
  let gx0 = Infinity, gz0 = Infinity, gx1 = -Infinity, gz1 = -Infinity;
  for (const b of boxes) { gx0 = Math.min(gx0, b.min[0]); gz0 = Math.min(gz0, b.min[2]); gx1 = Math.max(gx1, b.max[0]); gz1 = Math.max(gz1, b.max[2]); }
  gx0 = Math.floor(gx0 / cell) * cell;
  gz0 = Math.floor(gz0 / cell) * cell;
  const nx = Math.max(1, Math.ceil((gx1 - gx0) / cell));
  const nz = Math.max(1, Math.ceil((gz1 - gz0) / cell));
  const lists: number[][] = Array.from({ length: nx * nz }, () => []);
  boxes.forEach((b, i) => {
    for (let x = Math.floor((b.min[0] - gx0) / cell); x <= Math.floor((b.max[0] - gx0) / cell); x++) {
      for (let z = Math.floor((b.min[2] - gz0) / cell); z <= Math.floor((b.max[2] - gz0) / cell); z++) {
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
  let bytes = 0;
  for (let m = 0; m < mips; m++) bytes += (LAYER_SIZE >> m) ** 2 * 4 * texNames.length;
  return {
    packed, count: decals.length, cells,
    grid: { originX: gx0, originZ: gz0, cell, nx, nz, maxPer },
    atlas: atlasTex.createView({ dimension: '2d-array' }),
    bytes,
  };
}
