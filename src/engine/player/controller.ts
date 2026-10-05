import type { Camera } from '../scene/camera';
import type { CollisionWorld, Surface } from '../scene/collision';
import type { Input } from '../input/input';
import { CharacterMotor } from '../physics/character';
import { FixedClock } from '../core/clock';
import { approach, spring, stepSpring } from '../core/spring';

/**
 * First-person controller.
 *
 * - Look: raw pointer-lock counts, applied once per rendered frame (never
 *   smoothed, never ticked), Source-style scale (0.022° per count × sensitivity).
 * - Movement: fixed ticks (`tick`) through the capsule motor; the eye is
 *   interpolated between ticks (`frame`), so motion is identical at any frame
 *   rate. Ground: constant acceleration towards the wish velocity, with the
 *   off-axis component braked separately (crisp direction changes). Air: a
 *   little steering, momentum kept.
 * - Jump (buffered, with coyote time), crouch (hold; stands up only when the
 *   capsule fits), sprint (forward), walk.
 * - Camera feel: steps smoothed, landing dip spring, optional bob / strafe roll
 *   (off by default: the weapon carries the walk cycle).
 * - Events: footsteps (surface, speed), jumps, landings, for audio and the
 *   weapon's motion.
 * All numbers live in `tuning` (game data: public/game/player.json).
 */
export interface PlayerTuning {
  /** Degrees per mouse count = 0.022 × sensitivity (Source / CS scale). */
  sensitivity: number;
  invertY: boolean;
  /** Horizontal field of view at 16:9 (degrees). */
  fov: number;

  radius: number;
  standHeight: number;
  crouchHeight: number;
  eyeStand: number;
  eyeCrouch: number;
  stepHeight: number;
  maxSlope: number;

  runSpeed: number;
  sprintSpeed: number;
  walkSpeed: number;
  crouchSpeed: number;
  /** m/s² towards the wish speed / braking (ground). */
  groundAccel: number;
  groundDecel: number;
  /** m/s² of steering in the air. */
  airAccel: number;

  jumpHeight: number;
  gravity: number;
  coyoteTime: number;
  jumpBuffer: number;
  crouchToggle: boolean;
  /** Eye height transition rate when crouching (1/s). */
  crouchRate: number;

  /** Step smoothing rate (1/s). */
  stepSmoothing: number;
  /** Landing dip: metres per m/s of landing speed, cap, spring. */
  landDip: number;
  landDipMax: number;
  landHz: number;
  landDamping: number;
  /** Camera bob amplitude (m), 0 = off. */
  bobAmount: number;
  /** Camera roll when strafing at run speed (degrees), 0 = off. */
  strafeRoll: number;

  /** Stride length (m) at walk / sprint speed (footsteps, weapon bob phase). */
  strideWalk: number;
  strideSprint: number;

  flySpeed: number;
}

export const PLAYER_DEFAULTS: PlayerTuning = {
  sensitivity: 5.7,
  invertY: false,
  fov: 95,
  radius: 0.3,
  standHeight: 1.8,
  crouchHeight: 1.2,
  eyeStand: 1.65,
  eyeCrouch: 1.08,
  stepHeight: 0.4,
  maxSlope: 46,
  runSpeed: 4.6,
  sprintSpeed: 6.6,
  walkSpeed: 2.2,
  crouchSpeed: 2.2,
  groundAccel: 50,
  groundDecel: 40,
  airAccel: 5,
  jumpHeight: 0.6,
  gravity: 16,
  coyoteTime: 0.1,
  jumpBuffer: 0.12,
  crouchToggle: false,
  crouchRate: 14,
  stepSmoothing: 16,
  landDip: 0.012,
  landDipMax: 0.09,
  landHz: 3.2,
  landDamping: 0.75,
  bobAmount: 0,
  strafeRoll: 0,
  strideWalk: 0.62,
  strideSprint: 0.95,
  flySpeed: 12,
};

