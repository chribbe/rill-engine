/**
 * Small BC7 encoder (modes 1, 5 and 6) plus a reference decoder.
 *
 *  - mode 6: one subset, RGBA 7+p bits, 4-bit indices: the general workhorse
 *  - mode 5: one subset, RGB 7 bits + separate 8-bit alpha (2-bit indices each),
 *            with channel rotation: uncorrelated 4th channels (ORM height,
 *            normal variance, cutout alpha)
 *  - mode 1: two subsets, RGB 6+shared p bits, 3-bit indices: blocks with two
 *            colour clusters (mortar/grout lines, chain link, leaf edges)
 *
 * Endpoints come from a PCA line fit, refined by least squares on the chosen
 * indices with exhaustive p-bit choice. Not as thorough as bc7enc/Compressonator,
 * but deterministic, dependency-free and good enough for material textures.
 */

const W2 = [0, 21, 43, 64];
const W3 = [0, 9, 18, 27, 37, 46, 55, 64];
const W4 = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];
const WEIGHTS: Record<number, number[]> = { 2: W2, 3: W3, 4: W4 };

/** Two-subset partition masks (bit i set = pixel i in subset 1). */
export const P2 = [
  0xcccc, 0x8888, 0xeeee, 0xecc8, 0xc880, 0xfeec, 0xfec8, 0xec80, 0xc800, 0xffec, 0xfe80, 0xe800, 0xffe8, 0xff00, 0xfff0, 0xf000,
  0xf710, 0x008e, 0x7100, 0x08ce, 0x008c, 0x7310, 0x3100, 0x8cce, 0x088c, 0x3110, 0x6666, 0x366c, 0x17e8, 0x0ff0, 0x718e, 0x399c,
  0xaaaa, 0xf0f0, 0x5a5a, 0x33cc, 0x3c3c, 0x55aa, 0x9696, 0xa55a, 0x73ce, 0x13c8, 0x324c, 0x3bdc, 0x6996, 0xc33c, 0x9966, 0x0660,
  0x0272, 0x04e4, 0x4e40, 0x2720, 0xc936, 0x936c, 0x39c6, 0x639c, 0x9336, 0x9cc6, 0x817e, 0xe718, 0xccf0, 0x0fcc, 0x7744, 0xee22,
];
/** Anchor pixel of subset 1 for each two-subset partition. */
export const ANCHOR2 = [
  15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15,
  15, 2, 8, 2, 2, 8, 8, 15, 2, 8, 2, 2, 8, 8, 2, 2,
  15, 15, 6, 8, 2, 8, 15, 15, 2, 8, 2, 2, 2, 15, 15, 6,
  6, 2, 6, 8, 15, 15, 2, 2, 15, 15, 15, 15, 15, 2, 2, 15,
];

// ------------------------------------------------------------ endpoint quantisers
/** bits = stored endpoint bits, pbit = per-endpoint ('unique'), per-subset ('shared') or none. */
interface QSpec {
  bits: number;
  pbit: 0 | 1 | 2; // 0 none, 1 unique, 2 shared
  /** lut[p][v] = best stored value for target v (0..255); val[p][q] = decoded 8-bit value. */
  lut: Uint8Array[];
  val: Uint8Array[];
}

function expand(x: number, n: number) {
  // n-bit -> 8-bit by bit replication (BC7 "unquantize").
  return n >= 8 ? x : ((x << (8 - n)) | (x >> (2 * n - 8))) & 255;
}

function makeSpec(bits: number, pbit: 0 | 1 | 2): QSpec {
  const ps = pbit ? 2 : 1;
  const lut: Uint8Array[] = [];
  const val: Uint8Array[] = [];
  for (let p = 0; p < ps; p++) {
    const v = new Uint8Array(1 << bits);
    for (let q = 0; q < 1 << bits; q++) v[q] = pbit ? expand((q << 1) | p, bits + 1) : expand(q, bits);
    const l = new Uint8Array(256);
    for (let t = 0; t < 256; t++) {
      let best = 0, be = 1e9;
      for (let q = 0; q < 1 << bits; q++) {
        const e = Math.abs(v[q] - t);
        if (e < be) { be = e; best = q; }
      }
      l[t] = best;
    }
    lut.push(l);
    val.push(v);
  }
  return { bits, pbit, lut, val };
}

