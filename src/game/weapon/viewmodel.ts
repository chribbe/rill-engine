import { mat4, quat, type Mat4 } from 'wgpu-matrix';
import type { Camera } from '../../engine/scene/camera';
import type { Renderer } from '../../engine/render/renderer';
import type { World } from '../../engine/scene/world';
import type { FirstPersonController } from '../../engine/player/controller';
import type { LightPulses } from '../../engine/render/lightpulses';
import { MeshBuilder, place } from '../../engine/scene/procmesh';
import { Rig, type RigPart, type RigPartSource } from '../../engine/scene/rig';
import { loadGlbParts } from '../../engine/assets/gltf';
import { spring, stepSpring, approach, type Spring1 } from '../../engine/core/spring';
import type { WeaponDef } from './def';
import type { ShotEvent } from './firearm';

const RAD = Math.PI / 180;
const MUZZLE_ANCHOR = 1;

/**
 * First-person weapon presentation: a rigid-part rig (receiver, bolt,
 * trigger, magazine) posed every frame from layered motion:
 *
 *   camera (rendered view, incl. punch)
 *   × offset + crouch + sprint pose
 *   × look inertia (springs towards a lag proportional to turn rate)
 *   × walk cycle (figure eight synced to footsteps) + strafe roll + acceleration lag
 *   × air / landing response, idle breathing
 *   × shot kick (springs, impulses applied at their exact shot times)
 *
 * Rotations pivot near the grip. The bolt cycles over exactly one shot
 * interval, so it matches any tuned rate of fire. Muzzle flash sprites are
 * drawn in the weapon's projection and follow the muzzle; smoke starts at the
 * world-space point that lines up with the muzzle on screen.
 */
export class Viewmodel {
  visible = true;
  readonly rig: Rig;
  readonly root: Mat4 = mat4.identity();
  private receiver: RigPart | null = null;
  private bolt: RigPart | null = null;
  private trigger: RigPart | null = null;
  /** Muzzle and ejection port in receiver space. */
  muzzleLocal: [number, number, number] = [0, 0, -0.47];
  ejectLocal: [number, number, number] = [0.024, 0.012, -0.04];
  private loaded = false;

  // Motion state.
  private swayY = spring();
  private swayP = spring();
  private swayR = spring();
  private swayX = spring();
  private lagZ = spring();
  private airY = spring();
  private airP = spring();
  private kick = { z: spring(), y: spring(), p: spring(), yaw: spring(), r: spring() };
  private bobAmp = 0;
  private sprint = 0;
  private crouch = 0;
  private lastVel: [number, number] = [0, 0];
  private time = 0;
  private lastShotTime = -Infinity;
  private trig = 0;
  private pending: { time: number; burst: number }[] = [];
  private flashQueue = 0;
  /** Barrel heat (shots, decaying): wisps of smoke after sustained fire. */
  private heat = 0;
  private wispT = 0;
  private tmp: [number, number, number] = [0, 0, 0];
  private tmp2: [number, number, number] = [0, 0, 0];
  private seed = 0x1234567;
  /**
   * Per shot, once the gun is posed: ejection port (world point lined up with the
   * rendered port), the gun's right / up / forward axes in world space.
   */
  onEject: ((port: [number, number, number], right: [number, number, number], up: [number, number, number], fwd: [number, number, number]) => void)[] = [];

  constructor(private renderer: Renderer, private world: World, private camera: Camera, private pulses: LightPulses, public def: WeaponDef) {
    this.rig = new Rig(renderer, 'viewmodel', { viewmodel: true });
  }

