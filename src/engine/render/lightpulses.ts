import type { LightData } from './renderer';

/**
 * Short-lived point lights (muzzle flashes, sparks): pooled, with a fast
 * attack and a quadratic decay. Each pulse is visible on at least the frame it
 * was emitted, however short its life, so a flash is never skipped at low
 * frame rates.
 */
interface Pulse {
  light: LightData;
  t: number;
  life: number;
  peak: number;
  shown: boolean;
}

export class LightPulses {
  private live: Pulse[] = [];
  private pool: Pulse[] = [];
  /** Cap: oldest pulses are dropped first. */
  max = 16;

  emit(position: ArrayLike<number>, color: [number, number, number], peak: number, range: number, life = 0.05, sourceRadius = 0.05, fogScatter = 0.3) {
    if (this.live.length >= this.max) this.pool.push(this.live.shift()!);
    const p = this.pool.pop() ?? { light: { position: [0, 0, 0], color: [1, 1, 1], intensity: 0, range: 1, type: 'point' } as LightData, t: 0, life: 0, peak: 0, shown: false };
    const L = p.light;
    L.position[0] = position[0]; L.position[1] = position[1]; L.position[2] = position[2];
    L.color = color;
    L.range = range;
    L.sourceRadius = sourceRadius;
    L.fogScatter = fogScatter;
    p.t = 0; p.life = life; p.peak = peak; p.shown = false;
    this.live.push(p);
  }

  /** Advances the pulses and appends the visible ones to `out` (call once per frame before rendering). */
  update(dt: number, out: LightData[]) {
    let w = 0;
    for (const p of this.live) {
      const x = Math.min(1, p.t / p.life);
      p.light.intensity = p.peak * (1 - x) * (1 - x);
      if (p.t < p.life || !p.shown) {
        out.push(p.light);
        p.shown = true;
        p.t += dt;
        this.live[w++] = p;
      } else {
        this.pool.push(p);
      }
    }
    this.live.length = w;
  }

  clear() {
    while (this.live.length) this.pool.push(this.live.pop()!);
  }
}
