import type { Runtime } from '../app/runtime';
import { FixedClock } from '../engine/core/clock';
import { PLAYER_DEFAULTS, type PlayerTuning } from '../engine/player/controller';
import { ConfigFile } from './config';
import { TuningPanel } from './ui/panel';
import { DebugHud } from './ui/hud';

/**
 * The game layer (G1): owns the fixed simulation clock and wires gameplay
 * systems into the runtime's frame hook. Engine systems (renderer, world,
 * collision, input, controller) stay generic; tuning lives in public/game/.
 */
export class Game {
  readonly clock = new FixedClock(120);
  readonly playerConfig = new ConfigFile<PlayerTuning>('player', PLAYER_DEFAULTS);
  panel: TuningPanel | null = null;
  hud: DebugHud | null = null;
  /** Called before every tick with the simulated time (scripted tests drive input here). */
  beforeTick: ((t: number) => void) | null = null;
  /** Real-time duration of the last frame's simulation work (ms). */
  simMs = 0;

  constructor(readonly rt: Runtime) {}

  async init(opts: { panel?: HTMLElement } = {}) {
    await this.playerConfig.load();
    this.rt.player.tuning = this.playerConfig.data;
    if (opts.panel) {
      this.panel = new TuningPanel(this, opts.panel);
      this.hud = new DebugHud(this);
    }
    const sp = this.rt.world.spawn();
    this.rt.player.teleport(sp.position, sp.yaw, sp.pitch);
  }

  /** Runtime frame hook: fixed ticks for gameplay, then per-frame presentation. */
  update = (dt: number) => {
    const t0 = performance.now();
    const { player, input, world, sandbox } = this.rt;
    const alpha = this.clock.advance(dt, (h, t) => {
      this.beforeTick?.(t);
      player.tick(h);
      input.endTick();
    });
    const sdt = dt * this.clock.timeScale;
    player.frame(sdt, alpha);
    world.update(sdt, player.feet);
    sandbox.update(sdt);
    this.simMs = performance.now() - t0;
    this.hud?.update();
  };

  /**
   * Frame-rate independence check: replays a scripted input sequence (in
   * simulated time) at several frame rates and compares the player's state at
   * common sample times. Returns the max deviation per rate (m).
   */
  async testFrameRates(rates = [30, 60, 120, 144, 240], seconds = 4) {
    const { player, input, camera } = this.rt;
    const start = { feet: [...player.feet] as [number, number, number], yaw: (camera.yaw * 180) / Math.PI };
    const script = (t: number) => {
      input.setKey('KeyW', t < 2.4);
      input.setKey('Space', t >= 0.5 && t < 0.55);
      input.setKey('KeyD', t >= 1.2 && t < 3.0);
      input.setKey('ShiftLeft', t >= 1.6 && t < 2.2);
      input.setKey('KeyC', t >= 2.6 && t < 3.4);
    };
    const runs: Record<number, { t: number; p: number[] }[]> = {};
    input.scripted = true;
    try {
      for (const fps of rates) {
        input.clear();
        player.fly = false;
        player.teleport(start.feet, start.yaw, 0);
        this.clock.reset();
        const k0 = this.clock.ticks;
        const samples: { t: number; p: number[] }[] = [];
        this.beforeTick = () => {
          const k = this.clock.ticks - k0, lt = k / this.clock.hz;
          script(lt);
          // Sample tick state at 0.1 s marks (identical tick times at every frame rate).
          if (k % 12 === 0) samples.push({ t: +lt.toFixed(3), p: [...player.feet] });
        };
        const frames = Math.round(seconds * fps);
        for (let i = 0; i < frames; i++) this.update(1 / fps);
        runs[fps] = samples;
      }
    } finally {
      this.beforeTick = null;
      input.scripted = false;
      input.clear();
      player.teleport(start.feet, start.yaw, 0);
    }
    const ref = runs[rates[0]];
    const result: Record<string, number> = {};
    for (const fps of rates) {
      let dev = 0;
      const s = runs[fps];
      for (let i = 0; i < Math.min(ref.length, s.length); i++) dev = Math.max(dev, Math.hypot(ref[i].p[0] - s[i].p[0], ref[i].p[1] - s[i].p[1], ref[i].p[2] - s[i].p[2]));
      result[`${fps}fps`] = +dev.toExponential(2);
    }
    const end = ref[ref.length - 1];
    return { maxDeviation: result, samples: ref.length, travelled: +Math.hypot(end.p[0] - start.feet[0], end.p[2] - start.feet[2]).toFixed(3) };
  }
}