const Q6 = makeSpec(7, 1); // mode 6 RGBA
const Q1 = makeSpec(6, 2); // mode 1 RGB
const Q5C = makeSpec(7, 0); // mode 5 colour
const Q5A = makeSpec(8, 0); // mode 5 alpha

// ------------------------------------------------------------ single-subset fit
interface Fit {
  q0: number[];
  q1: number[];
  p0: number;
  p1: number;
  idx: Uint8Array; // per block pixel (only subset pixels meaningful)
  err: number;
}

const tmpIdx = new Uint8Array(16);
const pal = new Float64Array(16 * 4);

/** Quantises float endpoints with the given p-bits, assigns indices, returns the error. */
function evalEndpoints(px: Float32Array, pix: number[], ch: number[], W: number[], q: QSpec,
  e0: number[], e1: number[], p0: number, p1: number, q0o: number[], q1o: number[], idxOut: Uint8Array): number {
  const C = ch.length, K = W.length;
  for (let c = 0; c < C; c++) {
    const a = q.lut[p0][Math.max(0, Math.min(255, Math.round(e0[c])))];
    const b = q.lut[p1][Math.max(0, Math.min(255, Math.round(e1[c])))];
    q0o[c] = a; q1o[c] = b;
    const va = q.val[p0][a], vb = q.val[p1][b];
    for (let k = 0; k < K; k++) pal[k * 4 + c] = ((64 - W[k]) * va + W[k] * vb + 32) >> 6;
  }
  let err = 0;
  for (const i of pix) {
    let best = 0, be = 1e18;
    for (let k = 0; k < K; k++) {
      let e = 0;
      for (let c = 0; c < C; c++) {
        const d = px[i * 4 + ch[c]] - pal[k * 4 + c];
        e += d * d;
      }
      if (e < be) { be = e; best = k; }
    }
    idxOut[i] = best;
    err += be;
  }
  return err;
}

function tryPbits(px: Float32Array, pix: number[], ch: number[], W: number[], q: QSpec, e0: number[], e1: number[], best: Fit) {
  const combos = q.pbit === 1 ? [[0, 0], [0, 1], [1, 0], [1, 1]] : q.pbit === 2 ? [[0, 0], [1, 1]] : [[0, 0]];
  const q0 = [0, 0, 0, 0], q1 = [0, 0, 0, 0];
  for (const [p0, p1] of combos) {
    const err = evalEndpoints(px, pix, ch, W, q, e0, e1, p0, p1, q0, q1, tmpIdx);
    if (err < best.err) {
      best.err = err;
      best.p0 = p0; best.p1 = p1;
      best.q0 = q0.slice(0, ch.length);
      best.q1 = q1.slice(0, ch.length);
      for (const i of pix) best.idx[i] = tmpIdx[i];
    }
  }
}

/** Principal axis of the subset's points (power iteration on the covariance). */
function lineFit(px: Float32Array, pix: number[], ch: number[], mean: number[], axis: number[]) {
  const C = ch.length, n = pix.length;
  for (let c = 0; c < C; c++) {
    let s = 0;
    for (const i of pix) s += px[i * 4 + ch[c]];
    mean[c] = s / n;
  }
  const cov = new Float64Array(16);
  for (const i of pix) {
    for (let a = 0; a < C; a++) {
      const da = px[i * 4 + ch[a]] - mean[a];
      for (let b = a; b < C; b++) cov[a * 4 + b] += da * (px[i * 4 + ch[b]] - mean[b]);
    }
  }
  for (let a = 0; a < C; a++) for (let b = 0; b < a; b++) cov[a * 4 + b] = cov[b * 4 + a];
  // Start from the channel with the largest variance.
  let v = [0, 0, 0, 0];
  let mc = 0;
  for (let c = 1; c < C; c++) if (cov[c * 5] > cov[mc * 5]) mc = c;
  v[mc] = 1;
  for (let it = 0; it < 8; it++) {
    const w = [0, 0, 0, 0];
    for (let a = 0; a < C; a++) for (let b = 0; b < C; b++) w[a] += cov[a * 4 + b] * v[b];
    const l = Math.hypot(w[0], w[1], w[2], w[3]);
    if (l < 1e-12) break;
    v = w.map((x) => x / l);
  }
  for (let c = 0; c < 4; c++) axis[c] = v[c];
}

