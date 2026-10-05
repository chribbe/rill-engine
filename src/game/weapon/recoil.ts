import type { Camera } from '../../engine/scene/camera';
import { spring, stepSpring } from '../../engine/core/spring';
import type { WeaponDef } from './def';

const RAD = Math.PI / 180;
/** Field-of-view punch spring (Hz). */
const FOV_HZ = 10;

/**
 * Recoil as two layers on the camera:
 *
 * - Aim kick (ticked, moves bullets): every shot adds a pitch / yaw kick that
 *   is applied over `kickTime`. A `permanent` share goes into the player's own
 *   view angles (aim displacement they must correct); the rest is an offset
 *   that returns after `recoverDelay`. Mouse movement against the offset uses
 *   it up first (`absorb`), so the automatic return only undoes what the
 *   player didn't correct: no overshoot below the target.
 * - View punch (per frame, visual only): a fast damped spring on pitch / yaw /
 *   roll that sells the shot without moving the bullets.
 *
 * The camera renders aim offset + punch through `camera.punch`; the firearm
 * aims along the camera's yaw / pitch + the aim offset.
 */
export class Recoil {
  /** Recoverable aim offset (radians, + pitch up, + yaw right). */
  aimP = 0;
  aimY = 0;
  private prevP = 0;
  private prevY = 0;
  /** Kick still being applied: recoverable and permanent parts (radians). */
  private pendP = 0;
  private pendY = 0;
  private pendPermP = 0;
  private pendPermY = 0;
  private sinceShot = Infinity;
  private punchP = spring();
  private punchY = spring();
  private punchR = spring();
  /** Field-of-view punch (radians, widening). */
  private fov = spring();
  private seed = 0x9e3779b9;

  constructor(public def: WeaponDef) {}

  private rand() {
    let t = (this.seed = (this.seed + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** A round was fired (`burstIndex` 0 = first shot of the pull). */
  onShot(burstIndex: number) {
    const r = this.def.recoil, p = this.def.punch;
    const ramp = Math.min(1, r.firstShot + (1 - r.firstShot) * (burstIndex / Math.max(1, r.ramp)));
    const kp = (r.pitch * ramp + (this.rand() * 2 - 1) * r.randomPitch) * RAD;
    const ky = (r.yaw * Math.sin(burstIndex * r.patternFreq + r.patternPhase) * ramp + (this.rand() * 2 - 1) * r.randomYaw) * RAD;
    this.pendP += kp * (1 - r.permanent);
    this.pendY += ky * (1 - r.permanent);
    this.pendPermP += kp * r.permanent;
    this.pendPermY += ky * r.permanent;
    this.sinceShot = 0;
    // Punch: velocity kicks sized so each peaks near its amplitude (degrees).
    const w = 2 * Math.PI * p.hz;
    const side = this.rand() * 2 - 1;
    this.punchP.v += p.pitch * RAD * w * 1.6;
    this.punchY.v += p.yaw * side * RAD * w * 1.6;
    this.punchR.v += p.roll * (this.rand() < 0.5 ? -1 : 1) * (0.6 + 0.4 * Math.abs(side)) * RAD * w * 1.6;
    this.fov.v += this.def.fx.fovPunch * RAD * 2 * Math.PI * FOV_HZ * 1.6;
  }

  /** Extra visual view kick (degrees), e.g. taking a hit. */
  kickView(pitch: number, yaw: number, roll: number) {
    const p = this.def.punch, w = 2 * Math.PI * p.hz;
    this.punchP.v += pitch * RAD * w * 1.6;
    this.punchY.v += yaw * RAD * w * 1.6;
    this.punchR.v += roll * RAD * w * 1.6;
  }

  /** Fixed tick: applies pending kick, recovery. */
  tick(h: number, camera: Camera) {
    const r = this.def.recoil;
    this.prevP = this.aimP;
    this.prevY = this.aimY;
    const k = 1 - Math.exp((-3 * h) / Math.max(1e-3, r.kickTime));
    const dp = this.pendP * k, dy = this.pendY * k;
    this.pendP -= dp; this.pendY -= dy;
    const maxP = r.maxPitch * RAD, maxY = r.maxYaw * RAD;
    this.aimP = Math.min(maxP, this.aimP + dp);
    this.aimY = Math.max(-maxY, Math.min(maxY, this.aimY + dy));
    const pp = this.pendPermP * k, py = this.pendPermY * k;
    this.pendPermP -= pp; this.pendPermY -= py;
    camera.pitch = Math.max(-1.553, Math.min(1.553, camera.pitch + pp));
    camera.yaw += py;
    this.sinceShot += h;
    if (this.sinceShot > r.recoverDelay) {
      const d = Math.exp(-r.recoverRate * h);
      this.aimP *= d;
      this.aimY *= d;
    }
  }

  /**
   * Mouse look this frame (radians, as applied to the camera). Movement against
   * the aim offset consumes it instead of the player's angles: the view moves
   * exactly as the mouse says, but there is less left to recover.
   */
  absorb(dyaw: number, dpitch: number, camera: Camera) {
    if (this.aimP > 0 && dpitch < 0) {
      const a = Math.min(this.aimP, -dpitch);
      this.aimP -= a; this.prevP -= a;
      camera.pitch += a;
    }
    if (this.aimY !== 0 && dyaw !== 0 && Math.sign(dyaw) !== Math.sign(this.aimY)) {
      const a = Math.min(Math.abs(this.aimY), Math.abs(dyaw)) * Math.sign(this.aimY);
      this.aimY -= a; this.prevY -= a;
      camera.yaw += a;
    }
  }

  /** Per frame: view punch springs and the camera's rendered offset (aim offset interpolated by `alpha`). */
  frame(dt: number, alpha: number, camera: Camera) {
    const p = this.def.punch;
    stepSpring(this.punchP, 0, p.hz, p.damping, dt);
    stepSpring(this.punchY, 0, p.hz, p.damping, dt);
    stepSpring(this.punchR, 0, p.hz * 0.8, p.damping, dt);
    const ap = this.prevP + (this.aimP - this.prevP) * alpha, ay = this.prevY + (this.aimY - this.prevY) * alpha;
    camera.punch[0] = ap + this.punchP.x;
    camera.punch[1] = ay + this.punchY.x;
    camera.punch[2] = this.punchR.x;
    // After the player set this frame's FOV: widen it by the shot punch.
    stepSpring(this.fov, 0, FOV_HZ, 0.55, dt);
    camera.fovY += this.fov.x;
  }

  /** Visual-only part of the view rotation (radians): where the crosshair is off the bullet line. */
  get punch(): [number, number] {
    return [this.punchP.x, this.punchY.x];
  }

  reset(camera: Camera) {
    this.seed = 0x9e3779b9;
    this.aimP = this.aimY = this.prevP = this.prevY = 0;
    this.pendP = this.pendY = this.pendPermP = this.pendPermY = 0;
    this.punchP.x = this.punchP.v = this.punchY.x = this.punchY.v = this.punchR.x = this.punchR.v = 0;
    this.fov.x = this.fov.v = 0;
    this.sinceShot = Infinity;
    camera.punch[0] = camera.punch[1] = camera.punch[2] = 0;
  }
}
