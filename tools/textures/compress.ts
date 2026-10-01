// Offline texture compression: material PNGs -> BC7 KTX2 with full mip chains.
//
//   node tools/textures/compress.ts [--force] [--jobs N]
//
// The texture kind (colour / normal / linear) comes from how materials use each
// file, and mips are built exactly like the runtime GPU path (src/shaders/mipgen.wgsl:
// Lanczos-2 in linear light for colour, vMF normal variance in alpha for normal
// maps, 8-bit quantised per level) so compressed and uncompressed loads match.
// Output: public/textures/bc7/<name>.ktx2 + index.json (read by TextureManager).
import { PNG } from 'pngjs';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { encodeBlock, decodeBlock } from './bc7.ts';
import { encodeBC5Block, decodeBC4Block } from './bc5.ts';

const PUBLIC = join(import.meta.dirname, '../../public');
const TEX = join(PUBLIC, 'textures');
const OUT = join(TEX, 'bc7');


type Kind = 'color' | 'linear' | 'normal';
/** normalPair: the normal map used with this ORM (its variance is folded into roughness). */
interface Job { file: string; kind: Kind; normalPair?: string }
interface Result { file: string; kind: Kind; format: 'bc7' | 'bc5'; width: number; height: number; levels: number; bytes: number; psnr: number[]; ms: number; modes: number[]; normalPair?: string }

// ------------------------------------------------------------ mip chain (mirrors mipgen.wgsl)
const LANCZOS = [-0.0412, 0.1144, 0.4268, 0.4268, 0.1144, -0.0412];
const s2l = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const l2s = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const q8 = (x: number) => Math.max(0, Math.min(255, Math.round(x * 255)));

export interface Level { w: number; h: number; data: Uint8Array }

export function nextLevel(src: Level, kind: Kind): Level {
  const sw = src.w, sh = src.h;
  const w = Math.max(1, sw >> 1), h = Math.max(1, sh >> 1);
  const out = new Uint8Array(w * h * 4);
  // Wrap addressing (tiling textures), source values decoded like the GPU fetch().
  const lin = new Float32Array(sw * sh * 4);
  for (let i = 0; i < sw * sh; i++) {
    for (let c = 0; c < 4; c++) {
      const v = src.data[i * 4 + c] / 255;
      lin[i * 4 + c] = kind === 'color' && c < 3 ? s2l(v) : v;
    }
  }
  const at = (x: number, y: number) => ((((y % sh) + sh) % sh) * sw + (((x % sw) + sw) % sw)) * 4;
  const stepX = sw > 1 ? 1 : 0, stepY = sh > 1 ? 1 : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const bx = x * 2, by = y * 2, o = (y * w + x) * 4;
      if (kind === 'normal') {
        let sx = 0, sy = 0, sz = 0, varSum = 0;
        for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
          const p = at(bx + i * stepX, by + j * stepY);
          const nx = lin[p] * 2 - 1, ny = lin[p + 1] * 2 - 1, nz = lin[p + 2] * 2 - 1;
          const l = Math.hypot(nx, ny, nz) || 1;
          sx += nx / l; sy += ny / l; sz += nz / l;
          varSum += (1 - lin[p + 3]) * 0.5;
        }
        sx *= 0.25; sy *= 0.25; sz *= 0.25;
        const r = Math.min(Math.hypot(sx, sy, sz), 0.9999);
        const kappa = (3 * r - r * r * r) / (1 - r * r);
        const v = Math.max(0, Math.min(0.5, varSum * 0.25 + 1 / kappa));
        const nz2 = sz + 1e-6;
        const l = Math.hypot(sx, sy, nz2) || 1;
        out[o] = q8((sx / l) * 0.5 + 0.5); out[o + 1] = q8((sy / l) * 0.5 + 0.5); out[o + 2] = q8((nz2 / l) * 0.5 + 0.5);
        out[o + 3] = q8(1 - 2 * v);
        continue;
      }
      const c = [0, 0, 0, 0];
      if (sw >= 4 && sh >= 4) {
        for (let j = 0; j < 6; j++) {
          const row = [0, 0, 0, 0];
          for (let i = 0; i < 6; i++) {
            const p = at(bx + i - 2, by + j - 2);
            for (let k = 0; k < 4; k++) row[k] += lin[p + k] * LANCZOS[i];
          }
          for (let k = 0; k < 4; k++) c[k] += row[k] * LANCZOS[j];
        }
        for (let k = 0; k < 4; k++) c[k] = Math.max(0, Math.min(1, c[k]));
      } else {
        for (const [dx, dy] of [[0, 0], [stepX, 0], [0, stepY], [stepX, stepY]]) {
          const p = at(bx + dx, by + dy);
          for (let k = 0; k < 4; k++) c[k] += lin[p + k] * 0.25;
        }
      }
      for (let k = 0; k < 4; k++) out[o + k] = q8(kind === 'color' && k < 3 ? l2s(c[k]) : c[k]);
    }
  }
  return { w, h, data: out };
}

