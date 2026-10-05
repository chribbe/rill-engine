import type { CollisionWorld } from '../scene/collision';

/**
 * Position-based Verlet body (Jakobsen): particles with distance constraints,
 * colliding as spheres with the static world. Small and robust: ragdolls,
 * dangling props. Equality constraints keep lengths; `min` constraints only
 * push apart (crude joint limits). Particles in contact get friction. The
 * body sleeps once it stops moving.
 */
export interface VerletParticle {
  pos: [number, number, number];
  prev: [number, number, number];
  invMass: number;
  radius: number;
  /** In contact with the world after the last step. */
  touching: boolean;
}

export interface VerletConstraint {
  a: number;
  b: number;
  rest: number;
  /** 0..1 per iteration. */
  stiffness: number;
  /** 'eq' keeps the length; 'min' only stops it shrinking below rest. */
  kind: 'eq' | 'min';
  broken?: boolean;
}

export class VerletBody {
  readonly particles: VerletParticle[] = [];
  readonly constraints: VerletConstraint[] = [];
  gravity = 9.81;
  /** Velocity kept per second (air drag). */
  damping = 0.985;
  friction = 0.55;
  iterations = 6;
  sleeping = false;
  private still = 0;
  private n: [number, number, number] = [0, 0, 0];
  /** Per particle: velocity at the start of the step (impact speed) and contact before it. */
  private v0 = new Float64Array(0);
  private touched = new Uint8Array(0);
  /** First world contact per particle this step (impact speed m/s): sounds, splats. */
  onContact: ((i: number, speed: number) => void) | null = null;

  addParticle(pos: ArrayLike<number>, vel: ArrayLike<number>, mass: number, radius: number, h: number) {
    this.particles.push({
      pos: [pos[0], pos[1], pos[2]],
      prev: [pos[0] - vel[0] * h, pos[1] - vel[1] * h, pos[2] - vel[2] * h],
      invMass: mass > 0 ? 1 / mass : 0, radius, touching: false,
    });
    return this.particles.length - 1;
  }

  connect(a: number, b: number, stiffness = 1, kind: 'eq' | 'min' = 'eq', rest?: number) {
    const A = this.particles[a].pos, B = this.particles[b].pos;
    const r = rest ?? Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
    this.constraints.push({ a, b, rest: r, stiffness, kind });
  }

  /** Velocity change at particle i (m/s). */
  kick(i: number, dv: ArrayLike<number>, h: number) {
    const p = this.particles[i];
    p.prev[0] -= dv[0] * h; p.prev[1] -= dv[1] * h; p.prev[2] -= dv[2] * h;
    this.sleeping = false;
    this.still = 0;
  }

  /** Impulse (N·s) at a world point: shared by nearby particles by inverse mass and distance. */
  impulse(point: ArrayLike<number>, dir: ArrayLike<number>, amount: number, reach: number, h: number) {
    let wsum = 0;
    const w: number[] = [];
    for (const p of this.particles) {
      const d = Math.hypot(p.pos[0] - point[0], p.pos[1] - point[1], p.pos[2] - point[2]);
      const k = Math.max(0, 1 - d / reach) * p.invMass;
      w.push(k);
      wsum += k;
    }
    if (wsum <= 0) return;
    for (let i = 0; i < this.particles.length; i++) {
      if (!w[i]) continue;
      // Velocity = impulse × invMass, distributed by proximity.
      const dv = (amount * w[i]) / wsum * this.particles[i].invMass;
      this.kick(i, [dir[0] * dv, dir[1] * dv, dir[2] * dv], h);
    }
  }

  step(h: number, collision: CollisionWorld | null) {
    if (this.sleeping) return;
    const damp = Math.pow(this.damping, h * 60);
    let motion = 0;
    const N = this.particles.length;
    if (this.v0.length < N * 3) { this.v0 = new Float64Array(N * 3); this.touched = new Uint8Array(N); }
    for (let i = 0; i < N; i++) {
      const p = this.particles[i];
      this.v0[i * 3] = p.pos[0] - p.prev[0]; this.v0[i * 3 + 1] = p.pos[1] - p.prev[1]; this.v0[i * 3 + 2] = p.pos[2] - p.prev[2];
      this.touched[i] = p.touching ? 1 : 0;
    }
    for (const p of this.particles) {
      if (p.invMass === 0) continue;
      const vx = (p.pos[0] - p.prev[0]) * damp, vy = (p.pos[1] - p.prev[1]) * damp, vz = (p.pos[2] - p.prev[2]) * damp;
      p.prev[0] = p.pos[0]; p.prev[1] = p.pos[1]; p.prev[2] = p.pos[2];
      p.pos[0] += vx; p.pos[1] += vy - this.gravity * h * h; p.pos[2] += vz;
      motion = Math.max(motion, Math.abs(vx) + Math.abs(vy) + Math.abs(vz));
    }
    for (let it = 0; it < this.iterations; it++) {
      for (const c of this.constraints) {
        if (c.broken) continue;
        const A = this.particles[c.a], B = this.particles[c.b];
        const dx = B.pos[0] - A.pos[0], dy = B.pos[1] - A.pos[1], dz = B.pos[2] - A.pos[2];
        const d = Math.hypot(dx, dy, dz);
        if (d < 1e-6 || (c.kind === 'min' && d >= c.rest)) continue;
        const w = A.invMass + B.invMass;
        if (w === 0) continue;
        const k = ((d - c.rest) / (d * w)) * c.stiffness;
        A.pos[0] += dx * k * A.invMass; A.pos[1] += dy * k * A.invMass; A.pos[2] += dz * k * A.invMass;
        B.pos[0] -= dx * k * B.invMass; B.pos[1] -= dy * k * B.invMass; B.pos[2] -= dz * k * B.invMass;
      }
      if (collision && (it === this.iterations - 1 || it % 2 === 1)) this.collide(collision, h, it === this.iterations - 1);
    }
    this.still = motion < 0.0006 ? this.still + h : 0;
    if (this.still > 0.6) this.sleeping = true;
  }

  private collide(C: CollisionWorld, h: number, last: boolean) {
    const n = this.n;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      const depth = C.pushSphereOut(p.pos, p.radius, n);
      if (depth > 0) p.touching = true;
      else if (last) p.touching = false;
      if (depth <= 0 || !last) continue;
      // Friction: remove part of the tangential motion of this step.
      const vx = p.pos[0] - p.prev[0], vy = p.pos[1] - p.prev[1], vz = p.pos[2] - p.prev[2];
      const vn = vx * n[0] + vy * n[1] + vz * n[2];
      const tx = vx - vn * n[0], ty = vy - vn * n[1], tz = vz - vn * n[2];
      p.prev[0] += tx * this.friction; p.prev[1] += ty * this.friction; p.prev[2] += tz * this.friction;
      if (!this.touched[i] && this.onContact) {
        const k = i * 3;
        this.onContact(i, Math.max(0, -(this.v0[k] * n[0] + this.v0[k + 1] * n[1] + this.v0[k + 2] * n[2])) / h);
      }
    }
  }
}
