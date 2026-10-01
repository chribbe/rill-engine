/**
 * Small CPU particle system for action effects (muzzle flash, smoke, impact
 * dust, sparks). Particles are camera-facing quads lit once per particle in
 * the vertex stage (sun with cascade shadows, sky, local lights, fog) and
 * blended inside the main MSAA pass. The target holds weighted colour
 * (rgb*w, w); blending the premultiplied source by dst-alpha keeps that
 * encoding exact: C' = Cp*W + C*(1-a), W' = W  =>  C'/W' = cp*a + c*(1-a).
 */

export const MAX_PARTICLES = 4096;
const FLOATS = 16; // per GPU particle: pos.xyz size | rot alpha kind seed | rgb emissive | vel.xyz -

export type ParticleKind = 'smoke' | 'flash' | 'spark' | 'dust';

interface P {
  kind: ParticleKind;
  pos: [number, number, number];
  vel: [number, number, number];
  age: number;
  life: number;
  size0: number;
  size1: number;
  rot: number;
  spin: number;
  alpha: number;
  color: [number, number, number];
  emissive: number;
  drag: number;
  gravity: number;
  seed: number;
}

export interface EmitOptions {
  count?: number;
  pos: ArrayLike<number>;
  dir?: ArrayLike<number>;
  spread?: number;
  speed?: [number, number];
  life?: [number, number];
  size?: [number, number];
  alpha?: number;
  color?: [number, number, number];
  emissive?: number;
  drag?: number;
  gravity?: number;
}

export class ParticleSystem {
  private list: P[] = [];
  readonly buffer: GPUBuffer;
  private cpu = new Float32Array(MAX_PARTICLES * FLOATS);
  /** Draw ranges after upload: alpha-blended (sorted back to front), then additive. */
  alphaCount = 0;
  addCount = 0;
  private seed = 1;

  constructor(private device: GPUDevice) {
    this.buffer = device.createBuffer({ label: 'particles', size: MAX_PARTICLES * FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }

  get count() {
    return this.list.length;
  }

  emit(kind: ParticleKind, o: EmitOptions) {
    const n = o.count ?? 1;
    const dir = o.dir ?? [0, 1, 0];
    for (let i = 0; i < n && this.list.length < MAX_PARTICLES; i++) {
      const r = () => Math.random();
      const sp = o.spread ?? 0.3;
      let vx = dir[0] + (r() - 0.5) * 2 * sp, vy = dir[1] + (r() - 0.5) * 2 * sp, vz = dir[2] + (r() - 0.5) * 2 * sp;
      const l = Math.hypot(vx, vy, vz) || 1;
      const speed = o.speed ? o.speed[0] + r() * (o.speed[1] - o.speed[0]) : 0;
      vx = (vx / l) * speed; vy = (vy / l) * speed; vz = (vz / l) * speed;
      const life = o.life ? o.life[0] + r() * (o.life[1] - o.life[0]) : 1;
      this.list.push({
        kind, pos: [o.pos[0], o.pos[1], o.pos[2]], vel: [vx, vy, vz], age: 0, life,
        size0: o.size?.[0] ?? 0.2, size1: o.size?.[1] ?? 0.6, rot: r() * Math.PI * 2, spin: (r() - 0.5) * 1.5,
        alpha: o.alpha ?? 1, color: o.color ?? [0.5, 0.5, 0.5], emissive: o.emissive ?? 0,
        drag: o.drag ?? 1.5, gravity: o.gravity ?? 0, seed: (this.seed++ * 2654435761) >>> 0,
      });
    }
  }

  update(dt: number) {
    for (const p of this.list) {
      p.age += dt;
      const k = Math.exp(-p.drag * dt);
      p.vel[0] *= k; p.vel[1] = p.vel[1] * k - p.gravity * dt; p.vel[2] *= k;
      p.pos[0] += p.vel[0] * dt; p.pos[1] += p.vel[1] * dt; p.pos[2] += p.vel[2] * dt;
      p.rot += p.spin * dt;
    }
    this.list = this.list.filter((p) => p.age < p.life);
  }

  /** Sorts alpha particles back to front for the camera and uploads both ranges. */
  upload(eye: ArrayLike<number>) {
    const alpha: P[] = [], add: P[] = [];
    for (const p of this.list) (p.kind === 'smoke' || p.kind === 'dust' ? alpha : add).push(p);
    const d2 = (p: P) => (p.pos[0] - eye[0]) ** 2 + (p.pos[1] - eye[1]) ** 2 + (p.pos[2] - eye[2]) ** 2;
    alpha.sort((a, b) => d2(b) - d2(a));
    const write = (p: P, i: number) => {
      const t = p.age / p.life;
      const o = i * FLOATS;
      const size = p.size0 + (p.size1 - p.size0) * Math.sqrt(t);
      // Soot fades in over a few frames and out smoothly; flashes and sparks start at full strength.
      const lit = p.kind === 'smoke' || p.kind === 'dust';
      const fade = lit ? Math.min(1, 0.2 + p.age / 0.08) * (1 - t) * (1 - t) : 1 - t;
      const kind = p.kind === 'smoke' ? 0 : p.kind === 'dust' ? 1 : p.kind === 'flash' ? 2 : 3;
      this.cpu.set([p.pos[0], p.pos[1], p.pos[2], size, p.rot, p.alpha * fade, kind, (p.seed % 1000) / 1000, p.color[0], p.color[1], p.color[2], p.emissive, p.vel[0], p.vel[1], p.vel[2], 0], o);
    };
    alpha.forEach((p, i) => write(p, i));
    add.forEach((p, i) => write(p, alpha.length + i));
    this.alphaCount = alpha.length;
    this.addCount = add.length;
    const n = alpha.length + add.length;
    if (n > 0) this.device.queue.writeBuffer(this.buffer, 0, this.cpu, 0, n * FLOATS);
  }
}
