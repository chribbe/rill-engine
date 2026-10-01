// Imports scanned CC0 texture sets (Poly Haven) into Rill's texture conventions.
//
//   node tools/textures/scanned.ts [name ...]
//
// For each set in tools/textures/scanned.json:
//  - downloads the 2K JPG maps (diffuse, OpenGL normal, AO/rough/metal, displacement)
//    into .texture-cache/polyhaven/<id>/ (gitignored; skipped when present)
//  - converts JPG -> PNG with macOS `sips` (pixel values preserved)
//  - downsamples to the output size like the GPU mipgen: albedo averaged in linear
//    light, normals averaged + renormalised with the lost variance kept in alpha
//  - calibrates albedo to a target mean luminance (scans vary in exposure)
//  - writes <name>_albedo.png (sRGB), <name>_normal.png (OpenGL, variance alpha),
//    <name>_orm.png (AO, roughness, metallic, normalised height)
//  - updates manifest.json (avg albedo for the baker, physical size, source) and
//    the listed material JSONs' physicalSize from the scan's real-world dimensions
//  - writes public/textures/CREDITS.md
import { PNG } from 'pngjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = join(import.meta.dirname, '../..');
const OUT = join(ROOT, 'public/textures');
const MATS = join(ROOT, 'public/materials');
const CACHE = join(ROOT, '.texture-cache/polyhaven');
const UA = { 'User-Agent': 'rill-texture-import/1.0 (offline asset tool)' };

interface SetDef { name: string; id: string; albedoLuma?: number; tint?: [number, number, number]; materials?: string[] }
const cfg = JSON.parse(readFileSync(join(import.meta.dirname, 'scanned.json'), 'utf8')) as { resolution: string; size: number; sets: SetDef[] };
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));

const s2l = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const l2s = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const q8 = (x: number) => Math.max(0, Math.min(255, Math.round(x * 255)));

async function json(url: string) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

async function download(url: string, file: string, expect?: number) {
  if (existsSync(file) && (!expect || statSync(file).size === expect)) return false;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return true;
}

function readJpg(jpg: string) {
  // Temporary 2K PNG (sips preserves pixel values); deleted again so the cache only holds the JPGs.
  const png = jpg.replace(/\.jpg$/, '.tmp.png');
  execFileSync('sips', ['-s', 'format', 'png', jpg, '--out', png], { stdio: 'ignore' });
  const img = PNG.sync.read(readFileSync(png));
  rmSync(png);
  return img;
}

function writePng(file: string, w: number, h: number, data: Uint8Array) {
  const png = new PNG({ width: w, height: h, colorType: 6 });
  png.data = Buffer.from(data);
  writeFileSync(join(OUT, file), PNG.sync.write(png, { colorType: 6 }));
}

/** Box-downsample by an integer factor with a per-texel transform in / out. */
function downsample(src: PNG, size: number, kind: 'color' | 'linear' | 'normal') {
  const f = src.width / size;
  if (!Number.isInteger(f) || src.height / size !== f) throw new Error(`can't downsample ${src.width}x${src.height} -> ${size}`);
  const out = new Float32Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const acc = [0, 0, 0, 0];
    for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) {
      const p = ((y * f + j) * src.width + x * f + i) * 4;
      let r = src.data[p] / 255, g = src.data[p + 1] / 255, b = src.data[p + 2] / 255;
      if (kind === 'color') { r = s2l(r); g = s2l(g); b = s2l(b); }
      if (kind === 'normal') {
        let nx = r * 2 - 1, ny = g * 2 - 1, nz = b * 2 - 1;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
        r = nx; g = ny; b = nz;
      }
      acc[0] += r; acc[1] += g; acc[2] += b; acc[3] += src.data[p + 3] / 255;
    }
    const o = (y * size + x) * 4, n = f * f;
    for (let k = 0; k < 4; k++) out[o + k] = acc[k] / n;
  }
  return out;
}

