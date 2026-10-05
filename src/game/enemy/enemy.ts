import { mat4, quat, type Mat4 } from 'wgpu-matrix';
import type { Renderer, Renderable } from '../../engine/render/renderer';
import type { CollisionWorld } from '../../engine/scene/collision';
import type { FirstPersonController } from '../../engine/player/controller';
import { CharacterMotor } from '../../engine/physics/character';
import { Rig, type RigPart, type RigPartSource } from '../../engine/scene/rig';
import { rayCapsule, raySphere, closestOnSegment } from '../../engine/physics/shapes';
import { spring, stepSpring, approach, type Spring1 } from '../../engine/core/spring';
import { surfaceId } from '../../engine/scene/surfaces';
import type { Hittable, ShotHit } from '../combat/hitscan';
import type { EnemyDef } from './def';
import { Ragdoll } from './ragdoll';

const RAD = Math.PI / 180;
const FLESH = surfaceId('flesh');

export type EnemyState = 'idle' | 'chase' | 'attack' | 'stagger' | 'dead';

/** Per-part reaction springs (pitch, yaw, roll radians in the part's frame). */
interface PartReaction {
  part: RigPart;
  x: Spring1;
  y: Spring1;
  z: Spring1;
  squash: Spring1;
}

/**
 * One enemy: a rigid-part rig driven by procedural animation, a capsule motor
 * against the static world, a small state machine (idle → chase → attack,
 * stagger, dead) and capsule hitboxes per part. Ticks at the game's fixed
 * rate; `pose` interpolates and animates per frame.
 */
export class Enemy implements Hittable {
  readonly rig: Rig;
  readonly motor: CharacterMotor;
  state: EnemyState = 'idle';
  health: number;
  yaw = 0;
  /** Gait phase (one step = π), speed (m/s). */
  phase = 0;
  speed = 0;
  attackT = 0;
  cooldown = 0;
  stagger = 0;
  staggerT = 0;
  deadT = 0;
  private prevFeet: [number, number, number] = [0, 0, 0];
  private prevYaw = 0;
  private headYaw = 0;
  private headPitch = 0;
  private parts = new Map<string, RigPart>();
  readonly reactions: PartReaction[] = [];
  private bodyKick = { x: spring(), z: spring() };
  /** World-space hit capsules (a xyz, b xyz, r) refreshed by `pose`. */
  private caps: Float64Array;
  private center: [number, number, number] = [0, 0, 0];
  private root: Mat4 = mat4.identity();
  private tmp: [number, number, number] = [0, 0, 0];
  private q = quat.create();
  /** Death physics (null while alive). */
  ragdoll: Ragdoll | null = null;
  /** Fires at the strike moment of an attack that reaches the player. */
  onStrike: ((e: Enemy) => void)[] = [];
  /** The body (pelvis / chest) hits the ground after death: position, impact speed. */
  onBodyLand: ((e: Enemy, pos: ArrayLike<number>, speed: number) => void)[] = [];
  private landed = false;

  constructor(readonly id: string, public def: EnemyDef, private renderer: Renderer, collision: CollisionWorld, parts: RigPartSource[], renderables: Renderable[], at: [number, number, number], yawDeg: number) {
    this.rig = new Rig(renderer, id, { castShadow: true }).add(parts, renderables);
    for (const p of this.rig.parts) {
      this.parts.set(p.name, p);
      this.reactions.push({ part: p, x: spring(), y: spring(), z: spring(), squash: spring() });
    }
    this.motor = new CharacterMotor(collision, { radius: def.radius, height: def.height, stepHeight: def.stepHeight, maxSlope: 46 });
    this.motor.feet = [at[0], at[1], at[2]];
    this.motor.refreshGround();
    this.yaw = this.prevYaw = yawDeg * RAD;
    this.prevFeet = [...this.motor.feet];
    this.health = def.health;
    this.caps = new Float64Array(def.hitboxes.length * 7);
  }

  get feet() {
    return this.motor.feet;
  }

  get alive() {
    return this.state !== 'dead';
  }

