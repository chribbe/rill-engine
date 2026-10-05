import type { Runtime } from '../app/runtime';
import { FixedClock } from '../engine/core/clock';
import { DebugDraw } from '../engine/debug/draw';
import { LightPulses } from '../engine/render/lightpulses';
import { surfaceName } from '../engine/scene/surfaces';
import { PLAYER_DEFAULTS, type PlayerTuning } from '../engine/player/controller';
import { ConfigFile } from './config';
import { Hitscan } from './combat/hitscan';
import { CARBINE_DEFAULTS, type WeaponDef } from './weapon/def';
import { Firearm, type ShotEvent } from './weapon/firearm';
import { Viewmodel } from './weapon/viewmodel';
import { Recoil } from './weapon/recoil';
import { ImpactFx, type ImpactTable } from './fx/impacts';
import { Shells } from './fx/shells';
import { GameAudio } from './audio/gameaudio';
import { BEET_DEFAULTS, type EnemyDef } from './enemy/def';
import { Enemies } from './enemy/manager';
import type { Enemy } from './enemy/enemy';
import { TuningPanel } from './ui/panel';
import { DebugHud } from './ui/hud';
import { Crosshair } from './ui/crosshair';

/** Last shot's result, for the debug readout. */
export interface HitInfo {
  object: string;
  surface: string;
  region: string;
  point: number[];
  normal: number[];
  distance: number;
  damage: number;
  pierced: number;
}

/**
 * The game layer (G1): owns the fixed simulation clock and wires gameplay
 * systems into the runtime's frame hook. Engine systems (renderer, world,
 * collision, input, controller) stay generic; tuning lives in public/game/.
 */
export class Game {
  readonly clock = new FixedClock(120);
  readonly playerConfig = new ConfigFile<PlayerTuning>('player', PLAYER_DEFAULTS);
  readonly weaponConfig = new ConfigFile<WeaponDef>('weapons/carbine', CARBINE_DEFAULTS);
  readonly enemyConfig = new ConfigFile<EnemyDef>('enemies/beet', BEET_DEFAULTS);
  readonly debug: DebugDraw;
  readonly pulses = new LightPulses();
  readonly hitscan: Hitscan;
  readonly weapon: Firearm;
  readonly viewmodel: Viewmodel;
  readonly recoil: Recoil;
  readonly shells: Shells;
  readonly audio: GameAudio;
  readonly enemies: Enemies;
  /** Draw enemy hit capsules. */
  showHitboxes = false;
  impacts!: ImpactFx;
  private impactTable: ImpactTable = { fallback: 'concrete', surfaces: {} };
  panel: TuningPanel | null = null;
  hud: DebugHud | null = null;
  crosshair: Crosshair | null = null;
  /** Draw shot traces, normals and hit points. */
  showTraces = false;
  lastHit: HitInfo | null = null;
  /** Called before every tick with the simulated time (scripted tests drive input here). */
  beforeTick: ((t: number) => void) | null = null;
  /** Real-time duration of the last frame's simulation work (ms). */
  simMs = 0;
  /** Frame-independent mode for tests (no frame-length-dependent scheduling). */
  deterministic = false;
  private muzzle: [number, number, number] = [0, 0, 0];

  constructor(readonly rt: Runtime) {
    this.debug = new DebugDraw(rt.renderer);
    this.hitscan = new Hitscan(() => rt.world.collision);
    this.weapon = new Firearm(this.weaponConfig.data, this.hitscan);
    this.viewmodel = new Viewmodel(rt.renderer, rt.world, rt.camera, this.pulses, this.weaponConfig.data);
    this.recoil = new Recoil(this.weaponConfig.data);
    this.shells = new Shells(rt.renderer, rt.world, () => rt.world.collision);
    this.audio = new GameAudio(() => this.impactTable);
    this.enemies = new Enemies(rt.renderer, rt.world, this.hitscan, this.enemyConfig.data);
  }

