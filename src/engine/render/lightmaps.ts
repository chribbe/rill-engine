import type { LightmapSetDocument } from '../scene/mapformat';

/**
 * Runtime lightmap support. A LightmapSet (produced by any bake backend) is a
 * set of atlas pages, each holding one texture per component:
 *   sky       - irradiance/PI from a uniform white sky of radiance 1 (incl. bounces)
 *   sunBounce - indirect-only irradiance/PI from a sun of illuminance 1
 * Both are linear in their light source, so the runtime rescales them by the
 * current sky and sun: weather and sun intensity change without rebaking, and
 * direct sunlight + shadows stay fully dynamic.
 * Textures are stored as rgb9e5ufloat (4 bytes/texel, HDR, filterable).
 */

export interface LoadedLightmaps {
  doc: LightmapSetDocument;
  texture: GPUTexture;
  view: GPUTextureView;
  layers: number;
  bytes: number;
  /** Directional (radiosity normal mapping) sky components present. */
  directional: boolean;
  probeVolume: LoadedProbeVolume | null;
}

export interface LoadedProbeVolume {
  texture: GPUTexture;
  view: GPUTextureView;
  origin: [number, number, number];
  spacing: [number, number, number];
  dims: [number, number, number];
  bytes: number;
  /** Per probe: sky irradiance on the up face relative to open sky (0 enclosed .. 1 open). CPU copy. */
  skyVisibility: Float32Array;
}

function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

/**
 * Probe volume: ambient cubes (6 faces x {sky, sunBounce} x RGB, float16) packed
 * into one 3D rgba16float texture of size (nx, ny, nz * 12) - one z-slab per
 * (component, face) so hardware trilinear filtering works within each slab.
 */
async function loadProbeVolume(device: GPUDevice, base: string, pv: NonNullable<LightmapSetDocument['probeVolumes']>[number]): Promise<LoadedProbeVolume> {
  const r = await fetch(base + pv.file);
  if (!r.ok) throw new Error(`Probe volume fetch failed: ${pv.file}`);
  const src = new Uint16Array(await r.arrayBuffer());
  const [nx, ny, nz] = pv.dims;
  const out = new Uint16Array(nx * ny * nz * 12 * 4);
  const ONE = 0x3c00;
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const p = (z * ny + y) * nx + x;
        for (let c = 0; c < 2; c++) {
          for (let f = 0; f < 6; f++) {
            const s = c * 6 + f;
            const i = ((p * 2 + c) * 6 + f) * 3;
            const o = (((s * nz + z) * ny + y) * nx + x) * 4;
            out[o] = src[i];
            out[o + 1] = src[i + 1];
            out[o + 2] = src[i + 2];
            out[o + 3] = ONE;
          }
        }
      }
    }
  }
  // Sky visibility per probe (component 0 = sky, face 2 = +Y), normalised by open sky (p95).
  const vis = new Float32Array(nx * ny * nz);
  for (let p = 0; p < vis.length; p++) {
    const i = ((p * 2) * 6 + 2) * 3;
    vis[p] = 0.2126 * halfToFloat(src[i]) + 0.7152 * halfToFloat(src[i + 1]) + 0.0722 * halfToFloat(src[i + 2]);
  }
  const sorted = Float32Array.from(vis).sort();
  const open = Math.max(1e-4, sorted[Math.floor(sorted.length * 0.95)]);
  for (let p = 0; p < vis.length; p++) vis[p] = Math.min(1, Math.max(0, vis[p] / open));
  const texture = device.createTexture({
    label: `probeVolume:${pv.id}`,
    size: [nx, ny, nz * 12],
    dimension: '3d',
    format: 'rgba16float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture }, out, { bytesPerRow: nx * 8, rowsPerImage: ny }, [nx, ny, nz * 12]);
  return { texture, view: texture.createView({ dimension: '3d' }), origin: pv.origin, spacing: pv.spacing, dims: pv.dims, bytes: out.byteLength, skyVisibility: vis };
}

/** Parses a Radiance .hdr (RGBE, new-style RLE or flat) into float RGB. Rows are top-to-bottom. */
export function parseHdr(buf: ArrayBuffer): { width: number; height: number; data: Float32Array } {
  const bytes = new Uint8Array(buf);
  let pos = 0;
  const readLine = () => {
    let s = '';
    while (pos < bytes.length && bytes[pos] !== 0x0a) s += String.fromCharCode(bytes[pos++]);
    pos++;
    return s;
  };
  const magic = readLine();
  if (!magic.startsWith('#?')) throw new Error('Not a Radiance HDR file');
  let line: string;
  while ((line = readLine()) !== '') {
    if (line.startsWith('FORMAT') && !line.includes('32-bit_rle_rgbe')) throw new Error(`Unsupported HDR format: ${line}`);
  }
  const res = readLine().trim().split(/\s+/);
  // Standard orientation: "-Y h +X w" (top-to-bottom rows).
  const height = parseInt(res[1], 10);
  const width = parseInt(res[3], 10);
  const flipY = res[0] === '+Y';
  const rgbe = new Uint8Array(width * height * 4);
  const scan = new Uint8Array(width * 4);
  for (let y = 0; y < height; y++) {
    const rleNew = width >= 8 && width < 32768 && bytes[pos] === 2 && bytes[pos + 1] === 2 && ((bytes[pos + 2] << 8) | bytes[pos + 3]) === width;
    if (rleNew) {
      pos += 4;
      for (let c = 0; c < 4; c++) {
        let x = 0;
        while (x < width) {
          let count = bytes[pos++];
          if (count > 128) {
            count -= 128;
            const v = bytes[pos++];
            for (let i = 0; i < count; i++) scan[(x++) * 4 + c] = v;
          } else {
            for (let i = 0; i < count; i++) scan[(x++) * 4 + c] = bytes[pos++];
          }
        }
      }
    } else {
      scan.set(bytes.subarray(pos, pos + width * 4));
      pos += width * 4;
    }
    const row = flipY ? height - 1 - y : y;
    rgbe.set(scan, row * width * 4);
  }
  const data = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const e = rgbe[i * 4 + 3];
    if (e === 0) continue;
    const f = Math.pow(2, e - 136);
    data[i * 3] = rgbe[i * 4] * f;
    data[i * 3 + 1] = rgbe[i * 4 + 1] * f;
    data[i * 3 + 2] = rgbe[i * 4 + 2] * f;
  }
  return { width, height, data };
}

