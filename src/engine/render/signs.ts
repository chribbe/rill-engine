import type { SignObject } from '../scene/mapformat';
import type { PrimitiveData } from './geometry';
import type { TextureManager } from './textures';

/**
 * Text signs (shop fascias, station name bands, street signs): map objects of
 * type 'sign' are rasterised at load into one canvas atlas with the bundled
 * OFL fonts (public/fonts) and drawn as quads, so a sign is edited by changing
 * its text in the map document (or in a future editor) with no asset build.
 *
 * Geometry is in the sign's local frame: the face lies in the XY plane facing
 * +Z, centred on the object origin (size[0] wide, size[1] high). `depth` > 0
 * adds a lightbox body behind the face.
 */

const FONT_FILES: Record<string, { file: string; weight: string }[]> = {
  'Barlow Condensed': [
    { file: 'BarlowCondensed-SemiBold.ttf', weight: '600' },
    { file: 'BarlowCondensed-Bold.ttf', weight: '700' },
  ],
  Jost: [{ file: 'Jost[wght].ttf', weight: '100 900' }],
  'Archivo Black': [{ file: 'ArchivoBlack-Regular.ttf', weight: '400' }],
  Pacifico: [{ file: 'Pacifico-Regular.ttf', weight: '400' }],
  Inter: [{ file: 'Inter[opsz,wght].ttf', weight: '100 900' }],
};

const ATLAS = 2048;
const PX_PER_M = 220;
const PAD = 6;

const loadedFonts = new Map<string, Promise<void>>();
function loadFont(family: string): Promise<void> {
  let p = loadedFonts.get(family);
  if (!p) {
    p = Promise.all(
      (FONT_FILES[family] ?? []).map(async (f) => {
        const face = new FontFace(family, `url(/fonts/${encodeURIComponent(f.file)})`, { weight: f.weight });
        await face.load();
        (document.fonts as unknown as { add(f: FontFace): void }).add(face);
      }),
    ).then(() => undefined, (e) => console.warn(`[signs] font ${family}:`, e));
    loadedFonts.set(family, p);
  }
  return p;
}

export interface SignBuild {
  /** Atlas face quads, split by lighting (backlit faces emit). */
  lit: PrimitiveData | null;
  painted: PrimitiveData | null;
  /** Lightbox bodies (plain material). */
  body: PrimitiveData | null;
}

interface Placed { o: SignObject; x: number; y: number; w: number; h: number }

