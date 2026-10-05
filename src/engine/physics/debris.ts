import { mat4, quat, vec3, type Quat } from 'wgpu-matrix';
import type { Renderable, Renderer } from '../render/renderer';
import type { GpuMesh } from '../render/geometry';
import type { Material } from '../render/materials';
import type { CollisionWorld, RayHit } from '../scene/collision';
import { transformAabb } from '../render/culling';

/** A mesh that can be thrown as debris (gibs, chunks, broken pieces). */
export interface DebrisMesh {
  mesh: GpuMesh;
  materials: Material[];
  /** Collision radius at scale 1 (m). */
  radius: number;
  /** Local axis that lies against the surface when the piece settles (a flat piece lands flat), or none. */
  flatAxis?: [number, number, number];
  /** Half thickness along the flat axis (m, at scale 1): how far it rests above the surface. */
  rest?: number;
  /** Local long axis of a stick-like piece: it settles lying along the surface. */
  longAxis?: [number, number, number];
}

export interface DebrisOptions {
  scale?: number;
  /** Seconds before it shrinks away (then the slot is free). */
  life?: number;
  /** Restitution and tangential friction per bounce (wet, heavy pieces: low / high). */
  bounce?: number;
  friction?: number;
  /** Chance a fast hit on a wall sticks it there for a while; it then slides down and drops. */
  stick?: number;
  /** Game tag passed back with impacts (e.g. what to paint). */
  tag?: number;
  castShadow?: boolean;
}

interface Body {
  r: Renderable;
  active: boolean;
  m: DebrisMesh | null;
  pos: [number, number, number];
  vel: [number, number, number];
  rot: Quat;
  spin: [number, number, number];
  scale: number;
  age: number;
  life: number;
  bounce: number;
  friction: number;
  stick: number;
  tag: number;
  impacts: number;
  /** 0 flying, 1 stuck to a wall (sliding), 2 resting. */
  mode: number;
  stuckT: number;
}

/**
 * Thrown rigid pieces (gibs, chunks): a fixed pool of instanced meshes with
 * gravity and spin, bouncing on the collision world (one ray along the motion
 * per substep), sticking to walls and sliding down, and settling flat on the
 * ground. Settled pieces cost nothing until they expire; the oldest piece is
 * recycled when the pool is full. Cosmetic: frame-rate dependent substeps.
 */
export class Debris {
  private list: Body[] = [];
  private next = 0;
  private hit: RayHit = { t: 0, point: [0, 0, 0], normal: [0, 0, 0], surface: 0, owner: '', tri: -1 };
  private m = mat4.create();
  private q = quat.create();
  private d: [number, number, number] = [0, 0, 0];
  /** First impacts (pos, normal, speed, surface, tag, scale): the game paints and plays sounds. */
  onImpact: ((pos: ArrayLike<number>, normal: ArrayLike<number>, speed: number, surface: number, tag: number, scale: number) => void)[] = [];
  /** Substep rate (Hz). */
  rate = 90;
  /** Pieces flying or sliding (the ones that cost rays). */
  moving = 0;

  /** `placeholder`: any mesh, so idle slots always hold a valid one. */
  constructor(private renderer: Renderer, renderables: Renderable[], private collision: () => CollisionWorld, placeholder: GpuMesh, capacity = 300) {
    const R = renderer;
    for (let i = 0; i < capacity; i++) {
      const r: Renderable = {
        slot: R.instances.alloc(), mesh: placeholder, materials: [], castShadow: true, visible: false, id: `debris${i}`,
        worldMin: new Float32Array(3), worldMax: new Float32Array(3),
      };
      renderables.push(r);
      this.list.push({ r, active: false, m: null, pos: [0, 0, 0], vel: [0, 0, 0], rot: quat.identity(), spin: [0, 0, 0], scale: 1, age: 0, life: 1, bounce: 0.2, friction: 0.6, stick: 0, tag: 0, impacts: 0, mode: 0, stuckT: 0 });
    }
  }

