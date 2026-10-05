/**
 * Synthesised stereo impulse responses for the acoustic environments (no
 * assets): sparse early reflections then a decorrelated, darkening noise tail.
 *
 * - outdoor: few strong slaps off nearby facades (25–300 ms), a long thin tail
 * - room:    dense early reflections, short bright tail
 * - tunnel:  long, flutter-y, dark tail (subway, underpasses; later)
 */
export type AcousticEnv = 'outdoor' | 'room' | 'tunnel';

interface IrSpec {
  length: number;
  /** Early taps: count, window (s), gain of the first, decay over the window. */
  taps: number;
  tapWindow: [number, number];
  tapGain: number;
  /** Tail: start (s), decay time constant (s), gain, lowpass start/end (Hz). */
  tailStart: number;
  tau: number;
  tailGain: number;
  bright: number;
  dark: number;
}

const SPECS: Record<AcousticEnv, IrSpec> = {
  outdoor: { length: 2.4, taps: 9, tapWindow: [0.025, 0.32], tapGain: 0.7, tailStart: 0.05, tau: 0.6, tailGain: 0.18, bright: 3500, dark: 600 },
  room: { length: 1.1, taps: 24, tapWindow: [0.003, 0.04], tapGain: 0.5, tailStart: 0.01, tau: 0.17, tailGain: 0.5, bright: 7000, dark: 2500 },
  tunnel: { length: 3.2, taps: 30, tapWindow: [0.01, 0.12], tapGain: 0.45, tailStart: 0.02, tau: 0.9, tailGain: 0.45, bright: 3000, dark: 400 },
};

export function makeImpulseResponse(ctx: BaseAudioContext, env: AcousticEnv, seed = 7): AudioBuffer {
  const S = SPECS[env], sr = ctx.sampleRate, n = Math.ceil(S.length * sr);
  const ir = ctx.createBuffer(2, n, sr);
  let s = seed >>> 0;
  const r = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    // Tail: noise with exponential decay, one-pole lowpass closing over time.
    let y = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      if (t < S.tailStart) continue;
      const cut = S.dark + (S.bright - S.dark) * Math.exp(-(t - S.tailStart) / (S.tau * 0.8));
      const k = 1 - Math.exp((-2 * Math.PI * cut) / sr);
      y += (r() * 2 - 1 - y) * k;
      const fadeIn = Math.min(1, (t - S.tailStart) / 0.02);
      d[i] = y * Math.exp(-(t - S.tailStart) / S.tau) * S.tailGain * fadeIn;
    }
    // Early reflections: short filtered bursts, per channel (spatial spread).
    for (let k = 0; k < S.taps; k++) {
      const u = r();
      const t0 = S.tapWindow[0] + (S.tapWindow[1] - S.tapWindow[0]) * u * u;
      const g = S.tapGain * Math.exp(-u * 2.2) * (0.6 + r() * 0.4) * (r() < 0.5 ? -1 : 1);
      const o = Math.floor(t0 * sr), len = Math.floor(sr * 0.004);
      let z = 0;
      for (let i = 0; i < len && o + i < n; i++) {
        z += (r() * 2 - 1 - z) * 0.35;
        d[o + i] += z * g * Math.exp(-i / (len * 0.3));
      }
    }
  }
  return ir;
}
