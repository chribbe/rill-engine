import type { Renderer } from '../render/renderer';

type RGBA = [number, number, number, number];

/**
 * Timed debug lines (traces, normals, hit markers) rendered through the
 * renderer's line pass. Lines live for `life` seconds (0 = this frame only).
 */
export class DebugDraw {
  private items: { v: number[]; until: number }[] = [];
  enabled = true;

  constructor(private renderer: Renderer) {}

  line(a: ArrayLike<number>, b: ArrayLike<number>, color: RGBA, life = 0) {
    if (!this.enabled) return;
    this.items.push({ v: [a[0], a[1], a[2], ...color, b[0], b[1], b[2], ...color], until: performance.now() + life * 1000 });
  }

  /** Three-axis cross at `p`. */
  cross(p: ArrayLike<number>, size: number, color: RGBA, life = 0) {
    const s = size / 2;
    this.line([p[0] - s, p[1], p[2]], [p[0] + s, p[1], p[2]], color, life);
    this.line([p[0], p[1] - s, p[2]], [p[0], p[1] + s, p[2]], color, life);
    this.line([p[0], p[1], p[2] - s], [p[0], p[1], p[2] + s], color, life);
  }

  /** Vertical capsule outline (two rings + four sides). */
  capsule(a: ArrayLike<number>, b: ArrayLike<number>, r: number, color: RGBA, life = 0) {
    const n = 12;
    for (const c of [a, b]) {
      for (let i = 0; i < n; i++) {
        const t0 = (i / n) * Math.PI * 2, t1 = ((i + 1) / n) * Math.PI * 2;
        this.line([c[0] + Math.cos(t0) * r, c[1], c[2] + Math.sin(t0) * r], [c[0] + Math.cos(t1) * r, c[1], c[2] + Math.sin(t1) * r], color, life);
      }
    }
    for (let i = 0; i < 4; i++) {
      const t = (i / 4) * Math.PI * 2, dx = Math.cos(t) * r, dz = Math.sin(t) * r;
      this.line([a[0] + dx, a[1], a[2] + dz], [b[0] + dx, b[1], b[2] + dz], color, life);
    }
    this.line([a[0], a[1] - r, a[2]], [b[0], b[1] + r, b[2]], color, life);
  }

  clear() {
    this.items.length = 0;
    this.renderer.debugLines.length = 0;
  }

  /** Once per frame: drops expired lines and hands the rest to the renderer. */
  flush() {
    const now = performance.now(), out = this.renderer.debugLines;
    out.length = 0;
    let w = 0;
    for (const it of this.items) {
      for (const x of it.v) out.push(x);
      if (it.until > now) this.items[w++] = it;
    }
    this.items.length = w;
  }
}
