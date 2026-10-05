import { quat, vec3, type Mat4, type Quat } from 'wgpu-matrix';
import type { World } from '../../engine/scene/world';
import type { ParticleSystem } from '../../engine/render/particles';
import type { Debris, DebrisMesh } from '../../engine/physics/debris';
import type { GpuMesh } from '../../engine/render/geometry';
import type { GameAudio } from '../audio/gameaudio';
import type { TomatoDef } from './def';
import type { TomatoModel } from './model';
import type { Tomato } from './tomato';

const SPLATS = ['decal_tomato_splat_a', 'decal_tomato_splat_b', 'decal_tomato_splat_c'];
export const GORE_DECALS = [...SPLATS, 'decal_tomato_drip', 'decal_tomato_streak'];
/** Debris tag: paints a splat where it lands. */
const PAINT = 1;

type V3 = [number, number, number];

/**
 * Tomato gore: the death burst (gibs, spray, mist, splats on the ground and
 * walls nearby, timed to the flying drops), bullet-hit spurts, legs torn off,
 * and splats where gibs land. All tuning in TomatoDef.gore.
 */
export class TomatoGore {
  private queue: { t: number; mat: string; p: V3; n: V3; size: number; angle?: number }[] = [];
  private time = 0;
  private lastSplatSound = 0;
  private q: Quat = quat.create();
  private v: V3 = [0, 0, 0];
  private centres = new Map<string, V3>();
  /** The camera position (set each frame): far bursts spend fewer particles. */
  viewer: ArrayLike<number> = [0, 0, 0];

  constructor(private world: World, private particles: ParticleSystem, private debris: Debris, private audio: GameAudio, private model: TomatoModel, public def: TomatoDef) {
    for (const p of model.parts) {
      const m = p.mesh as GpuMesh | null;
      if (m) this.centres.set(p.name, [(m.aabb.min[0] + m.aabb.max[0]) / 2, (m.aabb.min[1] + m.aabb.max[1]) / 2, (m.aabb.min[2] + m.aabb.max[2]) / 2]);
    }
    debris.onImpact.push((pos, n, speed, surface, tag, scale) => {
      if (tag !== PAINT) return;
      const wall = n[1] < 0.5;
      const size = (0.22 + Math.random() * 0.3) * scale * Math.min(1.4, 0.5 + speed * 0.15);
      this.world.addDecal(wall ? 'decal_tomato_drip' : this.pick(), pos, n, size, true, wall ? 0 : undefined);
      if (this.time - this.lastSplatSound > 0.035) {
        this.lastSplatSound = this.time;
        this.audio.play('tomato_splat', { pos, gain: Math.min(4, -6 + speed * 1.5) });
      }
    });
  }

  private pick() {
    return SPLATS[Math.floor(Math.random() * SPLATS.length)];
  }

  private rnd(a: number, b: number) {
    return a + Math.random() * (b - a);
  }

  /** The blast direction: the killing shot's, lifted a little (or a random horizontal one). */
  private mainDir(dir: ArrayLike<number> | null): V3 {
    if (dir) return vec3.normalize([dir[0], Math.max(-0.2, dir[1]) + 0.18, dir[2]]) as V3;
    const a = Math.random() * Math.PI * 2;
    return vec3.normalize([Math.cos(a), 0.3, Math.sin(a)]) as V3;
  }

  /** A random direction within `cone` (radians) of `d`, lifted by `up`. */
  private inCone(d: ArrayLike<number>, cone: number, up: number): V3 {
    const ref = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const x = vec3.normalize(vec3.cross(d, ref)), y = vec3.cross(d, x);
    const a = Math.random() * Math.PI * 2, t = Math.tan(cone * Math.sqrt(Math.random()));
    return vec3.normalize([
      d[0] + (x[0] * Math.cos(a) + y[0] * Math.sin(a)) * t,
      d[1] + (x[1] * Math.cos(a) + y[1] * Math.sin(a)) * t + up,
      d[2] + (x[2] * Math.cos(a) + y[2] * Math.sin(a)) * t,
    ]) as V3;
  }

