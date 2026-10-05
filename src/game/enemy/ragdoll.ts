import { mat4, type Mat4 } from 'wgpu-matrix';
import type { CollisionWorld } from '../../engine/scene/collision';
import type { Rig, RigPart } from '../../engine/scene/rig';
import { VerletBody } from '../../engine/physics/verlet';
import type { EnemyDef } from './def';

type V3 = [number, number, number];

/**
 * Death ragdoll: a Verlet body built from the creature's animated pose at the
 * moment of death (joint positions from the posed rig, the body's velocity
 * plus the killing impulse), then the rig's parts are oriented from it every
 * frame (pivot joint → axis joint, twist from a reference joint pair). The
 * layout is data (EnemyDef.ragdoll), so other creatures can bring their own.
 */
export class Ragdoll {
  readonly body = new VerletBody();
  private index = new Map<string, number>();
  private bones: { part: RigPart; from: number; to: number; r0: number; r1: number; rest: Mat4 }[] = [];
  private tmp: V3 = [0, 0, 0];
  private m = mat4.create();
  headPopped = false;

  constructor(private def: EnemyDef, private rig: Rig, velocity: ArrayLike<number>, h: number) {
    const R = def.ragdoll;
    // Joints: rest-space positions mapped through the posed parts.
    const rest = new Map<string, V3>();
    const o: V3 = [0, 0, 0];
    for (const j of R.joints) {
      const part = rig.part(j.part);
      if (!part) continue;
      rig.restOrigin(part, o);
      const local: V3 = [j.at[0] - o[0], j.at[1] - o[1], j.at[2] - o[2]];
      const w = rig.point(part, local, [0, 0, 0]);
      this.index.set(j.name, this.body.addParticle(w, velocity, j.mass, j.radius, h));
      rest.set(j.name, [...j.at] as V3);
    }
    const I = (n: string) => this.index.get(n) ?? -1;
    for (const group of R.rigid) {
      for (let a = 0; a < group.length; a++) for (let b = a + 1; b < group.length; b++) if (I(group[a]) >= 0 && I(group[b]) >= 0) this.body.connect(I(group[a]), I(group[b]), 1);
    }
    for (const [a, b, kind, k] of R.links) {
      if (I(a) < 0 || I(b) < 0) continue;
      if (kind === 'eq') this.body.connect(I(a), I(b), k);
      else {
        const A = rest.get(a)!, B = rest.get(b)!;
        this.body.connect(I(a), I(b), 1, 'min', Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]) * k);
      }
    }
    // Bones: rest frames (rig rest space) to map current frames onto the parts.
    for (const b of R.bones) {
      const part = rig.part(b.part);
      if (!part || I(b.from) < 0 || I(b.to) < 0) continue;
      const f = this.frame(rest.get(b.from)!, rest.get(b.to)!, rest.get(b.ref[0])!, rest.get(b.ref[1])!, mat4.create());
      mat4.transpose(f, f); // inverse of an orthonormal frame
      this.bones.push({ part, from: I(b.from), to: I(b.to), r0: I(b.ref[0]), r1: I(b.ref[1]), rest: f });
    }
  }

  /** Orthonormal frame: y along from→to, x along the reference pair (orthogonalised), z = x × y. */
  private frame(from: ArrayLike<number>, to: ArrayLike<number>, r0: ArrayLike<number>, r1: ArrayLike<number>, out: Mat4) {
    let yx = to[0] - from[0], yy = to[1] - from[1], yz = to[2] - from[2];
    const yl = Math.hypot(yx, yy, yz) || 1;
    yx /= yl; yy /= yl; yz /= yl;
    let xx = r1[0] - r0[0], xy = r1[1] - r0[1], xz = r1[2] - r0[2];
    const d = xx * yx + xy * yy + xz * yz;
    xx -= yx * d; xy -= yy * d; xz -= yz * d;
    let xl = Math.hypot(xx, xy, xz);
    if (xl < 1e-5) { xx = 1; xy = 0; xz = 0; xl = 1; }
    xx /= xl; xy /= xl; xz /= xl;
    const zx = xy * yz - xz * yy, zy = xz * yx - xx * yz, zz = xx * yy - xy * yx;
    mat4.set(xx, xy, xz, 0, yx, yy, yz, 0, zx, zy, zz, 0, 0, 0, 0, 1, out);
    return out;
  }

  joint(name: string) {
    const i = this.index.get(name);
    return i === undefined ? null : this.body.particles[i];
  }

  /** Breaks the head stick off the body and throws it along `dir`. */
  popHead(dir: ArrayLike<number>, speed: number, h: number) {
    const [neck, head] = this.def.ragdoll.head;
    const n = this.index.get(neck), hd = this.index.get(head);
    if (n === undefined || hd === undefined) return;
    for (const c of this.body.constraints) {
      const touches = c.a === n || c.b === n || c.a === hd || c.b === hd;
      const own = (c.a === n && c.b === hd) || (c.a === hd && c.b === n);
      if (touches && !own) c.broken = true;
    }
    const up = 2.5 + Math.random();
    this.body.kick(hd, [dir[0] * speed, dir[1] * speed + up, dir[2] * speed], h);
    this.body.kick(n, [dir[0] * speed * 0.8, dir[1] * speed * 0.8 + up * 0.8, dir[2] * speed * 0.8], h);
    this.headPopped = true;
  }

  step(h: number, collision: CollisionWorld) {
    this.body.step(h, collision);
  }

  /** Orients the rig's parts from the particles and writes them out. */
  apply() {
    const P = this.body.particles, M = this.m;
    for (const b of this.bones) {
      const from = P[b.from].pos;
      this.frame(from, P[b.to].pos, P[b.r0].pos, P[b.r1].pos, M);
      // world = T(pivot joint) · current frame · rest frameᵀ · T(-pivot offset in the part)
      mat4.multiply(M, b.rest, M);
      const part = b.part, o = this.rig.restOrigin(part, this.tmp);
      // The part's mesh origin is its rest origin; the pivot joint sits at `from` (its rest position).
      const j = this.def.ragdoll.joints.find((q) => this.index.get(q.name) === b.from)!;
      const ox = o[0] - j.at[0], oy = o[1] - j.at[1], oz = o[2] - j.at[2];
      const w = part.world;
      mat4.copy(M, w);
      w[12] = from[0] + M[0] * ox + M[4] * oy + M[8] * oz;
      w[13] = from[1] + M[1] * ox + M[5] * oy + M[9] * oz;
      w[14] = from[2] + M[2] * ox + M[6] * oy + M[10] * oz;
    }
  }
}
