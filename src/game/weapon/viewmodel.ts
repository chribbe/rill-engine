import { mat4, vec3, type Mat4 } from 'wgpu-matrix';
import type { Camera } from '../../engine/scene/camera';
import type { Renderable, Renderer } from '../../engine/render/renderer';
import type { World } from '../../engine/scene/world';
import type { FirstPersonController } from '../../engine/player/controller';
import type { LightPulses } from '../../engine/render/lightpulses';
import { MeshBuilder, place } from '../../engine/scene/procmesh';
import { transformAabb } from '../../engine/render/culling';
import type { ShotEvent } from './firearm';

/**
 * First-person weapon presentation (step 2 placeholder: the box-built carbine
 * with look sway, walk bob and a kick spring; replaced by the modelled,
 * animated gun in step 3). Muzzle flash and smoke are emitted here so they
 * line up with the rendered muzzle.
 */
const OFFSET: [number, number, number] = [0.15, -0.15, -0.27];
const MUZZLE: [number, number, number] = [0, 0, -0.47];

export class Viewmodel {
  visible = true;
  readonly matrix: Mat4 = mat4.identity();
  private r: Renderable | null = null;
  private lastYaw = 0;
  private lastPitch = 0;
  private sway = [0, 0];
  private bobAmp = 0;
  private kick = 0;
  private kickVel = 0;

  constructor(private renderer: Renderer, private world: World, private camera: Camera, private pulses: LightPulses) {}

  async load() {
    const steel = new MeshBuilder()
      .box(place(0, 0, -0.06), [0.044, 0.062, 0.28])
      .box(place(0, 0.037, -0.07), [0.022, 0.012, 0.24])
      .box(place(0, 0.047, 0.05), [0.03, 0.02, 0.026])
      .box(place(0, 0.04, -0.345), [0.006, 0.04, 0.008])
      .box(place(0.026, 0.012, -0.02), [0.01, 0.012, 0.04])
      .cylinder(place(0, 0, -0.415), 0.0105, 0.11, 14)
      .cylinder(place(0, 0, -0.462), 0.0145, 0.018, 14)
      .cylinder(place(0, 0.004, 0.16), 0.012, 0.16, 12)
      .build('weapon_steel');
    const polymer = new MeshBuilder()
      .cylinder(place(0, -0.004, -0.285), 0.025, 0.17, 18)
      .box(place(0, -0.1, -0.105, 0.22), [0.026, 0.15, 0.046])
      .box(place(0, -0.075, 0.045, -0.32), [0.03, 0.1, 0.042])
      .box(place(0, -0.036, -0.36), [0.03, 0.026, 0.05])
      .build('weapon_polymer');
    const mesh = this.renderer.arena.upload({ name: 'viewmodel', primitives: [steel, polymer] });
    const materials = await Promise.all(mesh.primitives.map((p) => this.renderer.materials.get(p.material)));
    const slot = this.renderer.instances.alloc();
    this.r = { slot, mesh, materials, viewmodel: true, castShadow: false, visible: false, id: 'viewmodel', worldMin: new Float32Array(3), worldMax: new Float32Array(3) };
    this.world.renderables.push(this.r);
    this.lastYaw = this.camera.yaw;
    this.lastPitch = this.camera.pitch;
  }

  /** World-space point in weapon space. */
  point(p: ArrayLike<number>, out: [number, number, number] = [0, 0, 0]) {
    const w = vec3.transformMat4(p, this.matrix);
    out[0] = w[0]; out[1] = w[1]; out[2] = w[2];
    return out;
  }

  muzzle(out?: [number, number, number]) {
    return this.point(MUZZLE, out);
  }

  onShot(e: ShotEvent) {
    this.kickVel += 1.6;
    const P = this.renderer.particles;
    const m = this.muzzle();
    const f = e.dir;
    const ahead = [m[0] + f[0] * 0.3, m[1] + f[1] * 0.3, m[2] + f[2] * 0.3];
    this.pulses.emit(ahead, [1.0, 0.72, 0.4], 450, 12, 0.05, 0.25);
    P.emit('flash', { pos: [m[0] + f[0] * 0.03, m[1] + f[1] * 0.03, m[2] + f[2] * 0.03], life: [0.035, 0.05], size: [0.07, 0.1], color: [1.0, 0.62, 0.3], emissive: 10000 });
    P.emit('flash', { pos: [m[0] + f[0] * 0.1, m[1] + f[1] * 0.1, m[2] + f[2] * 0.1], life: [0.03, 0.045], size: [0.045, 0.065], color: [1.0, 0.8, 0.55], emissive: 15000 });
    P.emit('smoke', { count: 2, pos: m, dir: f, spread: 0.5, speed: [0.4, 1.2], life: [0.8, 1.5], size: [0.03, 0.22], color: [0.5, 0.5, 0.51], alpha: 0.1, drag: 3, gravity: -0.12 });
  }

  update(dt: number, player: FirstPersonController) {
    const c = this.camera;
    // This frame's view basis (the renderer updates the camera again; posing from last frame's would lag a frame).
    c.update();
    const dyaw = Math.atan2(Math.sin(c.yaw - this.lastYaw), Math.cos(c.yaw - this.lastYaw));
    const dpitch = c.pitch - this.lastPitch;
    this.lastYaw = c.yaw;
    this.lastPitch = c.pitch;
    const ks = 1 - Math.exp(-dt * 10);
    this.sway[0] += (Math.max(-0.04, Math.min(0.04, -dyaw * 0.35)) - this.sway[0]) * ks;
    this.sway[1] += (Math.max(-0.03, Math.min(0.03, -dpitch * 0.35)) - this.sway[1]) * ks;
    const walk = player.onGround ? Math.min(1, player.speed / 4) : 0;
    this.bobAmp += (walk - this.bobAmp) * (1 - Math.exp(-dt * 6));
    const bx = Math.sin(player.bobPhase) * 0.006 * this.bobAmp;
    const by = -Math.abs(Math.cos(player.bobPhase)) * 0.008 * this.bobAmp;
    // Kick spring, substepped for stability at low frame rates.
    for (let n = Math.max(1, Math.ceil(dt / (1 / 240))), i = 0; i < n; i++) {
      const h = dt / n;
      this.kickVel += (-this.kick * 260 - this.kickVel * 26) * h;
      this.kick += this.kickVel * h;
    }
    const f = c.forward, r = c.right;
    const u = vec3.cross(r, f);
    const cam = mat4.create(r[0], r[1], r[2], 0, u[0], u[1], u[2], 0, -f[0], -f[1], -f[2], 0, c.position[0], c.position[1], c.position[2], 1);
    const local = place(OFFSET[0] + bx + this.sway[0], OFFSET[1] + by + this.sway[1] - this.kick * 0.15, OFFSET[2] + this.kick, this.kick * 1.2 + this.sway[1] * 2, -this.sway[0] * 2);
    mat4.multiply(cam, local, this.matrix);
    const vm = this.r;
    if (!vm) return;
    vm.visible = this.visible;
    if (!vm.visible) return;
    transformAabb(this.matrix, vm.mesh.aabb.min, vm.mesh.aabb.max, vm.worldMin, vm.worldMax);
    this.renderer.instances.set(vm.slot, this.matrix, null, -1, 2 | 4 | this.renderer.probeBits(vm.worldMin, vm.worldMax), 1, 0x5eed);
  }
}