async function importSet(s: SetDef, credits: string[]) {
  const t0 = performance.now();
  const dir = join(CACHE, s.id);
  mkdirSync(dir, { recursive: true });
  const infoFile = join(dir, 'info.json'), filesFile = join(dir, 'files.json');
  if (!existsSync(infoFile)) writeFileSync(infoFile, JSON.stringify(await json(`https://api.polyhaven.com/info/${s.id}`)));
  if (!existsSync(filesFile)) writeFileSync(filesFile, JSON.stringify(await json(`https://api.polyhaven.com/files/${s.id}`)));
  const info = JSON.parse(readFileSync(infoFile, 'utf8'));
  const files = JSON.parse(readFileSync(filesFile, 'utf8'));
  const res = cfg.resolution;
  const maps: Record<string, string> = { Diffuse: 'diff', nor_gl: 'nor_gl', arm: 'arm', Displacement: 'disp' };
  const local: Record<string, string> = {};
  let bytes = 0, fetched = 0;
  for (const [key, short] of Object.entries(maps)) {
    const e = files[key]?.[res]?.jpg;
    if (!e) throw new Error(`${s.id}: no ${key} ${res} jpg`);
    const file = join(dir, `${short}_${res}.jpg`);
    if (await download(e.url, file, e.size)) fetched++;
    bytes += e.size;
    local[short] = file;
  }
  const N = cfg.size;
  const diff = downsample(readJpg(local.diff), N, 'color');
  const nor = downsample(readJpg(local.nor_gl), N, 'normal');
  const arm = downsample(readJpg(local.arm), N, 'linear');
  const disp = downsample(readJpg(local.disp), N, 'linear');

  // Optional linear tint (season/hue correction, e.g. dry-season lawn scans -> summer green).
  if (s.tint) for (let i = 0; i < N * N; i++) for (let k = 0; k < 3; k++) diff[i * 4 + k] *= s.tint[k];
  // Albedo calibration (linear luminance).
  let lum = 0;
  for (let i = 0; i < N * N; i++) lum += 0.2126 * diff[i * 4] + 0.7152 * diff[i * 4 + 1] + 0.0722 * diff[i * 4 + 2];
  lum /= N * N;
  const scale = s.albedoLuma ? s.albedoLuma / lum : 1;
  const albedo = new Uint8Array(N * N * 4), normal = new Uint8Array(N * N * 4), orm = new Uint8Array(N * N * 4);
  const avg = [0, 0, 0];
  let hMin = 1, hMax = 0;
  for (let i = 0; i < N * N; i++) { hMin = Math.min(hMin, disp[i * 4]); hMax = Math.max(hMax, disp[i * 4]); }
  const hr = Math.max(1e-6, hMax - hMin);
  for (let i = 0; i < N * N; i++) {
    const o = i * 4;
    for (let k = 0; k < 3; k++) {
      const v = Math.min(0.95, diff[o + k] * scale);
      avg[k] += v;
      albedo[o + k] = q8(l2s(v));
    }
    albedo[o + 3] = 255;
    // Normal: mean of unit vectors; its shortening -> vMF variance (same as mipgen.wgsl).
    const sx = nor[o], sy = nor[o + 1], sz = nor[o + 2];
    const r = Math.min(Math.hypot(sx, sy, sz), 0.9999);
    const kappa = (3 * r - r * r * r) / (1 - r * r);
    const v = Math.max(0, Math.min(0.5, 1 / kappa));
    const l = Math.hypot(sx, sy, sz + 1e-6) || 1;
    normal[o] = q8((sx / l) * 0.5 + 0.5); normal[o + 1] = q8((sy / l) * 0.5 + 0.5); normal[o + 2] = q8(((sz + 1e-6) / l) * 0.5 + 0.5);
    normal[o + 3] = q8(1 - 2 * v);
    orm[o] = q8(arm[o]); orm[o + 1] = q8(arm[o + 1]); orm[o + 2] = q8(arm[o + 2]);
    orm[o + 3] = q8((disp[o] - hMin) / hr);
  }
  writePng(`${s.name}_albedo.png`, N, N, albedo);
  writePng(`${s.name}_normal.png`, N, N, normal);
  writePng(`${s.name}_orm.png`, N, N, orm);
  const dims = (info.dimensions as number[] | undefined)?.map((d) => +(d / 1000).toFixed(3)) ?? [2, 2];
  const manifestPath = join(OUT, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest[s.name] = {
    averageAlbedo: avg.map((v) => +(v / (N * N)).toFixed(4)), size: N, physicalSize: dims,
    source: { kind: 'scan', provider: 'Poly Haven', id: s.id, license: 'CC0', url: `https://polyhaven.com/a/${s.id}` },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
  for (const m of s.materials ?? []) {
    const p = join(MATS, `${m}.json`);
    const d = JSON.parse(readFileSync(p, 'utf8'));
    d.physicalSize = dims[0] === dims[1] ? dims[0] : dims;
    if (m === 'concrete_wall') {
      // concrete_wall switches from the smooth cast texture to the board-formed scan.
      d.baseColor = `${s.name}_albedo.png`; d.normal = `${s.name}_normal.png`; d.orm = `${s.name}_orm.png`;
    }
    writeFileSync(p, JSON.stringify(d, null, 1) + '\n');
  }
  const authors = Object.keys(info.authors ?? {}).join(', ');
  credits.push(`| ${s.name} | [${info.name}](https://polyhaven.com/a/${s.id}) | ${authors} | ${dims.join(' × ')} m |`);
  console.log(`  ${s.name.padEnd(20)} <- ${s.id.padEnd(26)} ${dims.join('x')} m  luma ${lum.toFixed(3)} -> x${scale.toFixed(2)}  ${(bytes / 1e6).toFixed(1)} MB (${fetched} fetched)  ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  return bytes;
}

const credits: string[] = [];
let total = 0;
for (const s of cfg.sets) {
  if (only.length && !only.includes(s.name)) continue;
  total += await importSet(s, credits);
}
if (only.length === 0) {
  writeFileSync(join(OUT, 'CREDITS.md'), [
    '# Scanned texture credits', '',
    'Imported by `tools/textures/scanned.ts` from [Poly Haven](https://polyhaven.com) (CC0 1.0 — no attribution required, credited anyway).',
    'Downsampled to 1024², albedo recalibrated, maps repacked to Rill conventions.', '',
    '| Rill texture | Source | Author(s) | Real-world size |', '|---|---|---|---|', ...credits, '',
  ].join('\n'));
}
console.log(`[scanned] ${credits.length} sets, ${(total / 1e6).toFixed(0)} MB of source maps in .texture-cache`);
