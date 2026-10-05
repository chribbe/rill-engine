import { mat4, vec3, type Mat4 } from 'wgpu-matrix';
import type { Camera } from './engine/scene/camera';
import type { LightData, Renderable, Renderer } from './engine/render/renderer';
import type { World } from './engine/scene/world';
import { MeshBuilder, place } from './engine/scene/procmesh';
import { transformAabb } from './engine/render/culling';
import { Surface } from './engine/scene/collision';

/**
 * Action sandbox: gameplay-side rendering hooks used to prove the engine's
 * action-game features (flashlight with realtime shadows, muzzle flashes,
 * particles, bullet decals, first-person viewmodel). Not a game system - a
 * test harness the future gameplay layer will replace.
 */

/** Weapon placement in camera space (x right, y up, -z forward), metres. */
const WEAPON_OFFSET: [number, number, number] = [0.15, -0.15, -0.27];
/** Muzzle and flashlight mount in weapon space. */
const MUZZLE: [number, number, number] = [0, 0, -0.47];
const LIGHT_MOUNT: [number, number, number] = [0, -0.036, -0.39];
const FIRE_INTERVAL = 0.1;

export class Sandbox {
  flashlight = false;
  weapon = false;
  trigger = false;
  /** The sandbox advances the shared particle system (off when the game layer owns it). */
  ownsParticles = true;
  /** Smoothed beam direction (hand-held lag). */
  private aim = vec3.fromValues(0, 0, -1);
  private flashes: { light: LightData; t: number; life: number; peak: number }[] = [];
  private viewmodel: Renderable | null = null;
  private loading = false;
  private weaponMatrix: Mat4 = mat4.identity();
  private cooldown = 0;
  // Viewmodel motion: sway (look lag), bob (walking), recoil (spring).
  private lastYaw = 0;
  private lastPitch = 0;
  private sway = [0, 0];
  private bobPhase = 0;
  private bobAmp = 0;
  private lastPos = vec3.create();
  private kick = 0;
  private kickVel = 0;

  constructor(private renderer: Renderer, private camera: Camera, private world: World) {
    vec3.copy(camera.position, this.lastPos);
    this.lastYaw = camera.yaw;
    this.lastPitch = camera.pitch;
  }

  toggleFlashlight() {
    this.flashlight = !this.flashlight;
  }

  toggleWeapon() {
    this.weapon = !this.weapon;
    if (this.weapon && !this.viewmodel && !this.loading) this.loadViewmodel();
  }

  /** Short point light at a muzzle / impact. */
  flash(position: ArrayLike<number>, color: [number, number, number], peak: number, range: number, life = 0.06, sourceRadius = 0.05, fogScatter = 0.3) {
    this.flashes.push({ light: { position: [position[0], position[1], position[2]], color, intensity: peak, range, type: 'point', sourceRadius, fogScatter }, t: 0, life, peak });
  }

  /** Camera-attached offset in world space (right, up, forward metres). */
  attach(right: number, up: number, fwd: number): [number, number, number] {
    const c = this.camera;
    const f = c.forward, r = c.right;
    const u = vec3.cross(r, f);
    return [0, 1, 2].map((i) => c.position[i] + r[i] * right + u[i] * up + f[i] * fwd) as [number, number, number];
  }

  /** Placeholder carbine built from boxes and cylinders (weapon space, muzzle towards -z). */
  private async loadViewmodel() {
    this.loading = true;
    const steel = new MeshBuilder()
      .box(place(0, 0, -0.06), [0.044, 0.062, 0.28])            // receiver
      .box(place(0, 0.037, -0.07), [0.022, 0.012, 0.24])         // top rail
      .box(place(0, 0.047, 0.05), [0.03, 0.02, 0.026])           // rear sight
      .box(place(0, 0.04, -0.345), [0.006, 0.04, 0.008])         // front sight post
      .box(place(0.026, 0.012, -0.02), [0.01, 0.012, 0.04])      // charging handle
      .cylinder(place(0, 0, -0.415), 0.0105, 0.11, 14)           // barrel
      .cylinder(place(0, 0, -0.462), 0.0145, 0.018, 14)          // muzzle device
      .cylinder(place(0, 0.004, 0.16), 0.012, 0.16, 12)          // stock tube
      .build('weapon_steel');
    const polymer = new MeshBuilder()
      .cylinder(place(0, -0.004, -0.285), 0.025, 0.17, 18)       // handguard
      .box(place(0, -0.1, -0.105, 0.22), [0.026, 0.15, 0.046])  // magazine
      .box(place(0, -0.075, 0.045, -0.32), [0.03, 0.1, 0.042])  // pistol grip
      .box(place(0, -0.036, -0.36), [0.03, 0.026, 0.05])         // light body
      .build('weapon_polymer');
    const mesh = this.renderer.arena.upload({ name: 'viewmodel', primitives: [steel, polymer] });
    const materials = await Promise.all(mesh.primitives.map((p) => this.renderer.materials.get(p.material)));
    const slot = this.renderer.instances.alloc();
    this.viewmodel = {
      slot, mesh, materials, viewmodel: true, castShadow: false, visible: false, id: 'viewmodel',
      worldMin: new Float32Array(3), worldMax: new Float32Array(3),
    };
    this.world.renderables.push(this.viewmodel);
    this.loading = false;
  }