  /**
   * A jet of liquid: blobs leaving one point in nearly the same direction at a spread of speeds, so
   * they string out into a stream that arcs under gravity and breaks up into drops.
   */
  private jet(from: ArrayLike<number>, d: ArrayLike<number>, n: number, speed: [number, number], size: [number, number], color: [number, number, number], inherit: ArrayLike<number>, sheet = true) {
    this.particles.emit('drop', { count: n, pos: from, dir: d, spread: 0.07, speed, life: [0.8, 1.8], size, color, alpha: 1, drag: 0.3, gravity: 9.8, stretch: true, addVel: inherit });
    if (!sheet) return;
    // The stream's body: a lit liquid sheet flung along the jet for its first few frames.
    const L = (speed[0] + speed[1]) * 0.085, w = L * 0.17, sp = Math.max(0, (L * 0.5 - w) / 0.012);
    this.particles.emit('splash', { pos: [from[0] + d[0] * L * 0.45, from[1] + d[1] * L * 0.45, from[2] + d[2] * L * 0.45], dir: d, spread: 0, speed: [sp, sp], life: [0.14, 0.26], size: [w * 0.7, w], color, alpha: 1, stretch: true, fixed: true });
  }

  /** World centre and orientation of a rig part (its mesh bounds centre), for the gib that replaces it. */
  private partPose(t: Tomato, name: string, world: Mat4, outPos: V3, outRot: Quat) {
    const c = this.centres.get(name) ?? [0, 0, 0];
    vec3.transformMat4(c, world, outPos);
    quat.fromMat(world, outRot);
    quat.normalize(outRot, outRot);
  }

  private throwPiece(m: DebrisMesh, pos: ArrayLike<number>, rot: ArrayLike<number>, from: ArrayLike<number>, speed: number, up: number, inherit: ArrayLike<number>, push: ArrayLike<number> | null, scale = 1) {
    const G = this.def.gore;
    let dx = pos[0] - from[0], dy = pos[1] - from[1], dz = pos[2] - from[2];
    const l = Math.hypot(dx, dy, dz);
    if (l < 1e-4) { dx = Math.random() - 0.5; dy = 0.3; dz = Math.random() - 0.5; } else { dx /= l; dy /= l; dz /= l; }
    const v = this.v;
    v[0] = dx * speed + inherit[0] * 0.6 + (push ? push[0] : 0) + (Math.random() - 0.5) * 1.5;
    v[1] = dy * speed + up + inherit[1] * 0.3 + (push ? push[1] : 0);
    v[2] = dz * speed + inherit[2] * 0.6 + (push ? push[2] : 0) + (Math.random() - 0.5) * 1.5;
    const w = G.gibSpin;
    this.debris.spawn(m, pos, rot, v, [(Math.random() - 0.5) * w * 2, (Math.random() - 0.5) * w * 2, (Math.random() - 0.5) * w * 2], {
      scale, life: G.gibLife * (0.8 + Math.random() * 0.4), bounce: 0.12, friction: 0.35, stick: 0.45, tag: PAINT,
    });
  }