  async init(opts: { panel?: HTMLElement } = {}) {
    const { rt } = this;
    const impacts = fetch('/game/impacts.json', { cache: 'no-store' }).then((r) => r.json() as Promise<ImpactTable>);
    await Promise.all([this.playerConfig.load(), this.weaponConfig.load(), this.enemyConfig.load(), this.viewmodel.load(), this.shells.load(), this.audio.init(rt.gpu.canvas)]);
    await this.enemies.load();
    this.impactTable = await impacts;
    this.impacts = new ImpactFx(this.impactTable, rt.world, rt.renderer.particles, this.pulses);
    const decalMats = Object.values(this.impactTable.surfaces).map((e) => e.decal).filter((d): d is string => !!d);
    await rt.world.addRuntimeDecalMaterials(decalMats);
    rt.player.tuning = this.playerConfig.data;
    rt.sandbox.ownsParticles = false;
    rt.world.ensureCollision();
    this.weapon.onShot.push((e) => this.onShot(e));
    this.weapon.onDryFire.push(() => this.audio.play('carbine_dry'));
    rt.player.onLand.push((speed, surface) => {
      this.viewmodel.land(speed);
      this.audio.land(surface, rt.player.feet, speed);
    });
    rt.player.onStep.push((surface, speed) => this.audio.step(surface, rt.player.feet, speed, rt.player.tuning.runSpeed, rt.player.stance === 'crouch'));
    this.viewmodel.onEject.push((port, right, up, fwd) => {
      const v = rt.player.velocity, j = () => Math.random() * 2 - 1;
      const sr = 2.4 + Math.random() * 0.9, su = 1.3 + Math.random() * 0.7, sb = 0.4 + Math.random() * 0.4;
      this.shells.eject(port,
        [right[0] * sr + up[0] * su - fwd[0] * sb + v[0], right[1] * sr + up[1] * su - fwd[1] * sb + v[1], right[2] * sr + up[2] * su - fwd[2] * sb + v[2]],
        fwd, [up[0] * 25 + j() * 6, up[1] * 25 + j() * 6, up[2] * 25 + j() * 6]);
    });
    this.shells.onBounce.push((pos, speed, surface, bounce) => this.audio.brass(surface, pos, speed, bounce));
    this.enemies.onSpawn.push((e) => e.onStrike.push((en) => this.onStrike(en)));
    if (opts.panel) {
      this.panel = new TuningPanel(this, opts.panel);
      this.hud = new DebugHud(this);
      this.crosshair = new Crosshair();
      document.getElementById('crosshair')?.remove();
    }
    const sp = rt.world.spawn();
    rt.player.teleport(sp.position, sp.yaw, sp.pitch);
    this.enemies.spawn(rt.player);
  }

  /** An enemy's swing connected: the player feels it (view kick, thud). */
  private onStrike(e: Enemy) {
    const { camera, player } = this.rt;
    const dx = player.feet[0] - e.feet[0], dz = player.feet[2] - e.feet[2], l = Math.hypot(dx, dz) || 1;
    // Knock the view away from the blow and shove the player.
    const side = (dx / l) * Math.cos(camera.yaw) + (dz / l) * Math.sin(camera.yaw);
    this.recoil.kickView(-4, side * 6, side * 5);
    player.velocity[0] += (dx / l) * 3.5;
    player.velocity[2] += (dz / l) * 3.5;
    this.audio.play('impact_flesh', { pos: camera.position, gain: 3, pitch: 0.7 });
  }

