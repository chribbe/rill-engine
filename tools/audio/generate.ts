// Placeholder sound synthesis for G1 (docs/GAME.md):
//   node tools/audio/generate.ts            -> public/audio/*.wav (48 kHz mono, 16-bit)
//
// Offline DSP recipes for every layer the game's sound events use: carbine
// blast / mechanism / tails, dry fire, brass, impacts per surface, footsteps.
// They are ours (committed); recorded sounds can replace any file by name
// (or go in the gitignored public/audio/local/, which overrides these).
// Deterministic: a fixed seed per file.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SR = 48000;
const OUT = join(import.meta.dirname, '../../public/audio');

// ------------------------------------------------------------------ DSP kit

type Buf = Float32Array;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const buf = (sec: number): Buf => new Float32Array(Math.ceil(sec * SR));

function noise(n: number, r: () => number): Buf {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = r() * 2 - 1;
  return b;
}

/** RBJ biquad, in place. */
function biquad(x: Buf, type: 'lp' | 'hp' | 'bp' | 'peak', f: number, q = 0.707, gainDb = 0): Buf {
  const w = (2 * Math.PI * Math.min(f, SR * 0.45)) / SR, c = Math.cos(w), s = Math.sin(w), a = s / (2 * q);
  const A = Math.pow(10, gainDb / 40);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; a0 = 1 + a; a1 = -2 * c; a2 = 1 - a; }
  else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; a0 = 1 + a; a1 = -2 * c; a2 = 1 - a; }
  else if (type === 'bp') { b0 = a; b1 = 0; b2 = -a; a0 = 1 + a; a1 = -2 * c; a2 = 1 - a; }
  else { b0 = 1 + a * A; b1 = -2 * c; b2 = 1 - a * A; a0 = 1 + a / A; a1 = -2 * c; a2 = 1 - a / A; }
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    x[i] = y0;
  }
  return x;
}

/** One-pole lowpass with a cutoff that moves over time (Hz as a function of t). */
function sweepLp(x: Buf, f: (t: number) => number): Buf {
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    const k = 1 - Math.exp((-2 * Math.PI * f(i / SR)) / SR);
    y += (x[i] - y) * k;
    x[i] = y;
  }
  return x;
}

/** Exponential decay envelope with a short linear attack (seconds). */
function env(x: Buf, attack: number, tau: number, start = 0): Buf {
  for (let i = 0; i < x.length; i++) {
    const t = i / SR - start;
    x[i] *= t < 0 ? 0 : t < attack ? t / attack : Math.exp(-(t - attack) / tau);
  }
  return x;
}

/** Sine with a frequency curve (Hz over t) and an amplitude envelope. */
function tone(sec: number, f: (t: number) => number, amp: (t: number) => number, phase = 0): Buf {
  const b = buf(sec);
  let p = phase;
  for (let i = 0; i < b.length; i++) {
    const t = i / SR;
    p += (2 * Math.PI * f(t)) / SR;
    b[i] = Math.sin(p) * amp(t);
  }
  return b;
}

/** Decaying partials (metal rings): [Hz, tau s, gain]. */
function ring(sec: number, partials: [number, number, number][], r: () => number): Buf {
  const b = buf(sec);
  for (const [f, tau, g] of partials) {
    const ph = r() * Math.PI * 2;
    for (let i = 0; i < b.length; i++) {
      const t = i / SR;
      b[i] += Math.sin(ph + 2 * Math.PI * f * t) * Math.exp(-t / tau) * g;
    }
  }
  return b;
}

/** Many tiny filtered clicks (debris, grit, crunch) spread over `span` seconds. */
function grains(sec: number, count: number, span: number, f0: number, f1: number, r: () => number, decay = 0.6): Buf {
  const b = buf(sec);
  for (let k = 0; k < count; k++) {
    const t0 = Math.pow(r(), 1.6) * span;
    const g = Math.exp(-t0 / (span * decay)) * (0.4 + r() * 0.6);
    const n = Math.floor(SR * (0.001 + r() * 0.003));
    const g1 = noise(n, r);
    biquad(g1, 'bp', f0 + r() * (f1 - f0), 1.5);
    env(g1, 0.0002, 0.0008 + r() * 0.0015);
    const o = Math.floor(t0 * SR);
    for (let i = 0; i < n && o + i < b.length; i++) b[o + i] += g1[i] * g;
  }
  return b;
}