export type Stance = 'stand' | 'crouch';

export class FirstPersonController {
  tuning: PlayerTuning = { ...PLAYER_DEFAULTS };
  fly = false;
  readonly motor: CharacterMotor;
  stance: Stance = 'stand';
  sprinting = false;
  /** Set by gameplay (e.g. firing) to prevent sprinting this tick. */
  sprintBlocked = false;
  /** Horizontal speed (m/s) and wish direction of the last tick. */
  speed = 0;
  /** Walk cycle phase in radians (one step = π), advanced by distance on the ground. */
  bobPhase = 0;
  /** Lateral / forward velocity in view space (m/s), for weapon sway. */
  localVelocity: [number, number] = [0, 0];
  private _enabled = true;

  // Eye: tick state (interpolated in frame()).
  private eyeHeightNow = PLAYER_DEFAULTS.eyeStand;
  private stepOffset = 0;
  private eye: [number, number, number] = [0, 0, 0];
  private prevEye: [number, number, number] = [0, 0, 0];
  // Per-frame camera feel.
  private dip = spring();
  private roll = 0;
  private mouse: [number, number] = [0, 0];
  private coyote = 0;
  private jumpQueued = 0;
  private stepDist = 0;
  private foot = 0;
  private crouchLatch = false;
  private clock = new FixedClock(120);

  onStep: ((surface: Surface, speed: number, foot: number) => void)[] = [];
  onLand: ((speed: number, surface: Surface) => void)[] = [];
  onJump: (() => void)[] = [];

  constructor(private camera: Camera, readonly input: Input, collision: CollisionWorld | null) {
    this.motor = new CharacterMotor(collision, { radius: 0.3, height: 1.8, stepHeight: 0.4, maxSlope: 46 });
    input.canLock = () => this._enabled;
  }

  get enabled() {
    return this._enabled;
  }
  set enabled(v: boolean) {
    this._enabled = v;
    // Presses made while disabled (editor keys) must not act on resume.
    this.input.clearEdges();
  }

  get locked() {
    return this.input.locked;
  }
  get feet() {
    return this.motor.feet;
  }
  set feet(p: [number, number, number]) {
    this.motor.feet = p;
  }
  get velocity() {
    return this.motor.velocity;
  }
  get onGround() {
    return this.motor.grounded;
  }
  get eyeHeight() {
    return this.tuning.eyeStand;
  }

  setCollision(c: CollisionWorld) {
    this.motor.collision = c;
  }

  teleport(pos: [number, number, number], yawDeg?: number, pitchDeg?: number) {
    const m = this.motor;
    m.feet = [pos[0], pos[1], pos[2]];
    m.velocity = [0, 0, 0];
    this.stance = 'stand';
    this.applyShape();
    this.eyeHeightNow = this.tuning.eyeStand;
    this.stepOffset = 0;
    this.dip.x = this.dip.v = 0;
    if (!this.fly) m.refreshGround();
    if (yawDeg !== undefined) this.camera.yaw = (yawDeg * Math.PI) / 180;
    if (pitchDeg !== undefined) this.camera.pitch = (pitchDeg * Math.PI) / 180;
    this.computeEye();
    this.prevEye[0] = this.eye[0]; this.prevEye[1] = this.eye[1]; this.prevEye[2] = this.eye[2];
    this.writeCamera(this.eye);
  }

  toggleFly() {
    this.fly = !this.fly;
    this.motor.velocity = [0, 0, 0];
    this.motor.grounded = false;
  }

  private applyShape() {
    const t = this.tuning, s = this.motor.shape;
    s.radius = t.radius;
    s.stepHeight = t.stepHeight;
    s.maxSlope = t.maxSlope;
    s.height = this.stance === 'crouch' ? t.crouchHeight : t.standHeight;
  }