function fitSubset(px: Float32Array, pix: number[], ch: number[], ib: number, q: QSpec, out: Fit): Fit {
  const W = WEIGHTS[ib];
  const C = ch.length;
  out.err = 1e18;
  const mean = [0, 0, 0, 0], axis = [0, 0, 0, 0];
  lineFit(px, pix, ch, mean, axis);
  let tmin = 1e9, tmax = -1e9;
  for (const i of pix) {
    let t = 0;
    for (let c = 0; c < C; c++) t += (px[i * 4 + ch[c]] - mean[c]) * axis[c];
    tmin = Math.min(tmin, t);
    tmax = Math.max(tmax, t);
  }
  const e0 = [], e1 = [];
  for (let c = 0; c < C; c++) {
    e0.push(mean[c] + tmin * axis[c]);
    e1.push(mean[c] + tmax * axis[c]);
  }
  tryPbits(px, pix, ch, W, q, e0, e1, out);
  // Also the bounding-box diagonal (helps nearly flat blocks).
  if (C > 1) {
    const b0 = [], b1 = [];
    for (let c = 0; c < C; c++) {
      let lo = 255, hi = 0;
      for (const i of pix) { const x = px[i * 4 + ch[c]]; lo = Math.min(lo, x); hi = Math.max(hi, x); }
      const s = axis[c] >= 0;
      b0.push(s ? lo : hi);
      b1.push(s ? hi : lo);
    }
    tryPbits(px, pix, ch, W, q, b0, b1, out);
  }
  // Least-squares refinement on the selected indices.
  for (let it = 0; it < 3 && out.err > 0; it++) {
    let aa = 0, ab = 0, bb = 0;
    const ax = [0, 0, 0, 0], bx = [0, 0, 0, 0];
    for (const i of pix) {
      const w = W[out.idx[i]] / 64, u = 1 - w;
      aa += u * u; ab += u * w; bb += w * w;
      for (let c = 0; c < C; c++) {
        const x = px[i * 4 + ch[c]];
        ax[c] += u * x; bx[c] += w * x;
      }
    }
    const det = aa * bb - ab * ab;
    if (Math.abs(det) < 1e-8) break;
    const r0 = [], r1 = [];
    for (let c = 0; c < C; c++) {
      r0.push((bb * ax[c] - ab * bx[c]) / det);
      r1.push((aa * bx[c] - ab * ax[c]) / det);
    }
    const before = out.err;
    tryPbits(px, pix, ch, W, q, r0, r1, out);
    if (out.err >= before) break;
  }
  return out;
}

function newFit(): Fit {
  return { q0: [], q1: [], p0: 0, p1: 0, idx: new Uint8Array(16), err: 1e18 };
}

// ------------------------------------------------------------ bit packing
class BitWriter {
  pos = 0;
  out: Uint8Array;
  off: number;
  constructor(out: Uint8Array, off: number) {
    this.out = out;
    this.off = off;
    for (let i = 0; i < 16; i++) out[off + i] = 0;
  }
  put(v: number, n: number) {
    for (let i = 0; i < n; i++, this.pos++) if ((v >>> i) & 1) this.out[this.off + (this.pos >> 3)] |= 1 << (this.pos & 7);
  }
}

class BitReader {
  pos = 0;
  b: Uint8Array;
  off: number;
  constructor(b: Uint8Array, off: number) {
    this.b = b;
    this.off = off;
  }
  get(n: number) {
    let v = 0;
    for (let i = 0; i < n; i++, this.pos++) v |= ((this.b[this.off + (this.pos >> 3)] >> (this.pos & 7)) & 1) << i;
    return v;
  }
}

const ALL16 = Array.from({ length: 16 }, (_, i) => i);
const ROT_CH = [[0, 1, 2, 3], [3, 1, 2, 0], [0, 3, 2, 1], [0, 1, 3, 2]];

function packMode6(f: Fit, out: Uint8Array, off: number) {
  let { q0, q1, p0, p1 } = f;
  const idx = f.idx.slice();
  if (idx[0] >= 8) {
    [q0, q1] = [q1, q0];
    [p0, p1] = [p1, p0];
    for (let i = 0; i < 16; i++) idx[i] = 15 - idx[i];
  }
  const w = new BitWriter(out, off);
  w.put(1 << 6, 7);
  for (let c = 0; c < 4; c++) { w.put(q0[c], 7); w.put(q1[c], 7); }
  w.put(p0, 1); w.put(p1, 1);
  for (let i = 0; i < 16; i++) w.put(idx[i], i === 0 ? 3 : 4);
}