  private weaponPoint(p: ArrayLike<number>): [number, number, number] {
    const w = vec3.transformMat4(p, this.weaponMatrix);
    return [w[0], w[1], w[2]];
  }

  private updateViewmodel(dt: number) {
    const c = this.camera;
    // Sway: the weapon lags behind fast turns, then springs back.
    const dyaw = Math.atan2(Math.sin(c.yaw - this.lastYaw), Math.cos(c.yaw - this.lastYaw));
    const dpitch = c.pitch - this.lastPitch;
    this.lastYaw = c.yaw;
    this.lastPitch = c.pitch;
    const ks = 1 - Math.exp(-dt * 10);
    this.sway[0] += (Math.max(-0.04, Math.min(0.04, -dyaw * 0.35)) - this.sway[0]) * ks;
    this.sway[1] += (Math.max(-0.03, Math.min(0.03, -dpitch * 0.35)) - this.sway[1]) * ks;
    // Bob from horizontal speed.
    const speed = dt > 0 ? Math.hypot(c.position[0] - this.lastPos[0], c.position[2] - this.lastPos[2]) / dt : 0;
    vec3.copy(c.position, this.lastPos);
    const walk = Math.min(1, speed / 4);
    this.bobAmp += (walk - this.bobAmp) * (1 - Math.exp(-dt * 6));
    this.bobPhase += dt * (6 + speed * 1.2);
    const bx = Math.sin(this.bobPhase) * 0.006 * this.bobAmp;
    const by = -Math.abs(Math.cos(this.bobPhase)) * 0.008 * this.bobAmp;
    // Recoil: critically-damped-ish spring.
    this.kickVel += (-this.kick * 260 - this.kickVel * 26) * dt;
    this.kick += this.kickVel * dt;

    const f = c.forward, r = c.right;
    const u = vec3.cross(r, f);
    const cam = mat4.create(r[0], r[1], r[2], 0, u[0], u[1], u[2], 0, -f[0], -f[1], -f[2], 0, c.position[0], c.position[1], c.position[2], 1);
    const local = place(WEAPON_OFFSET[0] + bx + this.sway[0], WEAPON_OFFSET[1] + by + this.sway[1] - this.kick * 0.15, WEAPON_OFFSET[2] + this.kick, this.kick * 1.2 + this.sway[1] * 2, -this.sway[0] * 2);
    mat4.multiply(cam, local, this.weaponMatrix);

    const vm = this.viewmodel;
    if (!vm) return;
    vm.visible = this.weapon;
    if (!vm.visible) return;
    transformAabb(this.weaponMatrix, vm.mesh.aabb.min, vm.mesh.aabb.max, vm.worldMin, vm.worldMax);
    this.renderer.instances.set(vm.slot, this.weaponMatrix, null, -1, 2 | 4 | this.renderer.probeBits(vm.worldMin, vm.worldMax), 1, 0x5eed);
  }

