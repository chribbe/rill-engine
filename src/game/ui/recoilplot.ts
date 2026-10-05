import type { ShotEvent } from '../weapon/firearm';

const DEG = 180 / Math.PI;

/**
 * Recoil pattern plot (debug, bottom right): where each round of the current /
 * last burst went, in degrees relative to the aim at the start of the pull,
 * so pattern, spread and the player's compensation can be read and tuned.
 * The first shot is ringed; later shots fade from white to orange.
 */
export class RecoilPlot {
  readonly el: HTMLCanvasElement;
  visible = false;
  /** Half extent of the plot (degrees). */
  range = 6;
  private pts: number[] = [];
  private start: [number, number] = [0, 0];
  private dirty = true;

  constructor(parent: HTMLElement = document.body) {
    this.el = document.createElement('canvas');
    this.el.width = this.el.height = 180;
    Object.assign(this.el.style, { position: 'absolute', right: '8px', bottom: '8px', zIndex: '5', width: '180px', height: '180px', pointerEvents: 'none', background: 'rgba(8,10,12,0.55)', borderRadius: '4px', display: 'none' });
    parent.append(this.el);
  }

  /** `aimYaw` / `aimPitch`: the player's view angles at the shot (radians). */
  shot(e: ShotEvent, aimYaw: number, aimPitch: number) {
    const yaw = Math.atan2(e.dir[0], -e.dir[2]), pitch = Math.asin(Math.max(-1, Math.min(1, e.dir[1])));
    if (e.burstIndex === 0) {
      this.pts.length = 0;
      this.start = [aimYaw, aimPitch];
    }
    let dy = yaw - this.start[0];
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.pts.push(dy * DEG, (pitch - this.start[1]) * DEG);
    this.dirty = true;
  }

  update() {
    this.el.style.display = this.visible ? 'block' : 'none';
    if (!this.visible || !this.dirty) return;
    this.dirty = false;
    const c = this.el.getContext('2d')!, S = 180, k = S / 2 / this.range;
    c.clearRect(0, 0, S, S);
    c.strokeStyle = 'rgba(255,255,255,0.15)';
    c.lineWidth = 1;
    for (let g = -this.range; g <= this.range; g += 1) {
      const p = S / 2 + g * k;
      c.beginPath(); c.moveTo(p, 0); c.lineTo(p, S); c.stroke();
      c.beginPath(); c.moveTo(0, p); c.lineTo(S, p); c.stroke();
    }
    c.strokeStyle = 'rgba(255,255,255,0.4)';
    c.beginPath(); c.moveTo(S / 2, 0); c.lineTo(S / 2, S); c.moveTo(0, S / 2); c.lineTo(S, S / 2); c.stroke();
    const n = this.pts.length / 2;
    for (let i = 0; i < n; i++) {
      const x = S / 2 + this.pts[i * 2] * k, y = S / 2 - this.pts[i * 2 + 1] * k;
      const t = n > 1 ? i / (n - 1) : 0;
      c.fillStyle = `rgb(255,${Math.round(255 - t * 120)},${Math.round(255 - t * 220)})`;
      c.beginPath(); c.arc(x, y, 2.2, 0, Math.PI * 2); c.fill();
      if (i === 0) { c.strokeStyle = 'white'; c.beginPath(); c.arc(x, y, 5, 0, Math.PI * 2); c.stroke(); }
    }
    c.fillStyle = 'rgba(223,227,232,0.8)';
    c.font = '10px ui-monospace, Menlo, monospace';
    c.fillText(`${n} rounds  ±${this.range}°`, 6, 14);
  }
}
