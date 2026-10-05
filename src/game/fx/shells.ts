import { mat4, quat, vec3, type Quat } from 'wgpu-matrix';
import type { Renderable, Renderer } from '../../engine/render/renderer';
import type { CollisionWorld, RayHit } from '../../engine/scene/collision';
import type { World } from '../../engine/scene/world';
import { MeshBuilder, place } from '../../engine/scene/procmesh';
import { transformAabb } from '../../engine/render/culling';

/**
 * Ejected brass: a pool of tiny rigid bodies (gravity, spin, bounces against
 * the collision world with restitution and friction, then they settle and lie
 * flat). Cosmetic, so it runs per frame with small substeps. Bounces report
 * the surface and impact speed (tinkle sounds).
 */
const POOL = 40;
const LIFE = 9;
const R = 0.005;

interface Shell {
  r: Renderable;
  active: boolean;
  pos: [number, number, number];
  vel: [number, number, number];
  rot: Quat;
  spin: [number, number, number];
  age: number;
  bounces: number;
  resting: boolean;
}

export class Shells {
  private list: Shell[] = [];
  private next = 0;
  private hit: RayHit = { t: 0, point: [0, 0, 0], normal: [0, 0, 0], surface: 0, owner: '', tri: -1 };
  private m = mat4.create();
  private q = quat.create();
  onBounce: ((pos: ArrayLike<number>, speed: number, surface: number, bounce: number) => void)[] = [];

  constructor(private renderer: Renderer, private world: World, private collision: () => CollisionWorld) {}

  async load() {
    const R_ = this.renderer;
    // Rifle case along +z: body, shoulder, neck, rim.
    const prim = new MeshBuilder()
      .cylinder(place(0, 0, 0.004), 0.0048, 0.034, 10)
      .cylinder(place(0, 0, -0.016), 0.0043, 0.006, 10)
      .cylinder(place(0, 0, -0.023), 0.0032, 0.008, 10)
      .cylinder(place(0, 0, 0.0215), 0.0049, 0.0015, 10)
      .build('brass');
    const mesh = R_.arena.upload({ name: 'shell', primitives: [prim] });
    const materials = [await R_.materials.get('brass')];
    for (let i = 0; i < POOL; i++) {
      const r: Renderable = { slot: R_.instances.alloc(), mesh, materials, castShadow: false, visible: false, id: `shell${i}`, worldMin: new Float32Array(3), worldMax: new Float32Array(3) };
      this.world.renderables.push(r);
      this.list.push({ r, active: false, pos: [0, 0, 0], vel: [0, 0, 0], rot: quat.identity(), spin: [0, 0, 0], age: 0, bounces: 0, resting: false });
    }
  }

  /** Ejects a casing at `pos` with velocity `vel`, oriented along `axis` (weapon forward), spinning `spin` rad/s. */
  eject(pos: ArrayLike<number>, vel: ArrayLike<number>, axis: ArrayLike<number>, spin: ArrayLike<number>) {
    if (!this.list.length) return;
    const s = this.list[this.next];
    this.next = (this.next + 1) % this.list.length;
    s.active = true;
    s.resting = false;
    s.age = 0;
    s.bounces = 0;
    s.pos[0] = pos[0]; s.pos[1] = pos[1]; s.pos[2] = pos[2];
    s.vel[0] = vel[0]; s.vel[1] = vel[1]; s.vel[2] = vel[2];
    s.spin[0] = spin[0]; s.spin[1] = spin[1]; s.spin[2] = spin[2];
    quat.rotationTo([0, 0, -1], vec3.normalize(axis), s.rot);
  }

  update(dt: number) {
    const C = this.collision(), R_ = this.renderer;
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / n;
    for (const s of this.list) {
      if (!s.active) continue;
      s.age += dt;
      if (s.age > LIFE) {
        s.active = false;
        s.r.visible = false;
        continue;
      }
      if (!s.resting) {
        for (let k = 0; k < n; k++) {
          s.vel[1] -= 9.81 * h;
          const v = s.vel, sp = Math.hypot(v[0], v[1], v[2]);
          if (sp > 1e-4) {
            const d = [v[0] / sp, v[1] / sp, v[2] / sp];
            const hit = C.raycast(s.pos, d, sp * h + R, undefined, this.hit);
            if (hit) {
              const nn = hit.normal, vn = v[0] * nn[0] + v[1] * nn[1] + v[2] * nn[2];
              if (vn < 0) {
                // Bounce: restitution on the normal part, friction on the tangent, spin scuffed.
                const e = 0.32 + Math.random() * 0.12, f = 0.62;
                for (let i = 0; i < 3; i++) {
                  const vt = v[i] - vn * nn[i];
                  v[i] = vt * f - vn * e * nn[i];
                }
                s.pos[0] = hit.point[0] + nn[0] * R; s.pos[1] = hit.point[1] + nn[1] * R; s.pos[2] = hit.point[2] + nn[2] * R;
                for (let i = 0; i < 3; i++) s.spin[i] = s.spin[i] * 0.5 + (Math.random() - 0.5) * 25 * Math.min(1, -vn / 3);
                s.bounces++;
                if (-vn > 0.35 && s.bounces <= 5) for (const g of this.onBounce) g(hit.point, -vn, hit.surface, s.bounces);
                if (Math.hypot(v[0], v[1], v[2]) < 0.25 && nn[1] > 0.6) {
                  s.resting = true;
                  // Lie on the surface: case axis in the plane, random heading.
                  const yaw = Math.random() * Math.PI * 2;
                  quat.rotationTo([0, 0, -1], [Math.cos(yaw), 0, Math.sin(yaw)], s.rot);
                  s.pos[1] = hit.point[1] + R * 0.9;
                  break;
                }
                continue;
              }
            }
          }
          s.pos[0] += v[0] * h; s.pos[1] += v[1] * h; s.pos[2] += v[2] * h;
          // Integrate spin.
          const w = Math.hypot(s.spin[0], s.spin[1], s.spin[2]);
          if (w > 1e-3) {
            quat.fromAxisAngle([s.spin[0] / w, s.spin[1] / w, s.spin[2] / w], w * h, this.q);
            quat.multiply(this.q, s.rot, s.rot);
          }
        }
      }
      mat4.fromQuat(s.rot, this.m);
      this.m[12] = s.pos[0]; this.m[13] = s.pos[1]; this.m[14] = s.pos[2];
      s.r.visible = true;
      transformAabb(this.m, s.r.mesh.aabb.min, s.r.mesh.aabb.max, s.r.worldMin, s.r.worldMax);
      R_.instances.set(s.r.slot, this.m, null, -1, 2 | R_.probeBits(s.r.worldMin, s.r.worldMax), 1, 0x5eed);
    }
  }

  clear() {
    for (const s of this.list) {
      s.active = false;
      s.r.visible = false;
    }
  }
}