  private fire() {
    const c = this.camera;
    const P = this.renderer.particles;
    const muzzle = this.weaponPoint(MUZZLE);
    const fwd = [c.forward[0], c.forward[1], c.forward[2]];
    this.kickVel += 1.6;
    // Muzzle flash: light slightly ahead of the muzzle (keeps the weapon from blowing out), sprite, smoke.
    const ahead = [0, 1, 2].map((i) => muzzle[i] + fwd[i] * 0.3);
    this.flash(ahead, [1.0, 0.72, 0.4], 450, 12, 0.05, 0.25);
    P.emit('flash', { pos: [0, 1, 2].map((i) => muzzle[i] + fwd[i] * 0.03), life: [0.035, 0.05], size: [0.07, 0.1], color: [1.0, 0.62, 0.3], emissive: 10000 });
    P.emit('flash', { pos: [0, 1, 2].map((i) => muzzle[i] + fwd[i] * 0.1), life: [0.03, 0.045], size: [0.045, 0.065], color: [1.0, 0.8, 0.55], emissive: 15000 });
    P.emit('smoke', { count: 2, pos: muzzle, dir: fwd, spread: 0.5, speed: [0.4, 1.2], life: [0.8, 1.5], size: [0.03, 0.22], color: [0.5, 0.5, 0.51], alpha: 0.1, drag: 3, gravity: -0.12 });

    // Hitscan with a little spread.
    const sp = 0.004;
    const d = vec3.normalize([fwd[0] + (Math.random() - 0.5) * sp, fwd[1] + (Math.random() - 0.5) * sp, fwd[2] + (Math.random() - 0.5) * sp]);
    const hit = this.world.collision.raycast(c.position, d, 250);
    if (!hit) return;
    const n = hit.normal;
    const p = [0, 1, 2].map((i) => hit.point[i] + n[i] * 0.02);
    const metal = hit.surface === Surface.Metal;
    this.world.addDecal(metal ? 'decal_bullet_metal' : 'decal_bullet', hit.point, n, metal ? 0.07 : 0.17 + Math.random() * 0.05);
    // Ricochet direction: reflect the shot, biased to the normal.
    const dn = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
    const refl = [0, 1, 2].map((i) => (d[i] - 2 * dn * n[i]) * 0.5 + n[i] * 0.5);
    if (metal) {
      P.emit('spark', { count: 10, pos: p, dir: refl, spread: 0.7, speed: [3, 9], life: [0.12, 0.35], size: [0.006, 0.006], color: [1.0, 0.55, 0.2], emissive: 40000, drag: 0.6, gravity: 9.8 });
      P.emit('dust', { count: 2, pos: p, dir: n, spread: 0.5, speed: [0.3, 0.8], life: [0.4, 0.8], size: [0.03, 0.18], color: [0.3, 0.3, 0.3], alpha: 0.3, drag: 4 });
      this.flash(p, [1.0, 0.6, 0.3], 60, 4, 0.04, 0.1);
    } else {
      // Fast chunky debris puff along the ricochet, then a slow lingering haze.
      P.emit('dust', { count: 5, pos: p, dir: refl, spread: 0.5, speed: [1, 3.5], life: [0.35, 0.8], size: [0.03, 0.25], color: [0.46, 0.44, 0.41], alpha: 0.45, drag: 5, gravity: 1.5 });
      P.emit('dust', { count: 1, pos: p, dir: n, spread: 0.3, speed: [0.2, 0.4], life: [1.0, 1.8], size: [0.08, 0.45], color: [0.5, 0.48, 0.45], alpha: 0.15, drag: 2.5, gravity: -0.05 });
      P.emit('spark', { count: 3, pos: p, dir: refl, spread: 0.8, speed: [2, 6], life: [0.05, 0.12], size: [0.004, 0.004], color: [1.0, 0.7, 0.4], emissive: 20000, drag: 1, gravity: 9.8 });
    }
  }

  update(dt: number) {
    if (this.ownsParticles) this.renderer.particles.update(dt);
    this.updateViewmodel(dt);
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.weapon && this.viewmodel && this.trigger && this.cooldown <= 0) {
      this.fire();
      this.cooldown = FIRE_INTERVAL;
    }

    const lights: LightData[] = [];
    // Hand-held flashlight: beam lags the view slightly, origin right/below the eye.
    // With the weapon out it is rail-mounted: no lag, origin at the mount.
    const k = this.weapon ? 1 : 1 - Math.exp(-dt * 14);
    vec3.lerp(this.aim, this.camera.forward, k, this.aim);
    vec3.normalize(this.aim, this.aim);
    if (this.flashlight) {
      lights.push({
        position: this.weapon && this.viewmodel ? this.weaponPoint(LIGHT_MOUNT) : this.attach(0.22, -0.2, 0.15),
        direction: [this.aim[0], this.aim[1], this.aim[2]],
        color: [1.0, 0.96, 0.9],
        intensity: 3000,
        range: 35,
        type: 'spot',
        outerAngle: 28,
        innerAngle: 12,
        sourceRadius: 0.03,
        fogScatter: 1.0,
        shadow: true,
      });
    }
    for (const f of this.flashes) {
      const x = f.t / f.life;
      f.light.intensity = f.peak * (1 - x) * (1 - x);
      lights.push(f.light);
      f.t += dt;
    }
    this.flashes = this.flashes.filter((f) => f.t < f.life);
    this.renderer.dynamicLights = lights;
  }
}
