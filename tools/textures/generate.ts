// Offline procedural texture generator for the M0/M1 test content.
//
//   node tools/textures/generate.ts [name ...]
//
// Writes tileable PNGs to public/textures and a manifest with average linear
// albedo per material (used as bounce albedo by the lightmap baker).
// Conventions: albedo authored in linear space and stored sRGB; normal maps are
// OpenGL-style (+Y = image up) derived from height fields in metres using the
// real texel size, so relief strength is physically meaningful; ORM = (AO,
// roughness, metallic).

import { PNG } from 'pngjs';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  Field, Img, fbm, ridged, worley, gnoise, hash2, mulberry32, normalFromHeight, aoFromHeight,
  smoothstep, clamp01, lerp, linearToSrgb, srgbToLinear, type Cell,
} from './noise.ts';

const OUT = join(import.meta.dirname, '../../public/textures');
mkdirSync(OUT, { recursive: true });
mkdirSync(join(OUT, 'decals'), { recursive: true });
const manifestPath = join(OUT, 'manifest.json');
const manifest: Record<string, { averageAlbedo: number[]; size: number; physicalSize: number[] }> = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8'))
  : {};

function writePng(file: string, w: number, h: number, px: (x: number, y: number, o: number[]) => void) {
  const png = new PNG({ width: w, height: h, colorType: 6 });
  const o = [0, 0, 0, 1];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      o[3] = 1;
      px(x, y, o);
      const i = (y * w + x) * 4;
      png.data[i] = Math.round(clamp01(o[0]) * 255);
      png.data[i + 1] = Math.round(clamp01(o[1]) * 255);
      png.data[i + 2] = Math.round(clamp01(o[2]) * 255);
      png.data[i + 3] = Math.round(clamp01(o[3]) * 255);
    }
  }
  writeFileSync(join(OUT, file), PNG.sync.write(png, { colorType: 6 }));
}

interface MaterialMaps {
  /** Linear albedo (rgb) + alpha. */
  albedo: Img;
  height?: Field;
  rough: Field;
  metal?: Field;
  ao?: Field;
}