function mix(dst: Buf, src: Buf, gain = 1, at = 0) {
  const o = Math.floor(at * SR);
  for (let i = 0; i < src.length && o + i < dst.length; i++) dst[o + i] += src[i] * gain;
  return dst;
}

function saturate(x: Buf, drive: number) {
  const k = Math.tanh(drive);
  for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i] * drive) / k;
  return x;
}

function normalize(x: Buf, peakDb: number) {
  let m = 1e-9;
  for (const v of x) m = Math.max(m, Math.abs(v));
  const g = Math.pow(10, peakDb / 20) / m;
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}

/** Short fade at the end (no clicks) and DC removal. */
function finish(x: Buf, peakDb: number) {
  biquad(x, 'hp', 18);
  const f = Math.min(x.length, Math.floor(0.01 * SR));
  for (let i = 0; i < f; i++) x[x.length - 1 - i] *= i / f;
  return normalize(x, peakDb);
}

function writeWav(name: string, x: Buf) {
  const n = x.length, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), 44 + i * 2);
  const file = join(OUT, `${name}.wav`);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, b);
  return file;
}

const v = (r: () => number, x: number, spread = 0.12) => x * (1 + (r() * 2 - 1) * spread);

// ------------------------------------------------------------------ recipes

/** Near-field muzzle blast: N-wave crack, pitch-dropping body, mid punch, sizzle; saturated. */
function blast(seed: number) {
  const r = rng(seed), x = buf(0.42);
  mix(x, env(biquad(noise(x.length, r), 'hp', 900), 0, v(r, 0.0005)), 1.2);
  const f0 = v(r, 175), f1 = v(r, 50);
  mix(x, tone(0.4, (t) => f1 + (f0 - f1) * Math.exp(-t / 0.03), (t) => (t < 0.001 ? t / 0.001 : Math.exp(-t / v(r, 0.05)))), 1.0);
  mix(x, env(biquad(noise(x.length, r), 'bp', v(r, 650), 0.8), 0.0005, v(r, 0.02)), 0.9);
  mix(x, env(biquad(noise(x.length, r), 'lp', v(r, 420)), 0.001, v(r, 0.07)), 0.7);
  mix(x, env(biquad(noise(x.length, r), 'hp', 4200), 0, v(r, 0.009)), 0.35);
  saturate(x, 2.4);
  return finish(x, -1);
}

/** Bolt carrier slam: click, inharmonic ring, a second smaller impact as it returns to battery. */
function mech(seed: number) {
  const r = rng(seed), x = buf(0.14);
  const hit = (at: number, g: number) => {
    mix(x, env(biquad(noise(x.length, r), 'bp', v(r, 3400), 2), 0, 0.0018), g, at);
    mix(x, ring(0.1, [[v(r, 1720, 0.05), 0.024, 0.5], [v(r, 2910, 0.05), 0.017, 0.4], [v(r, 4380, 0.05), 0.011, 0.3], [v(r, 6150, 0.05), 0.007, 0.2]], r), g * 0.6, at);
    mix(x, env(biquad(noise(x.length, r), 'bp', 900, 1.2), 0, 0.007), g * 0.5, at);
  };
  hit(0, 1);
  hit(v(r, 0.04, 0.1), 0.6);
  return finish(x, -3);
}

/** Outdoor roll-off: early slaps off nearby buildings, then a darkening rumble. */
function tailOutdoor(seed: number) {
  const r = rng(seed), x = buf(2.0);
  const body = env(noise(x.length, r), 0.012, v(r, 0.5));
  sweepLp(body, (t) => 250 + 2400 * Math.exp(-t / 0.25));
  mix(x, body, 1);
  for (const [at, g] of [[v(r, 0.06), 0.55], [v(r, 0.15), 0.4], [v(r, 0.27), 0.25], [v(r, 0.42), 0.15]] as const) {
    const slap = env(biquad(noise(Math.floor(0.08 * SR), r), 'lp', 1800), 0.002, 0.018);
    mix(x, slap, g, at);
  }
  mix(x, env(biquad(noise(x.length, r), 'lp', 160), 0.03, 0.7), 0.6);
  return finish(x, -2);
}