// ------------------------------------------------------------ BC5 level encode (normal xy)
function encodeLevelBC5(L: Level): { data: Uint8Array; se: number } {
  const bw = Math.ceil(L.w / 4), bh = Math.ceil(L.h / 4);
  const data = new Uint8Array(bw * bh * 16);
  const px = new Float32Array(64);
  const dec = new Float32Array(16);
  let se = 0;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
        const sx = Math.min(bx * 4 + x, L.w - 1), sy = Math.min(by * 4 + y, L.h - 1);
        for (let c = 0; c < 4; c++) px[(y * 4 + x) * 4 + c] = L.data[(sy * L.w + sx) * 4 + c];
      }
      const off = (by * bw + bx) * 16;
      encodeBC5Block(px, data, off);
      for (const [ch, o] of [[0, 0], [1, 8]]) {
        decodeBC4Block(data, off + o, dec);
        for (let i = 0; i < 16; i++) { const d = dec[i] - px[i * 4 + ch]; se += d * d; }
      }
    }
  }
  return { data, se };
}

/** Normal variance (alpha of our normal mips) -> wider GGX roughness in the ORM's G channel. */
function foldVariance(orm: Level, nrm: Level) {
  for (let y = 0; y < orm.h; y++) for (let x = 0; x < orm.w; x++) {
    const nx = Math.min(nrm.w - 1, Math.floor((x + 0.5) * nrm.w / orm.w)), ny = Math.min(nrm.h - 1, Math.floor((y + 0.5) * nrm.h / orm.h));
    const v = (1 - nrm.data[(ny * nrm.w + nx) * 4 + 3] / 255) * 0.5;
    if (v <= 0) continue;
    const i = (y * orm.w + x) * 4 + 1;
    const r = orm.data[i] / 255;
    // Shader: alpha = r^2, alpha' = sqrt(alpha^2 + v)  =>  r' = (r^4 + v)^(1/4).
    orm.data[i] = q8(Math.pow(r ** 4 + v, 0.25));
  }
}

// ------------------------------------------------------------ BC7 level encode
function encodeLevel(L: Level, modes: number[]): { data: Uint8Array; se: number } {
  const bw = Math.ceil(L.w / 4), bh = Math.ceil(L.h / 4);
  const data = new Uint8Array(bw * bh * 16);
  const px = new Float32Array(64);
  const dec = new Uint8Array(64);
  let se = 0;
  const stats = { modes };
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
        // Blocks overhanging small mips replicate the edge texels.
        const sx = Math.min(bx * 4 + x, L.w - 1), sy = Math.min(by * 4 + y, L.h - 1);
        for (let c = 0; c < 4; c++) px[(y * 4 + x) * 4 + c] = L.data[(sy * L.w + sx) * 4 + c];
      }
      const off = (by * bw + bx) * 16;
      encodeBlock(px, data, off, stats);
      decodeBlock(data, off, dec);
      for (let i = 0; i < 64; i++) { const d = dec[i] - px[i]; se += d * d; }
    }
  }
  return { data, se };
}

// ------------------------------------------------------------ KTX2 writer
const VK_FORMAT_BC5_UNORM_BLOCK = 141;
const VK_FORMAT_BC7_UNORM_BLOCK = 145;
const VK_FORMAT_BC7_SRGB_BLOCK = 146;