  /** The death burst. `point`/`dir`/`impulse`: the killing shot (or null). */
  burst(t: Tomato, point: ArrayLike<number> | null, dir: ArrayLike<number> | null, impulse: number) {
    const G = this.def.gore, P = this.particles, C = this.world.collision;
    const S = this.def.scale, c = t.shown, r = this.def.radius * S;
    // Far away a burst is small on screen: fewer particles (a horde dies many at a time).
    const dv = Math.hypot(c[0] - this.viewer[0], c[1] - this.viewer[1], c[2] - this.viewer[2]);
    const q = Math.max(0.3, Math.min(1, 1.35 - dv / 30));
    const n = (x: number) => Math.max(1, Math.round(x * q));
    const push: V3 | null = dir ? [dir[0] * impulse * 0.22, dir[1] * impulse * 0.1 + 0.6, dir[2] * impulse * 0.22] : null;
    const inherit = t.vel;
    const pos: V3 = [0, 0, 0];
    // Whole pieces: lid (and crown on it), every leg segment still on.
    this.partPose(t, 'lid', t.partMatrix('lid'), pos, this.q);
    this.throwPiece(this.model.lid, pos, this.q, [c[0], c[1] - 0.2, c[2]], this.rnd(2, 4), this.rnd(3, 5.5), inherit, push, S);
    this.partPose(t, 'crown', t.partMatrix('crown'), pos, this.q);
    this.throwPiece(this.model.crown, pos, this.q, c, this.rnd(2, 4), this.rnd(4, 7), inherit, push, S);
    for (let i = 0; i < 6; i++) {
      const L = t.legs[i];
      if (L.lost) continue;
      const legs = this.model.legs[i];
      this.partPose(t, legs.upper, L.upper.world, pos, this.q);
      this.throwPiece(this.model.legUpper, pos, this.q, c, this.rnd(2, 5), this.rnd(1, 3), inherit, push, S);
      this.partPose(t, legs.lower, L.lower.world, pos, this.q);
      this.throwPiece(this.model.legLower, pos, this.q, c, this.rnd(1.5, 4), this.rnd(0.5, 2.5), inherit, push, S);
    }
    // The body bursts into skin shells, wall chunks and pulp.
    const spawnSet = (set: DebrisMesh[], [a, b]: [number, number]) => {
      const n = a + Math.floor(Math.random() * (b - a + 1));
      for (let k = 0; k < n && set.length; k++) {
        const m = set[Math.floor(Math.random() * set.length)];
        const d = vec3.normalize([Math.random() - 0.5, Math.random() * 0.8 - 0.2, Math.random() - 0.5]);
        pos[0] = c[0] + d[0] * r * 0.6; pos[1] = c[1] + d[1] * r * 0.5; pos[2] = c[2] + d[2] * r * 0.6;
        quat.fromEuler(Math.random() * 6.3, Math.random() * 6.3, Math.random() * 6.3, 'xyz', this.q);
        this.throwPiece(m, pos, this.q, c, this.rnd(G.gibSpeed[0], G.gibSpeed[1]), this.rnd(1.5, 4), inherit, push, this.rnd(G.gibScale[0], G.gibScale[1]) * S);
      }
    };
    spawnSet(this.model.shells, G.shells);
    spawnSet(this.model.chunks, G.chunks);
    spawnSet(this.model.pulp, G.pulp);

    // The red explosion, directional: thick glossy jets blasted out along the killing shot, a gush back
    // out of the entry, big blobs bursting from the core, a fine all-round spray.
    const g = C.groundHeight(c[0], c[1] + 0.2, c[2], 4);
    const floor = g > -Infinity ? g : c[1] - 1;
    const hv: V3 = [inherit[0] * 0.5, inherit[1] * 0.3, inherit[2] * 0.5];
    const main = this.mainDir(dir);
    const cone = G.jetCone * Math.PI / 180, ma = Math.atan2(main[2], main[0]);
    for (let k = 0; k < G.jets; k++) {
      const d = this.inCone(main, cone, 0.12);
      this.jet([c[0] + d[0] * r * 0.6, c[1] + d[1] * r * 0.6, c[2] + d[2] * r * 0.6], d, n(G.jetBlobs), G.jetSpeed, [G.jetSize[0] * S, G.jetSize[1] * S], k % 3 === 2 ? G.juice : G.red, hv);
    }
    const back: V3 = [-main[0], 0.35 - main[1] * 0.5, -main[2]];
    vec3.normalize(back, back);
    for (let k = 0; k < G.backJets; k++) {
      const d = this.inCone(back, cone * 1.2, 0.1);
      this.jet([c[0] + d[0] * r * 0.7, c[1] + d[1] * r * 0.7, c[2] + d[2] * r * 0.7], d, n(G.jetBlobs * 0.55), [G.jetSpeed[0] * 0.5, G.jetSpeed[1] * 0.5], [G.jetSize[0] * S * 0.8, G.jetSize[1] * S * 0.8], G.red, hv);
    }
    // Core: big blobs leaving slowly, biased along the blast (the bursting volume).
    P.emit('drop', { count: n(G.coreBlobs), pos: c, dir: [main[0] * 0.6, 0.35, main[2] * 0.6], spread: 0.9, speed: [0.6, 4.5], life: [0.4, 0.85], size: [G.coreSize[0] * S, G.coreSize[1] * S], color: G.red, alpha: 1, drag: 1.2, gravity: 6, stretch: true, addVel: hv });
    P.emit('drop', { count: n(G.coreBlobs * 0.4), pos: c, dir: [main[0] * 0.5, 0.3, main[2] * 0.5], spread: 0.9, speed: [0.5, 3.4], life: [0.35, 0.7], size: [G.coreSize[0] * S * 0.8, G.coreSize[1] * S * 0.8], color: G.juice, alpha: 1, drag: 1.2, gravity: 6, stretch: true, addVel: hv });
    P.emit('drop', { count: n(G.drops), pos: c, dir: [0, 0.45, 0], spread: 1, speed: G.dropSpeed, life: [0.6, 1.4], size: [G.dropSize[0] * S, G.dropSize[1] * S], color: G.red, alpha: 1, drag: 0.5, gravity: 9.8, stretch: true, addVel: hv });
    // A dark burst behind it all: the volume's silhouette for the first few frames.
    if (G.pops > 0) P.emit('splash', { count: G.pops, pos: c, dir: [main[0] * 0.5, 0.5, main[2] * 0.5], spread: 0.8, speed: [0.4, 2.4], life: G.popLife, size: [G.popSize[0] * S, G.popSize[1] * S], color: G.red, alpha: 1, drag: 3, gravity: 1, addVel: hv });
    for (let k = 0; k < G.sprays; k++) {
      const d = this.inCone(main, cone * 1.4, 0.15);
      const L = this.rnd(G.sprayLength[0], G.sprayLength[1]) * S, w = L * this.rnd(0.16, 0.24);
      const half = L * 0.5, sp = Math.max(0, (half - w) / 0.012);
      P.emit('splash', { pos: [c[0] + d[0] * half * 0.8, c[1] + d[1] * half * 0.8, c[2] + d[2] * half * 0.8], dir: d, spread: 0, speed: [sp, sp], life: G.sprayLife, size: [w * 0.7, w], color: k % 2 ? G.juice : G.red, alpha: 1, stretch: true, fixed: true });
    }
    P.emit('debris', { count: n(G.blobs), pos: c, dir: [0, 0.6, 0], spread: 1, speed: [2, 7.5], life: [1.4, 2.8], size: [G.blobSize[0] * S, G.blobSize[1] * S], color: G.flesh, alpha: 1, drag: 0.4, gravity: 9.8, floor });
    P.emit('debris', { count: n(G.seeds), pos: c, dir: [0, 0.5, 0], spread: 1, speed: [1.5, 6.5], life: [1.0, 2.2], size: [0.006, 0.011], color: G.seed, alpha: 1, drag: 0.5, gravity: 9.8, floor });
    P.emit('smoke', { count: 4, pos: c, dir: [0, 0.4, 0], spread: 1, speed: [1.5, 4], life: [0.3, 0.7], size: [0.2, 0.9 * S], color: G.juice, alpha: G.mist, drag: 5, gravity: 1.5 });

    // Paint: a pool under it now, satellites timed to the drops' flight, drips on walls in reach.
    if (g > -Infinity) this.world.addDecal(this.pick(), [c[0], g, c[2]], [0, 1, 0], this.rnd(G.poolSize[0], G.poolSize[1]), true);
    for (let k = 0; k < G.splats; k++) {
      const a = k < G.splats * 0.6 ? ma + (Math.random() - 0.5) * cone * 2.5 : Math.random() * Math.PI * 2;
      const d = 0.5 + Math.pow(Math.random(), 0.7) * G.splatRadius * (k < G.splats * 0.6 ? 1.3 : 0.7);
      const x = c[0] + Math.cos(a) * d, z = c[2] + Math.sin(a) * d;
      const gy = C.groundHeight(x, c[1] + 0.6, z, 4);
      if (gy > -Infinity) this.queue.push({ t: this.time + 0.08 + d * 0.09, mat: this.pick(), p: [x, gy, z], n: [0, 1, 0], size: this.rnd(G.splatSize[0], G.splatSize[1]) });
    }
    for (let k = 0; k < G.streaks; k++) {
      // Mostly flung along the blast, a few all round.
      const a = k < G.streaks * 0.7 ? ma + (Math.random() - 0.5) * cone * 2.2 : Math.random() * Math.PI * 2;
      const d = 0.8 + Math.random() * G.splatRadius * 0.9;
      const x = c[0] + Math.cos(a) * d, z = c[2] + Math.sin(a) * d;
      const gy = C.groundHeight(x, c[1] + 0.6, z, 4);
      // The texture sprays along +u: roll it so +u points away from the burst.
      if (gy > -Infinity) this.queue.push({ t: this.time + 0.06 + d * 0.07, mat: 'decal_tomato_streak', p: [x, gy, z], n: [0, 1, 0], size: this.rnd(1.8, 3.4) * S, angle: Math.atan2(Math.cos(a), Math.sin(a)) });
    }
    for (let k = 0; k < G.wallSplats; k++) {
      // Rays mostly along the blast: what is behind the tomato gets painted.
      const dir3 = k < G.wallSplats * 0.7 ? this.inCone(main, cone * 1.3, -0.1) : vec3.normalize([Math.cos(k * 2.4), (Math.random() - 0.3) * 0.5, Math.sin(k * 2.4)]);
      const hit = C.raycast(c, dir3, G.splatRadius + 1);
      if (!hit) continue;
      const wall = hit.normal[1] < 0.5;
      this.queue.push({ t: this.time + 0.05 + hit.t * 0.08, mat: wall ? 'decal_tomato_drip' : this.pick(), p: [...hit.point] as V3, n: [...hit.normal] as V3, size: this.rnd(G.splatSize[0], G.splatSize[1]) * 1.2, angle: wall ? 0 : undefined });
    }
    this.audio.play('tomato_burst', { pos: c });
  }