  get capacity() {
    return this.list.length;
  }

  /** Throws a piece: position, orientation, velocity (m/s), spin (rad/s, world axes). */
  spawn(m: DebrisMesh, pos: ArrayLike<number>, rot: ArrayLike<number>, vel: ArrayLike<number>, spin: ArrayLike<number>, o: DebrisOptions = {}) {
    // Prefer a free slot; otherwise recycle the oldest.
    let s: Body | null = null;
    for (let k = 0; k < this.list.length; k++) {
      const c = this.list[(this.next + k) % this.list.length];
      if (!c.active) { s = c; this.next = (this.next + k + 1) % this.list.length; break; }
    }
    if (!s) {
      s = this.list[this.next];
      this.next = (this.next + 1) % this.list.length;
    }
    s.active = true;
    s.m = m;
    s.r.mesh = m.mesh;
    s.r.materials = m.materials;
    s.r.castShadow = o.castShadow ?? true;
    s.pos[0] = pos[0]; s.pos[1] = pos[1]; s.pos[2] = pos[2];
    s.vel[0] = vel[0]; s.vel[1] = vel[1]; s.vel[2] = vel[2];
    s.spin[0] = spin[0]; s.spin[1] = spin[1]; s.spin[2] = spin[2];
    quat.copy(rot as Quat, s.rot);
    s.scale = o.scale ?? 1;
    s.age = 0;
    s.life = o.life ?? 20;
    s.bounce = o.bounce ?? 0.2;
    s.friction = o.friction ?? 0.6;
    s.stick = o.stick ?? 0;
    s.tag = o.tag ?? 0;
    s.impacts = 0;
    s.mode = 0;
    s.stuckT = 0;
    return s;
  }

  update(dt: number) {
    if (dt <= 0) { this.draw(); return; }
    const C = this.collision();
    const n = Math.max(1, Math.ceil(dt * this.rate));
    const h = dt / n;
    let moving = 0;
    for (const s of this.list) {
      if (!s.active) continue;
      s.age += dt;
      if (s.age > s.life + 0.8) {
        s.active = false;
        s.r.visible = false;
        continue;
      }
      if (s.mode === 2) continue;
      moving++;
      if (s.mode === 1) {
        // Stuck on a wall: slides down slowly, then lets go.
        s.stuckT -= dt;
        s.pos[1] -= dt * (0.05 + 0.25 * Math.max(0, 1 - s.stuckT));
        if (s.stuckT <= 0) { s.mode = 0; s.vel[0] = s.vel[2] = 0; s.vel[1] = -0.5; }
        continue;
      }
      const R = s.m!.radius * s.scale;
      for (let k = 0; k < n && s.mode === 0; k++) {
        s.vel[1] -= 9.81 * h;
        const v = s.vel, sp = Math.hypot(v[0], v[1], v[2]);
        if (sp > 1e-4) {
          const d = this.d;
          d[0] = v[0] / sp; d[1] = v[1] / sp; d[2] = v[2] / sp;
          const hit = C.raycast(s.pos, d, sp * h + R, undefined, this.hit);
          if (hit) {
            const nn = hit.normal, vn = v[0] * nn[0] + v[1] * nn[1] + v[2] * nn[2];
            if (vn < 0) {
              this.impact(s, hit, -vn);
              if (s.mode !== 0) break;
              continue;
            }
          }
        }
        s.pos[0] += s.vel[0] * h; s.pos[1] += s.vel[1] * h; s.pos[2] += s.vel[2] * h;
        const w = Math.hypot(s.spin[0], s.spin[1], s.spin[2]);
        if (w > 1e-3) {
          quat.fromAxisAngle([s.spin[0] / w, s.spin[1] / w, s.spin[2] / w], w * h, this.q);
          quat.multiply(this.q, s.rot, s.rot);
        }
      }
    }
    this.moving = moving;
    this.draw();
  }

