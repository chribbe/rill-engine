/**
 * Screen splatter: when a tomato bursts right in front of the camera, wet red
 * blobs land on the "lens" (a canvas overlay), grow drips that run down, and
 * fade over a couple of seconds. Cheap: a few dozen paths per frame while any
 * are alive, nothing otherwise.
 */
interface Splat {
  x: number;
  y: number;
  r: number;
  age: number;
  life: number;
  /** Outline radius multipliers around the blob. */
  pts: number[];
  rot: number;
  drops: { dx: number; dy: number; r: number }[];
  drips: { dx: number; w: number; len: number; speed: number }[];
}

export class ScreenGore {
  readonly el: HTMLCanvasElement;
  private list: Splat[] = [];
  private ctx: CanvasRenderingContext2D;

  constructor(parent: HTMLElement = document.body) {
    this.el = document.createElement('canvas');
    Object.assign(this.el.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '4' });
    parent.append(this.el);
    this.ctx = this.el.getContext('2d')!;
  }

  /** A burst at screen position (sx, sy) in 0..1, `strength` 0..1 (how close / how much). */
  splash(strength: number, sx: number, sy: number) {
    const n = 2 + Math.round(strength * 6);
    for (let k = 0; k < n; k++) {
      const spread = 0.12 + 0.25 * strength;
      const x = sx + (Math.random() - 0.5) * spread * 2, y = sy + (Math.random() - 0.5) * spread * 1.4;
      const r = (0.025 + Math.random() * 0.07) * (0.5 + strength);
      const pts = Array.from({ length: 14 }, () => 0.75 + Math.random() * 0.5);
      const drops = Array.from({ length: 5 + Math.floor(Math.random() * 8) }, () => {
        const a = Math.random() * Math.PI * 2, d = 1.2 + Math.random() * 1.6;
        return { dx: Math.cos(a) * d, dy: Math.sin(a) * d, r: 0.06 + Math.random() * 0.16 };
      });
      const drips = Array.from({ length: Math.floor(Math.random() * 3) }, () => ({ dx: (Math.random() - 0.5) * 1.2, w: 0.12 + Math.random() * 0.14, len: 0, speed: 0.4 + Math.random() * 1.2 }));
      this.list.push({ x, y, r, age: 0, life: 1.6 + Math.random() * 1.4, pts, rot: Math.random() * 6.3, drops, drips });
    }
    if (this.list.length > 60) this.list.splice(0, this.list.length - 60);
  }

  update(dt: number) {
    const c = this.el, g = this.ctx;
    if (!this.list.length) {
      if (c.width) { c.width = 0; c.height = 0; }
      return;
    }
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    g.clearRect(0, 0, w, h);
    const m = Math.min(w, h);
    let keep = 0;
    for (const s of this.list) {
      s.age += dt;
      if (s.age >= s.life) continue;
      this.list[keep++] = s;
      const t = s.age / s.life;
      const a = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
      const cx = s.x * w, cy = s.y * h + s.age * s.age * 6, R = s.r * m;
      g.globalAlpha = a * 0.92;
      // Drips run down from the blob.
      for (const d of s.drips) {
        d.len += d.speed * dt;
        g.fillStyle = 'rgb(110,4,4)';
        const x = cx + d.dx * R, dw = d.w * R, dl = d.len * R * 2;
        g.beginPath();
        g.roundRect(x - dw / 2, cy, dw, dl, dw / 2);
        g.fill();
        g.beginPath();
        g.arc(x, cy + dl, dw * 0.75, 0, Math.PI * 2);
        g.fill();
      }
      const grad = g.createRadialGradient(cx - R * 0.2, cy - R * 0.2, R * 0.1, cx, cy, R * 1.2);
      grad.addColorStop(0, 'rgb(70,0,0)');
      grad.addColorStop(0.7, 'rgb(120,6,4)');
      grad.addColorStop(1, 'rgb(150,12,8)');
      g.fillStyle = grad;
      g.beginPath();
      const n = s.pts.length;
      for (let i = 0; i <= n; i++) {
        const k = i % n, an = s.rot + (k / n) * Math.PI * 2, rr = R * s.pts[k];
        const px = cx + Math.cos(an) * rr, py = cy + Math.sin(an) * rr;
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.closePath();
      g.fill();
      for (const d of s.drops) {
        g.beginPath();
        g.arc(cx + d.dx * R, cy + d.dy * R, d.r * R, 0, Math.PI * 2);
        g.fill();
      }
      // A wet highlight.
      g.globalAlpha = a * 0.22;
      g.fillStyle = 'rgb(255,200,190)';
      g.beginPath();
      g.ellipse(cx - R * 0.35, cy - R * 0.4, R * 0.28, R * 0.14, -0.6, 0, Math.PI * 2);
      g.fill();
    }
    this.list.length = keep;
    g.globalAlpha = 1;
  }

  clear() {
    this.list.length = 0;
  }
}