function packMode5(rot: number, fc: Fit, fa: Fit, out: Uint8Array, off: number) {
  let cq0 = fc.q0, cq1 = fc.q1, aq0 = fa.q0[0], aq1 = fa.q1[0];
  const ci = fc.idx.slice(), ai = fa.idx.slice();
  if (ci[0] >= 2) { [cq0, cq1] = [cq1, cq0]; for (let i = 0; i < 16; i++) ci[i] = 3 - ci[i]; }
  if (ai[0] >= 2) { [aq0, aq1] = [aq1, aq0]; for (let i = 0; i < 16; i++) ai[i] = 3 - ai[i]; }
  const w = new BitWriter(out, off);
  w.put(1 << 5, 6);
  w.put(rot, 2);
  for (let c = 0; c < 3; c++) { w.put(cq0[c], 7); w.put(cq1[c], 7); }
  w.put(aq0, 8); w.put(aq1, 8);
  for (let i = 0; i < 16; i++) w.put(ci[i], i === 0 ? 1 : 2);
  for (let i = 0; i < 16; i++) w.put(ai[i], i === 0 ? 1 : 2);
}

function packMode1(part: number, f0: Fit, f1: Fit, out: Uint8Array, off: number) {
  const mask = P2[part];
  const anchor = ANCHOR2[part];
  const idx = new Uint8Array(16);
  for (let i = 0; i < 16; i++) idx[i] = (mask >> i) & 1 ? f1.idx[i] : f0.idx[i];
  let a0 = f0.q0, b0 = f0.q1, a1 = f1.q0, b1 = f1.q1;
  if (idx[0] >= 4) {
    [a0, b0] = [b0, a0];
    for (let i = 0; i < 16; i++) if (!((mask >> i) & 1)) idx[i] = 7 - idx[i];
  }
  if (idx[anchor] >= 4) {
    [a1, b1] = [b1, a1];
    for (let i = 0; i < 16; i++) if ((mask >> i) & 1) idx[i] = 7 - idx[i];
  }
  const w = new BitWriter(out, off);
  w.put(2, 2);
  w.put(part, 6);
  for (let c = 0; c < 3; c++) { w.put(a0[c], 6); w.put(b0[c], 6); w.put(a1[c], 6); w.put(b1[c], 6); }
  w.put(f0.p0, 1); w.put(f1.p0, 1);
  for (let i = 0; i < 16; i++) w.put(idx[i], i === 0 || i === anchor ? 2 : 3);
}

// ------------------------------------------------------------ mode selection
/** Residual (perpendicular) error of a line fit to a subset: sum of squared deviations minus the largest eigenvalue. */
function lineResidual(px: Float32Array, pix: number[]) {
  const mean = [0, 0, 0, 0], axis = [0, 0, 0, 0];
  const ch = [0, 1, 2];
  lineFit(px, pix, ch, mean, axis);
  let tot = 0, along = 0;
  for (const i of pix) {
    let t = 0;
    for (let c = 0; c < 3; c++) {
      const d = px[i * 4 + c] - mean[c];
      tot += d * d;
      t += d * axis[c];
    }
    along += t * t;
  }
  return tot - along;
}

const SUBSETS = P2.map((m) => {
  const s0: number[] = [], s1: number[] = [];
  for (let i = 0; i < 16; i++) ((m >> i) & 1 ? s1 : s0).push(i);
  return [s0, s1];
});

export interface EncodeStats {
  modes: number[];
}

/**
 * Encodes one 4x4 block. `px` = 16 RGBA pixels (row-major) as 0..255 values.
 * Returns the squared error of the chosen encoding.
 */