/** Enclosed space: dense, brighter, short. */
function tailRoom(seed: number) {
  const r = rng(seed), x = buf(0.9);
  const body = env(biquad(biquad(noise(x.length, r), 'hp', 250), 'lp', 4500), 0.004, v(r, 0.17));
  mix(x, body, 1);
  return finish(x, -3);
}

function dryFire(seed: number) {
  const r = rng(seed), x = buf(0.08);
  mix(x, env(biquad(noise(x.length, r), 'bp', 2600, 2), 0, 0.0015), 1);
  mix(x, ring(0.06, [[2250, 0.008, 0.4], [3900, 0.005, 0.25]], r), 0.6);
  return finish(x, -6);
}

/** Brass casing bounce: high inharmonic ping. */
function brass(seed: number, soft: boolean) {
  const r = rng(seed), x = buf(0.25);
  const f = v(r, 3800, 0.15);
  mix(x, ring(0.25, [[f, v(r, 0.05), 0.6], [f * 2.34, 0.03, 0.4], [f * 3.9, 0.018, 0.25], [f * 5.3, 0.01, 0.15]], r), 1);
  mix(x, env(biquad(noise(x.length, r), 'hp', 3000), 0, 0.0012), 0.6);
  if (soft) { biquad(x, 'lp', 1800); env(x, 0, 0.012); }
  return finish(x, -2);
}

function impactConcrete(seed: number) {
  const r = rng(seed), x = buf(0.3);
  mix(x, env(biquad(noise(x.length, r), 'bp', v(r, 2400), 1), 0, 0.004), 1);
  mix(x, env(biquad(noise(x.length, r), 'lp', 320), 0.001, 0.015), 0.8);
  mix(x, grains(0.3, 22, 0.16, 2500, 6500, r), 0.7, 0.006);
  return finish(x, -1);
}

function impactMetal(seed: number) {
  const r = rng(seed), x = buf(0.45);
  mix(x, env(biquad(noise(x.length, r), 'bp', 4200, 1.5), 0, 0.0015), 1);
  const f = v(r, 1250, 0.2);
  mix(x, ring(0.45, [[f, v(r, 0.11), 0.5], [f * 2.17, 0.08, 0.35], [f * 3.31, 0.05, 0.25], [f * 4.73, 0.03, 0.18]], r), 0.8);
  return finish(x, -1);
}

function ricochet(seed: number) {
  const r = rng(seed), x = buf(0.5);
  const f0 = v(r, 3900, 0.1), f1 = v(r, 1700, 0.1), d = v(r, 0.35, 0.1);
  mix(x, tone(0.5, (t) => f1 + (f0 - f1) * Math.max(0, 1 - t / d) + 60 * Math.sin(t * 90), (t) => (t < 0.01 ? t / 0.01 : Math.exp(-(t - 0.01) / 0.12))), 0.6);
  mix(x, env(biquad(noise(x.length, r), 'bp', 3000, 3), 0.005, 0.1), 0.3);
  return finish(x, -4);
}

function impactWood(seed: number) {
  const r = rng(seed), x = buf(0.25);
  mix(x, env(biquad(noise(x.length, r), 'lp', 1300), 0, 0.012), 1);
  mix(x, ring(0.2, [[v(r, 380), 0.03, 0.6], [v(r, 610), 0.02, 0.3]], r), 0.6);
  mix(x, grains(0.25, 10, 0.08, 3000, 7000, r), 0.5, 0.004);
  return finish(x, -1);
}

function impactGlass(seed: number) {
  const r = rng(seed), x = buf(0.6);
  mix(x, env(biquad(noise(x.length, r), 'hp', 2200), 0, 0.03), 0.8);
  for (let k = 0; k < 26; k++) {
    const at = Math.pow(r(), 1.5) * 0.35, f = 2800 + r() * 6500;
    mix(x, ring(0.15, [[f, 0.015 + r() * 0.03, 0.5], [f * 1.7, 0.01, 0.2]], r), 0.25 * Math.exp(-at / 0.2), at);
  }
  return finish(x, -1);
}

function impactSoil(seed: number) {
  const r = rng(seed), x = buf(0.3);
  mix(x, env(biquad(noise(x.length, r), 'lp', 260), 0.001, 0.025), 1);
  mix(x, env(biquad(noise(x.length, r), 'bp', 1500, 0.7), 0.003, 0.05), 0.5);
  mix(x, grains(0.3, 18, 0.2, 1200, 4000, r), 0.4, 0.01);
  return finish(x, -1);
}

