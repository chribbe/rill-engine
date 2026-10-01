import type { Camera } from '../scene/camera';
import type { CollisionWorld } from '../scene/collision';

/**
 * First-person controller. Raw pointer-lock mouse look (no smoothing, no
 * acceleration), velocity-based movement with quick acceleration/friction, and a
 * capsule approximated by stacked spheres for wall collision. Stairs are climbed
 * via ground rays within a step height; the eye height is smoothed so steps
 * read as steps without jerking the view.
 */
export class FirstPersonController {
  fly = false;
  eyeHeight = 1.65;
  radius = 0.3;
  stepHeight = 0.45;
  walkSpeed = 3.2;
  runSpeed = 7.0;
  slowSpeed = 1.2;
  flySpeed = 12;
  sensitivity = 0.0022;
  /** Feet position. */
  feet: [number, number, number] = [0, 0, 0];
  velocity: [number, number, number] = [0, 0, 0];
  onGround = false;
  private smoothedFeetY = 0;
  private keys = new Set<string>();
  locked = false;
  enabled = true;

  constructor(private camera: Camera, canvas: HTMLCanvasElement, private collision: CollisionWorld | null) {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      this.keys.add(e.code);
      if (e.code === 'KeyF' && !e.repeat) this.toggleFly();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    canvas.addEventListener('click', () => {
      if (!this.locked && this.enabled) {
        const req = canvas.requestPointerLock as (o?: { unadjustedMovement?: boolean }) => Promise<void> | void;
        try {
          const r = req.call(canvas, { unadjustedMovement: true });
          if (r && 'catch' in r) (r as Promise<void>).catch(() => canvas.requestPointerLock());
        } catch {
          canvas.requestPointerLock();
        }
      }
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.camera.yaw += e.movementX * this.sensitivity;
      this.camera.pitch = Math.max(-1.55, Math.min(1.55, this.camera.pitch - e.movementY * this.sensitivity));
    });
  }

  setCollision(c: CollisionWorld) {
    this.collision = c;
  }

  teleport(pos: [number, number, number], yawDeg?: number, pitchDeg?: number) {
    this.feet = [pos[0], pos[1], pos[2]];
    this.smoothedFeetY = pos[1];
    this.velocity = [0, 0, 0];
    if (yawDeg !== undefined) this.camera.yaw = (yawDeg * Math.PI) / 180;
    if (pitchDeg !== undefined) this.camera.pitch = (pitchDeg * Math.PI) / 180;
    this.syncCamera();
  }

  toggleFly() {
    this.fly = !this.fly;
    this.velocity = [0, 0, 0];
  }

  private syncCamera() {
    const c = this.camera.position;
    c[0] = this.feet[0];
    c[1] = (this.fly ? this.feet[1] : this.smoothedFeetY) + this.eyeHeight;
    c[2] = this.feet[2];
  }

