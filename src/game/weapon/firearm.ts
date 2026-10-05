import type { Camera } from '../../engine/scene/camera';
import type { Input } from '../../engine/input/input';
import type { FirstPersonController } from '../../engine/player/controller';
import type { Hitscan, ShotHit } from '../combat/hitscan';
import type { WeaponDef } from './def';

/** One fired round. The object is reused: listeners copy what they keep. */
export interface ShotEvent {
  /** Rounds fired since load, and within the current trigger pull (0 = first shot). */
  index: number;
  burstIndex: number;
  /** Simulated time of the shot (exact cadence, between tick boundaries). */
  time: number;
  /** Seconds from the shot to the end of the tick it was fired in (lets effects catch up exactly). */
  lag: number;
  origin: [number, number, number];
  dir: [number, number, number];
  /** Cone half-angle used (degrees). */
  spread: number;
  hits: ShotHit[];
  hitCount: number;
  /** Trigger press → shot processed (ms), for the first shot of a pull; -1 otherwise. */
  latencyMs: number;
}

/**
 * Firearm logic: trigger, cadence, magazine, spread, hitscan. Shots happen at
 * exact times derived from the rate of fire (several per tick if needed), so
 * the rhythm is identical at any frame rate. The trigger never waits for an
 * animation: a press fires on the next tick. Presentation (viewmodel,
 * effects, audio) listens to `onShot`.
 */
export class Firearm {
  ammo: number;
  reloading = 0;
  /** Accumulated bloom (degrees). */
  bloom = 0;
  shots = 0;
  burst = 0;
  /** Aim displacement from recoil (pitch, yaw radians), added to the view for bullets; set by the recoil system. */
  aimOffset: [number, number] = [0, 0];
  onShot: ((e: ShotEvent) => void)[] = [];
  onDryFire: (() => void)[] = [];
  onReload: ((phase: 'start' | 'end') => void)[] = [];
  lastLatencyMs = -1;
  /** Simulated time of the next possible shot. */
  nextShot = -Infinity;
  /**
   * Shots up to this time are committed (their sound is already scheduled):
   * they fire even if the trigger is released in the last frame before them.
   */
  committedUntil = -Infinity;
  private lastShot = -Infinity;
  private sinceShot = Infinity;
  private semiQueued = false;
  private pullTime = -1;
  private seed = 0x2545f491;
  private ev: ShotEvent;

  constructor(public def: WeaponDef, private hitscan: Hitscan) {
    this.ammo = def.fire.magazine;
    this.ev = { index: 0, burstIndex: 0, time: 0, lag: 0, origin: [0, 0, 0], dir: [0, 0, -1], spread: 0, hits: hitscan.hits, hitCount: 0, latencyMs: -1 };
  }

  get interval() {
    return 60 / Math.max(1, this.def.fire.rpm);
  }

  /** Whether held fire will produce the shot at `nextShot` (auto, rounds left, not reloading). */
  willContinue(held: boolean) {
    return held && this.def.fire.mode === 'auto' && this.reloading === 0 && (this.ammo > 0 || this.def.fire.infiniteAmmo) && this.burst > 0;
  }

  /** Current cone half-angle (degrees) for the player's state. */
  spread(player: FirstPersonController): number {
    const s = this.def.spread, t = player.tuning;
    let a = s.base + this.bloom + s.moving * Math.min(1.5, player.speed / Math.max(0.1, t.runSpeed));
    if (!player.onGround && !player.fly) a += s.air;
    if (player.stance === 'crouch') a *= s.crouch;
    return a;
  }