/** Packs linear RGB floats into the rgb9e5ufloat shared-exponent format. */
export function packRgb9e5(rgb: Float32Array, n: number): Uint32Array<ArrayBuffer> {
  const out = new Uint32Array(n);
  const MAX = 65408; // (2^9 - 1) / 2^9 * 2^15
  for (let i = 0; i < n; i++) {
    const r = Math.min(Math.max(rgb[i * 3], 0), MAX);
    const g = Math.min(Math.max(rgb[i * 3 + 1], 0), MAX);
    const b = Math.min(Math.max(rgb[i * 3 + 2], 0), MAX);
    const m = Math.max(r, g, b);
    if (m <= 1e-9) continue;
    let e = Math.max(-16, Math.floor(Math.log2(m))) + 1 + 15;
    let denom = Math.pow(2, e - 15 - 9);
    if (Math.floor(m / denom + 0.5) === 512) {
      denom *= 2;
      e += 1;
    }
    const rm = Math.floor(r / denom + 0.5);
    const gm = Math.floor(g / denom + 0.5);
    const bm = Math.floor(b / denom + 0.5);
    out[i] = (rm | (gm << 9) | (bm << 18) | (e << 27)) >>> 0;
  }
  return out;
}

export async function loadLightmapSet(device: GPUDevice, url: string): Promise<LoadedLightmaps> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`LightmapSet fetch failed: ${url}`);
  const doc = (await res.json()) as LightmapSetDocument;
  const base = url.slice(0, url.lastIndexOf('/') + 1);
  const [w, h] = doc.atlasSize;
  const layers = doc.pages.length * doc.components.length;
  const texture = device.createTexture({
    label: 'lightmaps',
    size: [w, h, layers],
    format: 'rgb9e5ufloat',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const files: { layer: number; file: string }[] = [];
  doc.pages.forEach((page, pi) => {
    doc.components.forEach((comp, ci) => files.push({ layer: pi * doc.components.length + ci, file: page[comp] }));
  });
  await Promise.all(
    files.map(async ({ layer, file }) => {
      const r = await fetch(base + file);
      if (!r.ok) throw new Error(`Lightmap fetch failed: ${file}`);
      const img = parseHdr(await r.arrayBuffer());
      if (img.width !== w || img.height !== h) throw new Error(`Lightmap ${file} size mismatch`);
      const packed = packRgb9e5(img.data, w * h);
      device.queue.writeTexture({ texture, origin: [0, 0, layer] }, packed, { bytesPerRow: w * 4, rowsPerImage: h }, [w, h, 1]);
    }),
  );
  const probeVolume = doc.probeVolumes?.length ? await loadProbeVolume(device, base, doc.probeVolumes[0]) : null;
  return {
    doc, texture, view: texture.createView({ dimension: '2d-array' }), layers, bytes: w * h * 4 * layers + (probeVolume?.bytes ?? 0),
    directional: doc.components[1] === 'skyRnm0',
    probeVolume,
  };
}