  update(dt: number) {
    dt = Math.min(dt, 0.05);
    const k = this.keys;
    let fx = 0, fz = 0;
    if (k.has('KeyW')) fz += 1;
    if (k.has('KeyS')) fz -= 1;
    if (k.has('KeyD')) fx += 1;
    if (k.has('KeyA')) fx -= 1;
    const sprint = k.has('ShiftLeft') || k.has('ShiftRight');
    const slow = k.has('AltLeft') || k.has('ControlLeft');
    const yaw = this.camera.yaw;
    const fwd = [Math.sin(yaw), 0, -Math.cos(yaw)];
    const right = [Math.cos(yaw), 0, Math.sin(yaw)];

    if (this.fly || !this.collision) {
      const pitch = this.camera.pitch;
      const f3 = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
      let up = 0;
      if (k.has('KeyE') || k.has('Space')) up += 1;
      if (k.has('KeyQ')) up -= 1;
      const sp = this.flySpeed * (sprint ? 4 : slow ? 0.2 : 1);
      const target = [0, 1, 2].map((i) => (f3[i] * fz + right[i] * fx) * sp + (i === 1 ? up * sp : 0));
      const a = 1 - Math.exp(-dt * 10);
      for (let i = 0; i < 3; i++) {
        this.velocity[i] += (target[i] - this.velocity[i]) * a;
        this.feet[i] += this.velocity[i] * dt;
      }
      this.smoothedFeetY = this.feet[1];
      this.syncCamera();
      return;
    }

    // ---- walking
    const len = Math.hypot(fx, fz) || 1;
    const speed = sprint ? this.runSpeed : slow ? this.slowSpeed : this.walkSpeed;
    const wish = [(fwd[0] * fz + right[0] * fx) / len * speed, (fwd[2] * fz + right[2] * fx) / len * speed];
    const accel = this.onGround ? 14 : 3;
    const a = 1 - Math.exp(-dt * accel);
    this.velocity[0] += (wish[0] - this.velocity[0]) * a;
    this.velocity[2] += (wish[1] - this.velocity[2]) * a;
    if (this.onGround && k.has('Space')) {
      this.velocity[1] = 4.2;
      this.onGround = false;
    }
    this.velocity[1] -= 9.81 * dt;

    // Never let a bad collision result poison the camera (NaN = white screen).
    const safe = [this.feet[0], this.feet[1], this.feet[2]];
    // Substeps keep collision stable at high speed.
    const steps = Math.max(1, Math.ceil((Math.hypot(this.velocity[0], this.velocity[2]) * dt) / 0.1));
    const sdt = dt / steps;
    for (let s = 0; s < steps; s++) {
      this.feet[0] += this.velocity[0] * sdt;
      this.feet[2] += this.velocity[2] * sdt;
      this.feet[1] += this.velocity[1] * sdt;
      // Wall collision: spheres from above step height to head height.
      const r = this.radius;
      for (const h of [this.stepHeight + r, 1.1, 1.8 - r]) {
        const p: [number, number, number] = [this.feet[0], this.feet[1] + h, this.feet[2]];
        const push = this.collision.pushSphere(p, r);
        this.feet[0] += push[0];
        this.feet[2] += push[2];
        // Ceiling
        if (push[1] < -1e-4 && this.velocity[1] > 0) this.velocity[1] = 0;
      }
      // Ground: rays at the centre and a small ring, highest hit wins.
      let ground = -Infinity;
      const probe = this.feet[1] + this.stepHeight;
      const maxDrop = this.stepHeight + (this.onGround ? 0.35 : 0.05) + Math.max(0, -this.velocity[1] * sdt);
      const ring = this.radius * 0.6;
      for (const [ox, oz] of [[0, 0], [ring, 0], [-ring, 0], [0, ring], [0, -ring]]) {
        const g = this.collision.groundHeight(this.feet[0] + ox, probe, this.feet[2] + oz, maxDrop);
        if (g > ground) ground = g;
      }
      if (ground > -Infinity && this.velocity[1] <= 0.01) {
        this.feet[1] = ground;
        this.velocity[1] = 0;
        this.onGround = true;
      } else {
        this.onGround = false;
      }
    }
    if (!this.feet.every(Number.isFinite) || !this.velocity.every(Number.isFinite)) {
      console.warn('[player] non-finite collision result; reverting step');
      this.feet[0] = safe[0]; this.feet[1] = safe[1]; this.feet[2] = safe[2];
      this.velocity[0] = this.velocity[1] = this.velocity[2] = 0;
    }
    if (this.feet[1] < -100) this.teleport([this.feet[0], 50, this.feet[2]]);
    // Smooth vertical eye motion on steps (only when stepping up/down on ground).
    const dy = this.feet[1] - this.smoothedFeetY;
    if (Math.abs(dy) > 1.0 || !this.onGround) this.smoothedFeetY = this.feet[1];
    else this.smoothedFeetY += dy * (1 - Math.exp(-dt * 18));
    this.syncCamera();
  }
}