function writeKtx2(width: number, height: number, format: 'bc7' | 'bc5', srgb: boolean, levels: Uint8Array[]): Uint8Array {
  const n = levels.length;
  const headerBytes = 12 + 9 * 4 + 4 * 4 + 2 * 8 + n * 24;
  // Data format descriptor: one basic block; BC7 = one sample, BC5 = R and G samples.
  const samples = format === 'bc5' ? 2 : 1;
  const dfdBytes = 4 + 24 + 16 * samples;
  const dfd = new DataView(new ArrayBuffer(dfdBytes));
  dfd.setUint32(0, dfdBytes, true);
  dfd.setUint32(4, 0, true); // vendorId 0 | descriptorType 0
  dfd.setUint16(8, 2, true); // version
  dfd.setUint16(10, 24 + 16 * samples, true); // descriptorBlockSize
  dfd.setUint8(12, format === 'bc5' ? 132 : 134); // KHR_DF_MODEL_BC5 / KHR_DF_MODEL_BC7
  dfd.setUint8(13, 1); // BT.709 primaries
  dfd.setUint8(14, srgb ? 2 : 1); // transfer: sRGB / linear
  dfd.setUint8(15, 0); // alpha straight
  dfd.setUint8(16, 3); dfd.setUint8(17, 3); // 4x4 texel block
  dfd.setUint8(20, 16); // bytesPlane0
  for (let k = 0; k < samples; k++) {
    const o = 28 + 16 * k;
    dfd.setUint16(o, format === 'bc5' ? 64 * k : 0, true); // bitOffset
    dfd.setUint8(o + 2, format === 'bc5' ? 63 : 127); // bitLength - 1
    dfd.setUint8(o + 3, format === 'bc5' ? k : 0); // channel: BC5 red / green, BC7 colour
    dfd.setUint32(o + 8, 0, true); // sampleLower
    dfd.setUint32(o + 12, 0xffffffff, true); // sampleUpper
  }
  const dfdOff = headerBytes;
  let off = dfdOff + dfdBytes;
  // Level data smallest-first, 16-byte aligned.
  const offsets: number[] = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    off = Math.ceil(off / 16) * 16;
    offsets[i] = off;
    off += levels[i].length;
  }
  const buf = new Uint8Array(off);
  const dv = new DataView(buf.buffer);
  buf.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const vk = format === 'bc5' ? VK_FORMAT_BC5_UNORM_BLOCK : srgb ? VK_FORMAT_BC7_SRGB_BLOCK : VK_FORMAT_BC7_UNORM_BLOCK;
  const hdr = [vk, 1, width, height, 0, 0, 1, n, 0];
  hdr.forEach((v, i) => dv.setUint32(12 + i * 4, v, true));
  dv.setUint32(48, dfdOff, true);
  dv.setUint32(52, dfdBytes, true);
  dv.setUint32(56, 0, true); // kvd
  dv.setUint32(60, 0, true);
  dv.setBigUint64(64, 0n, true); // sgd
  dv.setBigUint64(72, 0n, true);
  for (let i = 0; i < n; i++) {
    dv.setBigUint64(80 + i * 24, BigInt(offsets[i]), true);
    dv.setBigUint64(88 + i * 24, BigInt(levels[i].length), true);
    dv.setBigUint64(96 + i * 24, BigInt(levels[i].length), true);
    buf.set(levels[i], offsets[i]);
  }
  buf.set(new Uint8Array(dfd.buffer), dfdOff);
  return buf;
}

function processJob(job: Job): Result {
  const t = performance.now();
  const png = PNG.sync.read(readFileSync(join(TEX, job.file)));
  let L: Level = { w: png.width, h: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length) };
  const chain: Level[] = [L];
  while (L.w > 1 || L.h > 1) {
    L = nextLevel(L, job.kind);
    chain.push(L);
  }
  // ORM paired with a normal map: fold the normal variance of each mip into roughness
  // (the BC5 normal map carries no variance channel).
  if (job.normalPair && existsSync(join(TEX, job.normalPair))) {
    const np = PNG.sync.read(readFileSync(join(TEX, job.normalPair)));
    let N: Level = { w: np.width, h: np.height, data: new Uint8Array(np.data.buffer, np.data.byteOffset, np.data.length) };
    const nchain: Level[] = [N];
    while (N.w > 1 || N.h > 1) { N = nextLevel(N, 'normal'); nchain.push(N); }
    chain.forEach((lv, i) => foldVariance(lv, nchain[Math.min(nchain.length - 1, i + Math.max(0, Math.round(Math.log2(np.width / png.width))))]));
  }
  const format = job.kind === 'normal' ? 'bc5' : 'bc7';
  const modes = [0, 0, 0, 0, 0, 0, 0, 0];
  const psnr: number[] = [];
  const blobs = chain.map((lv, i) => {
    const { data, se } = format === 'bc5' ? encodeLevelBC5(lv) : encodeLevel(lv, modes);
    if (i < 3) psnr.push(+(10 * Math.log10((255 * 255) / Math.max(1e-9, se / (lv.w * lv.h * (format === 'bc5' ? 2 : 4))))).toFixed(1));
    return data;
  });
  const ktx = writeKtx2(png.width, png.height, format, job.kind === 'color', blobs);
  writeFileSync(join(OUT, job.file.replace(/\.png$/, '.ktx2')), ktx);
  return { file: job.file, kind: job.kind, format, width: png.width, height: png.height, levels: chain.length, bytes: ktx.length, psnr, ms: performance.now() - t, modes, normalPair: job.normalPair };
}

