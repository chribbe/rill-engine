import { CapsuleContacts, type CollisionWorld, type GroundProbe } from '../scene/collision';

/**
 * Kinematic character motor over the static collision world ("floating
 * capsule"): a vertical capsule from step height up to the head collides with
 * walls and ceilings; ground below step height is found by a ring of ground
 * probes, so kerbs and stairs are climbed by snapping instead of being walls.
 * Velocity is clipped against every contact (no sticky walls, no corner
 * jitter), only walkable slopes count as ground, and steps are reported so the
 * camera can smooth them. Movement is substepped below half the radius, so it
 * cannot tunnel at any speed.
 */
export interface CharacterShape {
  radius: number;
  /** Current capsule height (standing or crouched). */
  height: number;
  stepHeight: number;
  /** Steepest walkable slope (degrees). */
  maxSlope: number;
}

/** Ground probe offsets (x, z pairs, in units of 0.6 × radius). */
const RING = [0, 0, 1, 0, -1, 0, 0, 1, 0, -1, 0.7071, 0.7071, -0.7071, 0.7071, 0.7071, -0.7071, -0.7071, -0.7071];
/** Ledges caught while falling (less than a step: no popping up onto things mid-air). */
const AIR_STEP = 0.18;
/** Snaps larger than this within one substep are steps (smoothed by the camera), not slope following. */
const STEP_THRESHOLD = 0.04;

export class CharacterMotor {
  feet: [number, number, number] = [0, 0, 0];
  velocity: [number, number, number] = [0, 0, 0];
  grounded = false;
  /** Ground under the character (valid while grounded). */
  ground: GroundProbe = { height: 0, nx: 0, ny: 1, nz: 0, surface: 0, tri: -1 };
  /** Set by `move`: downward speed at landing (m/s, 0 = no landing this move). */
  landSpeed = 0;
  hitCeiling = false;
  /** Sum of step snaps during the last move (m, + up), for camera smoothing. */
  stepDelta = 0;
  readonly contacts = new CapsuleContacts();
  private prev: [number, number, number] = [0, 0, 0];
  private probe: GroundProbe = { height: 0, nx: 0, ny: 1, nz: 0, surface: 0, tri: -1 };

  constructor(public collision: CollisionWorld | null, public shape: CharacterShape) {}

  private get wallBottom() {
    return this.shape.stepHeight + this.shape.radius;
  }

  /** Integrates the velocity for `h` seconds with collision. */
  move(h: number) {
    const C = this.collision;
    const p = this.feet, v = this.velocity;
    this.landSpeed = 0;
    this.hitCeiling = false;
    this.stepDelta = 0;
    if (!C) {
      p[0] += v[0] * h; p[1] += v[1] * h; p[2] += v[2] * h;
      return;
    }
    const { radius: r, stepHeight } = this.shape;
    const minNy = Math.cos((this.shape.maxSlope * Math.PI) / 180);
    const n = Math.min(16, Math.max(1, Math.ceil((Math.hypot(v[0], v[1], v[2]) * h) / (r * 0.4))));
    const sh = h / n;
    const y0 = this.wallBottom, y1 = Math.max(y0, this.shape.height - r);
    for (let s = 0; s < n; s++) {
      this.prev[0] = p[0]; this.prev[1] = p[1]; this.prev[2] = p[2];
      p[0] += v[0] * sh; p[1] += v[1] * sh; p[2] += v[2] * sh;

      // Walls and ceilings; clip the velocity against every contact.
      const k = C.pushCapsule(p, y0, y1, r, this.contacts, this.prev);
      for (let i = 0; i < k; i++) {
        const nx = this.contacts.n[i * 3], ny = this.contacts.n[i * 3 + 1], nz = this.contacts.n[i * 3 + 2];
        if (ny < -0.2 && v[1] > 0) {
          v[1] = 0;
          this.hitCeiling = true;
        }
        const hl = Math.hypot(nx, nz);
        if (hl < 0.25) continue;
        const hx = nx / hl, hz = nz / hl;
        const vn = v[0] * hx + v[2] * hz;
        if (vn < 0) { v[0] -= hx * vn; v[2] -= hz * vn; }
      }

      // Ground: highest walkable surface under the ring, from a step above to a snap below.
      if (v[1] <= 1e-4) {
        const up = this.grounded ? stepHeight : AIR_STEP;
        const down = (this.grounded ? stepHeight : 0.02) + Math.max(0, -v[1] * sh);
        if (this.probeGround(p, up, down, minNy)) {
          const dy = this.probe.height - p[1];
          if (!this.grounded) this.landSpeed = Math.max(this.landSpeed, -v[1]);
          else if (Math.abs(dy) > STEP_THRESHOLD) this.stepDelta += dy;
          p[1] = this.probe.height;
          v[1] = 0;
          this.grounded = true;
          const g = this.ground, q = this.probe;
          g.height = q.height; g.nx = q.nx; g.ny = q.ny; g.nz = q.nz; g.surface = q.surface; g.tri = q.tri;
        } else {
          this.grounded = false;
        }
      } else {
        this.grounded = false;
      }
    }
  }

  private probeGround(p: ArrayLike<number>, up: number, down: number, minNy: number): boolean {
    const C = this.collision!;
    const ring = this.shape.radius * 0.6;
    let found = false, best = -Infinity;
    const q = this.probe;
    const tmp = TMP_PROBE;
    for (let i = 0; i < RING.length; i += 2) {
      if (!C.groundProbe(p[0] + RING[i] * ring, p[1] + up, p[2] + RING[i + 1] * ring, up + down, minNy, tmp)) continue;
      if (tmp.height > best) {
        best = tmp.height;
        q.height = tmp.height; q.nx = tmp.nx; q.ny = tmp.ny; q.nz = tmp.nz; q.surface = tmp.surface; q.tri = tmp.tri;
        found = true;
      }
    }
    return found;
  }

  /** Whether a capsule of `height` fits at the current position (standing up from a crouch). */
  fits(height: number): boolean {
    if (!this.collision) return true;
    const r = this.shape.radius, y0 = this.wallBottom;
    return !this.collision.capsuleBlocked(this.feet, y0, Math.max(y0, height - r), r);
  }

  /** Surface under the feet (ground probe straight down), for footsteps after teleports. */
  refreshGround() {
    const minNy = Math.cos((this.shape.maxSlope * Math.PI) / 180);
    this.grounded = !!this.collision && this.probeGround(this.feet, this.shape.stepHeight, this.shape.stepHeight, minNy);
    if (this.grounded) {
      this.feet[1] = this.probe.height;
      Object.assign(this.ground, this.probe);
    }
  }
}

const TMP_PROBE: GroundProbe = { height: 0, nx: 0, ny: 1, nz: 0, surface: 0, tri: -1 };