  private onShot(e: ShotEvent) {
    this.recoil.onShot(e.burstIndex);
    this.viewmodel.onShot(e);
    const st = this.audio.shotTime(e.time, this.weapon.interval);
    const at = st.at;
    if (!st.scheduled) this.audio.play('carbine_shot', { at });
    const muzzle = this.viewmodel.muzzle(this.muzzle);
    let end: number[] = [e.origin[0] + e.dir[0] * 300, e.origin[1] + e.dir[1] * 300, e.origin[2] + e.dir[2] * 300];
    for (let i = 0; i < e.hitCount; i++) {
      const h = e.hits[i];
      if (h.kind === 'target') {
        const en = h.target as Enemy;
        const reg = en.def.regions[h.region] ?? { damage: 1, stagger: 1 };
        const dmg = h.damage * reg.damage;
        h.damage = dmg;
        const killed = en.hit(dmg, h.region, h.point, e.dir, this.weapon.def.fire.impactForce, h.part || 'body');
        this.impacts.playSurface('flesh', h.point, h.normal, e.dir, false);
        this.audio.play('impact_flesh', { pos: h.point, at: at + h.t / 900, gain: killed ? 3 : 0 });
        this.crosshair?.confirm(killed);
      }
      if (h.kind === 'world') {
        this.impacts.play(h, e.dir);
        // Bullet flight (~900 m/s) before the impact is heard.
        this.audio.impact(h.surface, h.point, at + h.t / 900);
      }
      if (this.showTraces) {
        this.debug.cross(h.point, 0.08, h.pierced ? [0.6, 0.9, 1, 1] : [1, 0.9, 0.2, 1], 4);
        this.debug.line(h.point, [h.point[0] + h.normal[0] * 0.3, h.point[1] + h.normal[1] * 0.3, h.point[2] + h.normal[2] * 0.3], [0.3, 0.5, 1, 1], 4);
      }
      if (i === e.hitCount - 1) end = h.point;
    }
    if (this.showTraces) {
      this.debug.line(e.origin, end, e.hitCount ? [0.2, 1, 0.4, 1] : [1, 0.25, 0.2, 1], 4);
      this.debug.line(muzzle, end, [1, 1, 1, 0.35], 4);
    }
    const h = e.hitCount ? e.hits[e.hitCount - 1] : null;
    this.lastHit = h && {
      object: h.owner, surface: surfaceName(h.surface), region: h.region, point: [...h.point], normal: [...h.normal],
      distance: h.t, damage: h.damage, pierced: e.hitCount - 1,
    };
  }

  /** Runtime frame hook: look, fixed ticks for gameplay, then per-frame presentation. */
  update = (dt: number) => {
    const t0 = performance.now();
    const { player, input, world, sandbox, camera, renderer } = this.rt;
    const look = player.look();
    this.recoil.absorb(look[0], look[1], camera);
    const armed = input.locked || input.scripted;
    player.sprintBlocked = false;
    this.weapon.aimOffset[0] = this.recoil.aimP;
    this.weapon.aimOffset[1] = this.recoil.aimY;
    this.weapon.pressNow(this.clock.timeAfter(dt), input, player, camera, armed);
    const alpha = this.clock.advance(dt, (h, t) => {
      this.beforeTick?.(t);
      player.sprintBlocked = false;
      this.weapon.aimOffset[0] = this.recoil.aimP;
      this.weapon.aimOffset[1] = this.recoil.aimY;
      this.weapon.tick(h, t, input, player, camera, armed);
      this.recoil.tick(h, camera);
      player.tick(h);
      this.enemies.tick(h, player);
      input.endTick();
    });
    const sdt = dt * this.clock.timeScale;
    const now = this.clock.time + alpha * this.clock.step;
    player.frame(sdt, alpha);
    this.enemies.pose(sdt, alpha, player);
    if (this.showHitboxes) this.drawHitboxes();
    this.recoil.frame(sdt, alpha, camera);
    world.update(sdt, player.feet);
    sandbox.update(sdt);
    this.viewmodel.update(sdt, now, look, player, armed && input.buttonDown(0), this.weapon.interval);
    this.shells.update(sdt);
    this.audio.frame(dt, camera, world.collision);
    // Exact burst cadence: the next shot's sound is scheduled ~a frame ahead and the shot committed
    // (off in the deterministic frame-rate test, where release timing must not depend on frame length).
    const c = this.deterministic ? null : this.audio.scheduleAhead(this.weapon.willContinue(armed && input.buttonDown(0)), this.weapon.nextShot, now);
    if (c !== null) this.weapon.committedUntil = c;
    renderer.particles.update(sdt);
    this.pulses.update(sdt, renderer.dynamicLights);
    world.flushRuntimeDecals(camera.position);
    this.debug.flush();
    this.crosshair?.update(sdt, this.weapon.spread(player), camera.fovY, this.rt.gpu.canvas.clientHeight || window.innerHeight, this.recoil.punch);
    this.simMs = performance.now() - t0;
    this.hud?.update();
  };

