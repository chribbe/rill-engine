/**
 * Small CPU particle system for action effects (muzzle flash, smoke, impact
 * dust, sparks). Particles are camera-facing quads lit once per particle in
 * the vertex stage (sun with cascade shadows, sky, local lights, fog) and
 * blended inside the main MSAA pass. The target holds weighted colour
 * (rgb*w, w); blending the premultiplied source by dst-alpha keeps that
 * encoding exact: C' = Cp*W + C*(1-a), W' = W  =>  C'/W' = cp*a + c*(1-a).
 */

export const MAX_PARTICLES = 4096;
const UP = [0, 1, 0];
const GREY: [number, number, number] = [0.5, 0.5, 0.5];
const FLOATS = 16; // per GPU particle: pos.xyz size | rot alpha kind seed | rgb emissive | vel.xyz -

export type ParticleKind = 'smoke' | 'flash' | 'spark' | 'dust' | 'debris';

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
  flags: number;
  /** Anchor id (follows a moving point, e.g. a muzzle), -1 = free. */
  anchor: number;
  /** Ground height to bounce on (debris), -Infinity = none. */
  floor: number;
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
  /** Drawn with the first-person weapon's projection and depth range (muzzle flash on the gun). */
  viewmodel?: boolean;
  /** Stretch the sprite along its velocity (directional flash); speed sets the length. */
  stretch?: boolean;
  /** Follow anchor `id` (see `setAnchor`): the particle keeps its offset from that point. */
  anchor?: number;
  /** Bounce on this ground height (debris chunks land instead of falling through). */
  floor?: number;
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

  /** Recycled particle records (no allocation per particle once warm). */
  private pool: P[] = [];

  emit(kind: ParticleKind, o: EmitOptions) {
    const n = o.count ?? 1;
    const dir = o.dir ?? UP;
    const a = o.anchor !== undefined ? this.anchors.get(o.anchor) : undefined;
    for (let i = 0; i < n && this.list.length < MAX_PARTICLES; i++) {
      const r = Math.random;
      const sp = o.spread ?? 0.3;
      let vx = dir[0] + (r() - 0.5) * 2 * sp, vy = dir[1] + (r() - 0.5) * 2 * sp, vz = dir[2] + (r() - 0.5) * 2 * sp;
      const l = Math.hypot(vx, vy, vz) || 1;
      const speed = o.speed ? o.speed[0] + r() * (o.speed[1] - o.speed[0]) : 0;
      vx = (vx / l) * speed; vy = (vy / l) * speed; vz = (vz / l) * speed;
      const p = this.pool.pop() ?? ({ pos: [0, 0, 0], vel: [0, 0, 0], color: [0, 0, 0] } as unknown as P);
      p.kind = kind;
      // Anchored particles store their offset from the anchor; the position follows it.
      p.pos[0] = o.pos[0] - (a ? a[0] : 0); p.pos[1] = o.pos[1] - (a ? a[1] : 0); p.pos[2] = o.pos[2] - (a ? a[2] : 0);
      p.vel[0] = vx; p.vel[1] = vy; p.vel[2] = vz;
      p.age = 0;
      p.life = o.life ? o.life[0] + r() * (o.life[1] - o.life[0]) : 1;
      p.size0 = o.size?.[0] ?? 0.2;
      p.size1 = o.size?.[1] ?? 0.6;
      p.rot = r() * Math.PI * 2;
      p.spin = (r() - 0.5) * 1.5;
      p.alpha = o.alpha ?? 1;
      const c = o.color ?? GREY;
      p.color[0] = c[0]; p.color[1] = c[1]; p.color[2] = c[2];
      p.emissive = o.emissive ?? 0;
      p.drag = o.drag ?? 1.5;
      p.gravity = o.gravity ?? 0;
      p.seed = (this.seed++ * 2654435761) >>> 0;
      p.flags = (o.viewmodel ? 1 : 0) | (o.stretch ? 2 : 0);
      p.anchor = a ? o.anchor! : -1;
      p.floor = o.floor ?? -Infinity;
      this.list.push(p);
    }
  }

  /** Air velocity (m/s, world x/z): drag relaxes smoke and dust towards it (set from the wind). */
  air: [number, number] = [0, 0];
  /** Moving points particles can follow (muzzle flashes stay on a swinging gun). */
  private anchors = new Map<number, [number, number, number]>();

  setAnchor(id: number, p: ArrayLike<number>) {
    let a = this.anchors.get(id);
    if (!a) this.anchors.set(id, (a = [0, 0, 0]));
    a[0] = p[0]; a[1] = p[1]; a[2] = p[2];
  }

  update(dt: number) {
    for (const p of this.list) {
      p.age += dt;
      const k = Math.exp(-p.drag * dt);
      const drifts = p.kind === 'smoke' || p.kind === 'dust';
      const ax = drifts ? this.air[0] : 0, az = drifts ? this.air[1] : 0;
      p.vel[0] = ax + (p.vel[0] - ax) * k; p.vel[1] = p.vel[1] * k - p.gravity * dt; p.vel[2] = az + (p.vel[2] - az) * k;
      p.pos[0] += p.vel[0] * dt; p.pos[1] += p.vel[1] * dt; p.pos[2] += p.vel[2] * dt;
      p.rot += p.spin * dt;
      const fl = p.floor + p.size0 * 0.5;
      if (p.pos[1] < fl) {
        p.pos[1] = fl;
        if (p.vel[1] < 0) p.vel[1] *= -0.25;
        p.vel[0] *= 0.5; p.vel[2] *= 0.5;
        p.spin *= 0.4;
      }
    }
    // Compact in place; dead records go back to the pool.
    let w = 0;
    for (const p of this.list) {
      if (p.age < p.life) this.list[w++] = p;
      else this.pool.push(p);
    }
    this.list.length = w;
  }

  /** Sorts alpha particles back to front for the camera and uploads both ranges. */
  private alphaList: P[] = [];
  private addList: P[] = [];
  private eye: [number, number, number] = [0, 0, 0];
  private byDistance = (a: P, b: P) => this.d2(b) - this.d2(a);
  private d2(p: P) {
    const e = this.eye;
    return (p.pos[0] - e[0]) ** 2 + (p.pos[1] - e[1]) ** 2 + (p.pos[2] - e[2]) ** 2;
  }

  upload(eye: ArrayLike<number>) {
    const alpha = this.alphaList, add = this.addList;
    alpha.length = 0;
    add.length = 0;
    for (const p of this.list) (p.kind === 'smoke' || p.kind === 'dust' || p.kind === 'debris' ? alpha : add).push(p);
    this.eye[0] = eye[0]; this.eye[1] = eye[1]; this.eye[2] = eye[2];
    alpha.sort(this.byDistance);
    for (let i = 0; i < alpha.length; i++) this.write(alpha[i], i);
    for (let i = 0; i < add.length; i++) this.write(add[i], alpha.length + i);
    this.finishUpload(alpha.length, add.length);
  }

  private write(p: P, i: number) {
    const t = p.age / p.life;
    const o = i * FLOATS;
    const size = p.kind === 'debris' ? p.size0 * Math.min(1, (1 - t) * 6) : p.size0 + (p.size1 - p.size0) * Math.sqrt(t);
    // Soot fades in over a few frames and out smoothly; flashes and sparks start at full strength.
    const lit = p.kind === 'smoke' || p.kind === 'dust';
    // Debris stays solid and only shrinks away at the end of its life.
    const fade = p.kind === 'debris' ? 1 : lit ? Math.min(1, 0.2 + p.age / 0.08) * (1 - t) * (1 - t) : 1 - t;
    const kind = p.kind === 'smoke' ? 0 : p.kind === 'dust' ? 1 : p.kind === 'flash' ? 2 : p.kind === 'spark' ? 3 : 4;
    const a = p.anchor >= 0 ? this.anchors.get(p.anchor) : undefined;
    const C = this.cpu;
    C[o] = p.pos[0] + (a ? a[0] : 0); C[o + 1] = p.pos[1] + (a ? a[1] : 0); C[o + 2] = p.pos[2] + (a ? a[2] : 0); C[o + 3] = size;
    C[o + 4] = p.rot; C[o + 5] = p.alpha * fade; C[o + 6] = kind; C[o + 7] = (p.seed % 1000) / 1000;
    C[o + 8] = p.color[0]; C[o + 9] = p.color[1]; C[o + 10] = p.color[2]; C[o + 11] = p.emissive;
    C[o + 12] = p.vel[0]; C[o + 13] = p.vel[1]; C[o + 14] = p.vel[2]; C[o + 15] = p.flags;
  }

  private finishUpload(nAlpha: number, nAdd: number) {
    this.alphaCount = nAlpha;
    this.addCount = nAdd;
    const n = nAlpha + nAdd;
    if (n > 0) this.device.queue.writeBuffer(this.buffer, 0, this.cpu, 0, n * FLOATS);
  }
}