  private impact(s: Body, hit: RayHit, speed: number) {
    const v = s.vel, nn = hit.normal, R = s.m!.radius * s.scale;
    const vn = v[0] * nn[0] + v[1] * nn[1] + v[2] * nn[2];
    if (s.impacts < 3 && speed > 1.2) for (const g of this.onImpact) g(hit.point, nn, speed, hit.surface, s.tag, s.scale);
    s.impacts++;
    s.pos[0] = hit.point[0] + nn[0] * R; s.pos[1] = hit.point[1] + nn[1] * R; s.pos[2] = hit.point[2] + nn[2] * R;
    // A fast wet hit on a wall can stick.
    if (nn[1] < 0.5 && speed > 3 && Math.random() < s.stick) {
      s.mode = 1;
      s.stuckT = 0.8 + Math.random() * 1.6;
      this.settle(s, nn, hit.point);
      return;
    }
    for (let i = 0; i < 3; i++) {
      const vt = v[i] - vn * nn[i];
      v[i] = vt * s.friction - vn * s.bounce * nn[i];
    }
    for (let i = 0; i < 3; i++) s.spin[i] = s.spin[i] * 0.45 + (Math.random() - 0.5) * 14 * Math.min(1, speed / 4);
    if (Math.hypot(v[0], v[1], v[2]) < 0.45 && nn[1] > 0.6) {
      s.mode = 2;
      this.settle(s, nn, hit.point);
    }
  }

  /** Lays a piece against the surface: its flat axis along the normal (either side), resting on it. */
  private settle(s: Body, n: ArrayLike<number>, at: ArrayLike<number>) {
    const m = s.m!;
    s.vel[0] = s.vel[1] = s.vel[2] = 0;
    s.spin[0] = s.spin[1] = s.spin[2] = 0;
    let off = m.radius * s.scale * 0.5;
    if (m.flatAxis) {
      const a = vec3.transformQuat(m.flatAxis, s.rot);
      const side = a[0] * n[0] + a[1] * n[1] + a[2] * n[2] >= 0 ? 1 : -1;
      quat.rotationTo(vec3.scale(a, side), n, this.q);
      quat.multiply(this.q, s.rot, s.rot);
      off = (m.rest ?? m.radius * 0.3) * s.scale;
    } else if (m.longAxis) {
      // Lay the long axis into the surface plane (smallest turn), resting on its side.
      const a = vec3.transformQuat(m.longAxis, s.rot);
      const an = a[0] * n[0] + a[1] * n[1] + a[2] * n[2];
      const t = vec3.normalize([a[0] - n[0] * an, a[1] - n[1] * an, a[2] - n[2] * an]);
      quat.rotationTo(vec3.normalize(a), t, this.q);
      quat.multiply(this.q, s.rot, s.rot);
      off = (m.rest ?? m.radius * 0.12) * s.scale;
    }
    s.pos[0] = at[0] + n[0] * off; s.pos[1] = at[1] + n[1] * off; s.pos[2] = at[2] + n[2] * off;
  }

  private draw() {
    const R = this.renderer;
    for (const s of this.list) {
      if (!s.active) continue;
      // Shrinks away at the end of its life.
      const fade = s.age > s.life ? Math.max(0.001, 1 - (s.age - s.life) / 0.8) : 1;
      mat4.fromQuat(s.rot, this.m);
      mat4.uniformScale(this.m, s.scale * fade, this.m);
      this.m[12] = s.pos[0]; this.m[13] = s.pos[1]; this.m[14] = s.pos[2];
      s.r.visible = true;
      transformAabb(this.m, s.r.mesh.aabb.min, s.r.mesh.aabb.max, s.r.worldMin, s.r.worldMax);
      R.instances.set(s.r.slot, this.m, null, -1, 2 | R.probeBits(s.r.worldMin, s.r.worldMax), 1, 0x5eed);
    }
  }

  clear() {
    for (const s of this.list) {
      s.active = false;
      s.r.visible = false;
    }
  }
}