function saveMaterial(name: string, size: number, physical: [number, number], m: MaterialMaps, opts: { aoRadius?: number; aoDepth?: number; noNormal?: boolean } = {}) {
  const t0 = performance.now();
  writePng(`${name}_albedo.png`, size, size, (x, y, o) => {
    const i = (y * size + x) * 4;
    o[0] = linearToSrgb(m.albedo.data[i]);
    o[1] = linearToSrgb(m.albedo.data[i + 1]);
    o[2] = linearToSrgb(m.albedo.data[i + 2]);
    o[3] = m.albedo.data[i + 3];
  });
  let ao = m.ao;
  if (m.height && !opts.noNormal) {
    const n = normalFromHeight(m.height, physical[0] / size, physical[1] / size);
    writePng(`${name}_normal.png`, size, size, (x, y, o) => {
      const i = (y * size + x) * 4;
      o[0] = n.data[i]; o[1] = n.data[i + 1]; o[2] = n.data[i + 2]; o[3] = 1;
    });
    if (!ao) ao = aoFromHeight(m.height, opts.aoRadius ?? size / 128, opts.aoDepth ?? 200);
  }
  // ORM(H): alpha = height normalised to the texture's own range (0.5 when flat),
  // used for height-aware material blending.
  let hMin = Infinity, hMax = -Infinity;
  if (m.height) for (const v of m.height.data) { hMin = Math.min(hMin, v); hMax = Math.max(hMax, v); }
  const hRange = hMax - hMin;
  writePng(`${name}_orm.png`, size, size, (x, y, o) => {
    const i = y * size + x;
    o[0] = ao ? ao.data[i] : 1;
    o[1] = m.rough.data[i];
    o[2] = m.metal ? m.metal.data[i] : 0;
    o[3] = m.height && hRange > 1e-9 ? (m.height.data[i] - hMin) / hRange : 0.5;
  });
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < size * size; i++) {
    const a = m.albedo.data[i * 4 + 3];
    r += m.albedo.data[i * 4] * a; g += m.albedo.data[i * 4 + 1] * a; b += m.albedo.data[i * 4 + 2] * a; n += a;
  }
  manifest[name] = { averageAlbedo: [r / n, g / n, b / n].map((v) => +v.toFixed(4)), size, physicalSize: physical };
  console.log(`  ${name.padEnd(22)} ${size}px  ${physical.join('x')} m  avg albedo ${manifest[name].averageAlbedo.join(', ')}  (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
}

const lin = (hex: string) => [0, 2, 4].map((i) => srgbToLinear(parseInt(hex.replace('#', '').slice(i, i + 2), 16) / 255));

// ------------------------------------------------------------ bitmap font (3x5)
const FONT: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'], '1': ['010', '110', '010', '010', '111'], '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'], '4': ['101', '101', '111', '001', '001'], '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'], '7': ['111', '001', '010', '010', '010'], '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'], ',': ['000', '000', '000', '010', '100'], 'm': ['000', '000', '111', '111', '101'],
  'U': ['101', '101', '101', '101', '111'], 'V': ['101', '101', '101', '101', '010'], '+': ['000', '010', '111', '010', '000'],
  '.': ['000', '000', '000', '000', '010'], 'c': ['000', '000', '111', '100', '111'],
};
function drawText(mask: Field, text: string, x0: number, y0: number, scale: number) {
  let x = x0;
  for (const ch of text) {
    const g = FONT[ch];
    if (g) {
      for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) {
        if (g[r][c] !== '1') continue;
        for (let yy = 0; yy < scale; yy++) for (let xx = 0; xx < scale; xx++) {
          const px = x + c * scale + xx, py = y0 + r * scale + yy;
          if (px >= 0 && py >= 0 && px < mask.w && py < mask.h) mask.data[py * mask.w + px] = 1;
        }
      }
    }
    x += 4 * scale;
  }
}

// ------------------------------------------------------------ recipes
const recipes: Record<string, () => void> = {};

recipes.debug_grid = () => {
  // 4 m tile, 512 px/m. 10 cm minor, 50 cm, 1 m major lines; per-metre labels and +U/+V arrows.
  const S = 2048, P = 4, ppm = S / P;
  const albedo = new Img(S, S);
  const label = new Field(S, S);
  for (let cy = 0; cy < P; cy++) for (let cx = 0; cx < P; cx++) {
    drawText(label, `${cx},${cy}`, cx * ppm + 24, cy * ppm + 24, 10);
    drawText(label, `1m`, cx * ppm + ppm - 90, cy * ppm + ppm - 70, 6);
  }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const mx = x / ppm, my = y / ppm;
      const cell = (Math.floor(mx) + Math.floor(my)) & 1;
      let v = cell ? 0.34 : 0.28; // linear
      const fx = (x % ppm), fy = (y % ppm);
      const d10 = Math.min(fx % (ppm / 10), fy % (ppm / 10));
      const d50x = fx % (ppm / 2), d50y = fy % (ppm / 2);
      if (d10 < 2) v *= 0.62;
      if (d50x < 3 || d50y < 3) v *= 0.55;
      if (fx < 5 || fy < 5) v = 0.02;
      // +U arrow (right) along the bottom of each cell, +V (down the image = world down on walls) on the left.
      const ax = fx - ppm * 0.35, ay = fy - ppm * 0.8;
      const arrowU = (ax > 0 && ax < ppm * 0.3 && Math.abs(ay) < 3) || (ax > ppm * 0.26 && ax < ppm * 0.3 && Math.abs(ay) < (ppm * 0.3 - ax) * 0.8);
      let r = v, g = v, b = v;
      if (arrowU) { r = 0.6; g = 0.08; b = 0.03; }
      const bx = fx - ppm * 0.12, by = fy - ppm * 0.45;
      const arrowV = (Math.abs(bx) < 3 && by > 0 && by < ppm * 0.3) || (by > ppm * 0.26 && by < ppm * 0.3 && Math.abs(bx) < (ppm * 0.3 - by) * 0.8);
      if (arrowV) { r = 0.03; g = 0.25; b = 0.6; }
      if (label.data[y * S + x] > 0) { r = 0.01; g = 0.01; b = 0.01; }
      albedo.set(x, y, r, g, b, 1);
    }
  }
  const rough = new Field(S, S).fill(() => 0.7);
  saveMaterial('debug_grid', S, [P, P], { albedo, rough });
};

/**
 * Hammer-style measured dev textures: flat colour, 25 cm thin lines, 1 m lines and a heavy
 * line every 4 m (the tile edge), plus a faint 1 m checker so scale reads at a distance.
 */
function devGrid(name: string, base: string, line: string) {
  const S = 1024, P = 4, ppm = S / P;
  const albedo = new Img(S, S), rough = new Field(S, S);
  const b = lin(base), l = lin(line);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const cell = (Math.floor(x / ppm) + Math.floor(y / ppm)) & 1;
      // Distance (px) to the nearest line of each spacing, from the texel centre.
      const d = (period: number) => {
        const ax = (x + 0.5) % period, ay = (y + 0.5) % period;
        return Math.min(ax, period - ax, ay, period - ay);
      };
      const d4 = Math.min(x + 0.5, S - x - 0.5, y + 0.5, S - y - 0.5);
      let w = 0;
      if (d(ppm / 4) < 0.75) w = 0.45;
      if (d(ppm) < 1.25) w = 0.8;
      if (d4 < 2.5) w = 1;
      const k = cell ? 1.04 : 0.96;
      const r = (b[0] * k) * (1 - w) + l[0] * w, g = (b[1] * k) * (1 - w) + l[1] * w, bb = (b[2] * k) * (1 - w) + l[2] * w;
      albedo.set(x, y, r, g, bb, 1);
      rough.data[y * S + x] = w > 0 ? 0.6 : 0.78;
    }
  }
  saveMaterial(name, S, [P, P], { albedo, rough });
}
recipes.dev_grey = () => devGrid('dev_grey', '#7c7d7e', '#a9abad');
recipes.dev_orange = () => devGrid('dev_orange', '#c8692a', '#e8a066');
recipes.dev_dark = () => devGrid('dev_dark', '#3b3e43', '#61666e');
recipes.dev_blue = () => devGrid('dev_blue', '#356aa6', '#78a6d6');
recipes.dev_green = () => devGrid('dev_green', '#4c8a3a', '#86ba72');
// Blockout default: a light warm grey that reads against the grey dev floor.
recipes.dev_wall = () => devGrid('dev_wall', '#b3aea4', '#8c877e');

recipes.debug_checker = () => {
  const S = 1024, P = 2, ppm = S / P;
  const albedo = new Img(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const c = (Math.floor(x / ppm) + Math.floor(y / ppm)) & 1;
    let v = c ? 0.5 : 0.05;
    const sub = (Math.floor(x / (ppm / 10)) + Math.floor(y / (ppm / 10))) & 1;
    v *= sub ? 1 : 0.85;
    albedo.set(x, y, v, v, v);
  }
  saveMaterial('debug_checker', S, [P, P], { albedo, rough: new Field(S, S).fill(() => 0.5) });
};

recipes.concrete_cast = () => {
  const S = 1024, P = 2;
  const albedo = new Img(S, S), height = new Field(S, S), rough = new Field(S, S);
  const base = lin('#8f8c86');
  const c: Cell = { f1: 0, f2: 0, id: 0, dx: 0, dy: 0 };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S, v = (y + 0.5) / S;
    const low = fbm(u, v, 3, 4, 11);
    const mid = fbm(u, v, 16, 4, 12);
    const fine = fbm(u, v, 96, 3, 13);
    worley(u, v, 180, 14, 1, c);
    const pore = smoothstep(0.18, 0.05, c.f1) * (hash2(c.id, 1, 5) / 4294967296 > 0.55 ? 1 : 0);
    worley(u, v, 50, 15, 1, c);
    const bigPore = smoothstep(0.12, 0.03, c.f1) * (hash2(c.id, 2, 5) / 4294967296 > 0.8 ? 1 : 0);
    const k = 1 + low * 0.08 + mid * 0.05 + fine * 0.03 - pore * 0.25 - bigPore * 0.35;
    albedo.set(x, y, base[0] * k, base[1] * k * 0.995, base[2] * k * 0.99);
    height.data[y * S + x] = fine * 0.0003 + mid * 0.0004 - pore * 0.0008 - bigPore * 0.0015;
    rough.data[y * S + x] = clamp01(0.86 + mid * 0.05 + pore * 0.08);
  }
  saveMaterial('concrete_cast', S, [P, P], { albedo, height, rough });
};

recipes.concrete_aggregate = () => {
  // Exposed aggregate ("frilagd ballast") panels: rounded pebbles in a cement matrix.
  const S = 1024, P = 1;
  const albedo = new Img(S, S), height = new Field(S, S), rough = new Field(S, S);
  const stones = ['#9c9890', '#7a746e', '#b3a89a', '#5d5a57', '#a08170', '#c9c3b9', '#6e6a62', '#8a6f63'].map(lin);
  const matrix = lin('#a9a59c');
  const c: Cell = { f1: 0, f2: 0, id: 0, dx: 0, dy: 0 };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S, v = (y + 0.5) / S;
    worley(u, v, 70, 21, 0.95, c);
    const edge = c.f2 - c.f1;
    const sizeR = 0.28 + (hash2(c.id, 3, 1) / 4294967296) * 0.18;
    const inStone = smoothstep(sizeR * 0.25, sizeR * 0.5, edge);
    const dome = Math.sqrt(clamp01(edge / 0.5));
    const col = stones[hash2(c.id, 9, 2) % stones.length];
    const speck = fbm(u, v, 256, 2, 22) * 0.12;
    const m = 1 + fbm(u, v, 8, 3, 23) * 0.06;
    const r = lerp(matrix[0] * (0.9 + speck), col[0] * (1 + speck), inStone) * m;
    const g = lerp(matrix[1] * (0.9 + speck), col[1] * (1 + speck), inStone) * m;
    const b = lerp(matrix[2] * (0.9 + speck), col[2] * (1 + speck), inStone) * m;
    albedo.set(x, y, r, g, b);
    height.data[y * S + x] = inStone * dome * 0.004 + fbm(u, v, 64, 2, 24) * 0.0002;
    rough.data[y * S + x] = lerp(0.92, 0.62 + (hash2(c.id, 5, 3) / 4294967296) * 0.15, inStone);
  }
  saveMaterial('concrete_aggregate', S, [P, P], { albedo, height, rough }, { aoRadius: 6, aoDepth: 350 });
};

recipes.asphalt = () => {
  const S = 1024, P = 2;
  const albedo = new Img(S, S), height = new Field(S, S), rough = new Field(S, S);
  const binder = lin('#3a3a39');
  const c: Cell = { f1: 0, f2: 0, id: 0, dx: 0, dy: 0 };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S, v = (y + 0.5) / S;
    worley(u, v, 260, 31, 1, c);
    const edge = c.f2 - c.f1;
    const hsh = hash2(c.id, 7, 1) / 4294967296;
    const stone = smoothstep(0.08, 0.22, edge) * (hsh > 0.35 ? 1 : 0);
    const bright = 0.7 + (hash2(c.id, 8, 1) / 4294967296) * 1.1;
    worley(u, v, 90, 32, 1, c);
    const big = smoothstep(0.1, 0.25, c.f2 - c.f1) * (hash2(c.id, 9, 1) / 4294967296 > 0.75 ? 1 : 0);
    const low = fbm(u, v, 4, 4, 33);
    const k = (1 + low * 0.1) * (1 + stone * (bright - 1) * 0.9 + big * 0.35);
    albedo.set(x, y, binder[0] * k, binder[1] * k, binder[2] * k * 0.98);
    height.data[y * S + x] = (stone * 0.0012 + big * 0.0018) * (0.6 + 0.4 * Math.sqrt(clamp01(edge * 3))) + fbm(u, v, 128, 2, 34) * 0.0002;
    rough.data[y * S + x] = clamp01(0.88 - stone * 0.15 - big * 0.1 + low * 0.04);
  }
  saveMaterial('asphalt', S, [P, P], { albedo, height, rough }, { aoRadius: 3, aoDepth: 300 });
};

recipes.plaster = () => {
  // Painted render (tintable via baseColorFactor): fine stucco relief.
  const S = 1024, P = 2;
  const albedo = new Img(S, S), height = new Field(S, S), rough = new Field(S, S);
  const c: Cell = { f1: 0, f2: 0, id: 0, dx: 0, dy: 0 };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S, v = (y + 0.5) / S;
    worley(u, v, 160, 41, 1, c);
    const blob = smoothstep(0.55, 0.1, c.f1);
    const n = fbm(u, v, 48, 4, 42);
    const low = fbm(u, v, 3, 3, 43);
    const k = 0.78 * (1 + low * 0.04 + n * 0.03 - (1 - blob) * 0.02);
    albedo.set(x, y, k, k * 0.995, k * 0.985);
    height.data[y * S + x] = blob * 0.0006 + n * 0.00035;
    rough.data[y * S + x] = clamp01(0.9 + n * 0.04);
  }
  saveMaterial('plaster', S, [P, P], { albedo, height, rough });
};

recipes.brick_red = () => {
  // Swedish 250x62 brick + 10 mm joints, running bond: 4 bricks x 14 courses per tile.
  const S = 1024, P: [number, number] = [1.04, 1.008];
  const albedo = new Img(S, S), height = new Field(S, S), rough = new Field(S, S);
  const reds = ['#8a3a2a', '#9b4430', '#7a3326', '#a24e36', '#6e2e22', '#94503a', '#833b2b'].map(lin);
  const mortar = lin('#9c968c');
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S, v = (y + 0.5) / S;
    const cv = v * 14, course = Math.floor(cv), fv = cv - course;
    const bu = u * 4 + (course % 2) * 0.5;
    const bi = Math.floor(bu), fu = bu - bi;
    const jw = 10 / 260 / 2, jh = 10 / 72 / 2;
    const du = Math.min(fu, 1 - fu), dv = Math.min(fv, 1 - fv);
    const inBrick = smoothstep(jw * 0.6, jw * 1.4, du) * smoothstep(jh * 0.6, jh * 1.4, dv);
    const id = hash2(((bi % 4) + 4) % 4, course, 51);
    const col = reds[id % reds.length];
    const n = fbm(u, v, 64, 4, 52);
    const speck = fbm(u, v, 300, 1, 53);
    const kb = (0.85 + (hash2(id, 1, 1) / 4294967296) * 0.3) * (1 + n * 0.12 + speck * 0.08);
    const km = 1 + fbm(u, v, 128, 2, 54) * 0.12;
    albedo.set(x, y, lerp(mortar[0] * km, col[0] * kb, inBrick), lerp(mortar[1] * km, col[1] * kb, inBrick), lerp(mortar[2] * km, col[2] * kb, inBrick));
    const bevel = Math.min(1, Math.min(du / 0.06, dv / 0.2));
    height.data[y * S + x] = inBrick * (0.004 + 0.001 * Math.sqrt(bevel)) + n * 0.0004;
    rough.data[y * S + x] = lerp(0.95, 0.82 + n * 0.05, inBrick);
  }
  saveMaterial('brick_red', S, P, { albedo, height, rough }, { aoRadius: 5, aoDepth: 120 });
};

recipes.paving_slabs = () => {
  // 35 x 35 cm grey concrete slabs ("betongplattor"), 4x4 per 1.4 m tile.
  const S = 1024, P = 1.4;
  const albedo = new Img(S, S), height = new Field(S, S), rough = new Field(S, S);
  const base = lin('#8b8883');
  const c: Cell = { f1: 0, f2: 0, id: 0, dx: 0, dy: 0 };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S, v = (y + 0.5) / S;
    const su = u * 4, sv = v * 4;
    const ix = Math.floor(su), iy = Math.floor(sv);
    const fu = su - ix, fv = sv - iy;
    const d = Math.min(fu, 1 - fu, fv, 1 - fv) * 350; // mm from joint
    const inSlab = smoothstep(2, 4.5, d);
    const chamfer = smoothstep(2, 7, d);
    const id = hash2(ix, iy, 61);
    const tone = 0.9 + (id / 4294967296) * 0.2;
    const n = fbm(u, v, 32, 4, 62);
    worley(u, v, 400, 63, 1, c);
    const pore = smoothstep(0.15, 0.04, c.f1) * (hash2(c.id, 1, 1) / 4294967296 > 0.6 ? 1 : 0);
    const stain = smoothstep(0.1, 0.5, fbm(u, v, 6, 3, 64 + (id % 5))) * 0.12;
    const k = tone * (1 + n * 0.06 - pore * 0.2 - stain);
    const joint = lin('#5f5a52');
    albedo.set(x, y, lerp(joint[0], base[0] * k, inSlab), lerp(joint[1], base[1] * k, inSlab), lerp(joint[2], base[2] * k * 0.99, inSlab));
    height.data[y * S + x] = chamfer * 0.003 + n * 0.0003 - pore * 0.0005;
    rough.data[y * S + x] = clamp01(lerp(0.95, 0.84 + n * 0.05, inSlab));
  }
  saveMaterial('paving_slabs', S, [P, P], { albedo, height, rough }, { aoRadius: 3, aoDepth: 200 });
};

recipes.tiles_white = () => {
  // Glazed 15 x 15 cm wall tiles (station / underpass interiors), 8x8 per 1.2 m tile.
  const S = 1024, P = 1.2;
  const albedo = new Img(S, S), height = new Field(S, S), rough = new Field(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S, v = (y + 0.5) / S;
    const su = u * 8, sv = v * 8;
    const ix = Math.floor(su), iy = Math.floor(sv);
    const fu = su - ix, fv = sv - iy;
    const d = Math.min(fu, 1 - fu, fv, 1 - fv) * 150;
    const inTile = smoothstep(1.2, 2.2, d);
    const edgeRound = smoothstep(1.2, 5, d);
    const tone = 0.93 + (hash2(ix, iy, 71) / 4294967296) * 0.05;
    const wave = gnoise(u * 8 * 3, v * 8 * 3, 24, 24, 72) * 0.00015;
    const k = 0.72 * tone;
    const grout = 0.28 * (1 + fbm(u, v, 128, 2, 73) * 0.2);
    albedo.set(x, y, lerp(grout, k, inTile), lerp(grout, k * 0.995, inTile), lerp(grout * 0.95, k * 0.98, inTile));
    height.data[y * S + x] = edgeRound * 0.002 + wave * inTile;
    rough.data[y * S + x] = lerp(0.9, 0.12 + (hash2(ix, iy, 74) / 4294967296) * 0.06, inTile);
  }
  saveMaterial('tiles_white', S, [P, P], { albedo, height, rough }, { aoRadius: 2, aoDepth: 150 });
};

recipes.roof_tiles = () => {
  // Swedish two-wave red clay tiles (enkupigt lertegel): 4 courses x 5 tiles per 1.2 m,
  // each tile one S-wave across, courses overlapping with a lower lip. Fired-clay
  // colour varies per tile; weathering darkens the lower edges.
  const S = 1024, P = 1.2;
  const albedo = new Img(S, S), height = new Field(S, S), rough = new Field(S, S);
  const red = lin('#8a3b22'), dark = lin('#5a2416'), orange = lin('#a14c2b');
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S, v = (y + 0.5) / S;
    const sv = v * 4, iy = Math.floor(sv), fv = sv - iy;          // fv: 0 at the upper edge, 1 at the lip
    const shift = (iy % 2) * 0.5;
    const su = u * 5 + shift, ix = Math.floor(su), fu = su - ix;
    // S-wave profile across the tile, ridge at the overlap side
    const wave = Math.sin(fu * Math.PI * 2) * 0.5 + 0.5;
    const lip = smoothstep(0.82, 0.98, fv);
    const h = wave * 0.012 + fv * 0.01 - smoothstep(0.97, 1.0, fv) * 0.02 + lip * 0.004;
    height.data[y * S + x] = h;
    const r = hash2(ix, iy, 401) / 4294967296;
    const base = [0, 1, 2].map((c) => (r < 0.5 ? lerp(red[c], orange[c], r * 2) : lerp(red[c], dark[c], (r - 0.5) * 1.6)));
    const grime = 0.8 + 0.2 * (1 - smoothstep(0.55, 1.0, fv)) + fbm(u, v, 24, 3, 402) * 0.12;
    const groove = 0.5 + 0.5 * Math.pow(wave, 0.7);
    const underLip = 0.45 + 0.55 * smoothstep(0.0, 0.12, fv);   // shadow under the course above
    const k = grime * groove * underLip;
    albedo.set(x, y, base[0] * k, base[1] * k, base[2] * k);
    rough.data[y * S + x] = 0.78 + 0.15 * (1 - wave) + fbm(u, v, 32, 2, 403) * 0.05;
  }
  saveMaterial('roof_tiles', S, [P, P], { albedo, height, rough }, { aoRadius: 6, aoDepth: 60 });
};

recipes.ground_grass = () => {
  const S = 1024, P = 2;
  const albedo = new Img(S, S), height = new Field(S, S), rough = new Field(S, S);
  const g1 = lin('#56693a'), g2 = lin('#7a7f45'), dirt = lin('#5e5040');
  const c: Cell = { f1: 0, f2: 0, id: 0, dx: 0, dy: 0 };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S, v = (y + 0.5) / S;
    const patch = 0.35 + 0.3 * smoothstep(-0.3, 0.5, fbm(u, v, 8, 4, 81));
    const bare = smoothstep(0.4, 0.6, fbm(u, v, 6, 3, 82)) * 0.5;
    worley(u, v, 300, 83, 1, c);
    const blade = 1 - smoothstep(0.0, 0.5, c.f1);
    const n = fbm(u, v, 128, 3, 84);
    const col = [0, 1, 2].map((i) => lerp(lerp(g1[i], g2[i], patch), dirt[i], bare * 0.8) * (0.8 + blade * 0.35 + n * 0.1));
    albedo.set(x, y, col[0], col[1], col[2]);
    height.data[y * S + x] = blade * 0.004 + n * 0.001;
    rough.data[y * S + x] = 0.93;
  }
  saveMaterial('ground_grass', S, [P, P], { albedo, height, rough }, { aoRadius: 2, aoDepth: 120 });
};

recipes.ground_forest = () => {
  // Nordic forest floor: needles, moss, lingon/blueberry-ish green, bare soil.
  const S = 1024, P = 2;
  const albedo = new Img(S, S), height = new Field(S, S), rough = new Field(S, S);
  const needles = lin('#5c4831'), moss = lin('#46562c'), soil = lin('#3a3026'), lichen = lin('#8c8f76');
  const rng = mulberry32(91);
  const needleMask = new Field(S, S);
  // Scatter needle strokes.
  for (let i = 0; i < 26000; i++) {
    const x0 = rng() * S, y0 = rng() * S, a = rng() * Math.PI, len = 10 + rng() * 14;
    const dx = Math.cos(a), dy = Math.sin(a);
    for (let t = 0; t < len; t += 0.7) {
      const px = Math.floor(x0 + dx * t + S) % S, py = Math.floor(y0 + dy * t + S) % S;
      needleMask.data[py * S + px] = Math.max(needleMask.data[py * S + px], 0.6 + rng() * 0.4);
    }
  }
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S, v = (y + 0.5) / S;
    const mossW = smoothstep(-0.35, 0.2, fbm(u, v, 6, 4, 92)) * 0.9;
    const soilW = smoothstep(0.35, 0.6, fbm(u, v, 8, 3, 93)) * (1 - mossW) * 0.7;
    const lichenW = smoothstep(0.45, 0.6, fbm(u, v, 7, 3, 94)) * mossW;
    const nm = needleMask.data[y * S + x];
    const n = fbm(u, v, 96, 3, 95);
    const col = [0, 1, 2].map((i) => {
      let cc = lerp(needles[i], moss[i], mossW);
      cc = lerp(cc, soil[i], soilW);
      cc = lerp(cc, lichen[i], lichenW);
      cc = lerp(cc, needles[i] * 1.15, nm * (1 - mossW * 0.7) * 0.6);
      return cc * (0.85 + n * 0.2);
    });
    albedo.set(x, y, col[0], col[1], col[2]);
    height.data[y * S + x] = mossW * (0.006 + n * 0.003) + nm * 0.0015 + n * 0.0015;
    rough.data[y * S + x] = 0.95;
  }
  saveMaterial('ground_forest', S, [P, P], { albedo, height, rough }, { aoRadius: 3, aoDepth: 100 });
};

recipes.gravel = () => {
  const S = 1024, P = 1;
  const albedo = new Img(S, S), height = new Field(S, S), rough = new Field(S, S);
  const cols = ['#8d8880', '#6f6a64', '#a39c90', '#7d746b', '#595551'].map(lin);
  const c: Cell = { f1: 0, f2: 0, id: 0, dx: 0, dy: 0 };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S, v = (y + 0.5) / S;
    worley(u, v, 90, 101, 1, c);
    const e = c.f2 - c.f1;
    const st = smoothstep(0.02, 0.2, e);
    const col = cols[hash2(c.id, 1, 1) % cols.length];
    const n = fbm(u, v, 200, 2, 102);
    const k = st * (0.9 + n * 0.15) + (1 - st) * 0.4;
    albedo.set(x, y, col[0] * k, col[1] * k, col[2] * k);
    height.data[y * S + x] = Math.sqrt(clamp01(e * 2.2)) * 0.008;
    rough.data[y * S + x] = 0.85;
  }
  saveMaterial('gravel', S, [P, P], { albedo, height, rough }, { aoRadius: 4, aoDepth: 80 });
};

recipes.rock_granite = () => {
  // Stockholm bedrock ("berghäll"): grey-pink granite, glacial smoothing, lichen.
  const S = 1024, P = 2;
  const albedo = new Img(S, S), height = new Field(S, S), rough = new Field(S, S);
  const grey = lin('#7e7a76'), pink = lin('#94807a'), dark = lin('#3f3d3c'), lichen = lin('#a2a591'), lichenDark = lin('#4b4f45');
  const c: Cell = { f1: 0, f2: 0, id: 0, dx: 0, dy: 0 };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S, v = (y + 0.5) / S;
    worley(u, v, 600, 111, 1, c);
    const grain = hash2(c.id, 1, 1) / 4294967296;
    const mineral = grain < 0.12 ? dark : grain < 0.45 ? pink : grey;
    const low = fbm(u, v, 3, 4, 112);
    const crackR = ridged(u, v, 3, 3, 113);
    const crack = smoothstep(0.82, 0.95, crackR);
    const lich = smoothstep(0.15, 0.4, fbm(u, v, 5, 4, 114));
    const lichD = smoothstep(0.35, 0.5, fbm(u, v, 9, 3, 115));
    const k = 0.9 + low * 0.15;
    let col = mineral.map((m, i) => lerp(m, grey[i], 0.45) * k);
    col = col.map((cc, i) => lerp(cc, lichen[i], lich * 0.7));
    col = col.map((cc, i) => lerp(cc, lichenDark[i], lichD * 0.6));
    col = col.map((cc) => cc * (1 - crack * 0.6));
    albedo.set(x, y, col[0], col[1], col[2]);
    height.data[y * S + x] = low * 0.02 + fbm(u, v, 24, 4, 116) * 0.003 - crack * 0.006 + lich * 0.0008;
    rough.data[y * S + x] = clamp01(0.72 + lich * 0.2 - low * 0.05);
  }
  saveMaterial('rock_granite', S, [P, P], { albedo, height, rough }, { aoRadius: 6, aoDepth: 60 });
};

recipes.metal_painted = () => {
  const S = 512, P = 1;
  const albedo = new Img(S, S), height = new Field(S, S), rough = new Field(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S, v = (y + 0.5) / S;
    const peel = fbm(u, v, 64, 3, 121);
    const wear = smoothstep(0.35, 0.55, fbm(u, v, 6, 4, 122));
    const k = 0.8 * (1 + peel * 0.02) * (1 - wear * 0.1);
    albedo.set(x, y, k, k, k);
    height.data[y * S + x] = peel * 0.00005;
    rough.data[y * S + x] = clamp01(0.42 + wear * 0.2 + peel * 0.03);
  }
  saveMaterial('metal_painted', S, [P, P], { albedo, height, rough });
};

recipes.metal_galvanized = () => {
  const S = 512, P = 1;
  const albedo = new Img(S, S), height = new Field(S, S), rough = new Field(S, S), metal = new Field(S, S);
  const c: Cell = { f1: 0, f2: 0, id: 0, dx: 0, dy: 0 };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S, v = (y + 0.5) / S;
    worley(u, v, 40, 131, 1, c);
    const sp = hash2(c.id, 1, 1) / 4294967296;
    const dull = smoothstep(0.2, 0.6, fbm(u, v, 5, 4, 132));
    const k = 0.55 + sp * 0.12 - dull * 0.1;
    albedo.set(x, y, k, k * 1.01, k * 1.02);
    height.data[y * S + x] = sp * 0.00002;
    rough.data[y * S + x] = clamp01(0.3 + sp * 0.18 + dull * 0.3);
    metal.data[y * S + x] = 1 - dull * 0.3;
  }
  saveMaterial('metal_galvanized', S, [P, P], { albedo, height, rough, metal });
};

recipes.bark_pine = () => {
  const S = 512, P = 1;
  const albedo = new Img(S, S), height = new Field(S, S), rough = new Field(S, S);
  const plate = lin('#7b5a44'), furrow = lin('#2e2520'), orange = lin('#a0643e');
  const c: Cell = { f1: 0, f2: 0, id: 0, dx: 0, dy: 0 };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S, v = (y + 0.5) / S;
    // Elongated plates: squash v by sampling worley with fewer cells vertically.
    worley((u * 3) % 1, v, 12, 141, 1, c);
    const e = c.f2 - c.f1;
    const pl = smoothstep(0.05, 0.25, e);
    const n = fbm(u, v, 32, 4, 142);
    const t = hash2(c.id, 1, 1) / 4294967296;
    const col = [0, 1, 2].map((i) => lerp(furrow[i], lerp(plate[i], orange[i], t * 0.5), pl) * (0.9 + n * 0.2));
    albedo.set(x, y, col[0], col[1], col[2]);
    height.data[y * S + x] = pl * 0.012 + n * 0.002;
    rough.data[y * S + x] = 0.92;
  }
  saveMaterial('bark_pine', S, [P, P], { albedo, height, rough }, { aoRadius: 4, aoDepth: 40 });
};

recipes.bark_birch = () => {
  const S = 512, P = 1;
  const albedo = new Img(S, S), height = new Field(S, S), rough = new Field(S, S);
  const white = lin('#d6d2c8'), black = lin('#2a2826');
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S, v = (y + 0.5) / S;
    const lent = gnoise(u * 6, v * 40, 6, 40, 151);
    const lenticel = smoothstep(0.55, 0.75, lent);
    const patch = smoothstep(0.35, 0.5, fbm(u, v, 3, 4, 152));
    const n = fbm(u, v, 32, 3, 153);
    const d = Math.max(lenticel, patch * 0.9);
    const col = [0, 1, 2].map((i) => lerp(white[i] * (0.92 + n * 0.1), black[i], d));
    albedo.set(x, y, col[0], col[1], col[2]);
    height.data[y * S + x] = -d * 0.002 + n * 0.0005;
    rough.data[y * S + x] = lerp(0.6, 0.9, d);
  }
  saveMaterial('bark_birch', S, [P, P], { albedo, height, rough });
};

recipes.moss = () => {
  // Cushion moss / algae growth for wall bases and damp concrete.
  const S = 1024, P = 1;
  const albedo = new Img(S, S), height = new Field(S, S), rough = new Field(S, S);
  const g1 = lin('#4f5d2c'), g2 = lin('#6f7a35'), dark = lin('#2b3220'), dry = lin('#7c7552');
  const c: Cell = { f1: 0, f2: 0, id: 0, dx: 0, dy: 0 };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S, v = (y + 0.5) / S;
    worley(u, v, 40, 321, 1, c);
    const cushion = Math.sqrt(clamp01(1 - c.f1 * 1.15));
    const fine = fbm(u, v, 96, 3, 322);
    const tone = fbm(u, v, 6, 4, 323);
    const dryW = smoothstep(0.25, 0.5, fbm(u, v, 5, 3, 324));
    const col = [0, 1, 2].map((i) => lerp(lerp(g1[i], g2[i], 0.5 + tone * 0.8), dry[i], dryW * 0.5) * (0.7 + cushion * 0.45 + fine * 0.15));
    const crev = 1 - smoothstep(0.0, 0.25, c.f2 - c.f1);
    albedo.set(x, y, lerp(col[0], dark[0], crev * 0.6), lerp(col[1], dark[1], crev * 0.6), lerp(col[2], dark[2], crev * 0.6));
    height.data[y * S + x] = cushion * 0.006 + fine * 0.0008;
    rough.data[y * S + x] = 0.97;
  }
  saveMaterial('moss', S, [P, P], { albedo, height, rough }, { aoRadius: 5, aoDepth: 60 });
};

recipes.dirt = () => {
  // Damp soil / grime with grit for wall bases, path edges and splash zones.
  const S = 1024, P = 1;
  const albedo = new Img(S, S), height = new Field(S, S), rough = new Field(S, S);
  const soil = lin('#4a3f33'), grey = lin('#5d5853'), wet = lin('#2f2a24');
  const c: Cell = { f1: 0, f2: 0, id: 0, dx: 0, dy: 0 };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S, v = (y + 0.5) / S;
    worley(u, v, 140, 331, 1, c);
    const grit = smoothstep(0.1, 0.3, c.f2 - c.f1) * ((hash2(c.id, 1, 1) / 4294967296) > 0.55 ? 1 : 0);
    const tone = fbm(u, v, 5, 4, 332);
    const wetW = smoothstep(0.1, 0.5, fbm(u, v, 4, 3, 333));
    const col = [0, 1, 2].map((i) => lerp(lerp(soil[i], grey[i], 0.5 + tone * 0.6), wet[i], wetW * 0.5) * (1 + grit * 0.4));
    albedo.set(x, y, col[0], col[1], col[2]);
    height.data[y * S + x] = grit * 0.002 + fbm(u, v, 48, 3, 334) * 0.001;
    rough.data[y * S + x] = clamp01(0.92 - wetW * 0.25);
  }
  saveMaterial('dirt', S, [P, P], { albedo, height, rough }, { aoRadius: 3, aoDepth: 120 });
};

/**
 * Alpha-tested foliage spray cards (twig base at the bottom centre, growth
 * upwards). Rasterised from strokes with coverage + a shade value; colour is
 * dilated into transparent texels so mips never bleed dark fringes. AO darkens
 * the inner/older parts of the spray.
 */
function sprayCard(name: string, kind: 'pine' | 'spruce' | 'birch' | 'birch_bare' | 'dead' | 'grass' | 'dwarf' | 'fern') {
  const S = 1024;
  const cov = new Field(S, S), shade = new Field(S, S), age = new Field(S, S);
  const seeds = { pine: 161, spruce: 191, birch: 171, birch_bare: 173, dead: 197, grass: 211, dwarf: 223, fern: 227 };
  const rng = mulberry32(seeds[kind]);
  // Anti-aliased capsule stroke; `val` = colour variation, `ag` = 0 young .. 1 old/inner.
  const seg = (x0: number, y0: number, x1: number, y1: number, w: number, val: number, ag: number) => {
    const minX = Math.max(0, Math.floor(Math.min(x0, x1) - w - 1)), maxX = Math.min(S - 1, Math.ceil(Math.max(x0, x1) + w + 1));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1) - w - 1)), maxY = Math.min(S - 1, Math.ceil(Math.max(y0, y1) + w + 1));
    const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy || 1;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const t = clamp01(((x + 0.5 - x0) * dx + (y + 0.5 - y0) * dy) / l2);
      const px = x0 + dx * t - (x + 0.5), py = y0 + dy * t - (y + 0.5);
      const a = clamp01(w + 0.5 - Math.sqrt(px * px + py * py));
      const i = y * S + x;
      if (a > cov.data[i] || (a > 0.5 && val < 0)) {
        cov.data[i] = Math.max(cov.data[i], a); shade.data[i] = val; age.data[i] = ag;
      }
    }
  };
  // Leaf blade: ovate-triangular with a serrated rim and a midrib.
  const leaf = (bx: number, by: number, ang: number, len: number, wid: number, val: number) => {
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const r = len + 2;
    for (let y = Math.max(0, Math.floor(by - r)); y <= Math.min(S - 1, Math.ceil(by + r)); y++) for (let x = Math.max(0, Math.floor(bx - r)); x <= Math.min(S - 1, Math.ceil(bx + r)); x++) {
      const px = x + 0.5 - bx, py = y + 0.5 - by;
      const l = px * ca + py * sa, q = -px * sa + py * ca;
      const t = l / len;
      if (t < 0 || t > 1) continue;
      // Widest at ~30% (birch leaves are rhombic-triangular), pointed tip.
      const prof = wid * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.75)), 0.9) * (1 - 0.35 * t);
      const serr = 1 + 0.08 * Math.sin(t * 60);
      const a = clamp01((prof * serr - Math.abs(q)) * 1.2 + 0.5);
      if (a <= 0) continue;
      const i = y * S + x;
      const rib = Math.abs(q) < 0.9 && t < 0.92 ? -0.25 : 0;
      if (a >= cov.data[i]) { cov.data[i] = a; shade.data[i] = clamp01(val + rib + (Math.abs(q) / Math.max(1, prof)) * 0.15); age.data[i] = t * 0.3; }
    }
  };
  // Polyline twig with a curvature; calls `along(x, y, ang, t)` per step.
  const twig = (x: number, y: number, ang: number, len: number, w0: number, w1: number, bend: number, steps: number,
    along: (x: number, y: number, a: number, t: number) => void, ag0 = 0.8, ag1 = 0.1) => {
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const a = ang + bend * t;
      const nx = x + Math.cos(a) * (len / steps), ny = y + Math.sin(a) * (len / steps);
      seg(x, y, nx, ny, lerp(w0, w1, t), -1, lerp(ag0, ag1, t));
      along(nx, ny, a, t);
      x = nx; y = ny;
    }
    return [x, y];
  };
  const UP = -Math.PI / 2;
  if (kind === 'spruce') {
    // Norway spruce frond: main shoot with alternating side shoots, short dense needles.
    const needles = (x: number, y: number, a: number, t: number, density: number, nl: number) => {
      for (let k = 0; k < density; k++) {
        const side = k % 2 ? 1 : -1;
        const na = a + side * (0.65 + rng() * 0.55) + (rng() - 0.5) * 0.25;
        const l = nl * (0.8 + rng() * 0.4) * (1 - t * 0.25);
        const ox = x + (rng() - 0.5) * 4, oy = y + (rng() - 0.5) * 4;
        seg(ox, oy, ox + Math.cos(na) * l, oy + Math.sin(na) * l, 1.5, 0.4 + rng() * 0.6, 1 - t);
      }
    };
    twig(S / 2, S - 8, UP + 0.04, S * 0.92, 5, 1.8, -0.1, 90, (x, y, a, t) => {
      needles(x, y, a, t, 8, 30);
      if (t > 0.03 && t < 0.88 && (Math.round(t * 90) % 3 === 0)) {
        const side = Math.round(t * 90) % 6 === 0 ? 1 : -1;
        const sl = S * 0.5 * (1 - t) ** 0.65 * (0.8 + rng() * 0.3) + 50;
        twig(x, y, a + side * (0.9 + rng() * 0.25), sl, 2.8, 1.1, -side * 0.5, 34, (x2, y2, a2, t2) => {
          needles(x2, y2, a2, t2, 6, 26);
          if (t2 > 0.15 && t2 < 0.75 && rng() < 0.22) {
            twig(x2, y2, a2 + (rng() < 0.5 ? 1 : -1) * 0.85, sl * 0.35, 1.6, 0.9, 0, 12, (x3, y3, a3, t3) => needles(x3, y3, a3, t3, 5, 22), 0.6, 0.1);
          }
        }, 0.7, 0.05);
      }
    }, 0.95, 0.1);
  } else if (kind === 'pine') {
    // Scots pine tuft: a few shoots fanning upwards, bottle-brush paired long needles towards the ends.
    const n = 6;
    for (let b = 0; b < n; b++) {
      const ang = UP + (b - (n - 1) / 2) * 0.24 + (rng() - 0.5) * 0.1;
      const len = S * (0.55 + rng() * 0.25) * (1 - Math.abs(b - (n - 1) / 2) * 0.06);
      const x0 = S / 2 + (rng() - 0.5) * 50;
      const [ex, ey] = twig(x0, S - 6, ang, len, 4.5, 2.6, (rng() - 0.5) * 0.3, 40, (x, y, a, t) => {
        if (t < 0.18) return;
        for (let k = 0; k < 9; k++) {
          const side = k % 2 ? 1 : -1;
          const spread = 0.35 + rng() * 0.75;
          const na = a + side * spread;
          const nl = (62 + rng() * 32) * (0.75 + 0.25 * Math.sin(Math.PI * t));
          const ox = x + (rng() - 0.5) * 5, oy = y + (rng() - 0.5) * 5;
          // Pine needles curve slightly and come in pairs.
          const mx = ox + Math.cos(na) * nl * 0.5, my = oy + Math.sin(na) * nl * 0.5;
          const na2 = na - side * 0.12;
          const v = 0.35 + rng() * 0.65;
          seg(ox, oy, mx, my, 1.45, v, 1 - t);
          seg(mx, my, mx + Math.cos(na2) * nl * 0.5, my + Math.sin(na2) * nl * 0.5, 1.2, v, 1 - t);
        }
      }, 0.9, 0.2);
      // terminal bud
      seg(ex, ey, ex + Math.cos(ang) * 14, ey + Math.sin(ang) * 14, 4, -1, 0);
    }
  } else if (kind === 'grass') {
    // Grass tuft: blades from a tight base, curving outwards; mixed live and dead blades.
    for (let k = 0; k < 140; k++) {
      const x0 = S / 2 + (rng() - 0.5) * 120;
      const lean = (rng() - 0.5) * 1.1;
      const len = S * (0.45 + rng() * 0.5) * (1 - Math.abs(lean) * 0.35);
      const w0 = 3.2 + rng() * 2.4;
      const v = rng() < 0.38 ? 0.95 + rng() * 0.05 : rng() * 0.8; // >0.9 = dead straw blade
      let x = x0, y = S - 4, a = UP + lean * 0.35;
      const bend = lean * (0.6 + rng() * 0.6);
      const steps = 14;
      for (let st = 0; st < steps; st++) {
        const t = st / steps;
        const nx = x + Math.cos(a + bend * t * t) * (len / steps), ny = y + Math.sin(a + bend * t * t) * (len / steps);
        seg(x, y, nx, ny, w0 * (1 - t * 0.85), v, 1 - t);
        x = nx; y = ny;
      }
    }
  } else if (kind === 'dwarf') {
    // Dwarf shrub (blueberry / lingonberry): wiry branching stems with small oval leaves.
    for (let b = 0; b < 9; b++) {
      const x0 = S / 2 + (rng() - 0.5) * 300;
      twig(x0, S - 6, UP + (rng() - 0.5) * 0.9, S * (0.45 + rng() * 0.4), 3.2, 1.2, (rng() - 0.5) * 0.8, 24, (x, y, a, t) => {
        if (t > 0.15 && rng() < 0.55) {
          const side = rng() < 0.5 ? -1 : 1;
          const la = a + side * (0.7 + rng() * 0.6);
          const ll = 22 + rng() * 16;
          leaf(x, y, la, ll, ll * 0.55, rng() < 0.18 ? 0.95 : rng() * 0.7);
        }
        if (t > 0.3 && t < 0.8 && rng() < 0.08) {
          const side = rng() < 0.5 ? -1 : 1;
          twig(x, y, a + side * 0.7, S * 0.15, 1.8, 0.9, -side * 0.2, 10, (x2, y2, a2) => {
            if (rng() < 0.5) { const ll = 18 + rng() * 12; leaf(x2, y2, a2 + (rng() < 0.5 ? 0.9 : -0.9), ll, ll * 0.55, rng() * 0.7); }
          }, 0.6, 0.2);
        }
      }, 0.8, 0.2);
    }
  } else if (kind === 'fern') {
    // Dead bracken: brown arching fronds with pinnate leaflets (late winter, flattened).
    for (let f = 0; f < 5; f++) {
      const x0 = S / 2 + (rng() - 0.5) * 140;
      const ang = UP + (f - 2) * 0.32 + (rng() - 0.5) * 0.2;
      twig(x0, S - 6, ang, S * (0.6 + rng() * 0.3), 3.6, 1.2, (f - 2) * 0.35 + (rng() - 0.5) * 0.3, 40, (x, y, a, t) => {
        if (t > 0.12 && Math.round(t * 40) % 2 === 0) {
          for (const side of [-1, 1]) {
            const pl = (S * 0.13) * Math.sin(Math.PI * Math.min(1, t * 1.1)) * (0.7 + rng() * 0.3) + 10;
            const pa = a + side * (1.15 + rng() * 0.2);
            leaf(x, y, pa, pl, pl * 0.22, 0.2 + rng() * 0.75);
          }
        }
      }, 0.8, 0.3);
    }
  } else if (kind === 'birch_bare') {
    // Winter birch: dense, fine, pendulous red-brown twigs (reads as a purple haze at distance).
    for (let b = 0; b < 10; b++) {
      const x0 = S / 2 + (rng() - 0.5) * 220;
      const ang = UP + (b - 4.5) * 0.16 + (rng() - 0.5) * 0.25;
      twig(x0, S - 6, ang, S * (0.62 + rng() * 0.32), 2.6, 0.8, (rng() - 0.5) * 0.7, 46, (x, y, a, t) => {
        if (t > 0.05 && rng() < 0.32) {
          const side = rng() < 0.5 ? -1 : 1;
          const sl = S * (0.1 + rng() * 0.2) * (1 - t * 0.5);
          twig(x, y, a + side * (0.35 + rng() * 0.5), sl, 1.3, 0.55, -side * 0.25, 14, (x2, y2, a2, t2) => {
            if (rng() < 0.18) {
              const s2 = rng() < 0.5 ? -1 : 1;
              twig(x2, y2, a2 + s2 * 0.5, sl * 0.4, 0.9, 0.5, 0, 6, () => {}, 0.3, 0.1);
            }
            if (t2 > 0.95) seg(x2, y2, x2 + Math.cos(a2) * 4, y2 + Math.sin(a2) * 4, 1.4, 0.05, 0.9);
          }, 0.5, 0.15);
        }
      }, 0.8, 0.2);
    }
  } else if (kind === 'dead') {
    // Dead lower spruce twigs: grey, brittle, herring-bone side twigs without needles,
    // with pale beard-lichen flecks.
    twig(S / 2, S - 8, UP + 0.03, S * 0.9, 4, 1.4, -0.12, 60, (x, y, a, t) => {
      if (t > 0.04 && t < 0.9 && Math.round(t * 60) % 3 === 0) {
        const side = Math.round(t * 60) % 6 === 0 ? 1 : -1;
        const sl = (S * 0.36 * (1 - t) ** 0.6 + 30) * (rng() < 0.25 ? 0.35 : 1); // some broken short
        twig(x, y, a + side * (0.9 + rng() * 0.3), sl, 2.0, 0.8, -side * 0.35, 18, (x2, y2, a2, t2) => {
          if (rng() < 0.12) {
            const s2 = rng() < 0.5 ? -1 : 1;
            twig(x2, y2, a2 + s2 * 0.8, sl * 0.3, 1.0, 0.6, 0, 7, () => {}, 0.6, 0.3);
          }
          if (rng() < 0.05) {
            // lichen tuft
            for (let k = 0; k < 6; k++) {
              const la = rng() * Math.PI * 2, ll = 6 + rng() * 10;
              seg(x2, y2, x2 + Math.cos(la) * ll, y2 + Math.sin(la) * ll, 1.2, 0.95, 0.0);
            }
          }
        }, 0.7, 0.4);
      }
    }, 0.9, 0.4);
  } else {
    // Silver birch: fine pendulous twigs with petioled rhombic leaves (texture "up" hangs down in the tree).
    for (let b = 0; b < 7; b++) {
      const x0 = S / 2 + (rng() - 0.5) * 160;
      const ang = UP + (b - 3) * 0.2 + (rng() - 0.5) * 0.25;
      twig(x0, S - 6, ang, S * (0.6 + rng() * 0.32), 2.4, 0.9, (rng() - 0.5) * 0.6, 44, (x, y, a, t) => {
        if (t > 0.08 && rng() < 0.55) {
          const side = rng() < 0.5 ? -1 : 1;
          const pa = a + side * (0.6 + rng() * 0.7);
          const pl = 10 + rng() * 8;
          const lx = x + Math.cos(pa) * pl, ly = y + Math.sin(pa) * pl;
          seg(x, y, lx, ly, 0.8, -1, 0.2);
          const ll = (42 + rng() * 22) * (0.75 + 0.25 * t);
          leaf(lx, ly, pa + (rng() - 0.5) * 0.5, ll, ll * 0.42, 0.25 + rng() * 0.75);
        }
        if (t > 0.15 && t < 0.75 && rng() < 0.06) {
          const side = rng() < 0.5 ? -1 : 1;
          twig(x, y, a + side * 0.7, S * 0.22, 1.2, 0.7, -side * 0.3, 14, (x2, y2, a2, t2) => {
            if (rng() < 0.5) {
              const s2 = rng() < 0.5 ? -1 : 1;
              const pa = a2 + s2 * (0.6 + rng() * 0.7);
              const lx = x2 + Math.cos(pa) * 12, ly = y2 + Math.sin(pa) * 12;
              seg(x2, y2, lx, ly, 0.7, -1, 0.2);
              const ll = 36 + rng() * 18;
              leaf(lx, ly, pa, ll, ll * 0.42, 0.3 + rng() * 0.7);
            }
          }, 0.5, 0.1);
        }
      }, 0.7, 0.1);
    }
  }
  const pal = {
    spruce: { a: lin('#1d3019'), b: lin('#3c5a2a'), young: lin('#6d8a3c'), twig: lin('#5a3f2a') },
    pine: { a: lin('#2d4128'), b: lin('#506a3c'), young: lin('#5f7a44'), twig: lin('#8a5a36') },
    birch: { a: lin('#44612a'), b: lin('#6a8834'), young: lin('#84a042'), twig: lin('#4a3a30') },
    birch_bare: { a: lin('#3b2f2c'), b: lin('#5c4c47'), young: lin('#6a5650'), twig: lin('#3e322f') },
    dead: { a: lin('#4d463f'), b: lin('#7b7367'), young: lin('#a3a68e'), twig: lin('#5a5249') },
    grass: { a: lin('#4f5d2c'), b: lin('#76804a'), young: lin('#8a8a55'), twig: lin('#9c8f66') },
    dwarf: { a: lin('#24391d'), b: lin('#3d5a2a'), young: lin('#6a3a2a'), twig: lin('#5a3a2c') },
    fern: { a: lin('#4a301d'), b: lin('#6e4c2e'), young: lin('#7a5636'), twig: lin('#45301f') },
  }[kind];
  const twigOnly = kind === 'birch_bare' || kind === 'dead';
  const albedo = new Img(S, S), rough = new Field(S, S), ao = new Field(S, S);
  // Dilate colours into empty texels (nearest-ish fill in a few passes).
  const col = new Float32Array(S * S * 3);
  const filled = new Uint8Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = y * S + x;
    if (cov.data[i] <= 0.01) continue;
    const sv = shade.data[i];
    let c: number[];
    if (sv < 0) {
      // Twig bark: plain for leafy sprays; for bare twigs, older (inner) wood darker.
      c = twigOnly ? pal.a.map((v, k) => lerp(v, pal.b[k], 0.25 + 0.75 * clamp01(1 - age.data[i]))) : pal.twig;
    } else if (twigOnly) {
      c = sv > 0.9 ? pal.young : pal.a.map((v) => v * 0.8); // lichen flecks / buds
    } else if ((kind === 'grass' || kind === 'dwarf') && sv > 0.9) {
      c = kind === 'grass' ? pal.twig : pal.young; // dead straw blade / reddened winter leaf
    } else {
      c = pal.a.map((v, k) => lerp(v, pal.b[k], sv));
      // Young growth (shoot tips) lighter and yellower.
      const yg = clamp01(1 - age.data[i] * 2.2) * (kind === 'birch' ? 0.25 : 0.55);
      c = c.map((v, k) => lerp(v, pal.young[k], yg));
    }
    const n = fbm((x + 0.5) / S, (y + 0.5) / S, 12, 3, seeds[kind] + 9) * 0.18;
    col[i * 3] = c[0] * (1 + n); col[i * 3 + 1] = c[1] * (1 + n); col[i * 3 + 2] = c[2] * (1 + n);
    filled[i] = 1;
  }
  for (let pass = 0; pass < 24; pass++) {
    const next = filled.slice();
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = y * S + x;
      if (filled[i]) continue;
      let r = 0, g = 0, b = 0, k = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= S || yy >= S) continue;
        const j = yy * S + xx;
        if (!filled[j]) continue;
        r += col[j * 3]; g += col[j * 3 + 1]; b += col[j * 3 + 2]; k++;
      }
      if (k) { col[i * 3] = r / k; col[i * 3 + 1] = g / k; col[i * 3 + 2] = b / k; next[i] = 1; }
    }
    filled.set(next);
  }
  const avg = [0, 1, 2].map((k) => (pal.a[k] + pal.b[k]) * 0.5);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = y * S + x;
    const c = filled[i] ? [col[i * 3], col[i * 3 + 1], col[i * 3 + 2]] : avg;
    albedo.set(x, y, c[0], c[1], c[2], cov.data[i]);
    rough.data[i] = shade.data[i] < 0 ? 0.85 : kind === 'birch' ? 0.55 : 0.6;
    ao.data[i] = cov.data[i] > 0.01 ? 0.55 + 0.45 * clamp01(1 - age.data[i] * 0.8) : 1;
  }
  saveMaterial(name, S, [1, 1], { albedo, rough, ao });
}
recipes.foliage_pine = () => sprayCard('foliage_pine', 'pine');
recipes.foliage_spruce = () => sprayCard('foliage_spruce', 'spruce');
recipes.foliage_birch = () => sprayCard('foliage_birch', 'birch');
recipes.twigs_birch = () => sprayCard('twigs_birch', 'birch_bare');
recipes.twigs_dead = () => sprayCard('twigs_dead', 'dead');
recipes.tuft_grass = () => sprayCard('tuft_grass', 'grass');
recipes.tuft_dwarf = () => sprayCard('tuft_dwarf', 'dwarf');
recipes.tuft_fern = () => sprayCard('tuft_fern', 'fern');

recipes.forest_canopy = () => {
  // Forest seen from far away / above: irregular 3-6 m crowns (two sizes), soft gaps, mixed tones.
  const S = 1024, P = 48;
  const albedo = new Img(S, S), height = new Field(S, S), rough = new Field(S, S);
  const spruce = lin('#2c4127'), pine = lin('#3d5532'), birch = lin('#5e7e36'), gap = lin('#1f2b1a');
  const c1: Cell = { f1: 0, f2: 0, id: 0, dx: 0, dy: 0 }, c2: Cell = { f1: 0, f2: 0, id: 0, dx: 0, dy: 0 };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S, v = (y + 0.5) / S;
    // Domain warp breaks the cell regularity.
    const wu = u + (fbm(u, v, 8, 3, 223) - 0.5) * 0.04, wv = v + (fbm(u, v, 8, 3, 224) - 0.5) * 0.04;
    worley(((wu % 1) + 1) % 1, ((wv % 1) + 1) % 1, 11, 221, 1, c1);
    worley(((wu % 1) + 1) % 1, ((wv % 1) + 1) % 1, 23, 225, 1, c2);
    const big = 1 - smoothstep(0.2, 0.85, c1.f1 * 1.25);
    const small = 1 - smoothstep(0.2, 0.85, c2.f1 * 1.25);
    const crown = Math.max(big, small * 0.85);
    const id = big >= small * 0.85 ? c1.id : c2.id + 7;
    const t = hash2(id, 5, 9) / 4294967296;
    const n = fbm(u, v, 128, 3, 222);
    const base = t < 0.45 ? spruce : t < 0.85 ? pine : birch;
    const lit = 0.85 + 0.2 * crown + (n - 0.5) * 0.2;
    const col = [0, 1, 2].map((i) => lerp(gap[i], base[i] * lit, smoothstep(0.0, 0.45, crown)));
    albedo.set(x, y, col[0], col[1], col[2]);
    height.data[y * S + x] = crown * (0.6 + 0.4 * t) * 2.5;
    rough.data[y * S + x] = 0.9;
  }
  saveMaterial('forest_canopy', S, [P, P], { albedo, height, rough }, { aoRadius: 8, aoDepth: 1.0 });
};

recipes.facade_far = () => {
  // Distant apartment facade: 4 bays x 4 storeys (2.7 m bays, 2.8 m storeys), windows + balcony bands.
  const S = 512, PW = 10.8, PH = 11.2;
  const albedo = new Img(S, S), rough = new Field(S, S), metal = new Field(S, S), height = new Field(S, S);
  const wall = lin('#c9c2b4'), glass = lin('#262c33'), frame = lin('#e8e6e0'), slab = lin('#9a958c');
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const mx = ((x + 0.5) / S) * PW, my = ((y + 0.5) / S) * PH;
    const bx = mx % 2.7, sy = my % 2.8;
    const win = bx > 0.7 && bx < 2.0 && sy > 0.9 && sy < 2.3;
    const fr = bx > 0.62 && bx < 2.08 && sy > 0.82 && sy < 2.38;
    const band = sy > 2.55;
    const n = fbm((x + 0.5) / S, (y + 0.5) / S, 16, 3, 231);
    const col = win ? glass : fr ? frame : band ? slab : wall;
    albedo.set(x, y, col[0] * (0.95 + n * 0.1), col[1] * (0.95 + n * 0.1), col[2] * (0.95 + n * 0.1));
    rough.data[y * S + x] = win ? 0.08 : 0.85;
    height.data[y * S + x] = win ? -0.06 : band ? 0.04 : 0;
  }
  saveMaterial('facade_far', S, [PW, PH], { albedo, height, rough, metal }, { aoRadius: 2, aoDepth: 20 });
};

recipes.bark_pine_upper = () => {
  // Scots pine upper trunk: thin orange bark peeling in papery, roughly horizontal flakes.
  const S = 512, P = 1;
  const albedo = new Img(S, S), height = new Field(S, S), rough = new Field(S, S);
  const orange = lin('#b36a3c'), pale = lin('#d29a68'), dark = lin('#6e3f26'), grey = lin('#8a7a6a');
  const c: Cell = { f1: 0, f2: 0, id: 0, dx: 0, dy: 0 };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S, v = (y + 0.5) / S;
    // Domain-warped cells: irregular papery flakes, wider than tall.
    const wu = u + (fbm(u, v, 6, 3, 204) - 0.5) * 0.08, wv = v + (fbm(u, v, 6, 3, 205) - 0.5) * 0.03;
    worley(((wu % 1) + 1) % 1, ((wv * 3 % 1) + 1) % 1, 16, 201, 1, c);
    const e = c.f2 - c.f1;
    const edge = 1 - smoothstep(0.0, 0.05, e);
    const t = hash2(c.id, 3, 7) / 4294967296;
    const n = fbm(u, v, 48, 4, 202);
    let col = [0, 1, 2].map((i) => lerp(orange[i], pale[i], smoothstep(0.65, 1.0, t) * 0.6));
    col = col.map((cc, i) => lerp(cc, grey[i], smoothstep(0.55, 0.8, fbm(u, v, 4, 3, 203)) * 0.5));
    col = col.map((cc, i) => lerp(cc, dark[i], edge * 0.45 + (1 - n) * 0.15) * (0.88 + n * 0.24));
    albedo.set(x, y, col[0], col[1], col[2]);
    height.data[y * S + x] = (1 - edge) * 0.0015 * (0.5 + t) + n * 0.0006;
    rough.data[y * S + x] = 0.82;
  }
  saveMaterial('bark_pine_upper', S, [P, P], { albedo, height, rough }, { aoRadius: 3, aoDepth: 60 });
};

recipes.bark_birch_base = () => {
  // Old birch base: black-grey, deeply fissured with corky grey ridges.
  const S = 512, P = 1;
  const albedo = new Img(S, S), height = new Field(S, S), rough = new Field(S, S);
  const ridge = lin('#6d6860'), fissure = lin('#1c1a18'), white = lin('#bdb8ad');
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S, v = (y + 0.5) / S;
    const r = ridged((u * 3) % 1, v, 6, 4, 211);
    const fis = smoothstep(0.45, 0.8, r);
    const n = fbm(u, v, 32, 3, 212);
    const wp = smoothstep(0.62, 0.75, fbm(u, v, 5, 3, 213)) * (1 - fis);
    const col = [0, 1, 2].map((i) => lerp(lerp(ridge[i], white[i], wp * 0.7), fissure[i], fis) * (0.88 + n * 0.24));
    albedo.set(x, y, col[0], col[1], col[2]);
    height.data[y * S + x] = (1 - fis) * 0.01 + n * 0.001;
    rough.data[y * S + x] = 0.93;
  }
  saveMaterial('bark_birch_base', S, [P, P], { albedo, height, rough }, { aoRadius: 4, aoDepth: 40 });
};

recipes.fence_chainlink = () => {
  // 50 mm diamond chain-link, 3 mm galvanised wire: tile = 0.1 m (two diamonds).
  const S = 256, P = 0.1;
  const albedo = new Img(S, S), rough = new Field(S, S), metal = new Field(S, S);
  const wire = 0.003 / P; // in tile units
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S, v = (y + 0.5) / S;
    // Two diagonal families of wires.
    const d1 = Math.abs(((u + v) * 2) % 1 - 0.5) / 2;
    const d2 = Math.abs(((u - v + 4) * 2) % 1 - 0.5) / 2;
    const d = Math.min(0.25 - d1, 0.25 - d2) * Math.SQRT1_2;
    const a = clamp01((wire * 0.5 - Math.abs(d)) * S + 0.5);
    const k = 0.55 + 0.1 * fbm(u, v, 8, 2, 311);
    albedo.set(x, y, k, k, k * 1.02, a);
    rough.data[y * S + x] = 0.45;
    metal.data[y * S + x] = 1;
  }
  saveMaterial('fence_chainlink', S, [P, P], { albedo, rough, metal });
};

recipes.tiles_brown = () => {
  // 1950s T-bana station wall tiles: 15 x 15 cm glazed stoneware, dark brown with
  // per-tile glaze variation, 4 mm grout. Tile = 0.6 m (4 x 4 tiles).
  const S = 1024, P = 0.6;
  const albedo = new Img(S, S), height = new Field(S, S), rough = new Field(S, S);
  const glazeA = lin('#3b2a20'), glazeB = lin('#5a3f2c'), grout = lin('#6d675e');
  const g = 0.002 / P * 4;   // half grout width in tile-cell units
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S, v = (y + 0.5) / S;
    const cu = u * 4, cv = v * 4, iu = Math.floor(cu), iv = Math.floor(cv);
    const fu = cu - iu, fv = cv - iv;
    const e = Math.min(fu, 1 - fu, fv, 1 - fv);                  // distance to the cell edge
    const inTile = smoothstep(g * 0.8, g * 1.4, e);
    const r = hash2(iu, iv, 931) / 4294967296;
    const glaze = [0, 1, 2].map((c) => lerp(glazeA[c], glazeB[c], r) * (0.9 + 0.15 * fbm(u, v, 24, 2, 932)));
    const c = [0, 1, 2].map((k) => lerp(grout[k], glaze[k], inTile));
    albedo.set(x, y, c[0], c[1], c[2]);
    height.data[y * S + x] = inTile * 0.002 + smoothstep(0.0, 0.25, e) * 0.0008;
    rough.data[y * S + x] = lerp(0.9, 0.22 + 0.1 * fbm(u, v, 16, 2, 933), inTile);
  }
  saveMaterial('tiles_brown', S, [P, P], { albedo, height, rough }, { aoRadius: 3, aoDepth: 80 });
};

recipes.sign_tbana = () => {
  // SL tunnelbana sign (1950s design): blue T inside a blue ring on a white disc.
  // The texture spans the disc diameter (UVs from the disc caps).
  const S = 512, P = 0.9;
  const albedo = new Img(S, S), rough = new Field(S, S);
  const blue = lin('#0b5aa6'), white = lin('#f2f0e6');
  const aa = (d: number) => clamp01(d * S + 0.5);            // signed distance (tile units) -> coverage
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S - 0.5, v = 0.5 - (y + 0.5) / S;     // centred, v up
    const r = Math.hypot(u, v);
    const ring = aa(Math.min(r - 0.415, 0.5 - r));               // blue ring between r 0.415 and the rim
    const bar = aa(Math.min(0.29 - Math.abs(u), 0.075 - Math.abs(v - 0.2)));
    const stem = aa(Math.min(0.085 - Math.abs(u), 0.2 - Math.abs(v + 0.06)));
    const t = Math.max(ring, bar, stem);
    albedo.set(x, y, lerp(white[0], blue[0], t), lerp(white[1], blue[1], t), lerp(white[2], blue[2], t));
    rough.data[y * S + x] = 0.25;
  }
  saveMaterial('sign_tbana', S, [P, P], { albedo, rough });
};

recipes.railing_bars = () => {
  // 1950s viaduct railing infill: 16 mm flat bars at 125 mm, dark painted steel (alpha mask).
  const S = 256, P = 0.5;
  const albedo = new Img(S, S), rough = new Field(S, S), metal = new Field(S, S);
  const half = 0.008 / P;
  const paint = lin('#2c3034'), rust = lin('#4a3326');
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S, v = (y + 0.5) / S;
    const f = (u * 4) % 1, d = Math.abs(f - 0.5) / 4;           // distance to the bar centre (tile units)
    const a = clamp01((half - d) * S + 0.5);
    const r = smoothstep(0.55, 0.9, fbm(u * 0.25, v, 12, 3, 921)) * 0.6 + smoothstep(0.85, 1.0, 1 - v) * 0.2;
    const k = 0.9 + 0.2 * fbm(u, v, 40, 2, 922);
    const c = [0, 1, 2].map((i) => lerp(paint[i], rust[i], r) * k);
    albedo.set(x, y, c[0], c[1], c[2], a);
    rough.data[y * S + x] = 0.6 + r * 0.3;
    metal.data[y * S + x] = 0;
  }
  saveMaterial('railing_bars', S, [P, P], { albedo, rough, metal });
};

function detailMap(name: string, size: number, physical: number, fn: (u: number, v: number) => [number, number]) {
  // Detail maps: albedo is a grey overlay centred on 0.5 (x2 multiply in the shader).
  const albedo = new Img(size, size), height = new Field(size, size), rough = new Field(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const [a, h] = fn((x + 0.5) / size, (y + 0.5) / size);
    const g = srgbToLinear(0.5 + a); // stored so that the linear read-back (not sRGB) is 0.5 +- a
    albedo.set(x, y, g, g, g);
    height.data[y * size + x] = h;
    rough.data[y * size + x] = 0.5;
  }
  // Detail albedo is sampled as linear data; store raw values.
  writePng(`${name}_albedo.png`, size, size, (x, y, o) => {
    const i = (y * size + x) * 4;
    o[0] = o[1] = o[2] = linearToSrgb(albedo.data[i]);
  });
  const n = normalFromHeight(height, physical / size, physical / size);
  writePng(`${name}_normal.png`, size, size, (x, y, o) => {
    const i = (y * size + x) * 4;
    o[0] = n.data[i]; o[1] = n.data[i + 1]; o[2] = n.data[i + 2]; o[3] = 1;
  });
  console.log(`  ${name.padEnd(22)} ${size}px  ${physical} m (detail)`);
}

recipes.detail_grain = () => detailMap('detail_grain', 512, 0.25, (u, v) => {
  const n = fbm(u, v, 32, 3, 191);
  return [n * 0.12, n * 0.00025];
});
recipes.detail_aggregate = () => {
  const c: Cell = { f1: 0, f2: 0, id: 0, dx: 0, dy: 0 };
  detailMap('detail_aggregate', 512, 0.2, (u, v) => {
    worley(u, v, 48, 201, 1, c);
    const e = c.f2 - c.f1;
    const s = smoothstep(0.05, 0.3, e) * ((hash2(c.id, 1, 1) / 4294967296) > 0.3 ? 1 : 0);
    const b = (hash2(c.id, 2, 1) / 4294967296 - 0.5) * 0.25;
    const n = fbm(u, v, 64, 2, 202) * 0.05;
    return [s * b + n, s * 0.0006 * Math.sqrt(clamp01(e * 3)) + n * 0.0002];
  });
};
recipes.detail_plaster = () => detailMap('detail_plaster', 512, 0.3, (u, v) => {
  const c = worley(u, v, 40, 211, 1);
  const n = fbm(u, v, 24, 3, 212);
  return [n * 0.06, (1 - smoothstep(0, 0.6, c.f1)) * 0.0004 + n * 0.0002];
});

recipes.macro_variation = () => {
  const S = 512;
  writePng('macro_variation.png', S, S, (x, y, o) => {
    const u = (x + 0.5) / S, v = (y + 0.5) / S;
    o[0] = 0.5 + fbm(u, v, 3, 5, 221) * 0.6;
    o[1] = smoothstep(0.05, 0.45, fbm(u, v, 5, 5, 222));
    o[2] = 0.5 + fbm(u, v, 4, 4, 223) * 0.6;
  });
  console.log('  macro_variation        512px');
};

recipes.cloud_noise = () => {
  const S = 256;
  writePng('cloud_noise.png', S, S, (x, y, o) => {
    const u = (x + 0.5) / S, v = (y + 0.5) / S;
    o[0] = 0.5 + fbm(u, v, 4, 5, 231) * 0.75;
    o[1] = 0.5 + fbm(u, v, 6, 5, 232) * 0.75;
    const c = worley(u, v, 10, 233, 1);
    o[2] = clamp01(1 - c.f1 * 1.2 + fbm(u, v, 16, 3, 234) * 0.3);
  });
  console.log('  cloud_noise            256px');
};

// ------------------------------------------------------------ decals (512², RGBA, sRGB colour)
function decal(name: string, fn: (u: number, v: number, o: number[]) => void) {
  writePng(`decals/${name}.png`, 512, 512, (x, y, o) => {
    fn((x + 0.5) / 512, (y + 0.5) / 512, o);
    o[0] = linearToSrgb(o[0]); o[1] = linearToSrgb(o[1]); o[2] = linearToSrgb(o[2]);
  });
  console.log(`  decals/${name}`);
}
recipes.decals = () => {
  decal('stain', (u, v, o) => {
    const r = Math.hypot(u - 0.5, v - 0.5) * 2;
    const n = fbm(u, v, 4, 5, 241);
    const a = smoothstep(1, 0.2, r + n * 0.5) * (0.55 + fbm(u, v, 16, 3, 242) * 0.4);
    o[0] = 0.05; o[1] = 0.045; o[2] = 0.035; o[3] = a;
  });
  decal('oil', (u, v, o) => {
    const r = Math.hypot(u - 0.5, (v - 0.5) * 1.3) * 2;
    const n = fbm(u, v, 3, 5, 251);
    const a = smoothstep(0.95, 0.4, r + n * 0.6) * 0.85;
    o[0] = 0.015; o[1] = 0.014; o[2] = 0.013; o[3] = a;
  });
  // Crack: branching random walk.
  const crack = new Field(512, 512);
  const rng = mulberry32(261);
  const walk = (x: number, y: number, a: number, len: number, w: number, depth: number) => {
    for (let i = 0; i < len; i++) {
      a += (rng() - 0.5) * 0.5;
      x += Math.cos(a) * 2; y += Math.sin(a) * 2;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const px = Math.floor(x + dx), py = Math.floor(y + dy);
        if (px < 0 || py < 0 || px >= 512 || py >= 512) continue;
        const d = Math.hypot(dx, dy);
        crack.data[py * 512 + px] = Math.max(crack.data[py * 512 + px], clamp01(w - d + 0.5));
      }
      if (depth < 3 && rng() < 0.025) walk(x, y, a + (rng() < 0.5 ? 0.8 : -0.8), len * 0.5, w * 0.7, depth + 1);
      w *= 0.997;
    }
  };
  walk(40, 256, 0, 230, 2.2, 0);
  decal('crack', (u, v, o) => {
    const c = crack.data[Math.floor(v * 512) * 512 + Math.floor(u * 512)];
    o[0] = 0.02; o[1] = 0.02; o[2] = 0.02; o[3] = c * 0.95;
  });
  decal('paint_line', (u, v, o) => {
    // Tiles along u (worn road/parking paint). Solid band across v with ragged edges.
    const edge = Math.min(v, 1 - v);
    const rag = gnoise(u * 40, v * 4, 40, 4, 271) * 0.03;
    const band = smoothstep(0.0, 0.06, edge + rag);
    const wear = smoothstep(0.55, 0.25, fbm(u, v, 8, 5, 272) * 0.5 + 0.5) ;
    const pits = smoothstep(0.62, 0.7, fbm(u, v, 64, 2, 273) * 0.5 + 0.5);
    o[0] = 0.72; o[1] = 0.72; o[2] = 0.68; o[3] = band * wear * (1 - pits) * 0.95;
  });
  decal('manhole', (u, v, o) => {
    const r = Math.hypot(u - 0.5, v - 0.5) * 2;
    const inside = smoothstep(1.0, 0.985, r);
    const ring = smoothstep(0.86, 0.88, r) * smoothstep(0.96, 0.94, r);
    const grid = (Math.abs(((u * 16) % 1) - 0.5) < 0.12 || Math.abs(((v * 16) % 1) - 0.5) < 0.12) ? 1 : 0;
    const rust = smoothstep(0.2, 0.6, fbm(u, v, 6, 4, 281));
    const k = 0.05 + grid * 0.03 * (1 - ring) + ring * 0.04;
    o[0] = k + rust * 0.05; o[1] = k + rust * 0.025; o[2] = k; o[3] = inside;
  });
  decal('waterstreak', (u, v, o) => {
    const s = gnoise(u * 24, v * 2, 24, 2, 291) * 0.5 + 0.5;
    const streak = smoothstep(0.55, 0.8, s + fbm(u, v, 8, 3, 292) * 0.2);
    const fadeDown = Math.pow(1 - v, 0.6) * smoothstep(0, 0.05, v) * smoothstep(0, 0.15, Math.min(u, 1 - u));
    o[0] = 0.07; o[1] = 0.068; o[2] = 0.06; o[3] = streak * fadeDown * 0.7;
  });
  // Bullet holes (centred, radius 1 = box edge). Relief comes from the shader's crater profile.
  const rays = (u: number, v: number, seed: number, n: number, reach: number) => {
    const rr = mulberry32(seed);
    const ang = Math.atan2(v - 0.5, u - 0.5);
    const r = Math.hypot(u - 0.5, v - 0.5) * 2;
    let c = 0;
    for (let k = 0; k < n; k++) {
      const a0 = rr() * Math.PI * 2, len = reach * (0.6 + rr() * 0.4);
      let da = Math.abs(ang - a0 - Math.sin(r * 9 + k) * 0.08);
      da = Math.min(da, Math.PI * 2 - da);
      c = Math.max(c, Math.exp(-((da * r * 90) ** 2)) * smoothstep(len, len * 0.4, r));
    }
    return c;
  };
  decal('bullet_hole', (u, v, o) => {
    const dx = u - 0.5, dy = v - 0.5;
    const r = Math.hypot(dx, dy) * 2;
    const ca = (dx / Math.max(r, 1e-6)) * 2, sa = (dy / Math.max(r, 1e-6)) * 2;
    // Irregular outlines: noise sampled around a circle (seamless in angle).
    const chipR = 0.36 + fbm(0.5 + ca * 0.12, 0.5 + sa * 0.12, 6, 2, 315) * 0.2 + fbm(u, v, 24, 3, 319) * 0.08;
    const holeR = 0.12 + fbm(0.5 + ca * 0.1, 0.5 + sa * 0.1, 8, 3, 316) * 0.07;
    const chip = smoothstep(chipR + 0.025, chipR - 0.025, r);
    const hole = smoothstep(holeR + 0.03, holeR - 0.02, r);
    // Fractured facets of varying brightness, darker (occluded) towards the pit.
    const cell = worley(u, v, 22, 317);
    const facet = ((cell.id >>> 0) % 997) / 997;
    const fracture = smoothstep(0.035, 0.0, cell.f2 - cell.f1) * 0.5;
    const depthShade = 0.5 + 0.5 * smoothstep(holeR, chipR, r);
    const fresh = (0.24 + facet * 0.13 + fbm(u, v, 48, 2, 318) * 0.05) * depthShade * (1 - fracture * 0.55);
    const smudge = smoothstep(0.75, 0.3, r + fbm(u, v, 5, 3, 312) * 0.35) * 0.3;
    const crack = rays(u, v, 313, 5, 0.85) * (1 - chip);
    let k = chip * fresh + (1 - chip) * (crack > 0.05 ? 0.03 : 0.06);
    k = k * (1 - hole) + 0.01 * hole;
    o[0] = k; o[1] = k * 0.98; o[2] = k * 0.95;
    o[3] = clamp01(Math.max(hole, chip * 0.95, crack * 0.85, smudge));
  });
  decal('bullet_hole_metal', (u, v, o) => {
    const r = Math.hypot(u - 0.5, v - 0.5) * 2;
    const n = fbm(u, v, 12, 3, 321);
    const hole = smoothstep(0.15, 0.12, r + n * 0.02);
    const bare = smoothstep(0.34, 0.26, r + n * 0.06);
    const scorch = smoothstep(0.8, 0.3, r + n * 0.2) * 0.5;
    const k = hole * 0.01 + (1 - hole) * (bare * 0.55 + (1 - bare) * 0.04);
    o[0] = k; o[1] = k; o[2] = k * 1.02;
    o[3] = clamp01(Math.max(hole, bare * 0.95, scorch));
  });
  decal('grime_base', (u, v, o) => {
    // Ground-contact grime for wall bases (dark at the bottom edge, v=1).
    const n = fbm(u, v, 12, 4, 301);
    const a = smoothstep(0.1, 1.0, v + n * 0.25) * smoothstep(0, 0.1, Math.min(u, 1 - u));
    o[0] = 0.06; o[1] = 0.055; o[2] = 0.045; o[3] = a * 0.8;
  });
};

// Splat (enemy juice on walls / ground): white mask tinted by its decal material.
recipes.splats = () => {
  const rr = (() => { let s = 0x5a17; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); })();
  const drops: { x: number; y: number; r: number; sx: number; sy: number }[] = [];
  for (let k = 0; k < 46; k++) {
    const a = rr() * Math.PI * 2, d = 0.3 + Math.pow(rr(), 0.7) * 0.62;
    const r = (0.012 + rr() * 0.035) * (1.25 - d);
    // Streak drops are stretched along the radial direction.
    const st = rr() < 0.4 ? 2.5 + rr() * 3 : 1;
    drops.push({ x: 0.5 + Math.cos(a) * d * 0.5, y: 0.5 + Math.sin(a) * d * 0.5, r, sx: Math.cos(a), sy: Math.sin(a) * 1 + 0 * st });
    (drops[drops.length - 1] as unknown as { st: number }).st = st;
  }
  decal('splat', (u, v, o) => {
    const dx = u - 0.5, dy = v - 0.5;
    const r = Math.hypot(dx, dy) * 2;
    const ca = dx / Math.max(1e-6, r) * 2, sa = dy / Math.max(1e-6, r) * 2;
    const edge = 0.34 + fbm(0.5 + ca * 0.16, 0.5 + sa * 0.16, 5, 3, 611) * 0.32 + fbm(u, v, 20, 2, 612) * 0.05;
    let a = smoothstep(edge + 0.015, edge - 0.015, r);
    for (const d of drops) {
      const st = (d as unknown as { st: number }).st;
      const px = u - d.x, py = v - d.y;
      const along = px * d.sx + py * d.sy, across = -px * d.sy + py * d.sx;
      const q = Math.hypot(along / st, across) / d.r;
      a = Math.max(a, smoothstep(1.05, 0.9, q));
    }
    const c = 0.8 + fbm(u, v, 14, 3, 613) * 0.2 + smoothstep(0.9, 0.2, r) * 0.08;
    o[0] = c; o[1] = c; o[2] = c; o[3] = clamp01(a * (0.92 + fbm(u, v, 30, 2, 614) * 0.08));
  });
};

// ------------------------------------------------------------ run
// Sets replaced by scans (tools/textures/scanned.json) are skipped unless --procedural is given.
const argv = process.argv.slice(2);
const procedural = argv.includes('--procedural');
const names = argv.filter((a) => !a.startsWith('--'));
const scannedPath = join(import.meta.dirname, 'scanned.json');
const scanned = new Set<string>(existsSync(scannedPath) ? JSON.parse(readFileSync(scannedPath, 'utf8')).sets.map((s: { name: string }) => s.name) : []);
const list = (names.length ? names : Object.keys(recipes)).filter((n) => {
  if (procedural || !scanned.has(n)) return true;
  console.log(`  ${n.padEnd(22)} skipped (scanned set; --procedural to regenerate)`);
  return false;
});
console.log(`Generating ${list.length} texture recipe(s) -> ${OUT}`);
const t0 = performance.now();
for (const n of list) {
  if (!recipes[n]) { console.warn(`unknown recipe ${n}`); continue; }
  recipes[n]();
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
console.log(`done in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
