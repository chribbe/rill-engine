import type { Game } from '../game';

const SURFACES = ['default', 'metal'];

/** Dev readout (bottom left): movement state, timing. Toggle with the panel. */
export class DebugHud {
  readonly el: HTMLPreElement;
  visible = true;
  private n = 0;

  constructor(private game: Game) {
    this.el = document.createElement('pre');
    Object.assign(this.el.style, {
      position: 'fixed', left: '8px', bottom: '8px', margin: '0', padding: '6px 8px', pointerEvents: 'none',
      background: 'rgba(8,10,12,0.55)', borderRadius: '4px', font: '11px/1.35 ui-monospace, Menlo, monospace', color: '#dfe3e8',
    } as Partial<CSSStyleDeclaration>);
    document.body.append(this.el);
  }

  update() {
    this.el.style.display = this.visible ? 'block' : 'none';
    if (!this.visible || ++this.n % 6) return;
    const { player, lastFrameMs } = this.game.rt;
    const m = player.motor;
    const v = m.velocity;
    this.el.textContent = [
      `speed ${player.speed.toFixed(2)} m/s  vy ${v[1].toFixed(2)}  ${player.fly ? 'FLY' : m.grounded ? 'ground' : 'air'}  ${player.stance}${player.sprinting ? '  sprint' : ''}`,
      `surface ${m.grounded ? SURFACES[m.ground.surface] ?? m.ground.surface : '-'}  slope ${m.grounded ? ((Math.acos(Math.min(1, m.ground.ny)) * 180) / Math.PI).toFixed(0) : '-'}°`,
      `frame ${lastFrameMs.toFixed(1)} ms  sim ${this.game.simMs.toFixed(2)} ms  ticks ${this.game.clock.ticks}  ×${this.game.clock.timeScale}`,
    ].join('\n');
  }
}
