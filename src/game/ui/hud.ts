import type { Game } from '../game';
import { surfaceName } from '../../engine/scene/surfaces';

/** Dev readout (bottom left): movement state, timing. Toggle with the panel. */
export class DebugHud {
  readonly el: HTMLPreElement;
  visible = true;
  private n = 0;

  constructor(private game: Game, parent: HTMLElement = document.body) {
    this.el = document.createElement('pre');
    Object.assign(this.el.style, {
      position: 'absolute', left: '8px', bottom: '8px', zIndex: '5', margin: '0', padding: '6px 8px', pointerEvents: 'none',
      background: 'rgba(8,10,12,0.55)', borderRadius: '4px', font: '11px/1.35 ui-monospace, Menlo, monospace', color: '#dfe3e8',
    } as Partial<CSSStyleDeclaration>);
    parent.append(this.el);
  }

  update() {
    this.el.style.display = this.visible ? 'block' : 'none';
    if (!this.visible || ++this.n % 6) return;
    const g = this.game, { player, lastFrameMs } = g.rt;
    const m = player.motor;
    const v = m.velocity;
    const w = g.weapon, h = g.lastHit;
    this.el.textContent = [
      `speed ${player.speed.toFixed(2)} m/s  vy ${v[1].toFixed(2)}  ${player.fly ? 'FLY' : m.grounded ? 'ground' : 'air'}  ${player.stance}${player.sprinting ? '  sprint' : ''}`,
      `surface ${m.grounded ? surfaceName(m.ground.surface) : '-'}  slope ${m.grounded ? ((Math.acos(Math.min(1, m.ground.ny)) * 180) / Math.PI).toFixed(0) : '-'}°`,
      `ammo ${w.def.fire.infiniteAmmo ? '∞' : `${w.ammo}/${w.def.fire.magazine}`}${w.reloading ? ` reloading ${w.reloadT.toFixed(1)}s${w.reloadEmpty ? ' (empty)' : ''}` : ''}  spread ${w.spread(player).toFixed(2)}°  shots ${w.shots}  trigger→shot ${w.lastLatencyMs >= 0 ? w.lastLatencyMs.toFixed(1) + ' ms' : '-'}`,
      h ? `hit ${h.object || '?'}  ${h.surface}${h.region ? ` (${h.region})` : ''}  ${h.distance.toFixed(1)} m  dmg ${h.damage.toFixed(1)}${h.pierced ? `  through ${h.pierced} pane` : ''}` : 'hit -',
      h ? `    at ${h.point.map((x) => x.toFixed(2)).join(' ')}  n ${h.normal.map((x) => x.toFixed(2)).join(' ')}` : '',
      (() => {
        const alive = g.horde.list.filter((t) => t.alive);
        const near = alive.reduce<typeof alive[number] | null>((b, t) => !b || Math.hypot(t.pos[0] - player.feet[0], t.pos[2] - player.feet[2]) < Math.hypot(b.pos[0] - player.feet[0], b.pos[2] - player.feet[2]) ? t : b, null);
        return `horde ${alive.length} alive  debris ${g.debris?.moving ?? 0} moving` + (near ? `  nearest ${near.state} ${Math.max(0, near.health).toFixed(0)}hp ${near.legsLeft} legs ${Math.hypot(near.pos[0] - player.feet[0], near.pos[2] - player.feet[2]).toFixed(1)}m` : '');
      })(),
      `audio ${g.audio.engine.ctx.state}  ${(g.audio.engine.latency * 1000).toFixed(0)} ms out  voices ${g.audio.engine.activeVoices}  room ${(g.audio.environment.room * 100).toFixed(0)}%`,
      `frame ${lastFrameMs.toFixed(1)} ms  sim ${g.simMs.toFixed(2)} ms  ticks ${g.clock.ticks}  ×${g.clock.timeScale}`,
    ].join('\n');
  }
}