  private drawHitboxes() {
    for (const en of this.enemies.list) {
      const C = en.capsules();
      for (let i = 0; i < C.length; i += 7) {
        const col: [number, number, number, number] = en.alive ? [1, 0.4, 0.2, 1] : [0.5, 0.5, 0.5, 1];
        this.debug.line([C[i], C[i + 1], C[i + 2]], [C[i + 3], C[i + 4], C[i + 5]], col, 0);
        this.debug.cross([C[i], C[i + 1], C[i + 2]], C[i + 6] * 2, col, 0);
        this.debug.cross([C[i + 3], C[i + 4], C[i + 5]], C[i + 6] * 2, col, 0);
      }
    }
  }

  /** Clears runtime effects (decals, traces, lights). */
  resetEffects() {
    this.rt.world.clearRuntimeDecals();
    this.shells.clear();
    this.debug.clear();
    this.pulses.clear();
  }

  /**
   * Frame-rate independence check: replays a scripted input sequence (in
   * simulated time) at several frame rates and compares the player's state at
   * common sample times, plus the shot count and shot times of held fire.
   * Returns the max deviation per rate (m).
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
      input.setButton(0, (t >= 0.2 && t < 1.0) || (t >= 3.0 && t < 3.01));
    };
    const runs: Record<number, { samples: { t: number; p: number[] }[]; shots: number[] }> = {};
    input.scripted = true;
    this.deterministic = true;
    const decals = this.impacts.decals;
    this.impacts.decals = false;
    const onShot = (e: ShotEvent) => run.shots.push(e.time);
    let run = { samples: [] as { t: number; p: number[] }[], shots: [] as number[] };
    this.weapon.onShot.push(onShot);
    try {
      for (const fps of rates) {
        input.clear();
        player.fly = false;
        player.teleport(start.feet, start.yaw, 0);
        this.weapon.reset();
        this.recoil.reset(camera);
        this.viewmodel.reset();
        this.clock.reset();
        const k0 = this.clock.ticks, t0 = this.clock.time;
        run = { samples: [], shots: [] };
        this.beforeTick = () => {
          const k = this.clock.ticks - k0, lt = k / this.clock.hz;
          script(lt);
          // Sample tick state at 0.1 s marks (identical tick times at every frame rate).
          if (k % 12 === 0) run.samples.push({ t: +lt.toFixed(3), p: [...player.feet] });
        };
        const frames = Math.round(seconds * fps);
        for (let i = 0; i < frames; i++) this.update(1 / fps);
        run.shots = run.shots.map((s) => +(s - t0).toFixed(5));
        runs[fps] = run;
      }
    } finally {
      this.deterministic = false;
      this.beforeTick = null;
      this.weapon.onShot.splice(this.weapon.onShot.indexOf(onShot), 1);
      this.impacts.decals = decals;
      input.scripted = false;
      input.clear();
      this.weapon.reset();
      player.teleport(start.feet, start.yaw, 0);
    }
    const ref = runs[rates[0]];
    const result: Record<string, number> = {};
    const shots: Record<string, number> = {};
    for (const fps of rates) {
      let dev = 0;
      const s = runs[fps].samples;
      for (let i = 0; i < Math.min(ref.samples.length, s.length); i++) dev = Math.max(dev, Math.hypot(ref.samples[i].p[0] - s[i].p[0], ref.samples[i].p[1] - s[i].p[1], ref.samples[i].p[2] - s[i].p[2]));
      result[`${fps}fps`] = +dev.toExponential(2);
      shots[`${fps}fps`] = runs[fps].shots.length + (JSON.stringify(runs[fps].shots) === JSON.stringify(ref.shots) ? '' : ' (times differ)') as unknown as number;
    }
    const end = ref.samples[ref.samples.length - 1];
    return { maxDeviation: result, shots, firstShotTimes: ref.shots.slice(0, 4), samples: ref.samples.length, travelled: +Math.hypot(end.p[0] - start.feet[0], end.p[2] - start.feet[2]).toFixed(3) };
  }
}