  private rand() {
    let t = (this.seed = (this.seed + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Loads the modelled weapon (GLB parts), or builds the placeholder when it is missing. */
  async load(url = '/assets/weapons/carbine.glb') {
    const R = this.renderer;
    let src: RigPartSource[];
    try {
      const parts = await loadGlbParts(url);
      src = await Promise.all(parts.map(async (p) => {
        const mesh = p.mesh.primitives.length ? R.arena.upload(p.mesh) : null;
        const materials = mesh ? await Promise.all(mesh.primitives.map((q) => R.materials.get(q.material))) : [];
        if (p.name === 'muzzle') this.muzzleLocal = [p.rest[12], p.rest[13], p.rest[14]];
        if (p.name === 'eject') this.ejectLocal = [p.rest[12], p.rest[13], p.rest[14]];
        return { name: p.name, parent: p.parent, rest: p.rest, mesh, materials };
      }));
      src = src.filter((s) => s.mesh);
    } catch {
      src = await this.placeholder();
    }
    this.rig.add(src, this.world.renderables);
    this.receiver = this.rig.part('receiver') ?? this.rig.parts[0];
    this.bolt = this.rig.part('bolt') ?? null;
    this.trigger = this.rig.part('trigger') ?? null;
    this.loaded = true;
  }

  /** Box-built carbine split into the rig's parts (until the Blender model exists). */
  private async placeholder(): Promise<RigPartSource[]> {
    const R = this.renderer;
    const mk = async (name: string, rest: Mat4, builders: { steel?: (b: MeshBuilder) => void; polymer?: (b: MeshBuilder) => void }) => {
      const prims = [];
      if (builders.steel) { const b = new MeshBuilder(); builders.steel(b); prims.push(b.build('weapon_steel')); }
      if (builders.polymer) { const b = new MeshBuilder(); builders.polymer(b); prims.push(b.build('weapon_polymer')); }
      const mesh = R.arena.upload({ name: `vm_${name}`, primitives: prims });
      const materials = await Promise.all(mesh.primitives.map((p) => R.materials.get(p.material)));
      return { name, rest, mesh, materials };
    };
    return Promise.all([
      mk('receiver', mat4.identity(), {
        steel: (b) => b
          .box(place(0, 0, -0.06), [0.044, 0.062, 0.28])
          .box(place(0, 0.037, -0.07), [0.022, 0.012, 0.24])
          .box(place(0, 0.047, 0.05), [0.03, 0.02, 0.026])
          .box(place(0, 0.04, -0.345), [0.006, 0.04, 0.008])
          .cylinder(place(0, 0, -0.415), 0.0105, 0.11, 14)
          .cylinder(place(0, 0, -0.462), 0.0145, 0.018, 14)
          .cylinder(place(0, 0.004, 0.16), 0.012, 0.16, 12),
        polymer: (b) => b
          .cylinder(place(0, -0.004, -0.285), 0.025, 0.17, 18)
          .box(place(0, -0.075, 0.045, -0.32), [0.03, 0.1, 0.042])
          .box(place(0, -0.036, -0.36), [0.03, 0.026, 0.05]),
      }),
      mk('bolt', mat4.translation([0.026, 0.012, -0.02]), { steel: (b) => b.box(place(0, 0, 0), [0.01, 0.012, 0.04]).box(place(-0.008, 0, 0.0), [0.008, 0.008, 0.012]) }),
      mk('trigger', mat4.translation([0, -0.038, -0.02]), { steel: (b) => b.box(place(0, -0.008, 0, 0.2), [0.006, 0.018, 0.005]) }),
      mk('magazine', mat4.translation([0, -0.04, -0.105]), { polymer: (b) => b.box(place(0, -0.06, 0, 0.22), [0.026, 0.15, 0.046]) }),
    ]);
  }

  /** The player landed at `speed` m/s: the gun dips and tips down, then springs back. */
  land(speed: number) {
    const V = this.def.viewmodel, k = Math.min(8, Math.max(0, speed - 1)) * 2 * Math.PI * 5 * 1.6;
    this.airY.v -= V.landDrop * k;
    this.airP.v -= V.landPitch * RAD * k;
  }

  /** A shot was fired (from the tick): kick at its exact time, flash on the next pose. */
  onShot(e: ShotEvent) {
    this.pending.push({ time: e.time, burst: e.burstIndex });
    this.flashQueue++;
  }

  private applyKick(burst: number) {
    const k = this.def.kick, K = this.kick;
    const v = (base: number) => base * (1 + (this.rand() * 2 - 1) * k.random);
    const wp = 2 * Math.PI * k.posHz, wr = 2 * Math.PI * k.rotHz;
    // Velocity kicks sized so each spring peaks near its amplitude.
    K.z.v += v(k.back) * wp * 1.6;
    K.y.v += v(k.up) * wp * 1.6;
    K.p.v += v(k.pitch) * RAD * wr * 1.6;
    K.yaw.v += k.yaw * (this.rand() * 2 - 1) * RAD * wr * 1.6;
    K.r.v += k.roll * (this.rand() * 2 - 1) * RAD * wr * 1.6;
    void burst;
  }

  private stepKick(dt: number) {
    const k = this.def.kick, K = this.kick;
    stepSpring(K.z, 0, k.posHz, k.posDamping, dt);
    stepSpring(K.y, 0, k.posHz, k.posDamping, dt);
    stepSpring(K.p, 0, k.rotHz, k.rotDamping, dt);
    stepSpring(K.yaw, 0, k.rotHz, k.rotDamping, dt);
    stepSpring(K.r, 0, k.rotHz, k.rotDamping, dt);
  }

  /**
   * Per frame. `now`: simulated time of this frame (clock time + alpha × step);
   * `look`: this frame's view rotation (yaw, pitch radians); `triggerHeld` for the trigger.
   */
  update(dt: number, now: number, look: [number, number], player: FirstPersonController, triggerHeld: boolean, interval: number) {
    const c = this.camera, V = this.def.viewmodel;
    c.viewmodelFovY = V.fov * RAD;
    // This frame's view basis (the renderer updates the camera again; posing from last frame's would lag a frame).
    c.update();
    if (!this.loaded) return;

    // ---- shot kicks at their exact times, then the rest of the frame
    let t = Math.min(this.time, now);
    this.pending.sort((a, b) => a.time - b.time);
    for (const p of this.pending) {
      const at = Math.max(t, Math.min(now, p.time));
      this.stepKick(at - t);
      this.applyKick(p.burst);
      this.lastShotTime = p.time;
      t = at;
    }
    this.pending.length = 0;
    this.stepKick(Math.max(0, now - t));
    this.time = now;

    // ---- look inertia: lag against the turn rate
    const inv = dt > 1e-5 ? 1 / dt : 0;
    const clampD = (x: number) => Math.max(-V.swayMax, Math.min(V.swayMax, x));
    stepSpring(this.swayY, clampD(-look[0] * inv * V.sway), V.swayHz, V.swayDamping, dt);
    stepSpring(this.swayP, clampD(-look[1] * inv * V.sway), V.swayHz, V.swayDamping, dt);
    stepSpring(this.swayR, clampD(-look[0] * inv * V.sway * 0.6 - player.localVelocity[0] * V.strafeRoll), V.swayHz * 0.8, V.swayDamping, dt);
    stepSpring(this.swayX, clampD(-look[0] * inv * V.sway) * 0.0012, V.swayHz, V.swayDamping, dt);

    // ---- movement: acceleration lag, air, landing
    const v = player.velocity;
    const fwdSpeed = player.localVelocity[1];
    const accel = inv * (fwdSpeed - this.lastVel[0]);
    const vy = player.fly ? 0 : v[1];
    this.lastVel[0] = fwdSpeed;
    stepSpring(this.lagZ, Math.max(-0.03, Math.min(0.03, accel * V.accelLag)), 4, 0.7, dt);
    stepSpring(this.airY, player.onGround ? 0 : Math.max(-0.03, Math.min(0.03, -vy * V.airLift)), 5, 0.55, dt);
    stepSpring(this.airP, player.onGround ? 0 : Math.max(-4, Math.min(4, -vy * V.airPitch)) * RAD, 5, 0.55, dt);

    // ---- walk cycle, stance, sprint
    const run = player.tuning.runSpeed;
    const walk = player.onGround && !player.fly ? Math.min(1.4, player.speed / run) : 0;
    this.bobAmp += (walk - this.bobAmp) * approach(8, dt);
    this.crouch += ((player.stance === 'crouch' ? 1 : 0) - this.crouch) * approach(10, dt);
    const sprintTarget = player.sprinting && !triggerHeld ? 1 : 0;
    this.sprint += (sprintTarget - this.sprint) * approach(sprintTarget ? V.sprintRate : V.sprintRate * 2.5, dt);
    const ph = player.bobPhase, a = this.bobAmp * (1 - this.sprint * 0.3);
    const bobX = Math.sin(ph) * V.bobSide * a;
    const bobY = -0.5 * (1 + Math.cos(2 * ph)) * V.bobUp * a * (1 + this.sprint * 0.6);
    const bobR = Math.sin(ph) * V.bobRoll * a;
    const br = this.time * 2 * Math.PI * V.breatheRate, still = Math.max(0, 1 - this.bobAmp * 2);
    const breY = Math.sin(br) * V.breathe * still, breP = Math.sin(br - 0.6) * V.breathePitch * still;

    // ---- compose: camera × offset × pivot × rotation × pivot⁻¹
    const K = this.kick, s = this.sprint, cr = this.crouch;
    const ox = V.offset[0] + V.crouchOffset[0] * cr + V.sprintOffset[0] * s + bobX + this.swayX.x;
    const oy = V.offset[1] + V.crouchOffset[1] * cr + V.sprintOffset[1] * s + bobY + breY + this.airY.x + K.y.x;
    const oz = V.offset[2] + V.crouchOffset[2] * cr + V.sprintOffset[2] * s + this.lagZ.x + K.z.x;
    const pitch = (V.rotation[0] + V.sprintRot[0] * s + breP) * RAD + this.swayP.x * RAD + this.airP.x + K.p.x;
    const yaw = (V.rotation[1] + V.sprintRot[1] * s) * RAD + this.swayY.x * RAD + K.yaw.x;
    const roll = (V.rotation[2] + V.sprintRot[2] * s + V.crouchRoll * cr + bobR) * RAD + this.swayR.x * RAD + K.r.x;
    const f = c.forward, r = c.right;
    const ux = r[1] * f[2] - r[2] * f[1], uy = r[2] * f[0] - r[0] * f[2], uz = r[0] * f[1] - r[1] * f[0];
    const M = this.root;
    mat4.set(r[0], r[1], r[2], 0, ux, uy, uz, 0, -f[0], -f[1], -f[2], 0, c.position[0], c.position[1], c.position[2], 1, M);
    mat4.translate(M, [ox + V.pivot[0], oy + V.pivot[1], oz + V.pivot[2]], M);
    mat4.rotateY(M, -yaw, M);
    mat4.rotateX(M, pitch, M);
    mat4.rotateZ(M, -roll, M);
    mat4.translate(M, [-V.pivot[0], -V.pivot[1], -V.pivot[2]], M);

    // ---- mechanics: bolt cycles over one shot interval; trigger follows the finger
    const m = this.def.mechanics;
    if (this.bolt) {
      const u = (now - this.lastShotTime) / Math.max(1e-3, interval);
      let x = 0;
      if (u >= 0 && u < 1) {
        if (u < m.boltBack) { const q = u / m.boltBack; x = 1 - (1 - q) * (1 - q); }
        else { const q = (u - m.boltBack) / (1 - m.boltBack); x = 1 - q * q; }
      }
      this.bolt.pos[2] = x * m.boltTravel;
    }
    this.trig += ((triggerHeld ? 1 : 0) - this.trig) * approach(60, dt);
    if (this.trigger) quat.fromEuler(-this.trig * m.triggerPull * RAD, 0, 0, 'xyz', this.trigger.rot);

    this.rig.visible = this.visible;
    this.rig.update(M, 2 | 4);

    // ---- flashes for this frame's shots, on the posed muzzle
    const mz = this.muzzle(this.tmp);
    this.renderer.particles.setAnchor(MUZZLE_ANCHOR, mz);
    // Barrel heat: wisps rise from the muzzle once a long burst stops.
    this.heat = Math.max(0, this.heat - dt * 0.9);
    this.wispT -= dt;
    if (this.heat > 4 && now - this.lastShotTime > 0.15 && this.wispT <= 0 && this.visible) {
      this.wispT = 0.05 + this.rand() * 0.04;
      const k = Math.min(1, (this.heat - 4) / 10);
      this.renderer.particles.emit('smoke', { pos: this.worldEquivalent(mz), dir: [0, 1, 0], spread: 0.25, speed: [0.08, 0.25], life: [1.0, 1.8], size: [0.008, 0.09], color: [0.6, 0.6, 0.62], alpha: 0.05 + 0.07 * k, drag: 2, gravity: -0.3 });
    }
    if (this.flashQueue > 0 && this.visible) {
      this.heat += this.flashQueue;
      this.emitFlash(mz);
      const R = this.receiver!;
      const norm = (v: [number, number, number]) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; v[0] /= l; v[1] /= l; v[2] /= l; return v; };
      const right = norm(this.rig.dir(R, [1, 0, 0], [0, 0, 0])), up = norm(this.rig.dir(R, [0, 1, 0], [0, 0, 0])), fwd = norm(this.rig.dir(R, [0, 0, -1], [0, 0, 0]));
      const port = this.worldEquivalent(this.eject([0, 0, 0]));
      for (let i = 0; i < this.flashQueue; i++) for (const g of this.onEject) g(port, right, up, fwd);
    }
    this.flashQueue = 0;
  }

  private emitFlash(mz: [number, number, number]) {
    const P = this.renderer.particles, R = this.receiver!;
    const fwd = this.rig.dir(R, [0, 0, -1], this.tmp2);
    const l = Math.hypot(fwd[0], fwd[1], fwd[2]) || 1;
    fwd[0] /= l; fwd[1] /= l; fwd[2] /= l;
    const at = (d: number): [number, number, number] => [mz[0] + fwd[0] * d, mz[1] + fwd[1] * d, mz[2] + fwd[2] * d];
    const big = 0.75 + this.rand() * 0.5;
    // Core star on the muzzle, a hot inner flash, and a forward plume streak.
    P.emit('flash', { pos: at(0.025), life: [0.03, 0.045], size: [0.05 * big, 0.075 * big], color: [1.0, 0.62, 0.3], emissive: 9000, viewmodel: true, anchor: MUZZLE_ANCHOR });
    P.emit('flash', { pos: at(0.012), life: [0.022, 0.03], size: [0.028, 0.04], color: [1.0, 0.85, 0.6], emissive: 16000, viewmodel: true, anchor: MUZZLE_ANCHOR });
    P.emit('flash', { pos: at(0.09), dir: fwd, spread: 0, speed: [5, 7], life: [0.025, 0.035], size: [0.03, 0.04], color: [1.0, 0.6, 0.28], emissive: 7000, viewmodel: true, stretch: true, drag: 30, anchor: MUZZLE_ANCHOR });
    // Light ahead of the muzzle (keeps the gun itself from blowing out).
    this.pulses.emit(this.worldEquivalent(at(0.3)), [1.0, 0.72, 0.4], 420, 12, 0.05, 0.25);
    // Smoke from the world point that lines up with the muzzle on screen.
    const sm = this.worldEquivalent(at(0.02));
    P.emit('smoke', { count: 2, pos: sm, dir: fwd, spread: 0.45, speed: [0.3, 1.0], life: [0.7, 1.4], size: [0.025, 0.2], color: [0.5, 0.5, 0.51], alpha: 0.09, drag: 3.5, gravity: -0.12 });
  }

  /** World point that projects (world FOV) to the same pixel as `p` does in the weapon's FOV. */
  worldEquivalent(p: ArrayLike<number>, out: [number, number, number] = [0, 0, 0]) {
    const c = this.camera, f = c.forward, r = c.right;
    const ux = r[1] * f[2] - r[2] * f[1], uy = r[2] * f[0] - r[0] * f[2], uz = r[0] * f[1] - r[1] * f[0];
    const dx = p[0] - c.position[0], dy = p[1] - c.position[1], dz = p[2] - c.position[2];
    const x = dx * r[0] + dy * r[1] + dz * r[2], y = dx * ux + dy * uy + dz * uz, z = dx * f[0] + dy * f[1] + dz * f[2];
    const k = c.viewmodelFovY > 0 ? Math.tan(c.fovY / 2) / Math.tan(c.viewmodelFovY / 2) : 1;
    out[0] = c.position[0] + (r[0] * x + ux * y) * k + f[0] * z;
    out[1] = c.position[1] + (r[1] * x + uy * y) * k + f[1] * z;
    out[2] = c.position[2] + (r[2] * x + uz * y) * k + f[2] * z;
    return out;
  }

  /** Hides the weapon now (leaving play mode: its instances must not linger). */
  hide() {
    this.visible = false;
    this.rig.visible = false;
    this.rig.commit(2 | 4);
  }

  muzzle(out: [number, number, number] = [0, 0, 0]) {
    return this.receiver ? this.rig.point(this.receiver, this.muzzleLocal, out) : out;
  }

  eject(out: [number, number, number] = [0, 0, 0]) {
    return this.receiver ? this.rig.point(this.receiver, this.ejectLocal, out) : out;
  }

  /** Weapon-space direction in world space (for shell ejection). */
  dir(local: ArrayLike<number>, out: [number, number, number] = [0, 0, 0]) {
    return this.receiver ? this.rig.dir(this.receiver, local, out) : out;
  }

  reset() {
    for (const s of [this.swayY, this.swayP, this.swayR, this.swayX, this.lagZ, this.airY, this.airP, ...Object.values(this.kick)] as Spring1[]) s.x = s.v = 0;
    this.pending.length = 0;
    this.lastShotTime = -Infinity;
  }
}
