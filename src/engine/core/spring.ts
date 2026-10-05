/**
 * Damped springs stepped in closed form: the curve is exact for any dt, so
 * camera and viewmodel motion look the same at 30 or 240 fps. Parameterised by
 * natural frequency (Hz) and damping ratio (1 = critical, < 1 overshoots).
 * Impulses are velocity kicks (`s.v += ...`).
 */
export interface Spring1 {
  x: number;
  v: number;
}

export const spring = (x = 0): Spring1 => ({ x, v: 0 });

/** Advances `s` towards `target` by `dt` seconds. */
export function stepSpring(s: Spring1, target: number, hz: number, zeta: number, dt: number) {
  if (dt <= 0) return;
  if (hz <= 0) {
    s.x += s.v * dt;
    return;
  }
  const w = 2 * Math.PI * hz;
  const y0 = s.x - target, v0 = s.v;
  let y: number, v: number;
  if (zeta < 0.9999) {
    const wd = w * Math.sqrt(1 - zeta * zeta);
    const e = Math.exp(-zeta * w * dt);
    const c = Math.cos(wd * dt), sn = Math.sin(wd * dt);
    y = e * (y0 * c + ((v0 + zeta * w * y0) / wd) * sn);
    v = e * (v0 * c - ((w * w * y0 + zeta * w * v0) / wd) * sn);
  } else if (zeta <= 1.0001) {
    const e = Math.exp(-w * dt);
    const b = v0 + w * y0;
    y = (y0 + b * dt) * e;
    v = (v0 - w * b * dt) * e;
  } else {
    const q = Math.sqrt(zeta * zeta - 1);
    const r1 = -w * (zeta - q), r2 = -w * (zeta + q);
    const c2 = (v0 - r1 * y0) / (r2 - r1), c1 = y0 - c2;
    const e1 = Math.exp(r1 * dt), e2 = Math.exp(r2 * dt);
    y = c1 * e1 + c2 * e2;
    v = c1 * r1 * e1 + c2 * r2 * e2;
  }
  s.x = target + y;
  s.v = v;
}

/** Frame-rate independent exponential approach: fraction of the gap closed in `dt` at `rate` (1/s). */
export const approach = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);