  private computeEye() {
    const f = this.motor.feet;
    this.eye[0] = f[0];
    this.eye[1] = f[1] + (this.fly ? this.tuning.eyeStand : this.eyeHeightNow + this.stepOffset);
    this.eye[2] = f[2];
  }

  private writeCamera(e: ArrayLike<number>) {
    const c = this.camera.position;
    c[0] = e[0]; c[1] = e[1]; c[2] = e[2];
  }

  /** Convenience for callers without a game clock (editor play, plain viewer): look, ticks, frame. */
  update(dt: number) {
    this.look();
    const alpha = this.clock.advance(dt, (h) => {
      this.tick(h);
      this.input.endTick();
    });
    this.frame(dt, alpha);
  }

  /** One fixed simulation step. */
  tick(h: number) {
    this.prevEye[0] = this.eye[0]; this.prevEye[1] = this.eye[1]; this.prevEye[2] = this.eye[2];
    const I = this.input, t = this.tuning, m = this.motor;
    if (this._enabled && I.pressed('KeyF')) this.toggleFly();
    let fx = 0, fz = 0;
    if (this._enabled) {
      if (I.down('KeyW')) fz += 1;
      if (I.down('KeyS')) fz -= 1;
      if (I.down('KeyD')) fx += 1;
      if (I.down('KeyA')) fx -= 1;
    }
    const yaw = this.camera.yaw;
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    if (this.fly || !m.collision) {
      this.flyTick(h, fx, fz, sy, cy);
      return;
    }
    this.applyShape();

    // ---- stance
    const crouchKey = this._enabled && I.anyDown('KeyC', 'ControlLeft');
    let wantCrouch = crouchKey;
    if (t.crouchToggle) {
      if (crouchKey && !this.crouchLatch) wantCrouch = this.stance !== 'crouch';
      else wantCrouch = this.stance === 'crouch';
      this.crouchLatch = crouchKey;
    }
    if (wantCrouch && this.stance === 'stand') {
      this.stance = 'crouch';
      this.applyShape();
    } else if (!wantCrouch && this.stance === 'crouch' && m.fits(t.standHeight)) {
      this.stance = 'stand';
      this.applyShape();
    }
    const crouched = this.stance === 'crouch';

    // ---- wish velocity
    const len = Math.hypot(fx, fz);
    this.sprinting = !crouched && !this.sprintBlocked && fz > 0 && this._enabled && I.anyDown('ShiftLeft', 'ShiftRight');
    const walking = this._enabled && I.down('AltLeft');
    const wishSpeed0 = len === 0 ? 0 : crouched ? t.crouchSpeed : this.sprinting ? t.sprintSpeed : walking ? t.walkSpeed : t.runSpeed;
    // Forward = (sin yaw, -cos yaw), right = (cos yaw, sin yaw).
    let wx = len ? (sy * fz + cy * fx) / len : 0, wz = len ? (-cy * fz + sy * fx) / len : 0;
    let wishSpeed = wishSpeed0;
    // Walls being touched: steer along them (full slide speed at once instead of grinding into them).
    const C = m.contacts;
    for (let i = 0; i < C.count && wishSpeed > 0; i++) {
      const nx = C.n[i * 3], nz = C.n[i * 3 + 2], hl = Math.hypot(nx, nz);
      if (hl < 0.5) continue;
      const d = (wx * nx + wz * nz) / hl;
      if (d >= 0) continue;
      wx -= (nx / hl) * d; wz -= (nz / hl) * d;
      const wl = Math.hypot(wx, wz);
      if (wl < 1e-3) { wishSpeed = 0; break; }
      wishSpeed *= wl;
      wx /= wl; wz /= wl;
    }
    const v = m.velocity;
    if (m.grounded) {
      if (wishSpeed > 0) {
        let along = v[0] * wx + v[2] * wz;
        let px = v[0] - wx * along, pz = v[2] - wz * along;
        // Off-axis velocity brakes (turning, strafing changes); along-axis accelerates to the wish speed.
        const pl = Math.hypot(px, pz), pk = pl > 0 ? Math.max(0, pl - t.groundDecel * h) / pl : 0;
        px *= pk; pz *= pk;
        along = along < wishSpeed ? Math.min(wishSpeed, along + t.groundAccel * h) : Math.max(wishSpeed, along - t.groundDecel * h);
        v[0] = wx * along + px;
        v[2] = wz * along + pz;
      } else {
        const sp = Math.hypot(v[0], v[2]);
        const k = sp > 0 ? Math.max(0, sp - t.groundDecel * h) / sp : 0;
        v[0] *= k; v[2] *= k;
      }
    } else if (wishSpeed > 0) {
      // Air: steer towards the wish velocity without gaining speed beyond max(current, wish).
      const sp0 = Math.hypot(v[0], v[2]);
      const dx = wx * wishSpeed - v[0], dz = wz * wishSpeed - v[2];
      const dl = Math.hypot(dx, dz), step = Math.min(dl, t.airAccel * h);
      if (dl > 0) { v[0] += (dx / dl) * step; v[2] += (dz / dl) * step; }
      const sp1 = Math.hypot(v[0], v[2]), cap = Math.max(sp0, wishSpeed);
      if (sp1 > cap) { v[0] *= cap / sp1; v[2] *= cap / sp1; }
    }

    // ---- jump (buffered press, coyote time after leaving the ground)
    if (this._enabled && I.pressed('Space')) this.jumpQueued = t.jumpBuffer;
    this.coyote = m.grounded ? t.coyoteTime : Math.max(0, this.coyote - h);
    if (this.jumpQueued > 0 && this.coyote > 0 && v[1] <= 0.01) {
      v[1] = Math.sqrt(2 * t.gravity * t.jumpHeight);
      m.grounded = false;
      this.coyote = 0;
      this.jumpQueued = 0;
      for (const f of this.onJump) f();
    }
    this.jumpQueued = Math.max(0, this.jumpQueued - h);
    v[1] -= t.gravity * h;

    // ---- move
    const x0 = m.feet[0], z0 = m.feet[2];
    const safe: [number, number, number] = [m.feet[0], m.feet[1], m.feet[2]];
    m.move(h);
    if (!m.feet.every(Number.isFinite) || !v.every(Number.isFinite)) {
      console.warn('[player] non-finite collision result; reverting step');
      m.feet = safe;
      m.velocity = [0, 0, 0];
    }
    if (m.feet[1] < -100) this.teleport([m.feet[0], 50, m.feet[2]]);
    if (m.landSpeed > 0) {
      this.onLanded(m.landSpeed);
      for (const f of this.onLand) f(m.landSpeed, m.ground.surface as Surface);
    }

    // ---- eye: crouch transition, step smoothing (tick state, interpolated per frame)
    const eyeTarget = crouched ? t.eyeCrouch : t.eyeStand;
    this.eyeHeightNow += (eyeTarget - this.eyeHeightNow) * approach(t.crouchRate, h);
    this.stepOffset = Math.max(-0.45, Math.min(0.45, this.stepOffset - m.stepDelta)) * Math.exp(-t.stepSmoothing * h);

    // ---- walk cycle + footsteps (distance actually covered on the ground)
    const moved = Math.hypot(m.feet[0] - x0, m.feet[2] - z0);
    this.speed = Math.hypot(v[0], v[2]);
    this.localVelocity[0] = v[0] * cy + v[2] * sy;
    this.localVelocity[1] = v[0] * sy - v[2] * cy;
    if (m.grounded && this.speed > 0.3) {
      const k = Math.max(0, Math.min(1, (this.speed - t.walkSpeed) / Math.max(0.1, t.sprintSpeed - t.walkSpeed)));
      const stride = t.strideWalk + (t.strideSprint - t.strideWalk) * k;
      this.stepDist += moved;
      if (this.stepDist >= stride) {
        this.stepDist -= stride;
        this.foot ^= 1;
        for (const f of this.onStep) f(m.ground.surface as Surface, this.speed, this.foot);
      }
      this.bobPhase = (this.foot + this.stepDist / stride) * Math.PI;
    }
    this.computeEye();
  }

