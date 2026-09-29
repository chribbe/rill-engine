// Tileable noise + image helpers for the offline texture generator.
// All noise is periodic over the unit tile so every texture repeats seamlessly.

export function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return h >>> 0;
}
const hf = (x: number, y: number, s: number) => hash2(x, y, s) / 4294967296;

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Periodic gradient noise in [-1, 1] (approximately). x,y in lattice units; period in cells. */
export function gnoise(x: number, y: number, px: number, py: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const g = (cx: number, cy: number, dx: number, dy: number) => {
    const h = hash2(mod(cx, px), mod(cy, py), seed);
    const a = (h / 4294967296) * Math.PI * 2;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  const u = fade(fx), v = fade(fy);
  const n00 = g(ix, iy, fx, fy), n10 = g(ix + 1, iy, fx - 1, fy);
  const n01 = g(ix, iy + 1, fx, fy - 1), n11 = g(ix + 1, iy + 1, fx - 1, fy - 1);
  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  return (a + (b - a) * v) * 1.414;
}

/** fBm over the unit tile: u,v in [0,1). basePeriod = cells across the tile at octave 0. */
export function fbm(u: number, v: number, basePeriod: number, octaves: number, seed: number, gain = 0.5): number {
  let sum = 0, amp = 1, norm = 0, p = basePeriod;
  for (let o = 0; o < octaves; o++) {
    sum += gnoise(u * p, v * p, p, p, seed + o * 101) * amp;
    norm += amp;
    amp *= gain;
    p *= 2;
  }
  return sum / norm;
}

/** Ridged fBm in [0,1]. */
export function ridged(u: number, v: number, basePeriod: number, octaves: number, seed: number): number {
  let sum = 0, amp = 0.5, p = basePeriod, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(gnoise(u * p, v * p, p, p, seed + o * 131));
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  return sum / norm;
}

export interface Cell {
  f1: number;
  f2: number;
  id: number;
  /** Offset from the pixel to the nearest feature point (lattice units). */
  dx: number;
  dy: number;
}

/** Periodic Worley noise. u,v in [0,1); n cells across; jitter 0..1. */
export function worley(u: number, v: number, n: number, seed: number, jitter = 0.9, out?: Cell): Cell {
  const x = u * n, y = v * n;
  const ix = Math.floor(x), iy = Math.floor(y);
  let f1 = 1e9, f2 = 1e9, id = 0, bdx = 0, bdy = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = ix + i, cy = iy + j;
      const wx = mod(cx, n), wy = mod(cy, n);
      const h = hash2(wx, wy, seed);
      const px = cx + 0.5 + (hf(wx, wy, seed + 7) - 0.5) * jitter;
      const py = cy + 0.5 + (hf(wx, wy, seed + 13) - 0.5) * jitter;
      const dx = px - x, dy = py - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = h;
        bdx = dx;
        bdy = dy;
      } else if (d < f2) f2 = d;
    }
  }
  const o = out ?? { f1: 0, f2: 0, id: 0, dx: 0, dy: 0 };
  o.f1 = f1; o.f2 = f2; o.id = id; o.dx = bdx; o.dy = bdy;
  return o;
}

export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** Float image, 4 channels, row-major, row 0 = top. */
export class Img {
  data: Float32Array;
  w: number;
  h: number;
  constructor(w: number, h: number, fill = 0) {
    this.w = w;
    this.h = h;
    this.data = new Float32Array(w * h * 4).fill(fill);
  }
  set(x: number, y: number, r: number, g: number, b: number, a = 1) {
    const o = (y * this.w + x) * 4;
    this.data[o] = r; this.data[o + 1] = g; this.data[o + 2] = b; this.data[o + 3] = a;
  }
  get(x: number, y: number, c: number) {
    return this.data[((mod(y, this.h)) * this.w + mod(x, this.w)) * 4 + c];
  }
}

/** Scalar field helper. */
export class Field {
  data: Float32Array;
  w: number;
  h: number;
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.data = new Float32Array(w * h);
  }
  at(x: number, y: number) {
    return this.data[mod(y, this.h) * this.w + mod(x, this.w)];
  }
  fill(fn: (u: number, v: number, x: number, y: number) => number) {
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) this.data[y * this.w + x] = fn((x + 0.5) / this.w, (y + 0.5) / this.h, x, y);
    return this;
  }
}

/**
 * Tangent-space normal map (OpenGL convention: +Y = image up) from a height
 * field in metres. texelSize = metres per texel.
 */
export function normalFromHeight(h: Field, texelX: number, texelY: number, wrap = true): Img {
  const out = new Img(h.w, h.h);
  const at = (x: number, y: number) => (wrap ? h.at(x, y) : h.data[Math.min(h.h - 1, Math.max(0, y)) * h.w + Math.min(h.w - 1, Math.max(0, x))]);
  for (let y = 0; y < h.h; y++) {
    for (let x = 0; x < h.w; x++) {
      // Sobel-ish central differences.
      const dx = (at(x + 1, y) - at(x - 1, y)) / (2 * texelX);
      const dyDown = (at(x, y + 1) - at(x, y - 1)) / (2 * texelY);
      // image-up derivative = -dyDown
      let nx = -dx, ny = dyDown, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      out.set(x, y, nx * 0.5 + 0.5, ny * 0.5 + 0.5, nz * 0.5 + 0.5, 1);
    }
  }
  return out;
}

/** Cavity-style AO from height: darker in local depressions. */
export function aoFromHeight(h: Field, radiusTexels: number, depthScale: number): Field {
  const out = new Field(h.w, h.h);
  const r = Math.max(1, Math.round(radiusTexels));
  // Box blur via separable passes (wrapping).
  const tmp = new Float32Array(h.w * h.h);
  for (let y = 0; y < h.h; y++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += h.at(k, y);
    for (let x = 0; x < h.w; x++) {
      tmp[y * h.w + x] = acc / (2 * r + 1);
      acc += h.at(x + r + 1, y) - h.at(x - r, y);
    }
  }
  const T = new Field(h.w, h.h);
  T.data = tmp;
  for (let x = 0; x < h.w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += T.at(x, k);
    for (let y = 0; y < h.h; y++) {
      const blurred = acc / (2 * r + 1);
      const d = blurred - h.data[y * h.w + x];
      out.data[y * h.w + x] = clamp01(1 - Math.max(0, d) * depthScale);
      acc += T.at(x, y + r + 1) - T.at(x, y - r);
    }
  }
  return out;
}
