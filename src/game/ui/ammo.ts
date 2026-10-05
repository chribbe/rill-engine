/**
 * Minimal ammo readout (bottom right): hidden while the magazine is healthy,
 * fades in when it runs low, shows reload progress. No permanent HUD.
 */
export class AmmoIndicator {
  readonly el: HTMLDivElement;
  private shown = 0;

  constructor(parent: HTMLElement = document.body) {
    this.el = document.createElement('div');
    Object.assign(this.el.style, {
      position: 'absolute', right: '22px', bottom: '18px', zIndex: '5', pointerEvents: 'none', textAlign: 'right',
      font: '600 15px/1 ui-monospace, Menlo, monospace', color: 'rgba(235,238,242,0.9)', textShadow: '0 1px 2px rgba(0,0,0,0.6)', opacity: '0',
    } as Partial<CSSStyleDeclaration>);
    parent.append(this.el);
  }

  update(dt: number, ammo: number, magazine: number, infinite: boolean, reload: { t: number; total: number } | null, active: boolean) {
    const low = !infinite && ammo <= Math.ceil(magazine / 3);
    const want = active && (low || !!reload) ? 1 : 0;
    this.shown += (want - this.shown) * (1 - Math.exp(-dt * (want ? 12 : 3)));
    this.el.style.opacity = this.shown.toFixed(3);
    if (this.shown < 0.01) return;
    if (reload) {
      const n = Math.round((reload.t / reload.total) * 10);
      this.el.textContent = `${'▮'.repeat(n)}${'▯'.repeat(10 - n)}`;
      this.el.style.color = 'rgba(235,238,242,0.75)';
    } else {
      this.el.textContent = String(ammo);
      this.el.style.color = ammo === 0 ? 'rgba(255,120,90,0.95)' : 'rgba(235,238,242,0.9)';
    }
  }
}