  /** A bullet into a live tomato: a red spurt out of the entry and a spray out of the exit, painting what is behind. */
  hitSpurt(t: Tomato, point: ArrayLike<number>, normal: ArrayLike<number>, dir: ArrayLike<number>, region: string) {
    const G = this.def.gore, P = this.particles, C = this.world.collision, S = this.def.scale;
    const n = region === 'maw' ? 1.8 : 1;
    const leg = region === 'leg';
    const out: V3 = [normal[0] * 0.8, normal[1] * 0.8 + 0.25, normal[2] * 0.8];
    // Entry: a short gush back out towards the shooter.
    this.jet(point, vec3.normalize(out), Math.round(10 * n), [1.2, 3.5], [0.014 * S, 0.03 * S], G.red, t.vel);
    if (!leg) {
      // Exit: the bullet blows a stream out of the far side.
      const rr = this.def.radius * S;
      const ex: V3 = [t.shown[0] + dir[0] * rr, t.shown[1] + dir[1] * rr, t.shown[2] + dir[2] * rr];
      const d: V3 = vec3.normalize([dir[0], dir[1] + 0.08, dir[2]]) as V3;
      this.jet(ex, d, Math.round(G.hitSpray * 1.4 * n), [3, 9], [0.016 * S, 0.04 * S], G.red, t.vel);
      const L2 = this.rnd(0.6, 1.1) * S * n, sp2 = (L2 * 0.5 - L2 * 0.12) / 0.012;
      P.emit('splash', { pos: [ex[0] + d[0] * L2 * 0.45, ex[1] + d[1] * L2 * 0.45, ex[2] + d[2] * L2 * 0.45], dir: d, spread: 0, speed: [sp2, sp2], life: [0.1, 0.18], size: [L2 * 0.1, L2 * 0.16], color: G.red, alpha: 1, stretch: true, fixed: true });
      if (Math.random() < G.hitSplatChance * n) {
        const hit = C.raycast(ex, dir, G.hitSplatReach) ?? C.raycast(ex, vec3.normalize([dir[0] * 0.5, -1, dir[2] * 0.5]), G.hitSplatReach + 1);
        if (hit) {
          const wall = hit.normal[1] < 0.5;
          this.queue.push({ t: this.time + 0.04 + hit.t * 0.06, mat: wall ? 'decal_tomato_drip' : this.pick(), p: [...hit.point] as V3, n: [...hit.normal] as V3, size: this.rnd(0.35, 0.7) * S, angle: wall ? 0 : undefined });
        }
      }
    }
    P.emit('debris', { count: 2 + Math.floor(Math.random() * 3), pos: point, dir: normal, spread: 0.7, speed: [1, 3.5], life: [1, 2], size: [0.01, 0.025], color: leg ? [0.05, 0.1, 0.02] : G.flesh, alpha: 1, drag: 0.5, gravity: 9.8 });
    this.audio.play('tomato_hit', { pos: point });
  }