export function encodeBlock(px: Float32Array, out: Uint8Array, off: number, stats?: EncodeStats): number {
  let opaque = true, amin = 255, amax = 0;
  for (let i = 0; i < 16; i++) {
    const a = px[i * 4 + 3];
    if (a < 255) opaque = false;
    amin = Math.min(amin, a); amax = Math.max(amax, a);
  }
  // Mode 6 (always a candidate).
  const f6 = fitSubset(px, ALL16, [0, 1, 2, 3], 4, Q6, newFit());
  let best = f6.err, mode = 6;
  let pack = () => packMode6(f6, out, off);
  if (best > 0) {
    // Mode 5: separate alpha with rotation.
    const rots = opaque ? [0] : [0, 1, 2, 3];
    for (const r of rots) {
      const ch = ROT_CH[r];
      const fc = fitSubset(px, ALL16, ch.slice(0, 3), 2, Q5C, newFit());
      if (fc.err >= best) continue;
      const fa = fitSubset(px, ALL16, [ch[3]], 2, Q5A, newFit());
      const e = fc.err + fa.err;
      if (e < best) {
        best = e; mode = 5;
        pack = () => packMode5(r, fc, fa, out, off);
      }
    }
    // Mode 1: two RGB subsets (opaque blocks only; mode 1 decodes alpha = 255).
    if (opaque && best > 64) {
      const est: [number, number][] = [];
      for (let p = 0; p < 64; p++) est.push([lineResidual(px, SUBSETS[p][0]) + lineResidual(px, SUBSETS[p][1]), p]);
      est.sort((a, b) => a[0] - b[0]);
      for (let k = 0; k < 4; k++) {
        const p = est[k][1];
        if (est[k][0] >= best) break;
        const fa = fitSubset(px, SUBSETS[p][0], [0, 1, 2], 3, Q1, newFit());
        if (fa.err >= best) continue;
        const fb = fitSubset(px, SUBSETS[p][1], [0, 1, 2], 3, Q1, newFit());
        const e = fa.err + fb.err;
        if (e < best) {
          best = e; mode = 1;
          pack = () => packMode1(p, fa, fb, out, off);
        }
      }
    }
  }
  pack();
  if (stats) stats.modes[mode]++;
  return best;
}

// ------------------------------------------------------------ decoder (verification)
export function decodeBlock(b: Uint8Array, off: number, out: Uint8Array, outOff = 0) {
  let mode = 0;
  while (mode < 8 && !((b[off] >> mode) & 1)) mode++;
  const r = new BitReader(b, off);
  r.get(mode + 1);
  const set = (i: number, rgba: number[]) => { for (let c = 0; c < 4; c++) out[outOff + i * 4 + c] = rgba[c]; };
  const lerp = (a: number, c: number, w: number) => ((64 - w) * a + w * c + 32) >> 6;
  if (mode === 6) {
    const e0 = [0, 0, 0, 0], e1 = [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) { e0[c] = r.get(7); e1[c] = r.get(7); }
    const p0 = r.get(1), p1 = r.get(1);
    for (let c = 0; c < 4; c++) { e0[c] = (e0[c] << 1) | p0; e1[c] = (e1[c] << 1) | p1; }
    for (let i = 0; i < 16; i++) {
      const k = r.get(i === 0 ? 3 : 4);
      set(i, e0.map((v, c) => lerp(v, e1[c], W4[k])));
    }
  } else if (mode === 5) {
    const rot = r.get(2);
    const e0 = [0, 0, 0, 0], e1 = [0, 0, 0, 0];
    for (let c = 0; c < 3; c++) { e0[c] = expand(r.get(7), 7); e1[c] = expand(r.get(7), 7); }
    e0[3] = r.get(8); e1[3] = r.get(8);
    const ci: number[] = [], ai: number[] = [];
    for (let i = 0; i < 16; i++) ci.push(r.get(i === 0 ? 1 : 2));
    for (let i = 0; i < 16; i++) ai.push(r.get(i === 0 ? 1 : 2));
    for (let i = 0; i < 16; i++) {
      const v = [0, 1, 2].map((c) => lerp(e0[c], e1[c], W2[ci[i]]));
      v.push(lerp(e0[3], e1[3], W2[ai[i]]));
      if (rot) { const t = v[3]; v[3] = v[rot - 1]; v[rot - 1] = t; }
      set(i, v);
    }
  } else if (mode === 1) {
    const part = r.get(6);
    const e = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let c = 0; c < 3; c++) for (let k = 0; k < 4; k++) e[k][c] = r.get(6);
    const p = [r.get(1), r.get(1)];
    for (let k = 0; k < 4; k++) for (let c = 0; c < 3; c++) e[k][c] = expand((e[k][c] << 1) | p[k >> 1], 7);
    const anchor = ANCHOR2[part];
    for (let i = 0; i < 16; i++) {
      const s = (P2[part] >> i) & 1;
      const k = r.get(i === 0 || i === anchor ? 2 : 3);
      const v = [0, 1, 2].map((c) => lerp(e[s * 2][c], e[s * 2 + 1][c], W3[k]));
      v.push(255);
      set(i, v);
    }
  } else {
    for (let i = 0; i < 16; i++) set(i, [255, 0, 255, 255]); // unsupported here
  }
}
