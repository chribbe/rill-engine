/**
 * Damage feedback: a red vignette that flares on a hit (stronger on the side
 * the hit came from) and fades. Pure overlay; health lives elsewhere.
 */
export class DamageFlash {
  readonly el: HTMLDivElement;
  private a = 0;
  private side = 0;

  constructor(parent: HTMLElement = document.body) {
    this.el = document.createElement('div');
    Object.assign(this.el.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '4', opacity: '0' });
    parent.append(this.el);
  }

  /** A hit of `amount` from world direction (dx, dz) (pointing from the attacker to the player). */
  hit(amount: number, dx: number, dz: number, cameraYaw: number) {
    this.a = Math.min(1, this.a + 0.35 + amount * 0.025);
    // Side of the screen the attacker is on: -1 left, +1 right.
    const rx = Math.cos(cameraYaw), rz = Math.sin(cameraYaw);
    this.side = -(dx * rx + dz * rz);
  }

  update(dt: number) {
    this.a = Math.max(0, this.a - dt * 1.4);
    const a = this.a;
    this.el.style.opacity = a > 0.001 ? '1' : '0';
    if (a <= 0.001) return;
    const x = 50 + this.side * 30;
    this.el.style.background = `radial-gradient(ellipse at ${x}% 50%, rgba(120,0,0,0) 45%, rgba(130,4,4,${(0.55 * a).toFixed(3)}) 80%, rgba(90,0,0,${(0.85 * a).toFixed(3)}) 100%)`;
  }
}