  /** Fixed tick: senses the player, decides, moves. */
  tick(h: number, player: FirstPersonController) {
    const D = this.def, m = this.motor, v = m.velocity;
    this.prevFeet[0] = m.feet[0]; this.prevFeet[1] = m.feet[1]; this.prevFeet[2] = m.feet[2];
    this.prevYaw = this.yaw;
    const dx = player.feet[0] - m.feet[0], dz = player.feet[2] - m.feet[2];
    const dist = Math.hypot(dx, dz);
    const toYaw = Math.atan2(dx, -dz);
    let wantSpeed = 0;
    let turn = true;
    this.cooldown = Math.max(0, this.cooldown - h);
    this.stagger = Math.max(0, this.stagger - D.reactions.staggerDecay * h);

    switch (this.state) {
      case 'idle':
        if (dist < D.move.sightRange) this.state = 'chase';
        break;
      case 'chase':
        wantSpeed = dist > D.move.chaseDistance ? D.move.chaseSpeed : D.move.walkSpeed;
        if (dist < D.attack.range && this.cooldown <= 0) {
          this.state = 'attack';
          this.attackT = 0;
        }
        break;
      case 'attack': {
        this.attackT += h;
        const A = D.attack, strikeAt = A.windup;
        if (this.attackT - h < strikeAt && this.attackT >= strikeAt && dist < A.range + 0.35) for (const f of this.onStrike) f(this);
        // Commit to the swing: no turning once the strike starts.
        turn = this.attackT < A.windup * 0.7;
        if (this.attackT > A.windup + A.strike + A.recover) {
          this.state = 'chase';
          this.cooldown = A.cooldown;
        }
        break;
      }
      case 'stagger':
        this.staggerT -= h;
        turn = false;
        if (this.staggerT <= 0) this.state = 'chase';
        break;
      case 'dead':
        this.deadT += h;
        if (this.ragdoll) {
          this.ragdoll.step(h, m.collision!);
          // A slow crumple may touch down too gently for a contact event: settle it here.
          if (!this.landed && this.deadT > 1.2) {
            const j = this.ragdoll.joint('pelvis') ?? this.ragdoll.body.particles[0];
            this.landed = true;
            for (const f of this.onBodyLand) f(this, j.pos, 0.5);
          }
          return;
        }
        turn = false;
        break;
    }

    // Turn towards the player; walk along the facing (a creature turns before it strides).
    if (turn && this.state !== 'idle') {
      let e = toYaw - this.yaw;
      e = Math.atan2(Math.sin(e), Math.cos(e));
      const step = D.move.turnRate * RAD * h;
      this.yaw += Math.max(-step, Math.min(step, e));
    }
    let err = toYaw - this.yaw;
    err = Math.atan2(Math.sin(err), Math.cos(err));
    const align = Math.max(0, Math.cos(err));
    const slow = this.stagger > 0 ? 1 - D.reactions.flinchSlow * Math.min(1, this.stagger / D.reactions.staggerThreshold) : 1;
    const target = this.state === 'chase' ? wantSpeed * align * slow : 0;
    const fx = Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const cur = v[0] * fx + v[2] * fz;
    const ns = cur + Math.max(-D.move.accel * h * 2, Math.min(D.move.accel * h, target - cur));
    // Keep any knockback (decays), steer the rest along the facing.
    const kx = v[0] - fx * cur, kz = v[2] - fz * cur, kd = Math.exp(-6 * h);
    v[0] = fx * ns + kx * kd;
    v[2] = fz * ns + kz * kd;
    if (this.state === 'dead') { v[0] *= kd; v[2] *= kd; }
    v[1] -= 16 * h;
    const x0 = m.feet[0], z0 = m.feet[2];
    m.move(h);
    const moved = Math.hypot(m.feet[0] - x0, m.feet[2] - z0);
    this.speed = moved / h;
    if (m.grounded) this.phase += (moved / D.gait.stride) * Math.PI;

    // Personal space with the player (the creature is heavier).
    if (this.state !== 'dead') {
      const rr = D.radius + player.tuning.radius;
      const ex = player.feet[0] - m.feet[0], ez = player.feet[2] - m.feet[2], ed = Math.hypot(ex, ez);
      if (ed < rr && ed > 1e-4 && Math.abs(player.feet[1] - m.feet[1]) < 1.5) {
        const push = rr - ed, nx = ex / ed, nz = ez / ed;
        player.feet[0] += nx * push * 0.7; player.feet[2] += nz * push * 0.7;
        m.feet[0] -= nx * push * 0.3; m.feet[2] -= nz * push * 0.3;
      }
    }
    if (m.feet[1] < -100) this.state = 'dead';
  }

