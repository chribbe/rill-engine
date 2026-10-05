import { mat4, quat, vec3, type Mat4, type Quat } from 'wgpu-matrix';
import type { Renderable, Renderer } from '../../engine/render/renderer';
import type { CollisionWorld } from '../../engine/scene/collision';
import { Rig, type RigPart } from '../../engine/scene/rig';
import { rayCapsule, raySphere } from '../../engine/physics/shapes';
import { spring, stepSpring } from '../../engine/core/spring';
import type { ShotHit } from '../combat/hitscan';
import type { TomatoDef } from './def';
import { LEG_GROUP, type TomatoModel } from './model';

const RAD = Math.PI / 180;
type V3 = [number, number, number];

export type TomatoState = 'chase' | 'windup' | 'bite' | 'recover' | 'lunge' | 'stagger' | 'dead';

/** What a tomato needs to know about its target each tick. */
export interface Prey {
  /** Feet (ground point) and velocity of the target. */
  feet: ArrayLike<number>;
  height: number;
}

interface Leg {
  upper: RigPart;
  lower: RigPart;
  hp: number;
  lost: boolean;
  /** Planted foot (world), step from / to, progress (-1 = planted). */
  foot: V3;
  from: V3;
  to: V3;
  t: number;
  dur: number;
}

/**
 * One tomato bug: fixed-rate simulation (steering, a small attack state
 * machine, ground and walls) plus per-frame presentation (tripod gait with
 * planted feet and two-bone IK, body bob / lean / roll, jaw and squash springs).
 * Pooled by the Horde: `reset` revives a slot.
 */
export class Tomato {
  readonly rig: Rig;
  active = false;
  state: TomatoState = 'chase';
  stateT = 0;
  health = 0;
  /** Body centre (sim), previous tick's, velocity. */
  readonly pos: V3 = [0, 0, 0];
  readonly prev: V3 = [0, 0, 0];
  readonly vel: V3 = [0, 0, 0];
  yaw = 0;
  prevYaw = 0;
  grounded = true;
  ground = 0;
  speedMul = 1;
  cooldown = 0;
  stagger = 0;
  flinchT = 0;
  bitThisAttack = false;
  /** Rendered body centre (pose): what bullets hit. */
  readonly shown: V3 = [0, 0, 0];
  readonly legs: Leg[];
  private frame: RigPart;
  private body: RigPart;
  private lid: RigPart;
  private crown: RigPart;
  private jaw = spring();
  private squash = spring();
  private tiltX = spring();
  private tiltZ = spring();
  private wobX = spring();
  private wobZ = spring();
  private lean = spring();
  private roll = spring();
  private lastVel: V3 = [0, 0, 0];
  private seed = 1;
  private root: Mat4 = mat4.identity();
  private inv: Mat4 = mat4.identity();
  private qa: Quat = quat.create();
  private qb: Quat = quat.create();
  private tmp: V3 = [0, 0, 0];
  private tmp2: V3 = [0, 0, 0];
  private fresh = true;

  constructor(readonly index: number, public def: TomatoDef, private model: TomatoModel, renderer: Renderer, renderables: Renderable[]) {
    this.rig = new Rig(renderer, `tomato${index}`).add(model.parts, renderables);
    this.rig.visible = false;
    this.rig.update(mat4.identity());
    this.frame = this.rig.part('frame')!;
    this.body = this.rig.part('body')!;
    this.lid = this.rig.part('lid')!;
    this.crown = this.rig.part('crown')!;
    this.legs = model.legs.map((l) => ({ upper: this.rig.part(l.upper)!, lower: this.rig.part(l.lower)!, hp: 0, lost: false, foot: [0, 0, 0], from: [0, 0, 0], to: [0, 0, 0], t: -1, dur: 0.1 }));
  }