class Quads {
  pos: number[] = []; nrm: number[] = []; uv: number[] = []; idx: number[] = [];
  quad(m: Float32Array | number[], corners: number[][], n: number[], uvs: number[][]) {
    const base = this.pos.length / 3;
    for (let i = 0; i < 4; i++) {
      const [x, y, z] = corners[i];
      this.pos.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
      const nx = m[0] * n[0] + m[4] * n[1] + m[8] * n[2], ny = m[1] * n[0] + m[5] * n[1] + m[9] * n[2], nz = m[2] * n[0] + m[6] * n[1] + m[10] * n[2];
      const l = Math.hypot(nx, ny, nz) || 1;
      this.nrm.push(nx / l, ny / l, nz / l);
      this.uv.push(uvs[i][0], uvs[i][1]);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  build(material: string): PrimitiveData | null {
    if (!this.idx.length) return null;
    return { positions: new Float32Array(this.pos), normals: new Float32Array(this.nrm), uv0: new Float32Array(this.uv), indices: new Uint32Array(this.idx), material };
  }
}

/** Rasterises every sign into the atlas texture `url` and returns the sign geometry (world space). */
export async function buildSigns(textures: TextureManager, signs: SignObject[], url: string, matrix: (o: SignObject) => Float32Array): Promise<SignBuild | null> {
  if (!signs.length) return null;
  await Promise.all([...new Set(signs.map((s) => s.sign.font ?? 'Barlow Condensed'))].map(loadFont));
  // Shelf-pack sign faces (rows back-filled with anything that still fits); the
  // texel density drops until everything fits on one atlas page.
  let placed: Placed[] = [];
  for (let density = PX_PER_M; density > 20; density *= 0.85) {
    const items = signs.map((o) => {
      const [sw, sh] = o.sign.size;
      const k = Math.min(density, (ATLAS - 2 * PAD) / sw, 256 / sh);
      return { o, w: Math.ceil(sw * k), h: Math.ceil(sh * k) };
    }).sort((a, b) => b.h - a.h || b.w - a.w);
    placed = [];
    let y = 0;
    const left = new Set(items);
    while (left.size) {
      let x = 0, rowH = 0;
      for (const it of [...left]) {
        if (x + it.w + PAD > ATLAS) continue;
        if (rowH && it.h > rowH) continue;
        if (y + it.h + PAD > ATLAS) continue;
        placed.push({ o: it.o, x: x + PAD, y: y + PAD, w: it.w, h: it.h });
        x += it.w + PAD;
        rowH = Math.max(rowH, it.h);
        left.delete(it);
      }
      if (!rowH) break;
      y += rowH + PAD;
    }
    if (!left.size) break;
  }
  if (placed.length < signs.length) console.warn(`[signs] ${signs.length - placed.length} signs did not fit the atlas`);
  const canvas = new OffscreenCanvas(ATLAS, ATLAS);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#202020';
  ctx.fillRect(0, 0, ATLAS, ATLAS);
  for (const p of placed) drawSign(ctx, p);
  await textures.registerCanvas(url, canvas, 'color');

  const lit = new Quads(), painted = new Quads(), body = new Quads();
  for (const p of placed) {
    const s = p.o.sign;
    const m = matrix(p.o);
    const hw = s.size[0] / 2, hh = s.size[1] / 2;
    // Inset the UVs half a texel so bilinear filtering never reads the neighbour.
    const u0 = (p.x + 0.5) / ATLAS, u1 = (p.x + p.w - 0.5) / ATLAS, v0 = (p.y + 0.5) / ATLAS, v1 = (p.y + p.h - 0.5) / ATLAS;
    const z = s.depth ? s.depth / 2 : 0.005;
    const face = (s.backlit ?? 0) > 0 ? lit : painted;
    face.quad(m, [[-hw, -hh, z], [hw, -hh, z], [hw, hh, z], [-hw, hh, z]], [0, 0, 1], [[u0, v1], [u1, v1], [u1, v0], [u0, v0]]);
    if (s.doubleSided) face.quad(m, [[hw, -hh, -z], [-hw, -hh, -z], [-hw, hh, -z], [hw, hh, -z]], [0, 0, -1], [[u0, v1], [u1, v1], [u1, v0], [u0, v0]]);
    if (s.depth) {
      const d = s.depth / 2;
      const sides: [number[][], number[]][] = [
        [[[hw, -hh, d], [hw, -hh, -d], [hw, hh, -d], [hw, hh, d]], [1, 0, 0]],
        [[[-hw, -hh, -d], [-hw, -hh, d], [-hw, hh, d], [-hw, hh, -d]], [-1, 0, 0]],
        [[[-hw, hh, d], [hw, hh, d], [hw, hh, -d], [-hw, hh, -d]], [0, 1, 0]],
        [[[-hw, -hh, -d], [hw, -hh, -d], [hw, -hh, d], [-hw, -hh, d]], [0, -1, 0]],
      ];
      if (!s.doubleSided) sides.push([[[hw, -hh, -d], [-hw, -hh, -d], [-hw, hh, -d], [hw, hh, -d]], [0, 0, -1]]);
      for (const [c, n] of sides) body.quad(m, c, n, c.map((q) => [q[0] + q[2], q[1]]));
    }
  }
  return { lit: lit.build('signs_lit'), painted: painted.build('signs_painted'), body: body.build('sign_body') };
}

function drawSign(ctx: OffscreenCanvasRenderingContext2D, p: Placed) {
  const s = p.o.sign;
  const { x, y, w, h } = p;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x - PAD / 2, y - PAD / 2, w + PAD, h + PAD);
  ctx.clip();
  ctx.fillStyle = s.background ?? '#00000000';
  ctx.fillRect(x - PAD / 2, y - PAD / 2, w + PAD, h + PAD);
  if (s.border) {
    const bw = Math.max(1, h * 0.06);
    ctx.strokeStyle = s.border;
    ctx.lineWidth = bw;
    ctx.strokeRect(x + bw / 2, y + bw / 2, w - bw, h - bw);
  }
  const lines = s.text.split('\n');
  const family = s.font ?? 'Barlow Condensed';
  const weight = s.weight ?? (family === 'Barlow Condensed' ? 700 : 600);
  const padX = (s.padding ?? 0.08) * h * 2.2;
  const lineH = (h * (s.textHeight ?? 0.62)) / lines.length;
  let px = lineH;
  const font = (sz: number) => `${s.italic ? 'italic ' : ''}${weight} ${sz}px "${family}"`;
  ctx.font = font(px);
  (ctx as unknown as { letterSpacing: string }).letterSpacing = `${(s.letterSpacing ?? 0) * px}px`;
  const widest = Math.max(...lines.map((l) => ctx.measureText(s.uppercase === false ? l : l.toUpperCase()).width));
  if (widest > w - 2 * padX) px *= (w - 2 * padX) / widest;
  ctx.font = font(px);
  (ctx as unknown as { letterSpacing: string }).letterSpacing = `${(s.letterSpacing ?? 0) * px}px`;
  ctx.fillStyle = s.color ?? '#ffffff';
  ctx.textBaseline = 'middle';
  const align = s.align ?? 'center';
  ctx.textAlign = align;
  const tx = align === 'left' ? x + padX : align === 'right' ? x + w - padX : x + w / 2;
  lines.forEach((l, i) => {
    const ty = y + h / 2 + (i - (lines.length - 1) / 2) * lineH * 1.08 + px * 0.04;
    ctx.fillText(s.uppercase === false ? l : l.toUpperCase(), tx, ty);
  });
  ctx.restore();
}