  /**
   * A shot hit `region` with `impulse` (N·s) along `dir` at `point`. Alive:
   * damage, reactions, maybe death (ragdoll from the current pose, the killing
   * impulse, the head popping off on a killing headshot). Dead: pushes the
   * ragdoll. Returns true when this hit killed it.
   */
  hit(damage: number, region: string, point: ArrayLike<number>, dir: ArrayLike<number>, impulse: number, partName: string, h = 1 / 120): boolean {
    if (!this.alive) {
      this.ragdoll?.body.impulse(point, dir, impulse * 1.6, 0.5, h);
      return false;
    }
    const D = this.def, R = D.reactions;
    this.health -= damage;
    const reg = D.regions[region] ?? { damage: 1, stagger: 1 };
    this.stagger += damage * reg.stagger;
    this.applyReaction(point, dir, impulse, partName);
    if (this.health <= 0) {
      this.state = 'dead';
      this.deadT = 0;
      this.ragdoll = new Ragdoll(D, this.rig, this.motor.velocity, h);
      // A heavy round knocks it over: the killing impulse plus a shove at the hips (it crumples, then falls).
      this.ragdoll.body.impulse(point, dir, impulse * 3.2, 0.55, h);
      const pel = this.ragdoll.joint('pelvis');
      if (pel) this.ragdoll.body.impulse(pel.pos, [dir[0], 0, dir[2]], impulse * 1.2, 0.4, h);
      if (region === 'head' && D.impact.headPop) this.ragdoll.popHead(dir, 3.2, h);
      this.ragdoll.body.onContact = (i, speed) => {
        const P = this.ragdoll!.body.particles;
        const pel2 = this.ragdoll!.joint('pelvis'), ch = this.ragdoll!.joint('chest');
        if (!this.landed && (P[i] === pel2 || P[i] === ch) && speed > 0.2) {
          this.landed = true;
          for (const f of this.onBodyLand) f(this, P[i].pos, speed);
        }
      };
      return true;
    }
    if (this.stagger > R.staggerThreshold && this.state !== 'stagger') {
      // Stumble: shoved back along the shot, rocking back hard, arms thrown up (see pose).
      this.state = 'stagger';
      this.staggerT = R.staggerTime;
      this.stagger *= 0.4;
      const v = this.motor.velocity, w = 2 * Math.PI * R.springHz;
      v[0] += dir[0] * 1.4; v[2] += dir[2] * 1.4;
      const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
      const lz = -dir[0] * sy + dir[2] * cy;
      this.bodyKick.x.v += -Math.sign(lz || 1) * 0.5 * w;
    }
    return false;
  }

  /** Angular kicks on the hit part and its parents, a body flinch and knockback. */
  applyReaction(point: ArrayLike<number>, dir: ArrayLike<number>, impulse: number, partName: string) {
    const R = this.def.reactions, w = 2 * Math.PI * R.springHz;
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    // Shot direction in the creature's frame (x right, z back).
    const lx = dir[0] * cy + dir[2] * sy, lz = -dir[0] * sy + dir[2] * cy;
    let p: RigPart | undefined = this.parts.get(partName);
    let k = 1;
    while (p) {
      const r = this.reactions[this.rig.parts.indexOf(p)];
      // Pushed back along the shot: pitch from the forward component, roll from the side.
      r.x.v += -lz * impulse * R.partKick * k * w * 0.05;
      r.z.v += -lx * impulse * R.partKick * k * w * 0.05;
      r.y.v += (Math.random() - 0.5) * impulse * R.partKick * k * w * 0.03;
      r.squash.v -= impulse * R.squash * k * w * 0.05;
      k *= 0.45;
      p = p.parent >= 0 ? this.rig.parts[p.parent] : undefined;
    }
    this.bodyKick.x.v += -lz * impulse * R.bodyKick * w * 0.02;
    this.bodyKick.z.v += -lx * impulse * R.bodyKick * w * 0.02;
    const v = this.motor.velocity;
    v[0] += dir[0] * impulse * R.knockback * 0.1;
    v[2] += dir[2] * impulse * R.knockback * 0.1;
    void point;
  }