  private onLanded(speed: number) {
    const t = this.tuning;
    // Velocity kick sized so the dip peaks near `amount` (critically damped response).
    const amount = Math.min(t.landDipMax, Math.max(0, speed - 1.5) * t.landDip);
    this.dip.v -= amount * 2 * Math.PI * t.landHz * Math.E;
    this.stepDist = 0;
  }

  private flyTick(h: number, fx: number, fz: number, sy: number, cy: number) {
    const I = this.input, t = this.tuning, v = this.motor.velocity;
    const pitch = this.camera.pitch, cp = Math.cos(pitch), spch = Math.sin(pitch);
    let up = 0;
    if (this._enabled && I.anyDown('KeyE', 'Space')) up += 1;
    if (this._enabled && I.down('KeyQ')) up -= 1;
    const sp = t.flySpeed * (I.anyDown('ShiftLeft', 'ShiftRight') ? 4 : I.down('AltLeft') ? 0.2 : 1);
    const f3 = [sy * cp, spch, -cy * cp], r3 = [cy, 0, sy];
    const a = approach(10, h);
    for (let i = 0; i < 3; i++) {
      const target = (f3[i] * fz + r3[i] * fx) * sp + (i === 1 ? up * sp : 0);
      v[i] += (target - v[i]) * a;
      this.motor.feet[i] += v[i] * h;
    }
    this.speed = 0;
    this.computeEye();
  }

