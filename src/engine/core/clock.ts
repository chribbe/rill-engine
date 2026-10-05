/**
 * Fixed-step simulation clock. Gameplay (movement, weapons, enemies) advances in
 * equal ticks so it behaves identically at any frame rate; rendering
 * interpolates between the last two ticks with the returned alpha.
 */
export class FixedClock {
  readonly step: number;
  /** Slow motion / pause (0); scales simulated time, not input. */
  timeScale = 1;
  /** Simulated seconds (ticks × step). */
  time = 0;
  ticks = 0;
  /** Guards against a spiral of death after a stall (excess time is dropped). */
  maxTicksPerFrame = 12;
  private acc = 0;

  constructor(readonly hz = 120) {
    this.step = 1 / hz;
  }

  /** Runs `tick` once per elapsed fixed step of `dt` (real seconds); returns the interpolation alpha in [0, 1). */
  advance(dt: number, tick: (h: number, t: number) => void): number {
    this.acc += Math.max(0, dt) * this.timeScale;
    let n = 0;
    while (this.acc >= this.step && n < this.maxTicksPerFrame) {
      tick(this.step, this.time);
      this.acc -= this.step;
      this.ticks++;
      // Exact multiples of the step (no drift from repeated addition).
      this.time = this.ticks * this.step;
      n++;
    }
    if (n === this.maxTicksPerFrame && this.acc >= this.step) this.acc = 0;
    return this.acc / this.step;
  }

  /** Simulated time this frame will reach after advancing by `dt` (real seconds). */
  timeAfter(dt: number) {
    return this.time + this.acc + Math.max(0, dt) * this.timeScale;
  }

  reset() {
    this.acc = 0;
  }
}
