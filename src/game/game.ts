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
import { Debris } from '../engine/physics/debris';
import type { MarkerObject } from '../engine/scene/mapformat';
import { TOMATO_DEFAULTS, type TomatoDef } from './horde/def';
import { Horde } from './horde/horde';
import { TomatoGore, GORE_DECALS } from './horde/gore';
import { Vitals } from './player/vitals';
import { HealthIndicator } from './ui/health';
import type { Tomato } from './horde/tomato';
import { DamageFlash } from './ui/damage';
import { ScreenGore } from './ui/screengore';
import { TuningPanel } from './ui/panel';
import { DebugHud } from './ui/hud';
import { Crosshair } from './ui/crosshair';
import { RecoilPlot } from './ui/recoilplot';
import { AmmoIndicator } from './ui/ammo';

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
  readonly hordeConfig = new ConfigFile<TomatoDef>('enemies/tomato', TOMATO_DEFAULTS);
  readonly debug: DebugDraw;
  readonly pulses = new LightPulses();
  readonly hitscan: Hitscan;
  readonly weapon: Firearm;
  readonly viewmodel: Viewmodel;
  readonly recoil: Recoil;
  readonly shells: Shells;
  readonly audio: GameAudio;
  readonly horde: Horde;
  debris!: Debris;
  gore!: TomatoGore;
  /** Draw tomato hit shapes. */
  showHitboxes = false;
  /** Seconds until the next respawn while below `horde.maxAlive`. */
  private respawnT = 1;
  damage: DamageFlash | null = null;
  readonly vitals = new Vitals();
  health: HealthIndicator | null = null;
  /** This run: tomatoes killed, seconds survived. */
  kills = 0;
  runTime = 0;
  /** Where the run started (a restart puts the player back there). */
  private start = { pos: [0, 0, 0] as [number, number, number], yaw: 0, pitch: 0 };
  private wasEnabled = true;
  private restartWanted = false;
  screenGore: ScreenGore | null = null;
  impacts!: ImpactFx;
  private impactTable: ImpactTable = { fallback: 'concrete', surfaces: {} };
  panel: TuningPanel | null = null;
  hud: DebugHud | null = null;
  crosshair: Crosshair | null = null;
  recoilPlot: RecoilPlot | null = null;
  ammo: AmmoIndicator | null = null;
  private reloadState = { t: 0, empty: false };
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
  private tracerFrom: [number, number, number] = [0, 0, 0];
  private tracerCount = 0;

  constructor(readonly rt: Runtime) {
    this.debug = new DebugDraw(rt.renderer);
    this.hitscan = new Hitscan(() => rt.world.collision);
    this.weapon = new Firearm(this.weaponConfig.data, this.hitscan);
    this.viewmodel = new Viewmodel(rt.renderer, rt.world, rt.camera, this.pulses, this.weaponConfig.data);
    this.recoil = new Recoil(this.weaponConfig.data);
    this.shells = new Shells(rt.renderer, rt.world, () => rt.world.collision);
    this.audio = new GameAudio(() => this.impactTable);
    this.horde = new Horde(rt.renderer, rt.world, this.hordeConfig.data);
    this.hitscan.targets.push(this.horde);
  }

  async init(opts: { panel?: HTMLElement; overlay?: HTMLElement } = {}) {
    const { rt } = this;
    const impacts = fetch('/game/impacts.json', { cache: 'no-store' }).then((r) => r.json() as Promise<ImpactTable>);
    await Promise.all([this.playerConfig.load(), this.weaponConfig.load(), this.hordeConfig.load(), this.viewmodel.load(), this.shells.load(), this.audio.init(rt.gpu.canvas)]);
    this.horde.def = this.hordeConfig.data;
    await this.horde.load();
    this.debris = new Debris(rt.renderer, rt.world.renderables, () => rt.world.collision, this.horde.model.any, 360);
    this.gore = new TomatoGore(rt.world, rt.renderer.particles, this.debris, this.audio, this.horde.model, this.hordeConfig.data);
    this.impactTable = await impacts;
    this.impacts = new ImpactFx(this.impactTable, rt.world, rt.renderer.particles, this.pulses);
    const decalMats = [...Object.values(this.impactTable.surfaces).map((e) => e.decal), ...GORE_DECALS].filter((d): d is string => !!d);
    await rt.world.addRuntimeDecalMaterials(decalMats);
    rt.player.tuning = this.playerConfig.data;
    rt.sandbox.ownsParticles = false;
    rt.world.ensureCollision();
    this.weapon.onShot.push((e) => this.onShot(e));
    this.weapon.onDryFire.push(() => this.audio.play('carbine_dry'));
    this.weapon.onReload.push((phase) => {
      this.viewmodel.reloadEvent(phase);
      if (phase !== 'start' && phase !== 'end') this.audio.play(`carbine_${phase}`);
      // The hard beats knock the view too.
      const P = this.weapon.def.fx.reloadPunch, j = (Math.random() - 0.5) * P * 0.6;
      if (phase === 'magout') this.recoil.kickView(-P * 0.3, j * 0.5, 0);
      if (phase === 'magin') this.recoil.kickView(P * 0.7, j, P * 0.9);
      if (phase === 'release') this.recoil.kickView(-P * 0.5, j, -P * 0.7);
    });
    rt.player.onLand.push((speed, surface) => {
      this.viewmodel.land(speed);
      this.audio.land(surface, rt.player.feet, speed);
    });
    rt.player.onStep.push((surface, speed) => this.audio.step(surface, rt.player.feet, speed, rt.player.tuning.runSpeed, rt.player.stance === 'crouch'));
    this.viewmodel.onEject.push((port, right, up, fwd) => {
      // Up and a little forward out of the port: the case arcs through the upper right of the view.
      const fx = this.weapon.def.fx, v = rt.player.velocity, j = () => Math.random() * 2 - 1, q = () => 1 + j() * fx.ejectRandom;
      const sr = fx.ejectRight * q(), su = fx.ejectUp * q(), sf = fx.ejectForward * q(), w = fx.ejectSpin * q();
      this.shells.scale = fx.brassScale;
      this.shells.life = fx.brassLife;
      this.shells.eject(port,
        [right[0] * sr + up[0] * su + fwd[0] * sf + v[0], right[1] * sr + up[1] * su + fwd[1] * sf + v[1], right[2] * sr + up[2] * su + fwd[2] * sf + v[2]],
        fwd, [up[0] * w + j() * 6, up[1] * w + j() * 6, up[2] * w + j() * 6]);
    });
    this.shells.onBounce.push((pos, speed, surface, bounce) => this.audio.brass(surface, pos, speed, bounce));
    this.horde.onKill.push((t, point, dir, impulse) => this.onTomatoKill(t, point, dir, impulse));
    this.horde.onLeg.push((t, i, point, dir) => this.gore.legOff(t, i, point, dir));
    this.horde.onBite.push((t) => this.onBite(t));
    if (opts.panel) this.panel = new TuningPanel(this, opts.panel);
    // Overlays (crosshair, readout, recoil plot) centre on `overlay` (positioned), default the page.
    const overlay = opts.overlay ?? document.body;
    this.hud = new DebugHud(this, overlay);
    this.crosshair = new Crosshair(overlay);
    this.recoilPlot = new RecoilPlot(overlay);
    this.ammo = new AmmoIndicator(overlay);
    this.damage = new DamageFlash(overlay);
    this.screenGore = new ScreenGore(overlay);
    this.health = new HealthIndicator(overlay);
    document.getElementById('crosshair')?.remove();
    this.ready = true;
  }

  /** Loaded and initialised (`init` finished). */
  ready = false;
  /** A play session is running (enemies, effects). */
  active = false;

  /**
   * Starts a play session: optional teleport to the map's player start, an
   * enemy at a spawn marker, the weapon shown.
   */
  begin(opts: { toSpawn?: boolean } = {}) {
    const { rt } = this;
    if (opts.toSpawn) {
      const sp = rt.world.spawn();
      rt.player.fly = false;
      rt.player.teleport(sp.position, sp.yaw, sp.pitch);
    }
    rt.world.ensureCollision();
    this.weapon.reset();
    this.recoil.reset(rt.camera);
    this.viewmodel.reset();
    this.viewmodel.visible = true;
    this.clock.reset();
    // Gun smoke and impact dust drift with only part of the map's wind (restored in end()).
    rt.renderer.particles.airScale = this.impactTable.wind ?? 1;
    this.horde.clear();
    this.horde.begin(rt.player.feet);
    this.respawnT = 1;
    this.group.left = 0;
    this.vitals.reset();
    this.kills = 0;
    this.runTime = 0;
    this.restartWanted = false;
    this.start.pos = [...rt.player.feet] as [number, number, number];
    this.start.yaw = (rt.camera.yaw * 180) / Math.PI;
    this.start.pitch = (rt.camera.pitch * 180) / Math.PI;
    if (this.crosshair) this.crosshair.visible = true;
    if (this.hud) this.hud.el.style.visibility = '';
    this.active = true;
  }

  /** Ends the session: enemies, casings, decals, traces, lights cleared; the gun hidden. */
  end() {
    const { rt } = this;
    this.active = false;
    if (this.vitals.dead) rt.camera.roll = 0;
    this.vitals.reset();
    this.horde.clear();
    this.resetEffects();
    this.viewmodel.hide();
    this.recoil.reset(rt.camera);
    rt.renderer.dynamicLights = [];
    rt.renderer.particles.airScale = 1;
    if (this.crosshair) { this.crosshair.visible = false; this.crosshair.el.style.display = 'none'; }
    if (this.hud) this.hud.el.style.visibility = 'hidden';
    if (this.recoilPlot) this.recoilPlot.el.style.display = 'none';
  }

  /** Spawn points: `enemy_spawn` markers, else 14 m in front of the map's player start. */
  spawnPoints(): { position: [number, number, number]; yaw: number }[] {
    const W = this.rt.world;
    const m = W.doc.entities.filter((e): e is MarkerObject => e.type === 'marker' && e.semantic === 'enemy_spawn');
    if (m.length) return m.map((e) => ({ position: [...e.transform.position] as [number, number, number], yaw: e.yaw ?? 0 }));
    const s = W.spawn(), a = (s.yaw * Math.PI) / 180;
    return [{ position: [s.position[0] + Math.sin(a) * 14, s.position[1], s.position[2] - Math.cos(a) * 14], yaw: s.yaw + 180 }];
  }

  /** Spawns a tomato at `at` (ground point), or somewhere out of sight around the player, else at the spawn point farthest away. */
  spawnTomato(at?: ArrayLike<number>) {
    const { player, camera } = this.rt;
    let pos: ArrayLike<number> | undefined = at, yaw = 0;
    if (!pos && this.horde.findSpawn(player.feet, camera.position, camera.forward, this.spawnPath[0], this.spawnPath[1], this.spawnAt)) pos = this.spawnAt;
    if (!pos) {
      let bd = -1;
      for (const p of this.spawnPoints()) {
        const d = Math.hypot(p.position[0] - player.feet[0], p.position[2] - player.feet[2]);
        if (d > bd) { bd = d; pos = p.position; yaw = (p.yaw * Math.PI) / 180; }
      }
    } else {
      yaw = Math.atan2(player.feet[0] - pos[0], -(player.feet[2] - pos[2]));
    }
    const g = this.rt.world.collision.groundHeight(pos![0], pos![1] + 1, pos![2], 4);
    return this.horde.spawn([pos![0], g > -Infinity ? g : pos![1], pos![2]], yaw);
  }

  /** Path distance (m) from the player that tomatoes are brought in at. */
  spawnPath: [number, number] = [22, 42];
  /** Tomatoes come in packs of this many, a pack every so often while below `horde.maxAlive`. */
  packSize: [number, number] = [3, 7];
  private spawnAt: [number, number, number] = [0, 0, 0];
  private group = { at: [0, 0, 0] as [number, number, number], left: 0, t: 0 };

  /** Keeps `horde.maxAlive` tomatoes coming: packs that pour out of one spot out of sight, one every 0.12 s. */
  private respawn(dt: number) {
    if (!this.active || !this.horde.enabled) return;
    const H = this.horde, G = this.group, { player, camera } = this.rt;
    if (H.alive >= H.maxAlive) { this.respawnT = Math.max(this.respawnT, 0.8); G.left = 0; return; }
    if (G.left > 0) {
      G.t -= dt;
      if (G.t <= 0) {
        G.t = 0.12;
        G.left--;
        const a = Math.random() * Math.PI * 2, r = Math.random() * 1.2;
        const p = [G.at[0] + Math.cos(a) * r, G.at[1], G.at[2] + Math.sin(a) * r];
        H.spawn(p, Math.atan2(player.feet[0] - p[0], -(player.feet[2] - p[2])));
      }
      return;
    }
    this.respawnT -= dt;
    if (this.respawnT > 0) return;
    if (H.findSpawn(player.feet, camera.position, camera.forward, this.spawnPath[0], this.spawnPath[1], G.at)) {
      const [a, b] = this.packSize;
      G.left = Math.min(H.maxAlive - H.alive, a + Math.floor(Math.random() * (b - a + 1)));
      G.t = 0;
      this.respawnT = 1.5 + Math.random() * 2;
    } else {
      this.respawnT = 0.3;
    }
  }

  private hissT = new Float32Array(160);

  /**
   * Thorn feet ticking on the ground near the player, and the odd hiss from the ones closing in.
   * A pack would fire dozens a frame: only a few steps per frame and a few hisses at once (the
   * nearest feet win; the rest of the crowd is the same sound anyway).
   */
  private hordeSounds(dt: number) {
    const cam = this.rt.camera.position;
    let steps = 0, hisses = 0;
    for (const t of this.horde.list) {
      if (!t.alive) { t.planted = 0; continue; }
      const d = Math.hypot(t.shown[0] - cam[0], t.shown[1] - cam[1], t.shown[2] - cam[2]);
      if (t.planted > 0) {
        if (d < 14 && steps < 3 && (d < 5 || Math.random() < 3 / (1 + this.horde.alive * 0.25))) { this.audio.play('tomato_step', { pos: t.shown, pitch: t.voice }); steps++; }
        t.planted = 0;
      }
      const i = t.index % this.hissT.length;
      this.hissT[i] -= dt;
      if (d < 12 && this.hissT[i] <= 0 && t.state === 'chase') {
        this.hissT[i] = 2.5 + Math.random() * 4 + this.horde.alive * 0.15;
        if (Math.random() < 0.6 && hisses < 1) { this.audio.play('tomato_hiss', { pos: t.shown, pitch: t.voice }); hisses++; }
      }
    }
  }

  /** A tomato burst: gore, a shake when it is close, the kill confirm on the crosshair. */
  private onTomatoKill(t: Tomato, point: ArrayLike<number> | null, dir: ArrayLike<number> | null, impulse: number) {
    this.gore.burst(t, point, dir, impulse);
    if (!this.vitals.dead) this.kills++;
    const { camera } = this.rt;
    const d = Math.hypot(t.shown[0] - camera.position[0], t.shown[1] - camera.position[1], t.shown[2] - camera.position[2]);
    const G = this.hordeConfig.data.gore;
    const k = G.shake / Math.max(1, d);
    if (k > 0.05) this.recoil.kickView(k * (Math.random() - 0.3), k * (Math.random() - 0.5), k * (Math.random() - 0.5) * 1.5);
    // Close and in front: it splatters the screen.
    if (d < G.screenDistance && this.screenGore) {
      const m = camera.viewProj, p = t.shown;
      const cw = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
      if (cw > 0.1) {
        const sx = ((m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / cw) * 0.5 + 0.5;
        const sy = 0.5 - ((m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / cw) * 0.5;
        if (sx > -0.3 && sx < 1.3 && sy > -0.3 && sy < 1.3) this.screenGore.splash(1 - d / G.screenDistance, Math.min(0.95, Math.max(0.05, sx)), Math.min(0.9, Math.max(0.1, sy)));
      }
    }
  }

  /** A bite connected: the view is knocked away from it, the player shoved, a red flash, a crunch. */
  private onBite(t: Tomato) {
    const { camera, player } = this.rt;
    const dx = player.feet[0] - t.pos[0], dz = player.feet[2] - t.pos[2], l = Math.hypot(dx, dz) || 1;
    const side = (dx / l) * Math.cos(camera.yaw) + (dz / l) * Math.sin(camera.yaw);
    this.recoil.kickView(-3.5, side * 5, side * 6);
    player.velocity[0] += (dx / l) * 3;
    player.velocity[2] += (dz / l) * 3;
    this.damage?.hit(this.hordeConfig.data.attack.damage, dx / l, dz / l, camera.yaw);
    this.audio.play('tomato_bite', { pos: t.shown, gain: 3, pitch: t.voice });
    if (this.vitals.damage(this.hordeConfig.data.attack.damage)) this.die();
  }

  /** Overrun: the view drops to the ground, the gun goes, the horde keeps at it. */
  private die() {
    const { player } = this.rt;
    this.wasEnabled = player.enabled;
    player.enabled = false;
    player.velocity[0] = player.velocity[2] = 0;
    this.viewmodel.visible = false;
    this.screenGore?.splash(1, 0.5, 0.45);
    this.recoil.kickView(-6, (Math.random() - 0.5) * 8, 10);
  }

  /** Go again from where the run started: a clean slate. */
  restart() {
    const { rt } = this;
    this.horde.clear();
    this.resetEffects();
    rt.player.enabled = this.wasEnabled;
    rt.player.fly = false;
    rt.player.teleport(this.start.pos, this.start.yaw, this.start.pitch);
    rt.camera.roll = 0;
    this.weapon.reset();
    this.recoil.reset(rt.camera);
    this.viewmodel.reset();
    this.viewmodel.visible = true;
    this.horde.begin(rt.player.feet);
    this.respawnT = 1;
    this.group.left = 0;
    this.vitals.reset();
    this.kills = 0;
    this.runTime = 0;
    this.restartWanted = false;
  }

  private onShot(e: ShotEvent) {
    this.recoilPlot?.shot(e, this.rt.camera.yaw, this.rt.camera.pitch);
    this.recoil.onShot(e.burstIndex);
    this.viewmodel.onShot(e);
    const st = this.audio.shotTime(e.time, this.weapon.interval);
    const at = st.at;
    if (!st.scheduled) this.audio.play('carbine_shot', { at });
    const muzzle = this.viewmodel.muzzle(this.muzzle);
    let end: number[] = [e.origin[0] + e.dir[0] * 300, e.origin[1] + e.dir[1] * 300, e.origin[2] + e.dir[2] * 300];
    for (let i = 0; i < e.hitCount; i++) {
      const h = e.hits[i];
      if (h.kind === 'target' && h.target === this.horde && h.index >= 0) {
        const t = this.horde.list[h.index];
        h.damage *= h.region === 'maw' ? 1.8 : h.region === 'leg' ? 0.6 : 1;
        if (t.alive) {
          this.gore.hitSpurt(t, h.point, h.normal, e.dir, h.region);
          const r = this.horde.hit(h.index, h.damage, h.point, e.dir, this.weapon.def.fire.impactForce, h.part);
          this.crosshair?.confirm(r === 'kill');
        }
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
    this.tracer(muzzle, end);
    const h = e.hitCount ? e.hits[e.hitCount - 1] : null;
    this.lastHit = h && {
      object: h.owner, surface: surfaceName(h.surface), region: h.region, point: [...h.point], normal: [...h.normal],
      distance: h.t, damage: h.damage, pierced: e.hitCount - 1,
    };
  }

  /**
   * A tracer (WeaponDef.fx) from the muzzle as seen on screen to where the round
   * ends: the streak's tail starts at the muzzle and it dies as its head reaches the hit.
   */
  private tracer(muzzle: [number, number, number], end: ArrayLike<number>) {
    const fx = this.weapon.def.fx, every = Math.round(fx.tracerEvery);
    if (every <= 0 || this.tracerCount++ % every !== 0 || !this.viewmodel.visible) return;
    const s = this.viewmodel.worldEquivalent(muzzle, this.tracerFrom);
    let dx = end[0] - s[0], dy = end[1] - s[1], dz = end[2] - s[2];
    const dist = Math.hypot(dx, dy, dz), half = Math.min(fx.tracerLength * 0.5, dist * 0.3), lead = half + 0.08;
    const travel = dist - lead - half;
    if (travel <= 0.3) return;
    dx /= dist; dy /= dist; dz /= dist;
    const P = this.rt.renderer.particles, dir: [number, number, number] = [dx, dy, dz];
    P.emit('tracer', {
      pos: [s[0] + dx * lead, s[1] + dy * lead, s[2] + dz * lead], dir, spread: 0, speed: [fx.tracerSpeed, fx.tracerSpeed],
      life: [travel / fx.tracerSpeed, travel / fx.tracerSpeed], size: [fx.tracerWidth, fx.tracerWidth], color: fx.tracerColor, emissive: fx.tracerEmissive, drag: 0, gravity: 0, length: half,
    });
    // The moving streak is metres out by the time it is first drawn, and from behind the gun the
    // muzzle end of the path is the part with screen length: one frame of beam leaving the muzzle.
    const bh = Math.min(half, dist * 0.4), bl = bh + 0.08;
    P.emit('tracer', {
      pos: [s[0] + dx * bl, s[1] + dy * bl, s[2] + dz * bl], dir, spread: 0, speed: [1, 1], fixed: true,
      life: [0.035, 0.035], size: [fx.tracerWidth, fx.tracerWidth], color: fx.tracerColor, emissive: fx.tracerEmissive, drag: 0, gravity: 0, length: bh,
    });
  }

  /** Runtime frame hook: look, fixed ticks for gameplay, then per-frame presentation. */
  update = (dt: number) => {
    const t0 = performance.now();
    const { player, input, world, sandbox, camera, renderer } = this.rt;
    const look = player.look();
    this.recoil.absorb(look[0], look[1], camera);
    const armed = (input.locked || input.scripted) && !this.vitals.dead;
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
      if (this.horde.enabled && this.active) this.horde.tick(h, { feet: player.feet, height: 1.7 });
      if (this.active) {
        this.vitals.tick(h);
        if (!this.vitals.dead) this.runTime += h;
        else if (this.vitals.deadT > 1.2 && (input.buttonPressed(0) || input.pressed('KeyR') || input.pressed('Space'))) this.restartWanted = true;
      }
      input.endTick();
    });
    const sdt = dt * this.clock.timeScale;
    const now = this.clock.time + alpha * this.clock.step;
    player.frame(sdt, alpha);
    this.horde.pose(sdt, alpha);
    this.hordeSounds(sdt);
    this.respawn(sdt);
    if (this.showHitboxes) this.drawHitboxes();
    this.recoil.frame(sdt, alpha, camera);
    if (this.restartWanted) this.restart();
    if (this.vitals.dead && this.active) {
      // Down on the ground, rolled over.
      const k = Math.min(1, this.vitals.deadT / 0.6), e = 1 - (1 - k) * (1 - k) * (1 - k);
      camera.position[1] -= e * Math.max(0, camera.position[1] - player.feet[1] - 0.3);
      camera.roll = e * 1.25;
    }
    world.update(sdt, player.feet);
    sandbox.update(sdt);
    const W = this.weapon;
    if (W.reloading) {
      this.reloadState.t = W.reloadT;
      this.reloadState.empty = W.reloadEmpty;
      this.viewmodel.reload = this.reloadState;
    } else {
      this.viewmodel.reload = null;
    }
    this.viewmodel.update(sdt, now, look, player, armed && input.buttonDown(0), this.weapon.interval);
    this.ammo?.update(sdt, W.ammo, W.def.fire.magazine, W.def.fire.infiniteAmmo, W.reloading ? { t: W.reloadT, total: W.reloadEmpty ? W.def.reload.empty : W.def.reload.tactical } : null, this.active);
    this.shells.update(sdt);
    this.debris.update(sdt);
    this.gore.viewer = camera.position;
    this.gore.update(sdt);
    this.damage?.update(sdt);
    this.health?.update(dt, this.vitals.hp, this.vitals.max, this.vitals.dead, this.vitals.deadT, this.kills, this.runTime, this.active);
    this.screenGore?.update(dt);
    this.impacts.update(sdt);
    this.audio.frame(dt, camera, world.collision);
    // Exact burst cadence: the next shot's sound is scheduled ~a frame ahead and the shot committed
    // (off in the deterministic frame-rate test, where release timing must not depend on frame length).
    const c = this.deterministic ? null : this.audio.scheduleAhead(this.weapon.willContinue(armed && input.buttonDown(0)), this.weapon.nextShot, now);
    if (c !== null) this.weapon.committedUntil = c;
    renderer.particles.update(sdt);
    // Darker scene, higher exposure: keep only part of the flash lights' extra relative brightness.
    const fx = this.weapon.def.fx, under = Math.max(0, fx.flashRefEV - renderer.currentEV);
    this.pulses.gain = Number.isFinite(under) ? Math.pow(2, -under * (1 - fx.flashDark)) : 1;
    this.pulses.update(sdt, renderer.dynamicLights);
    world.flushRuntimeDecals(camera.position);
    this.debug.flush();
    this.crosshair?.update(sdt, this.weapon.spread(player), camera.fovY, this.rt.gpu.canvas.clientHeight || window.innerHeight, this.recoil.punch);
    this.simMs = performance.now() - t0;
    this.hud?.update();
    this.recoilPlot?.update();
  };

  private drawHitboxes() {
    const A: [number, number, number] = [0, 0, 0], B: [number, number, number] = [0, 0, 0];
    for (const t of this.horde.list) {
      if (!t.alive) continue;
      const col: [number, number, number, number] = [1, 0.4, 0.2, 1];
      this.debug.cross(t.shown, this.horde.def.radius * 1.9, col, 0);
      for (let i = 0; i < 6; i++) {
        if (t.legs[i].lost) continue;
        for (const lower of [false, true]) {
          t.legSegment(i, lower, A, B);
          this.debug.line(A, B, col, 0);
        }
      }
    }
  }

  /** Clears runtime effects (decals, traces, lights). */
  resetEffects() {
    this.rt.world.clearRuntimeDecals();
    this.shells.clear();
    this.debris?.clear();
    this.gore?.clear();
    this.screenGore?.clear();
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
    // No tomatoes in the run (they are random, and a bite shoves the player).
    const hordeOn = this.horde.enabled;
    this.horde.enabled = false;
    this.horde.clear();
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
      this.horde.enabled = hordeOn;
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