  /**
   * Mouse look: applies the counts since the last frame. Call first in a frame, before
   * the ticks, so a shot fired this frame goes where this frame's crosshair points.
   * Returns the applied (yaw, pitch) change in radians.
   */
  look(): [number, number] {
    const t = this.tuning, c = this.camera;
    this.input.takeMouse(this.mouse);
    if (!this.input.locked || !this._enabled) return [0, 0];
    const k = (0.022 * t.sensitivity * Math.PI) / 180;
    const p0 = c.pitch;
    const dyaw = this.mouse[0] * k;
    c.yaw += dyaw;
    c.pitch = Math.max(-1.553, Math.min(1.553, c.pitch - this.mouse[1] * k * (t.invertY ? -1 : 1)));
    return [dyaw, c.pitch - p0];
  }

  /** Per rendered frame (after `look` and the ticks): interpolated eye, camera feel. `alpha` = tick interpolation. */
  frame(dt: number, alpha: number) {
    const t = this.tuning, c = this.camera;
    c.fovY = 2 * Math.atan(Math.tan((t.fov * Math.PI) / 360) * (9 / 16));
    const e = this.prevEye, n = this.eye;
    const x = e[0] + (n[0] - e[0]) * alpha, z = e[2] + (n[2] - e[2]) * alpha;
    let y = e[1] + (n[1] - e[1]) * alpha;
    if (!this.fly) {
      stepSpring(this.dip, 0, t.landHz, t.landDamping, dt);
      y += this.dip.x;
      if (t.bobAmount > 0 && this.motor.grounded) y -= Math.abs(Math.sin(this.bobPhase)) * t.bobAmount * Math.min(1, this.speed / t.runSpeed);
      const rollTarget = t.strafeRoll > 0 ? (-this.localVelocity[0] / t.runSpeed) * ((t.strafeRoll * Math.PI) / 180) : 0;
      this.roll += (rollTarget - this.roll) * approach(10, dt);
    } else {
      this.roll = 0;
    }
    c.roll = this.roll;
    c.position[0] = x; c.position[1] = y; c.position[2] = z;
  }
}
