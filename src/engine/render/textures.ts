import { shaderModule } from './shaderlib';

export type TextureKind = 'color' | 'linear' | 'normal';

export interface TextureHandle {
  texture: GPUTexture;
  /** View used for sampling (sRGB view for colour textures). */
  view: GPUTextureView;
  width: number;
  height: number;
  kind: TextureKind;
  bytes: number;
  url: string;
  /** Block-compressed (BC7) upload from an offline KTX2. */
  compressed?: boolean;
}

/** Entry of public/textures/bc7/index.json (written by tools/textures/compress.ts). */
interface CompressedEntry {
  kind: TextureKind;
  file: string;
  width: number;
  height: number;
  levels: number;
  bytes: number;
}

export interface TextureLoadOptions {
  /** Tiling textures wrap during mip filtering so mips stay seamless. */
  wrap?: boolean;
}

export type MipFilter = 'box' | 'lanczos';

function mipCount(w: number, h: number) {
  return Math.floor(Math.log2(Math.max(w, h))) + 1;
}

/**
 * Loads PNG textures and builds mip chains on the GPU:
 *  - colour: filtered in linear space (sRGB decode/encode in the shader), sampled via an sRGB view
 *  - normal: averaged unit vectors, lost variance stored in alpha (specular anti-aliasing)
 *  - linear: plain filtering (ORM, masks)
 */
export class TextureManager {
  private cache = new Map<string, Promise<TextureHandle>>();
  private pipeline: GPUComputePipeline;
  private paramBuffers = new Map<string, GPUBuffer>();
  readonly all: TextureHandle[] = [];
  mipFilter: MipFilter = 'lanczos';
  /** url -> offline BC7 version (null = compression disabled / unsupported). */
  private compressed: Map<string, { url: string; entry: CompressedEntry }> | null = null;

  readonly white: TextureHandle;
  readonly black: TextureHandle;
  readonly gray: TextureHandle;
  readonly flatNormal: TextureHandle;
  readonly defaultOrm: TextureHandle;

  constructor(private device: GPUDevice) {
    this.pipeline = device.createComputePipeline({
      label: 'mipgen',
      layout: 'auto',
      compute: { module: shaderModule(device, 'mipgen'), entryPoint: 'main' },
    });
    this.white = this.solid('white', [255, 255, 255, 255], 'color');
    this.black = this.solid('black', [0, 0, 0, 255], 'color');
    this.gray = this.solid('gray', [128, 128, 128, 255], 'linear');
    this.flatNormal = this.solid('flatNormal', [128, 128, 255, 255], 'normal');
    // ORM(H): AO = 1, roughness = 1 (scaled by the material factor), metallic = 0, height = 0.5
    this.defaultOrm = this.solid('defaultOrm', [255, 255, 0, 128], 'linear');
  }

  /**
   * Uses offline BC7 KTX2 files for textures listed in the index when the device
   * supports BC formats. Must run before materials load. Textures are only
   * substituted when the requested kind matches the kind they were encoded for
   * (mips/colour space are baked offline) and they tile (wrap = true).
   */
  async enableCompression(indexUrl = '/textures/bc7/index.json'): Promise<number> {
    if (!this.device.features.has('texture-compression-bc')) return 0;
    try {
      const res = await fetch(indexUrl);
      if (!res.ok) return 0;
      const doc = (await res.json()) as { textures: Record<string, CompressedEntry> };
      const dir = indexUrl.slice(0, indexUrl.lastIndexOf('/') + 1);
      const root = dir.replace(/bc7\/$/, '');
      this.compressed = new Map();
      for (const [file, entry] of Object.entries(doc.textures)) this.compressed.set(root + file, { url: dir + entry.file, entry });
      return this.compressed.size;
    } catch (e) {
      console.warn('[textures] compressed index unavailable', e);
      return 0;
    }
  }

  get compressedCount() {
    return this.all.filter((t) => t.compressed).length;
  }

  get totalBytes() {
    let b = 0;
    for (const t of this.all) b += t.bytes;
    return b;
  }