  private rand() {
    let t = (this.seed = (this.seed + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  get alive() {
    return this.active && this.state !== 'dead';
  }

  get legsLeft() {
    let n = 0;
    for (const l of this.legs) if (!l.lost) n++;
    return n;
  }

  reset(at: ArrayLike<number>, yawRad: number, seed: number) {
    const d = this.def;
    this.active = true;
    this.state = 'chase';
    this.stateT = 0;
    this.health = d.health;
    this.seed = seed | 1;
    this.speedMul = 1 + (this.rand() * 2 - 1) * d.move.speedJitter;
    this.pos[0] = at[0]; this.pos[1] = at[1] + d.rideHeight * d.scale; this.pos[2] = at[2];
    this.prev[0] = this.pos[0]; this.prev[1] = this.pos[1]; this.prev[2] = this.pos[2];
    this.vel[0] = this.vel[1] = this.vel[2] = 0;
    this.yaw = this.prevYaw = yawRad;
    this.grounded = true;
    this.ground = at[1];
    this.cooldown = 0.3 + this.rand() * 0.4;
    this.stagger = 0;
    this.flinchT = 0;
    for (const s of [this.jaw, this.squash, this.tiltX, this.tiltZ, this.wobX, this.wobZ, this.lean, this.roll]) s.x = s.v = 0;
    for (const l of this.legs) { l.hp = 22; l.lost = false; l.t = -1; l.upper.visible = l.lower.visible = true; }
    this.lid.visible = this.crown.visible = this.body.visible = true;
    this.fresh = true;
    this.rig.visible = true;
  }

  // ------------------------------------------------------------------ simulation (fixed rate)

  tick(h: number, prey: Prey, C: CollisionWorld, onBite: (t: Tomato) => void) {
    if (!this.alive) return;
    const d = this.def, M = d.move, A = d.attack, S = d.scale, range = A.range * S, radius = d.radius * S, ride0 = d.rideHeight * S;
    this.prev[0] = this.pos[0]; this.prev[1] = this.pos[1]; this.prev[2] = this.pos[2];
    this.prevYaw = this.yaw;
    this.stateT += h;
    this.cooldown = Math.max(0, this.cooldown - h);
    this.flinchT = Math.max(0, this.flinchT - h);
    this.stagger = Math.max(0, this.stagger - d.reactions.staggerThreshold * 0.6 * h);

    const dx = prey.feet[0] - this.pos[0], dz = prey.feet[2] - this.pos[2];
    const dist = Math.hypot(dx, dz) || 1e-6;
    const ux = dx / dist, uz = dz / dist;
    const legs = this.legsLeft, legMul = legs >= 6 ? 1 : 0.25 + 0.75 * (legs / 6) ** 1.6;
    let want = (dist > M.sprintDistance ? M.sprint : M.speed) * this.speedMul * legMul * (this.flinchT > 0 ? d.reactions.flinch : 1);
    let face = true;

    switch (this.state) {
      case 'chase':
        if (dist < range && this.cooldown <= 0 && this.grounded) this.enter('windup');
        else if (this.grounded && this.cooldown <= 0 && dist > A.lungeRange[0] && dist < A.lungeRange[1] && legs >= 4 && this.rand() < A.lungeChance * h) {
          this.enter('lunge');
          const up = A.lungeUp, sp = A.lungeSpeed * this.speedMul;
          this.vel[0] = ux * sp; this.vel[1] = up; this.vel[2] = uz * sp;
          this.grounded = false;
          this.squash.v -= 4;
        }
        break;
      case 'windup':
        want *= 0.15;
        if (this.stateT >= A.windup) this.enter('bite');
        break;
      case 'bite':
        want = 0;
        if (!this.bitThisAttack) {
          this.bitThisAttack = true;
          if (dist < range + 0.35) onBite(this);
          this.squash.v += 3;
        }
        if (this.stateT >= A.bite) this.enter('recover');
        break;
      case 'recover':
        want *= 0.35;
        if (this.stateT >= A.recover) { this.enter('chase'); this.cooldown = A.cooldown * (0.7 + this.rand() * 0.6); }
        break;
      case 'lunge':
        face = false;
        // Mid-air bite when it reaches the prey's body.
        if (!this.bitThisAttack && Math.hypot(dx, dz) < radius + 0.55 && Math.abs(prey.feet[1] + 1.0 - this.pos[1]) < 1.0) {
          this.bitThisAttack = true;
          onBite(this);
        }
        break;
      case 'stagger':
        want *= 0.1;
        face = false;
        if (this.stateT >= d.reactions.staggerTime) this.enter('chase');
        break;
    }

    // Steering (on the ground only): accelerate towards the wanted velocity, turn the heading.
    if (this.grounded) {
      const tx = ux * want, tz = uz * want;
      const ax = tx - this.vel[0], az = tz - this.vel[2], al = Math.hypot(ax, az), amax = M.accel * h;
      const k = al > amax ? amax / al : 1;
      this.vel[0] += ax * k; this.vel[2] += az * k;
    }
    if (face) {
      const target = Math.atan2(ux, -uz);
      let dy = target - this.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      const step = M.turnRate * RAD * h;
      this.yaw += Math.max(-step, Math.min(step, dy));
    }

    // Integrate; gravity in the air.
    if (!this.grounded) this.vel[1] -= 9.81 * h;
    this.pos[0] += this.vel[0] * h; this.pos[1] += this.vel[1] * h; this.pos[2] += this.vel[2] * h;

    // Walls: push the body sphere out of the world (horizontal part only kills velocity into it).
    const n = this.tmp;
    const depth = C.pushSphereOut(this.pos, radius * 0.85, n, 2);
    if (depth > 0) {
      const vn = this.vel[0] * n[0] + this.vel[2] * n[2];
      if (vn < 0 && Math.abs(n[1]) < 0.7) { this.vel[0] -= vn * n[0]; this.vel[2] -= vn * n[2]; }
    }

    // Ground: follow it up steps and kerbs while walking; land from the air.
    const g = C.groundHeight(this.pos[0], this.pos[1] - ride0 + 0.55, this.pos[2], 4);
    const ride = g > -Infinity ? g + ride0 : -Infinity;
    if (this.grounded) {
      if (ride === -Infinity || ride < this.pos[1] - 0.5) {
        this.grounded = false;
      } else {
        this.ground = g;
        this.pos[1] += (ride - this.pos[1]) * Math.min(1, h * 25);
        this.vel[1] = 0;
      }
    } else if (ride > -Infinity && this.pos[1] <= ride && this.vel[1] <= 0) {
      const impact = -this.vel[1];
      this.pos[1] = ride;
      this.ground = g;
      this.vel[1] = 0;
      this.grounded = true;
      this.squash.v -= Math.min(8, impact * 1.2);
      if (this.state === 'lunge') { this.enter('recover'); this.vel[0] *= 0.3; this.vel[2] *= 0.3; }
    }
    if (this.pos[1] < -50) this.health = 0;
  }

  private enter(s: TomatoState) {
    this.state = s;
    this.stateT = 0;
    if (s === 'windup' || s === 'lunge') this.bitThisAttack = false;
  }

  /** A bullet hit: returns 'kill', 'leg' (a leg came off), or ''. `legIndex` for leg parts. */
  hit(damage: number, point: ArrayLike<number>, dir: ArrayLike<number>, impulse: number, part: string): 'kill' | 'leg' | '' {
    if (!this.alive) return '';
    const R = this.def.reactions;
    const li = part.startsWith('leg') ? +part.slice(4) : -1;
    let result: 'kill' | 'leg' | '' = '';
    if (li >= 0) {
      const leg = this.legs[li];
      leg.hp -= damage;
      this.health -= damage * 0.35;
      if (leg.hp <= 0 && !leg.lost) { leg.lost = true; leg.upper.visible = leg.lower.visible = false; result = 'leg'; }
    } else {
      this.health -= damage;
    }
    // Squash and a tilt away from the hit, a shove, a flinch; heavy damage staggers.
    const hx = point[0] - this.shown[0], hz = point[2] - this.shown[2];
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const lx = hx * c + hz * s, lz = -hx * s + hz * c; // right, back (local)
    const k = Math.min(3, impulse * 0.12);
    // Pushed away from the hit: a front hit tips the nose up, a hit on the right lifts the right side.
    this.tiltX.v -= lz * 30 * k;
    this.tiltZ.v += lx * 30 * k;
    this.squash.v -= R.squash * 25 * k;
    this.wobX.v += (this.rand() - 0.5) * 20 * k;
    this.wobZ.v += (this.rand() - 0.5) * 20 * k;
    this.vel[0] += dir[0] * impulse * R.knock;
    this.vel[2] += dir[2] * impulse * R.knock;
    this.flinchT = 0.15;
    this.stagger += damage;
    if (this.stagger > R.staggerThreshold && this.state !== 'lunge') { this.enter('stagger'); this.stagger = 0; }
    if (this.health <= 0) {
      this.state = 'dead';
      result = 'kill';
    }
    return result;
  }

  // ------------------------------------------------------------------ presentation (per frame)

  pose(dt: number, alpha: number, C: CollisionWorld) {
    if (!this.active) return;
    const d = this.def, G = d.gait, A = d.attack, R = d.reactions;
    const p = this.shown;
    p[0] = this.prev[0] + (this.pos[0] - this.prev[0]) * alpha;
    p[1] = this.prev[1] + (this.pos[1] - this.prev[1]) * alpha;
    p[2] = this.prev[2] + (this.pos[2] - this.prev[2]) * alpha;
    let dy = this.yaw - this.prevYaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    const yaw = this.prevYaw + dy * alpha;

    // Lean into acceleration, roll into turns (springs, so they swing).
    const inv = dt > 1e-5 ? 1 / dt : 0;
    const ax = (this.vel[0] - this.lastVel[0]) * inv, az = (this.vel[2] - this.lastVel[2]) * inv;
    this.lastVel[0] = this.vel[0]; this.lastVel[2] = this.vel[2];
    const fx = Math.sin(yaw), fz = -Math.cos(yaw);
    const accF = Math.max(-30, Math.min(30, ax * fx + az * fz));
    stepSpring(this.lean, -accF * G.lean * RAD * 0.5, 6, 0.6, dt);
    stepSpring(this.roll, Math.max(-1, Math.min(1, -dy * inv * 0.15)) * G.roll * RAD, 5, 0.6, dt);
    stepSpring(this.tiltX, 0, R.springHz, R.springDamping, dt);
    stepSpring(this.tiltZ, 0, R.springHz, R.springDamping, dt);
    stepSpring(this.squash, 0, R.springHz * 1.3, R.springDamping, dt);
    stepSpring(this.wobX, 0, 3, 0.25, dt);
    stepSpring(this.wobZ, 0, 3, 0.25, dt);

    // Jaw: chatters while chasing close, gapes on the windup and in a lunge, snaps shut on the bite.
    let jawT = 0;
    const speed = Math.hypot(this.vel[0], this.vel[2]);
    if (this.state === 'windup' || this.state === 'lunge') jawT = A.jawOpen;
    else if (this.state === 'bite') jawT = -4;
    else if (this.state === 'chase') jawT = A.jawChase * (0.5 + 0.5 * Math.sin(performance.now() * 0.022 + this.index * 1.7)) * Math.min(1, speed / 2);
    else if (this.state === 'dead') jawT = A.jawOpen;
    stepSpring(this.jaw, jawT * RAD, this.state === 'bite' ? 18 : 7, 0.45, dt);

    // Body bob from the gait: rises while a tripod swings.
    let swing = 0;
    for (const l of this.legs) if (!l.lost && l.t >= 0) swing = Math.max(swing, Math.sin(Math.PI * l.t));
    const bob = (swing - 0.5) * G.bob * d.scale * Math.min(1, speed / 1.5) * 2;

    const M = this.root;
    mat4.translation([p[0], p[1] + bob, p[2]], M);
    mat4.rotateY(M, -yaw, M);
    mat4.rotateX(M, this.lean.x + this.tiltX.x, M);
    mat4.rotateZ(M, this.roll.x + this.tiltZ.x, M);
    mat4.uniformScale(M, d.scale, M);
    mat4.inverse(M, this.inv);
    const sq = this.squash.x;
    this.body.scale[0] = this.body.scale[2] = 1 - sq * 0.5;
    this.body.scale[1] = 1 + sq;
    quat.fromEuler(Math.max(-0.1, this.jaw.x), 0, 0, 'xyz', this.lid.rot);
    quat.fromEuler(this.wobX.x * 0.6, 0, this.wobZ.x * 0.6, 'xyz', this.crown.rot);

    this.stepLegs(dt, M, C);
    this.rig.update(this.root);
  }

  /** Tripod gait: a leg steps when its planted foot falls behind its home; alternate groups. */
  private stepLegs(dt: number, M: Mat4, C: CollisionWorld) {
    const d = this.def, G = d.gait, legs = this.model.legs;
    const vx = this.vel[0], vz = this.vel[2], speed = Math.hypot(vx, vz);
    const stepDur = Math.max(0.07, G.stepTime * Math.min(1.6, Math.max(0.6, 3 / Math.max(0.5, speed))));
    const home = this.tmp, hipW = this.tmp2;
    const busy = [0, 0];
    for (let i = 0; i < 6; i++) if (this.legs[i].t >= 0 && this.legs[i].t < 0.6) busy[LEG_GROUP[i]]++;
    for (let i = 0; i < 6; i++) {
      const L = this.legs[i], info = legs[i];
      if (L.lost) continue;
      vec3.transformMat4(info.foot, M, home);
      if (this.grounded) {
        home[1] = this.ground;
        home[0] += vx * G.lead; home[2] += vz * G.lead;
      } else {
        // In the air the legs reach forward and down, splayed.
        home[1] = this.shown[1] - d.rideHeight * d.scale * 0.55;
      }
      if (this.fresh) { L.foot[0] = home[0]; L.foot[1] = home[1]; L.foot[2] = home[2]; L.t = -1; continue; }
      if (!this.grounded) {
        const k = Math.min(1, dt * 14);
        L.foot[0] += (home[0] - L.foot[0]) * k; L.foot[1] += (home[1] - L.foot[1]) * k; L.foot[2] += (home[2] - L.foot[2]) * k;
        L.t = -1;
      } else if (L.t >= 0) {
        L.t += dt / L.dur;
        if (L.t >= 1) { L.t = -1; L.foot[0] = L.to[0]; L.foot[1] = L.to[1]; L.foot[2] = L.to[2]; }
        else {
          const e = L.t * L.t * (3 - 2 * L.t);
          L.foot[0] = L.from[0] + (L.to[0] - L.from[0]) * e;
          L.foot[1] = L.from[1] + (L.to[1] - L.from[1]) * e + Math.sin(Math.PI * L.t) * G.lift * d.scale;
          L.foot[2] = L.from[2] + (L.to[2] - L.from[2]) * e;
        }
      } else {
        const off = Math.hypot(L.foot[0] - home[0], L.foot[2] - home[2]);
        const g = LEG_GROUP[i];
        if (off > G.stride * d.scale * 0.5 && busy[1 - g] === 0) {
          L.t = 0;
          L.dur = stepDur * (0.9 + this.rand() * 0.2);
          L.from[0] = L.foot[0]; L.from[1] = L.foot[1]; L.from[2] = L.foot[2];
          L.to[0] = home[0] + vx * L.dur * 0.5; L.to[1] = home[1]; L.to[2] = home[2] + vz * L.dur * 0.5;
          busy[g]++;
        } else if (Math.abs(L.foot[1] - home[1]) > 0.02) {
          L.foot[1] += (home[1] - L.foot[1]) * Math.min(1, dt * 10);
        }
      }
      // Two-bone IK in the frame's space.
      vec3.transformMat4(L.foot, this.inv, hipW);
      this.solveLeg(L, i, hipW);
    }
    this.fresh = false;
  }

  private solveLeg(L: Leg, i: number, f: V3) {
    const info = this.model.legs[i];
    const H = info.hip, l1 = info.l1, l2 = info.l2;
    let ux = f[0] - H[0], uy = f[1] - H[1], uz = f[2] - H[2];
    let dist = Math.hypot(ux, uy, uz) || 1e-6;
    ux /= dist; uy /= dist; uz /= dist;
    dist = Math.max(Math.abs(l1 - l2) + 0.01, Math.min(l1 + l2 - 0.002, dist));
    // Knee bends up and out (spider stance).
    let hx = info.out[0] * 0.35, hy = 1, hz = info.out[2] * 0.35;
    const dp = hx * ux + hy * uy + hz * uz;
    hx -= ux * dp; hy -= uy * dp; hz -= uz * dp;
    const hl = Math.hypot(hx, hy, hz) || 1;
    hx /= hl; hy /= hl; hz /= hl;
    const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
    const hh = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    const kx = H[0] + ux * a + hx * hh, ky = H[1] + uy * a + hy * hh, kz = H[2] + uz * a + hz * hh;
    const fx = H[0] + ux * dist, fy = H[1] + uy * dist, fz = H[2] + uz * dist;
    const t = info.thigh, sh = info.shin;
    const tl = info.l1, sl = info.l2;
    quat.rotationTo([t[0] / tl, t[1] / tl, t[2] / tl], vec3.normalize([kx - H[0], ky - H[1], kz - H[2]]), this.qa);
    quat.copy(this.qa, L.upper.rot);
    // Shin direction in the thigh's (rotated) frame.
    quat.conjugate(this.qa, this.qb);
    const sd = vec3.transformQuat(vec3.normalize([fx - kx, fy - ky, fz - kz]), this.qb);
    quat.rotationTo([sh[0] / sl, sh[1] / sl, sh[2] / sl], sd, L.lower.rot);
  }

  // ------------------------------------------------------------------ hit tests (posed)

  private segA: V3 = [0, 0, 0];
  private segB: V3 = [0, 0, 0];

  /** Nearest hit on this tomato's posed body or legs within maxT. */
  raycast(o: ArrayLike<number>, dir: ArrayLike<number>, maxT: number, out: ShotHit): boolean {
    if (!this.alive) return false;
    let best = maxT, part = '', region = '';
    const S = this.def.scale, r = this.def.radius * S * 0.95;
    const tb = raySphere(o, dir, this.shown, r);
    if (tb >= 0 && tb < best) { best = tb; part = 'body'; region = 'body'; }
    for (let i = 0; i < 6; i++) {
      const L = this.legs[i];
      if (L.lost) continue;
      const info = this.model.legs[i];
      for (const [seg, tip, rad] of [[L.upper, info.thigh, 0.05 * S], [L.lower, info.shin, 0.04 * S]] as [RigPart, V3, number][]) {
        this.rig.point(seg, [0, 0, 0], this.segA);
        this.rig.point(seg, tip, this.segB);
        const t = rayCapsule(o, dir, this.segA, this.segB, rad);
        if (t >= 0 && t < best) { best = t; part = `leg ${i}`; region = 'leg'; }
      }
    }
    if (!part) return false;
    out.t = best;
    out.point[0] = o[0] + dir[0] * best; out.point[1] = o[1] + dir[1] * best; out.point[2] = o[2] + dir[2] * best;
    if (part === 'body') {
      const nx = out.point[0] - this.shown[0], ny = out.point[1] - this.shown[1], nz = out.point[2] - this.shown[2], l = Math.hypot(nx, ny, nz) || 1;
      out.normal[0] = nx / l; out.normal[1] = ny / l; out.normal[2] = nz / l;
      // Into the open maw: the front, around the mouth line, while the jaw is open.
      const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
      const fwd = (nx * s - nz * c) / l;
      if (this.jaw.x > 15 * RAD && fwd > 0.45 && ny / l > -0.25 && ny / l < 0.45) region = 'maw';
    } else {
      out.normal[0] = -dir[0]; out.normal[1] = -dir[1]; out.normal[2] = -dir[2];
    }
    out.part = part;
    out.region = region;
    out.index = this.index;
    out.surface = 0;
    return true;
  }

  /** World matrix of a rig part (for gibs that replace it). */
  partMatrix(name: 'body' | 'lid' | 'crown'): Mat4 {
    return (name === 'body' ? this.body : name === 'lid' ? this.lid : this.crown).world;
  }

  legSegment(i: number, lower: boolean, a: V3, b: V3) {
    const L = this.legs[i], info = this.model.legs[i];
    const seg = lower ? L.lower : L.upper;
    this.rig.point(seg, [0, 0, 0], a);
    this.rig.point(seg, lower ? info.shin : info.thigh, b);
  }

  /** Planted feet this frame (for footstep sounds / debug). */
  footPos(i: number) {
    return this.legs[i].foot;
  }

  hide() {
    this.active = false;
    this.rig.visible = false;
    this.rig.commit();
  }

  get frameMatrix() {
    return this.frame.world;
  }
}
