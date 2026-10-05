/**
 * Minimal crosshair: a centre dot and four short ticks whose gap follows the
 * weapon's current spread cone (so bloom and movement penalties read without
 * a HUD). Optional hit tick: a brief cross when a shot connects with a target.
 */
export class Crosshair {
  readonly el: HTMLDivElement;
  private ticks: HTMLDivElement[] = [];
  private hit: HTMLDivElement;
  private hitT = 0;
  showSpread = true;
  hitMarker = true;
  visible = true;

  constructor(parent: HTMLElement = document.body) {
    this.el = document.createElement('div');
    Object.assign(this.el.style, { position: 'fixed', left: '50%', top: '50%', width: '0', height: '0', pointerEvents: 'none', zIndex: '5' });
    const dot = document.createElement('div');
    Object.assign(dot.style, { position: 'absolute', left: '-1.5px', top: '-1.5px', width: '3px', height: '3px', borderRadius: '2px', background: 'rgba(255,255,255,0.8)', boxShadow: '0 0 1px rgba(0,0,0,0.6)' });
    this.el.append(dot);
    for (let i = 0; i < 4; i++) {
      const t = document.createElement('div');
      const horiz = i % 2 === 0;
      Object.assign(t.style, { position: 'absolute', background: 'rgba(255,255,255,0.55)', boxShadow: '0 0 1px rgba(0,0,0,0.5)', width: horiz ? '6px' : '1.5px', height: horiz ? '1.5px' : '6px' });
      this.ticks.push(t);
      this.el.append(t);
    }
    this.hit = document.createElement('div');
    this.hit.innerHTML = '<svg width="22" height="22" viewBox="-11 -11 22 22"><g stroke="white" stroke-width="1.5" stroke-linecap="round"><line x1="-8" y1="-8" x2="-4" y2="-4"/><line x1="8" y1="-8" x2="4" y2="-4"/><line x1="-8" y1="8" x2="-4" y2="4"/><line x1="8" y1="8" x2="4" y2="4"/></g></svg>';
    Object.assign(this.hit.style, { position: 'absolute', left: '-11px', top: '-11px', opacity: '0' });
    this.el.append(this.hit);
    parent.append(this.el);
  }

  /** A shot hit a target (`kill` = it died): flash the hit tick. */
  confirm(kill = false) {
    if (!this.hitMarker) return;
    this.hitT = kill ? 0.28 : 0.14;
    (this.hit.firstChild as SVGElement).querySelector('g')!.setAttribute('stroke', kill ? '#ff8a6a' : 'white');
  }

  /**
   * `spreadDeg`: cone half-angle; `fovY` radians; `heightPx`: viewport CSS height;
   * `punch` (pitch, yaw radians): visual-only view kick, which the crosshair
   * counters so it keeps marking where bullets go.
   */
  update(dt: number, spreadDeg: number, fovY: number, heightPx: number, punch: [number, number] = [0, 0]) {
    this.el.style.display = this.visible ? 'block' : 'none';
    const f = heightPx / 2 / Math.tan(fovY / 2);
    this.el.style.transform = `translate(${(-Math.tan(punch[1]) * f).toFixed(2)}px, ${(Math.tan(punch[0]) * f).toFixed(2)}px)`;
    const gap = this.showSpread ? Math.max(3, (Math.tan((spreadDeg * Math.PI) / 180) / Math.tan(fovY / 2)) * (heightPx / 2)) + 2 : 0;
    const show = this.showSpread ? '1' : '0';
    const [r, d, l, u] = this.ticks;
    r.style.left = `${gap}px`; r.style.top = '-0.75px'; r.style.opacity = show;
    l.style.left = `${-gap - 6}px`; l.style.top = '-0.75px'; l.style.opacity = show;
    d.style.top = `${gap}px`; d.style.left = '-0.75px'; d.style.opacity = show;
    u.style.top = `${-gap - 6}px`; u.style.left = '-0.75px'; u.style.opacity = show;
    this.hitT = Math.max(0, this.hitT - dt);
    this.hit.style.opacity = String(Math.min(1, this.hitT / 0.08));
  }
}