/** Wet vegetable hit: squelch with bubbly modulation and a low thump. */
function impactFlesh(seed: number) {
  const r = rng(seed), x = buf(0.32);
  const wet = env(biquad(noise(x.length, r), 'lp', v(r, 950)), 0.002, v(r, 0.07));
  const am = v(r, 55, 0.3);
  for (let i = 0; i < wet.length; i++) wet[i] *= 0.6 + 0.4 * Math.sin((i / SR) * am * 2 * Math.PI + Math.sin(i / 300));
  mix(x, wet, 1);
  mix(x, tone(0.3, (t) => 140 - 60 * t * 3, (t) => (t < 0.002 ? t / 0.002 : Math.exp(-t / 0.03))), 0.7);
  mix(x, env(biquad(noise(x.length, r), 'bp', 420, 2), 0.004, 0.04), 0.5, 0.01);
  return finish(x, -1);
}

function step(seed: number, kind: 'hard' | 'soft' | 'gravel' | 'metal', land = false) {
  const r = rng(seed), x = buf(land ? 0.35 : 0.22), L = land ? 1.6 : 1;
  if (kind === 'hard') {
    mix(x, env(biquad(noise(x.length, r), 'bp', v(r, 1800), 1.2), 0, 0.006 * L), 0.8);
    mix(x, env(biquad(noise(x.length, r), 'lp', 200), 0.002, 0.02 * L), 1);
    mix(x, env(biquad(noise(x.length, r), 'bp', 3200, 0.8), 0.01, 0.03), 0.18, 0.02);
  } else if (kind === 'soft') {
    mix(x, env(biquad(noise(x.length, r), 'lp', 300), 0.004, 0.025 * L), 1);
    mix(x, env(biquad(noise(x.length, r), 'bp', 2600, 0.6), 0.02, 0.05), 0.07);
  } else if (kind === 'gravel') {
    mix(x, env(biquad(noise(x.length, r), 'lp', 250), 0.003, 0.02 * L), 0.8);
    mix(x, grains(x.length / SR, 40, 0.11 * L, 1800, 5000, r), 0.9);
  } else {
    mix(x, env(biquad(noise(x.length, r), 'lp', 300), 0.002, 0.02 * L), 1);
    mix(x, ring(x.length / SR, [[v(r, 620), 0.04, 0.35], [v(r, 1130), 0.03, 0.25]], r), 0.6);
  }
  return finish(x, land ? -1 : -3);
}

// ------------------------------------------------------------------ build

const files: string[] = [];
const out = (name: string, x: Buf) => files.push(writeWav(name, x));
for (let i = 1; i <= 4; i++) out(`carbine/blast_${i}`, blast(100 + i));
for (let i = 1; i <= 3; i++) out(`carbine/mech_${i}`, mech(200 + i));
for (let i = 1; i <= 2; i++) out(`carbine/tail_outdoor_${i}`, tailOutdoor(300 + i));
out('carbine/tail_room_1', tailRoom(401));
out('carbine/dry_1', dryFire(501));
for (let i = 1; i <= 5; i++) out(`brass/hard_${i}`, brass(600 + i, false));
for (let i = 1; i <= 2; i++) out(`brass/soft_${i}`, brass(650 + i, true));
for (let i = 1; i <= 4; i++) out(`impact/concrete_${i}`, impactConcrete(700 + i));
for (let i = 1; i <= 3; i++) out(`impact/metal_${i}`, impactMetal(800 + i));
for (let i = 1; i <= 2; i++) out(`impact/ricochet_${i}`, ricochet(850 + i));
for (let i = 1; i <= 3; i++) out(`impact/wood_${i}`, impactWood(900 + i));
for (let i = 1; i <= 2; i++) out(`impact/glass_${i}`, impactGlass(1000 + i));
for (let i = 1; i <= 3; i++) out(`impact/soil_${i}`, impactSoil(1100 + i));
for (let i = 1; i <= 3; i++) out(`impact/flesh_${i}`, impactFlesh(1200 + i));
for (const k of ['hard', 'soft', 'gravel', 'metal'] as const) {
  for (let i = 1; i <= 4; i++) out(`step/${k}_${i}`, step(1300 + i * 7 + k.length, k));
  out(`step/${k}_land`, step(1400 + k.length, k, true));
}
console.log(`${files.length} sounds -> ${OUT}`);