  solid(name: string, rgba: number[], kind: TextureKind): TextureHandle {
    const texture = this.device.createTexture({
      label: `solid:${name}`,
      size: [1, 1],
      format: 'rgba8unorm',
      viewFormats: kind === 'color' ? ['rgba8unorm-srgb'] : [],
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture({ texture }, new Uint8Array(rgba), { bytesPerRow: 4 }, [1, 1]);
    const view = texture.createView(kind === 'color' ? { format: 'rgba8unorm-srgb' } : {});
    const h: TextureHandle = { texture, view, width: 1, height: 1, kind, bytes: 4, url: `solid:${name}` };
    this.all.push(h);
    return h;
  }

  load(url: string, kind: TextureKind, opts: TextureLoadOptions = {}): Promise<TextureHandle> {
    const key = `${url}|${kind}|${opts.wrap ?? true}`;
    let p = this.cache.get(key);
    if (!p) {
      p = this.loadImpl(url, kind, opts.wrap ?? true);
      this.cache.set(key, p);
    }
    return p;
  }

  private async loadImpl(url: string, kind: TextureKind, wrap: boolean): Promise<TextureHandle> {
    const c = wrap ? this.compressed?.get(url) : undefined;
    if (c && c.entry.kind === kind) {
      try {
        return await this.loadKtx2(url, c.url, kind);
      } catch (e) {
        console.warn(`[textures] ${c.url}: ${(e as Error).message}; falling back to PNG`);
      }
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Texture fetch failed: ${url} (${res.status})`);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const { width, height } = bitmap;
    const mips = mipCount(width, height);
    const texture = this.device.createTexture({
      label: url,
      size: [width, height],
      format: 'rgba8unorm',
      mipLevelCount: mips,
      viewFormats: kind === 'color' ? ['rgba8unorm-srgb'] : [],
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.device.queue.copyExternalImageToTexture(
      { source: bitmap },
      { texture, mipLevel: 0, premultipliedAlpha: false },
      [width, height],
    );
    bitmap.close();
    this.generateMips(texture, kind, wrap);
    // The sRGB view must not inherit STORAGE usage (not valid for sRGB formats).
    const view = texture.createView(
      kind === 'color' ? { format: 'rgba8unorm-srgb', usage: GPUTextureUsage.TEXTURE_BINDING } : { usage: GPUTextureUsage.TEXTURE_BINDING },
    );
    let bytes = 0;
    for (let i = 0; i < mips; i++) bytes += Math.max(1, width >> i) * Math.max(1, height >> i) * 4;
    const h: TextureHandle = { texture, view, width, height, kind, bytes, url };
    this.all.push(h);
    return h;
  }

  /** KTX2 with BC7 levels (no supercompression), uploaded as-is. */
  private async loadKtx2(url: string, ktxUrl: string, kind: TextureKind): Promise<TextureHandle> {
    const res = await fetch(ktxUrl);
    if (!res.ok) throw new Error(`fetch failed (${res.status})`);
    const buf = await res.arrayBuffer();
    const dv = new DataView(buf);
    const ID = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
    if (ID.some((b, i) => dv.getUint8(i) !== b)) throw new Error('not a KTX2 file');
    const vk = dv.getUint32(12, true);
    const width = dv.getUint32(20, true);
    const height = dv.getUint32(24, true);
    const levels = Math.max(1, dv.getUint32(40, true));
    if (dv.getUint32(44, true) !== 0) throw new Error('supercompressed KTX2 not supported');
    const format: GPUTextureFormat | undefined = vk === 146 ? 'bc7-rgba-unorm-srgb' : vk === 145 ? 'bc7-rgba-unorm' : undefined;
    if (!format) throw new Error(`unsupported vkFormat ${vk}`);
    if ((format === 'bc7-rgba-unorm-srgb') !== (kind === 'color')) throw new Error('colour space does not match texture kind');
    const texture = this.device.createTexture({
      label: url,
      size: [width, height],
      format,
      mipLevelCount: levels,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    let bytes = 0;
    for (let i = 0; i < levels; i++) {
      const off = Number(dv.getBigUint64(80 + i * 24, true));
      const len = Number(dv.getBigUint64(88 + i * 24, true));
      const bw = Math.ceil(Math.max(1, width >> i) / 4), bh = Math.ceil(Math.max(1, height >> i) / 4);
      if (len !== bw * bh * 16) throw new Error(`level ${i}: ${len} bytes, expected ${bw * bh * 16}`);
      this.device.queue.writeTexture({ texture, mipLevel: i }, new Uint8Array(buf, off, len), { bytesPerRow: bw * 16, rowsPerImage: bh }, [bw * 4, bh * 4]);
      bytes += len;
    }
    const h: TextureHandle = { texture, view: texture.createView(), width, height, kind, bytes, url, compressed: true };
    this.all.push(h);
    return h;
  }

  private params(kind: TextureKind, wrap: boolean): GPUBuffer {
    const mode = kind === 'color' ? 0 : kind === 'linear' ? 1 : 2;
    const filter = this.mipFilter === 'lanczos' ? 1 : 0;
    const key = `${mode}:${filter}:${wrap}`;
    let b = this.paramBuffers.get(key);
    if (!b) {
      b = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(b, 0, new Uint32Array([mode, filter, wrap ? 1 : 0, 0]));
      this.paramBuffers.set(key, b);
    }
    return b;
  }

  generateMips(texture: GPUTexture, kind: TextureKind, wrap: boolean) {
    const levels = texture.mipLevelCount;
    if (levels <= 1) return;
    const enc = this.device.createCommandEncoder({ label: 'mipgen' });
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipeline);
    const params = this.params(kind, wrap);
    for (let i = 1; i < levels; i++) {
      const bg = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: params } },
          { binding: 1, resource: texture.createView({ baseMipLevel: i - 1, mipLevelCount: 1, format: 'rgba8unorm' }) },
          { binding: 2, resource: texture.createView({ baseMipLevel: i, mipLevelCount: 1, format: 'rgba8unorm' }) },
        ],
      });
      pass.setBindGroup(0, bg);
      const w = Math.max(1, texture.width >> i);
      const h = Math.max(1, texture.height >> i);
      pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    }
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }
}