  private rand() {
    // mulberry32: deterministic spread for replayable tests.
    let t = (this.seed = (this.seed + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * A trigger press seen at the start of a frame fires right away at the frame's
   * simulated time `now`, instead of waiting for the next tick (up to a tick of
   * latency at high frame rates). Held fire then continues on the tick cadence.
   */
  pressNow(now: number, input: Input, player: FirstPersonController, camera: Camera, enabled: boolean) {
    if (!enabled || !input.buttonPressed(0)) return;
    const f = this.def.fire;
    if (this.reloading > 0 || now < this.nextShot) return;
    this.pullTime = input.buttonPressTime(0);
    input.consumeButton(0);
    if (this.ammo <= 0 && !f.infiniteAmmo) {
      for (const g of this.onDryFire) g();
      return;
    }
    this.fire(now, now, player, camera);
    this.nextShot = now + this.interval;
    this.semiQueued = false;
  }

  tick(h: number, t: number, input: Input, player: FirstPersonController, camera: Camera, enabled: boolean) {
    const f = this.def.fire;
    const pressed = enabled && input.buttonPressed(0);
    const held = enabled && input.buttonDown(0);
    if (pressed) {
      this.pullTime = input.buttonPressTime(0);
      if (f.mode === 'semi') this.semiQueued = true;
    }
    if (enabled && input.pressed('KeyR') && !this.reloading && this.ammo < f.magazine && !f.infiniteAmmo) {
      this.reloading = f.reloadTime;
      for (const g of this.onReload) g('start');
    }
    if (this.reloading > 0) {
      this.reloading = Math.max(0, this.reloading - h);
      if (this.reloading === 0) {
        this.ammo = f.magazine;
        for (const g of this.onReload) g('end');
      }
    }
    if (!held && !pressed && t - this.lastShot > this.interval * 1.5) this.burst = 0;

    const committed = f.mode === 'auto' && this.committedUntil > -Infinity && this.nextShot <= this.committedUntil && this.nextShot < t + h;
    const wants = f.mode === 'auto' ? held || pressed || committed : this.semiQueued;
    if (wants && this.reloading === 0) {
      if (this.ammo <= 0 && !f.infiniteAmmo) {
        if (pressed) for (const g of this.onDryFire) g();
        this.semiQueued = false;
      } else {
        let shotT = Math.max(this.nextShot, t);
        while (shotT < t + h && (this.ammo > 0 || f.infiniteAmmo)) {
          this.fire(shotT, t + h, player, camera);
          this.nextShot = shotT + this.interval;
          this.semiQueued = false;
          // A tap shorter than a tick fires exactly one round.
          if (this.nextShot > this.committedUntil) this.committedUntil = -Infinity;
          if (f.mode === 'semi' || (!held && this.committedUntil === -Infinity)) break;
          shotT = this.nextShot;
        }
      }
    }
    if (held || this.sinceShot < f.sprintBlock) player.sprintBlocked = true;

    this.sinceShot += h;
    if (this.sinceShot > this.def.spread.recoveryDelay) this.bloom = Math.max(0, this.bloom - this.def.spread.recovery * h);
  }

  private fire(time: number, tickEnd: number, player: FirstPersonController, camera: Camera) {
    const f = this.def.fire, s = this.def.spread, e = this.ev;
    // Origin and aim: what the player sees (rendered eye, current view + recoil aim displacement).
    const pitch = camera.pitch + this.aimOffset[0], yaw = camera.yaw + this.aimOffset[1];
    const cp = Math.cos(pitch);
    let dx = Math.sin(yaw) * cp, dy = Math.sin(pitch), dz = -Math.cos(yaw) * cp;
    const spread = this.spread(player);
    if (spread > 0) {
      // Cone sample biased towards the centre (readable groups, rare flyers).
      const r = ((spread * Math.PI) / 180) * Math.pow(this.rand(), 0.75), th = this.rand() * Math.PI * 2;
      const rx = Math.cos(yaw), rz = Math.sin(yaw);
      const ux = -Math.sin(yaw) * Math.sin(pitch), uy = cp, uz = Math.cos(yaw) * Math.sin(pitch);
      const a = Math.sin(r) * Math.cos(th), b = Math.sin(r) * Math.sin(th), c = Math.cos(r);
      dx = dx * c + rx * a + ux * b; dy = dy * c + uy * b; dz = dz * c + rz * a + uz * b;
      const l = Math.hypot(dx, dy, dz);
      dx /= l; dy /= l; dz /= l;
    }
    e.origin[0] = camera.position[0]; e.origin[1] = camera.position[1]; e.origin[2] = camera.position[2];
    e.dir[0] = dx; e.dir[1] = dy; e.dir[2] = dz;
    e.hitCount = this.hitscan.trace(e.origin, e.dir, f.range, f.pierceGlass);
    for (let i = 0; i < e.hitCount; i++) {
      const h = e.hits[i];
      const k = Math.max(0, Math.min(1, (h.t - f.falloffStart) / Math.max(1e-3, f.falloffEnd - f.falloffStart)));
      h.damage = h.pierced ? 0 : f.damage * (1 - k * (1 - f.falloffMin));
    }
    e.index = this.shots++;
    e.burstIndex = this.burst++;
    e.time = time;
    e.lag = tickEnd - time;
    e.spread = spread;
    e.latencyMs = -1;
    if (this.pullTime >= 0) {
      e.latencyMs = this.lastLatencyMs = performance.now() - this.pullTime;
      this.pullTime = -1;
    }
    if (!f.infiniteAmmo) this.ammo--;
    this.bloom = Math.min(s.max, this.bloom + s.perShot);
    this.sinceShot = 0;
    this.lastShot = time;
    for (const g of this.onShot) g(e);
  }

  reset() {
    this.seed = 0x2545f491;
    this.ammo = this.def.fire.magazine;
    this.reloading = 0;
    this.bloom = 0;
    this.burst = 0;
    this.nextShot = this.lastShot = this.committedUntil = -Infinity;
    this.sinceShot = Infinity;
    this.semiQueued = false;
  }
}
