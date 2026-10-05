/**
 * Health readout (bottom left): hidden at full health, fades in when hurt,
 * pulses red when low. On death, a dim screen with the run's tally and how to
 * go again. Kills and survival time sit quietly next to it while playing.
 */
export class HealthIndicator {
  readonly el: HTMLDivElement;
  private bar: HTMLDivElement;
  private fill: HTMLDivElement;
  private tally: HTMLDivElement;
  private death: HTMLDivElement;
  private deathText: HTMLDivElement;
  private shown = 0;
  private pulse = 0;

  constructor(parent: HTMLElement = document.body) {
    this.el = document.createElement('div');
    Object.assign(this.el.style, {
      position: 'absolute', left: '22px', bottom: '18px', zIndex: '5', pointerEvents: 'none',
      font: '600 13px/1 ui-monospace, Menlo, monospace', color: 'rgba(235,238,242,0.85)', textShadow: '0 1px 2px rgba(0,0,0,0.6)',
    } as Partial<CSSStyleDeclaration>);
    this.bar = document.createElement('div');
    Object.assign(this.bar.style, { width: '180px', height: '6px', background: 'rgba(20,20,22,0.55)', borderRadius: '3px', overflow: 'hidden', opacity: '0', marginBottom: '8px' });
    this.fill = document.createElement('div');
    Object.assign(this.fill.style, { height: '100%', width: '100%', background: 'rgba(235,238,242,0.9)', borderRadius: '3px' });
    this.bar.append(this.fill);
    this.tally = document.createElement('div');
    this.tally.style.opacity = '0.7';
    this.el.append(this.bar, this.tally);
    parent.append(this.el);
    this.death = document.createElement('div');
    Object.assign(this.death.style, {
      position: 'absolute', inset: '0', zIndex: '6', pointerEvents: 'none', display: 'none', alignItems: 'center', justifyContent: 'center',
      background: 'radial-gradient(ellipse at 50% 50%, rgba(40,0,0,0.25) 30%, rgba(20,0,0,0.75) 100%)',
    } as Partial<CSSStyleDeclaration>);
    this.deathText = document.createElement('div');
    Object.assign(this.deathText.style, {
      font: '600 15px/1.7 ui-monospace, Menlo, monospace', color: 'rgba(240,236,236,0.92)', textAlign: 'center', textShadow: '0 1px 3px rgba(0,0,0,0.8)', whiteSpace: 'pre',
    } as Partial<CSSStyleDeclaration>);
    this.death.append(this.deathText);
    parent.append(this.death);
  }

  update(dt: number, hp: number, max: number, dead: boolean, deadT: number, kills: number, time: number, active: boolean) {
    const f = Math.max(0, hp / max);
    const want = active && !dead && f < 0.999 ? 1 : 0;
    this.shown += (want - this.shown) * (1 - Math.exp(-dt * (want ? 12 : 2)));
    this.bar.style.opacity = this.shown.toFixed(3);
    this.fill.style.width = `${(f * 100).toFixed(1)}%`;
    const low = f < 0.35;
    this.pulse = low ? (this.pulse + dt * 5) % (Math.PI * 2) : 0;
    this.fill.style.background = low ? `rgba(255,${(70 + 50 * Math.sin(this.pulse)).toFixed(0)},60,0.95)` : 'rgba(235,238,242,0.9)';
    const m = Math.floor(time / 60), s = Math.floor(time % 60);
    this.tally.textContent = active && !dead ? `${kills} · ${m}:${String(s).padStart(2, '0')}` : '';
    this.death.style.display = active && dead ? 'flex' : 'none';
    if (active && dead) {
      this.death.style.opacity = Math.min(1, deadT / 1.2).toFixed(3);
      this.deathText.textContent = `DEAD\n\n${kills} kills  ·  ${m}:${String(s).padStart(2, '0')}${deadT > 1.2 ? '\n\nclick or R to go again' : ''}`;
    }
  }
}