  /** Per frame: interpolated root, procedural animation (or the ragdoll), reaction springs, hit capsules. */
  pose(dt: number, alpha: number, player: FirstPersonController) {
    if (this.ragdoll) {
      this.ragdoll.apply();
      // Last moments of a corpse: it sinks into the ground instead of vanishing.
      const sink = Math.max(0, this.deadT - (this.def.corpseTime - 1.5)) / 1.5;
      if (sink > 0) for (const p of this.rig.parts) p.world[13] -= sink * sink * 0.6;
      this.rig.commit(2);
      this.updateCapsules();
      return;
    }
    const D = this.def, G = D.gait, m = this.motor;
    const fx = this.prevFeet[0] + (m.feet[0] - this.prevFeet[0]) * alpha;
    const fy = this.prevFeet[1] + (m.feet[1] - this.prevFeet[1]) * alpha;
    const fz = this.prevFeet[2] + (m.feet[2] - this.prevFeet[2]) * alpha;
    let dy = this.yaw - this.prevYaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    const yaw = this.prevYaw + dy * alpha;
    mat4.translation([fx, fy, fz], this.root);
    mat4.rotateY(this.root, -yaw, this.root);

    for (const r of this.reactions) {
      stepSpring(r.x, 0, D.reactions.springHz, D.reactions.springDamping, dt);
      stepSpring(r.y, 0, D.reactions.springHz, D.reactions.springDamping, dt);
      stepSpring(r.z, 0, D.reactions.springHz, D.reactions.springDamping, dt);
      stepSpring(r.squash, 0, D.reactions.springHz * 1.6, 0.4, dt);
    }
    stepSpring(this.bodyKick.x, 0, D.reactions.springHz * 0.8, 0.45, dt);
    stepSpring(this.bodyKick.z, 0, D.reactions.springHz * 0.8, 0.45, dt);

    const sp = Math.min(1.3, this.speed / Math.max(0.1, D.move.walkSpeed));
    const ph = this.phase, s = Math.sin(ph), c = Math.cos(ph);
    const set = (name: string, px: number, py: number, pz: number, ty = 0, tz = 0) => {
      const p = this.parts.get(name);
      if (!p) return;
      const r = this.reactions[this.rig.parts.indexOf(p)];
      quat.fromEuler(px + r.x.x, py + r.y.x, pz + r.z.x, 'yxz', p.rot);
      p.pos[1] = ty; p.pos[2] = tz;
      const sq = 1 + r.squash.x;
      p.scale[0] = p.scale[2] = 1 / Math.sqrt(Math.max(0.5, sq)); p.scale[1] = sq;
    };
    const dead = this.state === 'dead';
    // Head tracks the player (limited), unless dead.
    const toYaw = Math.atan2(player.feet[0] - fx, -(player.feet[2] - fz));
    let hy = Math.atan2(Math.sin(toYaw - yaw), Math.cos(toYaw - yaw));
    hy = dead ? 0 : Math.max(-1, Math.min(1, hy));
    const hp = dead ? 0 : Math.max(-0.5, Math.min(0.5, Math.atan2((player.feet[1] + 1.5) - (fy + 1.45), Math.hypot(player.feet[0] - fx, player.feet[2] - fz))));
    this.headYaw += (hy - this.headYaw) * approach(6, dt);
    this.headPitch += (hp - this.headPitch) * approach(6, dt);

    // Attack swing (right arm), body twist.
    let armR = 0, twist = 0, forearmR = 0.35;
    if (this.state === 'attack') {
      const A = D.attack, t = this.attackT;
      if (t < A.windup) { const u = t / A.windup; armR = 2.3 * u * u * (3 - 2 * u); twist = 0.35 * u; forearmR = 0.35 + 0.6 * u; }
      else if (t < A.windup + A.strike) { const u = (t - A.windup) / A.strike; armR = 2.3 - 3.0 * u; twist = 0.35 - 0.7 * u; forearmR = 0.95 - 0.8 * u; }
      else { const u = Math.min(1, (t - A.windup - A.strike) / A.recover); armR = -0.7 * (1 - u); twist = -0.35 * (1 - u); forearmR = 0.15 + 0.2 * u; }
    }
    // Stagger: arms thrown up and out, leaning back while it regains balance.
    const st = this.state === 'stagger' ? Math.min(1, this.staggerT / Math.max(0.05, D.reactions.staggerTime)) : 0;
    const stE = Math.sin(st * Math.PI * 0.5);
    // Death without a ragdoll (fell off the map): topple backwards.
    const fall = dead ? Math.min(1, this.deadT / 0.6) : 0;
    const fallE = fall * fall;
    const bob = -G.bob * Math.abs(s) * sp;
    const lean = -G.lean * RAD * Math.min(1, sp);
    const breathe = Math.sin(performance.now() / 700) * 0.015 * (1 - Math.min(1, sp));
    set('body', lean + this.bodyKick.x.x + fallE * 1.45 + stE * 0.25, twist, G.roll * RAD * c * sp + this.bodyKick.z.x, bob + breathe - fallE * 0.62, 0);
    set('head', -this.headPitch, this.headYaw - twist, 0);
    set('arm_l', -G.armSwing * RAD * s * sp - fallE * 1.2 + stE * 1.1, 0, -0.12 - fallE * 0.5 - stE * 0.6);
    set('arm_r', -G.armSwing * RAD * s * sp * (this.state === 'attack' ? 0 : 1) + armR - fallE * 1.2 + stE * 0.9, 0, 0.12 + fallE * 0.5 + stE * 0.7);
    set('forearm_l', 0.35 + 0.15 * s * sp, 0, 0);
    set('forearm_r', forearmR, 0, 0);
    set('leg_l', G.legSwing * RAD * s * sp + fallE * 0.6, 0, -0.04);
    set('leg_r', -G.legSwing * RAD * s * sp + fallE * 0.9, 0, 0.04);
    set('shin_l', -G.kneeBend * RAD * Math.max(0, c) * sp - fallE * 0.4, 0, 0);
    set('shin_r', -G.kneeBend * RAD * Math.max(0, -c) * sp - fallE * 0.7, 0, 0);
    this.rig.update(this.root, 2);
    this.updateCapsules();
  }