// ------------------------------------------------------------ driver
if (!isMainThread) {
  parentPort!.on('message', (job: Job | null) => {
    if (!job) process.exit(0);
    parentPort!.postMessage(processJob(job));
  });
} else if (import.meta.main) {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const ji = argv.indexOf('--jobs');
  const nJobs = ji >= 0 ? +argv[ji + 1] : Math.max(1, availableParallelism() - 2);
  mkdirSync(OUT, { recursive: true });

  // Texture kinds from material usage (decal textures stay PNG: the decal atlas copies rgba8 layers).
  const kinds = new Map<string, Kind>();
  const normalOf = new Map<string, string>(); // orm -> the normal map it is used with
  const use = (file: unknown, kind: Kind, mat: string) => {
    if (typeof file !== 'string' || file.includes('/')) return;
    const prev = kinds.get(file);
    if (prev && prev !== kind) console.warn(`[compress] ${file} used as ${prev} and ${kind} (${mat}); keeping ${prev}`);
    else kinds.set(file, kind);
  };
  for (const f of readdirSync(join(PUBLIC, 'materials'))) {
    if (!f.endsWith('.json')) continue;
    const d = JSON.parse(readFileSync(join(PUBLIC, 'materials', f), 'utf8'));
    use(d.baseColor, 'color', f);
    use(d.normal, 'normal', f);
    use(d.orm, 'linear', f);
    use(d.detail?.albedo, 'linear', f);
    use(d.detail?.normal, 'normal', f);
    use(d.macro?.texture, 'linear', f);
    if (typeof d.orm === 'string' && typeof d.normal === 'string' && !normalOf.has(d.orm)) normalOf.set(d.orm, d.normal);
  }
  const indexPath = join(OUT, 'index.json');
  const prevIndex = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')).textures ?? {} : {};
  const index: Record<string, unknown> = {};
  const jobs: Job[] = [];
  const mtime = (f: string) => (existsSync(join(TEX, f)) ? statSync(join(TEX, f)).mtimeMs : 0);
  for (const [file, kind] of kinds) {
    if (!existsSync(join(TEX, file))) { console.warn(`[compress] missing ${file}`); continue; }
    const ktx = join(OUT, file.replace(/\.png$/, '.ktx2'));
    const pair = kind === 'linear' ? normalOf.get(file) : undefined;
    const format = kind === 'normal' ? 'bc5' : 'bc7';
    const prev = prevIndex[file];
    const fresh = prev && prev.kind === kind && prev.format === format && prev.normalPair === pair && existsSync(ktx)
      && statSync(ktx).mtimeMs > Math.max(mtime(file), pair ? mtime(pair) : 0);
    if (!force && fresh) {
      index[file] = prev;
      continue;
    }
    jobs.push({ file, kind, normalPair: pair });
  }
  console.log(`[compress] ${kinds.size} textures, ${jobs.length} to encode on ${Math.min(nJobs, jobs.length)} workers`);
  const t0 = performance.now();
  const results: Result[] = [];
  // Largest first for better load balance.
  jobs.sort((a, b) => statSync(join(TEX, b.file)).size - statSync(join(TEX, a.file)).size);
  await new Promise<void>((resolve) => {
    let next = 0, active = 0;
    if (jobs.length === 0) resolve();
    for (let w = 0; w < Math.min(nJobs, jobs.length); w++) {
      const worker = new Worker(new URL(import.meta.url), { workerData: { worker: true } });
      active++;
      const feed = () => worker.postMessage(next < jobs.length ? jobs[next++] : null);
      worker.on('message', (r: Result) => {
        results.push(r);
        console.log(`  ${r.file.padEnd(32)} ${r.format} ${r.kind.padEnd(6)} ${r.width}x${r.height} PSNR ${r.psnr.join('/')} dB  ${(r.bytes / 1024).toFixed(0)} KiB  ${(r.ms / 1000).toFixed(1)}s${r.normalPair ? '  (+variance of ' + r.normalPair + ')' : ''}`);
        feed();
      });
      worker.on('exit', () => { if (--active === 0) resolve(); });
      worker.on('error', (e) => { console.error(e); });
      feed();
    }
  });
  for (const r of results) {
    index[r.file] = { kind: r.kind, format: r.format, file: r.file.replace(/\.png$/, '.ktx2'), width: r.width, height: r.height, levels: r.levels, bytes: r.bytes, psnr: r.psnr[0], normalPair: r.normalPair };
  }
  const sorted = Object.fromEntries(Object.entries(index).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(indexPath, JSON.stringify({ format: 'rill.textures.bc', version: 2, textures: sorted }, null, 1));
  const total = Object.values(sorted).reduce((s: number, e) => s + (e as { bytes: number }).bytes, 0);
  const modes = results.reduce((m, r) => m.map((v, i) => v + r.modes[i]), [0, 0, 0, 0, 0, 0, 0, 0]);
  const nb = modes.reduce((a, b) => a + b, 0) || 1;
  console.log(`[compress] done in ${((performance.now() - t0) / 1000).toFixed(1)}s: ${(total / 1048576).toFixed(1)} MiB (BC7 + BC5); BC7 modes 1/5/6 = ${[1, 5, 6].map((m) => ((100 * modes[m]) / nb).toFixed(0) + '%').join('/')}`);
}
