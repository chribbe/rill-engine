/**
 * BC4 / BC5 encoder (+ reference decoder). BC5 stores two independent BC4
 * channels (normal-map X and Y); Z is reconstructed in the shader. Each 4x4
 * channel gets two 8-bit endpoints and 3-bit indices; both BC4 modes (8
 * interpolated values, or 6 + explicit 0/255) are tried with a small endpoint
 * search around the block's min/max.
 */

function palette(e0: number, e1: number, out: Float32Array) {
  out[0] = e0; out[1] = e1;
  if (e0 > e1) {
    for (let i = 1; i < 7; i++) out[i + 1] = ((7 - i) * e0 + i * e1) / 7;
  } else {
    for (let i = 1; i < 5; i++) out[i + 1] = ((5 - i) * e0 + i * e1) / 5;
    out[6] = 0; out[7] = 255;
  }
}

const pal = new Float32Array(8);

function evalBlock(v: Float32Array, e0: number, e1: number, idx: Uint8Array): number {
  palette(e0, e1, pal);
  let err = 0;
  for (let i = 0; i < 16; i++) {
    let best = 0, be = Infinity;
    for (let k = 0; k < 8; k++) {
      const d = v[i] - pal[k];
      const e = d * d;
      if (e < be) { be = e; best = k; }
    }
    idx[i] = best;
    err += be;
  }
  return err;
}

const tmp = new Uint8Array(16);

/** Encodes 16 values (0..255) into 8 bytes at out[off]. Returns the squared error. */
export function encodeBC4Block(v: Float32Array, out: Uint8Array, off: number): number {
  let lo = 255, hi = 0;
  for (let i = 0; i < 16; i++) { lo = Math.min(lo, v[i]); hi = Math.max(hi, v[i]); }
  lo = Math.round(lo); hi = Math.round(hi);
  let bestErr = Infinity, b0 = hi, b1 = lo;
  const bestIdx = new Uint8Array(16);
  if (hi === lo) {
    // Flat block: any mode, all indices 0.
    out[off] = hi; out[off + 1] = lo;
    for (let i = 2; i < 8; i++) out[off + i] = 0;
    return 0;
  }
  const R = 3;
  for (let a = -R; a <= R; a++) {
    for (let b = -R; b <= R; b++) {
      const e0 = Math.max(0, Math.min(255, hi + a)), e1 = Math.max(0, Math.min(255, lo + b));
      if (e0 <= e1) continue; // 8-value mode
      const err = evalBlock(v, e0, e1, tmp);
      if (err < bestErr) { bestErr = err; b0 = e0; b1 = e1; bestIdx.set(tmp); }
    }
  }
  // 6-value mode helps blocks that touch 0 or 255.
  if (lo <= 4 || hi >= 251) {
    let l2 = 255, h2 = 0;
    for (let i = 0; i < 16; i++) { if (v[i] > 4 && v[i] < 251) { l2 = Math.min(l2, v[i]); h2 = Math.max(h2, v[i]); } }
    if (l2 <= h2) {
      const err = evalBlock(v, Math.round(l2), Math.round(h2), tmp);
      if (err < bestErr) { bestErr = err; b0 = Math.round(l2); b1 = Math.round(h2); bestIdx.set(tmp); }
    }
  }
  out[off] = b0; out[off + 1] = b1;
  // 48 bits of 3-bit indices, LSB first.
  let bits = 0n;
  for (let i = 0; i < 16; i++) bits |= BigInt(bestIdx[i]) << BigInt(3 * i);
  for (let i = 0; i < 6; i++) out[off + 2 + i] = Number((bits >> BigInt(8 * i)) & 0xffn);
  return bestErr;
}

export function decodeBC4Block(b: Uint8Array, off: number, out: Float32Array) {
  palette(b[off], b[off + 1], pal);
  let bits = 0n;
  for (let i = 0; i < 6; i++) bits |= BigInt(b[off + 2 + i]) << BigInt(8 * i);
  for (let i = 0; i < 16; i++) out[i] = pal[Number((bits >> BigInt(3 * i)) & 7n)];
}

const chx = new Float32Array(16), chy = new Float32Array(16);

/** px = 16 RGBA texels (0..255); encodes R and G as BC5 (16 bytes). Returns the squared error. */
export function encodeBC5Block(px: Float32Array, out: Uint8Array, off: number): number {
  for (let i = 0; i < 16; i++) { chx[i] = px[i * 4]; chy[i] = px[i * 4 + 1]; }
  return encodeBC4Block(chx, out, off) + encodeBC4Block(chy, out, off + 8);
}