  /** Hit capsules in world space (from the parts as posed). */
  private updateCapsules() {
    const D = this.def;
    const H = D.hitboxes;
    for (let i = 0; i < H.length; i++) {
      const hb = H[i], p = this.parts.get(hb.part);
      if (!p) continue;
      const o = i * 7;
      this.rig.point(p, hb.a, this.tmp);
      this.caps[o] = this.tmp[0]; this.caps[o + 1] = this.tmp[1]; this.caps[o + 2] = this.tmp[2];
      this.rig.point(p, hb.b, this.tmp);
      this.caps[o + 3] = this.tmp[0]; this.caps[o + 4] = this.tmp[1]; this.caps[o + 5] = this.tmp[2];
      this.caps[o + 6] = hb.r;
    }
    const body = this.parts.get('body');
    if (body) { this.center[0] = body.world[12]; this.center[1] = body.world[13] + 0.2; this.center[2] = body.world[14]; }
    void this.q;
  }

  /** Hittable: nearest capsule along the ray. */
  raycast(o: ArrayLike<number>, d: ArrayLike<number>, maxT: number, out: ShotHit): boolean {
    if (raySphere(o, d, this.center, 1.4) < 0) return false;
    let best = maxT, bi = -1;
    const C = this.caps, A: [number, number, number] = [0, 0, 0], B: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < this.def.hitboxes.length; i++) {
      const k = i * 7;
      A[0] = C[k]; A[1] = C[k + 1]; A[2] = C[k + 2]; B[0] = C[k + 3]; B[1] = C[k + 4]; B[2] = C[k + 5];
      const t = rayCapsule(o, d, A, B, C[k + 6]);
      if (t >= 0 && t < best) { best = t; bi = i; }
    }
    if (bi < 0) return false;
    const k = bi * 7;
    out.t = best;
    out.point[0] = o[0] + d[0] * best; out.point[1] = o[1] + d[1] * best; out.point[2] = o[2] + d[2] * best;
    A[0] = C[k]; A[1] = C[k + 1]; A[2] = C[k + 2]; B[0] = C[k + 3]; B[1] = C[k + 4]; B[2] = C[k + 5];
    const q = closestOnSegment(out.point, A, B, this.tmp);
    const nx = out.point[0] - q[0], ny = out.point[1] - q[1], nz = out.point[2] - q[2], nl = Math.hypot(nx, ny, nz) || 1;
    out.normal[0] = nx / nl; out.normal[1] = ny / nl; out.normal[2] = nz / nl;
    out.region = this.def.hitboxes[bi].region;
    out.surface = FLESH;
    out.owner = this.id;
    out.part = this.def.hitboxes[bi].part;
    return true;
  }

  /** World-space capsules (debug drawing). */
  capsules(): Float64Array {
    return this.caps;
  }

  destroy(renderables: Renderable[]) {
    for (const p of this.rig.parts) {
      if (!p.r) continue;
      p.r.visible = false;
      const i = renderables.indexOf(p.r);
      if (i >= 0) renderables.splice(i, 1);
      this.renderer.instances.free(p.r.slot);
    }
  }
}