  /** A leg shot off: both segments fly, the stump gushes. */
  legOff(t: Tomato, i: number, point: ArrayLike<number>, dir: ArrayLike<number>) {
    const G = this.def.gore, P = this.particles;
    const L = t.legs[i], legs = this.model.legs[i];
    const pos: V3 = [0, 0, 0];
    const push: V3 = [dir[0] * 2.5, 1.5, dir[2] * 2.5];
    this.partPose(t, legs.upper, L.upper.world, pos, this.q);
    const hip: V3 = [L.upper.world[12], L.upper.world[13], L.upper.world[14]];
    this.throwPiece(this.model.legUpper, pos, this.q, hip, this.rnd(1.5, 3), 1.5, t.vel, push, this.def.scale);
    this.partPose(t, legs.lower, L.lower.world, pos, this.q);
    this.throwPiece(this.model.legLower, pos, this.q, hip, this.rnd(1, 2.5), 1, t.vel, push, this.def.scale);
    P.emit('drop', { count: 30, pos: hip, dir: [legs.out[0], 0.6, legs.out[2]], spread: 0.45, speed: [1.5, 5], life: [0.4, 0.9], size: [0.014, 0.04], color: G.red, alpha: 1, drag: 0.8, gravity: 9.8, stretch: true, addVel: t.vel });
    P.emit('splash', { count: 1, pos: hip, dir: [0, 1, 0], spread: 0.3, speed: [0.2, 0.6], life: [0.15, 0.25], size: [0.08, 0.35], color: G.red, alpha: 0.95, drag: 3 });
    this.audio.play('tomato_leg', { pos: point });
  }

  update(dt: number) {
    this.time += dt;
    let w = 0;
    for (const s of this.queue) {
      if (s.t <= this.time) this.world.addDecal(s.mat, s.p, s.n, s.size, true, s.angle);
      else this.queue[w++] = s;
    }
    this.queue.length = w;
  }

  clear() {
    this.queue.length = 0;
  }
}
