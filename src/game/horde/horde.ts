import type { Renderer } from '../../engine/render/renderer';
import type { World } from '../../engine/scene/world';
import { raySphere } from '../../engine/physics/shapes';
import { NavGrid } from '../../engine/nav/navgrid';
import type { Hittable, ShotHit } from '../combat/hitscan';
import type { TomatoDef } from './def';
import { loadTomatoModel, type TomatoModel } from './model';
import { Tomato, type Prey } from './tomato';

/** Spatial hash size (buckets) for the crowd pass. */
const HASH = 1024;

/**
 * The horde: a pool of tomato bugs, ticked at the game's fixed rate and posed
 * per frame. They run on a nav grid baked from the world's collision (a flow
 * field towards the prey, refreshed in slices as it moves) and shove each
 * other as spheres in a spatial hash: the ones held up behind climb over the
 * backs of the ones in front, so they pile at chokepoints. One Hittable for
 * the whole pool (bullets test a bounding sphere per tomato, then its body and
 * legs). Gore and sound hang off the events.
 */
export class Horde implements Hittable {
  readonly id = 'horde';
  readonly list: Tomato[] = [];
  model!: TomatoModel;
  /** Spawning and AI on. */
  enabled = true;
  /** Most alive at once (kept topped up from the spawn points). */
  maxAlive = 24;
  private serial = 1;
  /** Nav grid (baked around the play area on `begin`), the world collision it was baked from, its centre. */
  nav: NavGrid | null = null;
  private navRev = -1;
  private navCentre: [number, number] = [0, 0];
  /** Half size of the baked square (m). */
  navRadius = 80;
  /** Path cost the flow field reaches (≈ m × 20). */
  flowReach = 2400;
  private flowT = 0;
  private flowNode = -1;
  // Crowd pass scratch.
  private live: Tomato[] = [];
  private head = new Int32Array(HASH);
  private next = new Int32Array(0);
  private px = new Float32Array(0);
  private pz = new Float32Array(0);
  private out: [number, number] = [0, 0];
  /** A tomato died (`hit`: the killing shot's point / direction / impulse, or null). */
  onKill: ((t: Tomato, point: ArrayLike<number> | null, dir: ArrayLike<number> | null, impulse: number) => void)[] = [];
  /** A leg came off (index, the hit point and bullet direction). */
  onLeg: ((t: Tomato, leg: number, point: ArrayLike<number>, dir: ArrayLike<number>) => void)[] = [];
  /** A bite landed on the prey. */
  onBite: ((t: Tomato) => void)[] = [];
  private bite = (t: Tomato) => { for (const g of this.onBite) g(t); };

  constructor(private renderer: Renderer, private world: World, public def: TomatoDef, private capacity = 160) {}

  async load() {
    this.model = await loadTomatoModel(this.renderer, this.def.model);
    for (let i = 0; i < this.capacity; i++) this.list.push(new Tomato(i, this.def, this.model, this.renderer, this.world.renderables));
    this.next = new Int32Array(this.capacity);
    this.px = new Float32Array(this.capacity);
    this.pz = new Float32Array(this.capacity);
  }

  /**
   * Ready for a session with the prey at `feet`: (re)bakes the nav grid when the world changed or
   * the prey is near its border, and settles a first flow field.
   */
  begin(feet: ArrayLike<number>) {
    const W = this.world, C = W.collision;
    const off = Math.max(Math.abs(feet[0] - this.navCentre[0]), Math.abs(feet[2] - this.navCentre[1]));
    if (!this.nav || this.navRev !== W.collisionRev || off > this.navRadius * 0.5) {
      const r = this.navRadius;
      this.nav = NavGrid.build(C.triangleData, { minX: feet[0] - r, maxX: feet[0] + r, minZ: feet[2] - r, maxZ: feet[2] + r });
      this.navRev = W.collisionRev;
      this.navCentre[0] = feet[0]; this.navCentre[1] = feet[2];
    }
    this.nav.computeFlow(feet[0], feet[1], feet[2], this.flowReach);
    this.flowNode = this.nav.nearestNode(feet[0], feet[1], feet[2]);
    this.flowT = 0;
  }

  /** Keeps the flow field leading to the prey: a new one when it changes cell (at most 5 a second), settled in slices. */
  private updateFlow(h: number, feet: ArrayLike<number>) {
    const nav = this.nav!;
    this.flowT += h;
    if (nav.flowBusy) { nav.stepFlow(12000); return; }
    const n = nav.nearestNode(feet[0], feet[1], feet[2]);
    if ((n !== this.flowNode && this.flowT > 0.2) || this.flowT > 2) {
      nav.beginFlow(feet[0], feet[1], feet[2], this.flowReach);
      nav.stepFlow(12000);
      this.flowNode = n;
      this.flowT = 0;
    }
  }

  get alive() {
    let n = 0;
    for (const t of this.list) if (t.alive) n++;
    return n;
  }

  /** Spawns one at `at` (ground point) facing `yawRad`; null when the pool is full. */
  spawn(at: ArrayLike<number>, yawRad: number): Tomato | null {
    const t = this.list.find((x) => !x.active);
    if (!t || !this.nav) return null;
    // On the flow field if anywhere near (not in a pocket under the stairs); else wherever it can stand.
    let node = this.nav.target >= 0 ? this.nav.nearestNode(at[0], at[1] + 0.3, at[2], 6, true) : -1;
    if (node < 0) node = this.nav.nearestNode(at[0], at[1] + 0.3, at[2], 4);
    if (node < 0) return null;
    // Stand it on the nav floor (in the node's column if `at` was off the walkable area).
    const p: [number, number, number] = [at[0], this.nav.layerH[node], at[2]];
    if (this.nav.nodeAt(at[0], at[1] + 0.3, at[2]) !== node) this.nav.nodeCentre(node, p);
    t.def = this.def;
    t.reset(p, yawRad, (this.serial++ * 2654435761) >>> 0, node);
    return t;
  }

  /**
   * A place to bring tomatoes in: on the nav, `minPath`..`maxPath` metres of path from the prey
   * (so they arrive by the routes it can be reached on), in the open, and out of sight of `eye`
   * (behind the view or behind something). Null when nothing fits after a few tries.
   */
  findSpawn(feet: ArrayLike<number>, eye: ArrayLike<number>, fwd: ArrayLike<number>, minPath: number, maxPath: number, out: [number, number, number]): boolean {
    const nav = this.nav;
    if (!nav || nav.flowBusy && nav.target < 0) return false;
    const C = this.world.collision, D = nav.dist, lo = minPath * 20, hi = maxPath * 20;
    const dir = [0, 0, 0];
    for (let attempt = 0; attempt < 48; attempt++) {
      const a = Math.random() * Math.PI * 2, rr = minPath * 0.6 + Math.random() * (maxPath - minPath * 0.6);
      const x = feet[0] + Math.cos(a) * rr, z = feet[2] + Math.sin(a) * rr;
      const ix = Math.floor((x - nav.x0) / nav.cell), iz = Math.floor((z - nav.z0) / nav.cell);
      if (ix < 0 || iz < 0 || ix >= nav.nx || iz >= nav.nz) continue;
      const c = iz * nav.nx + ix;
      let node = -1;
      for (let l = 0; l < nav.layerN[c]; l++) {
        const nd = c * 4 + l, dd = D[nd];
        if (dd >= lo && dd <= hi && nav.edge[nd] >= 1) { node = nd; break; }
      }
      if (node < 0) continue;
      nav.nodeCentre(node, out);
      // Seen? In front of the view and nothing in between.
      dir[0] = out[0] - eye[0]; dir[1] = out[1] + 0.7 - eye[1]; dir[2] = out[2] - eye[2];
      const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
      dir[0] /= len; dir[1] /= len; dir[2] /= len;
      const front = dir[0] * fwd[0] + dir[1] * fwd[1] + dir[2] * fwd[2] > 0.35;
      if (front && !C.raycast(eye, dir, len - 0.3)) continue;
      return true;
    }
    return false;
  }

  /** Kills `t` (events first: gore reads its posed parts), then frees the slot. */
  kill(t: Tomato, point: ArrayLike<number> | null = null, dir: ArrayLike<number> | null = null, impulse = 0) {
    if (!t.active) return;
    t.state = 'dead';
    for (const g of this.onKill) g(t, point, dir, impulse);
    t.hide();
  }

  clear() {
    for (const t of this.list) if (t.active) t.hide();
  }

  tick(h: number, prey: Prey) {
    const nav = this.nav;
    if (!nav) return;
    this.updateFlow(h, prey.feet);
    for (const t of this.list) {
      if (!t.alive) continue;
      t.tick(h, prey, nav, this.bite);
      if (t.health <= 0) this.kill(t);
    }
    this.crowd(prey);
  }

  /**
   * Bodies push each other apart (spheres, squashed vertically so stacks sit snug). The one higher
   * up takes the whole vertical part, so a tomato climbing into another rides up onto its back and
   * rests there (`pileT`). Each notes whether another blocks its way ahead (it climbs when held up).
   * Then nobody stands inside the prey, and the moves go back through the nav so none end in a wall.
   */
  private crowd(prey: Prey) {
    const nav = this.nav!, d = this.def, sp = d.crowd.spacing, VK = 1.3;
    const live = this.live;
    live.length = 0;
    for (const t of this.list) if (t.alive) live.push(t);
    const n = live.length, head = this.head, next = this.next;
    let rmax = 0;
    for (const t of live) rmax = Math.max(rmax, t.radius);
    const cs = Math.max(1.25, 2 * rmax * sp);
    head.fill(-1);
    const key = (ix: number, iz: number) => ((ix * 73856093) ^ (iz * 19349663)) & (HASH - 1);
    for (let i = 0; i < n; i++) {
      const t = live[i];
      this.px[i] = t.pos[0]; this.pz[i] = t.pos[2];
      t.blockedAhead = false;
      const k = key(Math.floor(t.pos[0] / cs), Math.floor(t.pos[2] / cs));
      next[i] = head[k];
      head[k] = i;
    }
    for (let i = 0; i < n; i++) {
      const a = live[i], pa = a.pos;
      const ix = Math.floor(pa[0] / cs), iz = Math.floor(pa[2] / cs);
      for (let oz = -1; oz <= 1; oz++) {
        for (let ox = -1; ox <= 1; ox++) {
          for (let j = head[key(ix + ox, iz + oz)]; j >= 0; j = next[j]) {
            if (j <= i) continue;
            const b = live[j], pb = b.pos;
            const dx = pb[0] - pa[0], dz = pb[2] - pa[2], dy = (pb[1] - pa[1]) * VK;
            const d2 = dx * dx + dz * dz + dy * dy, R = (a.radius + b.radius) * sp, R2 = R * R;
            if (d2 >= R2) continue;
            const dist = Math.sqrt(d2) || 1e-4, pen = R - dist;
            const nx = dx / dist, nz = dz / dist, ny = dy / dist;
            // Sideways: split. Upwards: all on the higher one (it is resting on the other).
            pa[0] -= nx * pen * 0.5; pa[2] -= nz * pen * 0.5;
            pb[0] += nx * pen * 0.5; pb[2] += nz * pen * 0.5;
            const up = (Math.abs(ny) * pen) / VK;
            if (dy >= 0) { pb[1] += up; b.pileT = 0.12; if (b.vel[1] < 0) b.vel[1] = 0; }
            else { pa[1] += up; a.pileT = 0.12; if (a.vel[1] < 0) a.vel[1] = 0; }
            // In the way ahead (roughly level)?
            const hd = Math.hypot(dx, dz) || 1e-4;
            if (Math.abs(dy) < Math.min(a.radius, b.radius) * VK) {
              if ((a.dir[0] * dx + a.dir[1] * dz) / hd > 0.6) a.blockedAhead = true;
              if (-(b.dir[0] * dx + b.dir[1] * dz) / hd > 0.6) b.blockedAhead = true;
            }
          }
        }
      }
    }
    // Out of the prey's column (its body, and nobody piles onto its head), and back through the nav.
    const f = prey.feet;
    for (let i = 0; i < n; i++) {
      const t = live[i], p = t.pos, pr = t.radius + 0.35, ride0 = t.ride;
      if (p[1] > f[1] - 0.3) {
        const dx = p[0] - f[0], dz = p[2] - f[2], dd = Math.hypot(dx, dz);
        if (dd < pr) {
          const k = dd > 1e-4 ? pr / dd : 0;
          if (k) { p[0] = f[0] + dx * k; p[2] = f[2] + dz * k; } else p[0] += pr;
        }
      }
      if (p[0] !== this.px[i] || p[2] !== this.pz[i]) {
        t.node = nav.move(t.node, this.px[i], this.pz[i], p[0], p[2], p[1] - ride0, true, this.out);
        nav.keepOff(t.node, t.radius * 0.4, this.out);
        p[0] = this.out[0]; p[2] = this.out[1];
      }
    }
  }

  pose(dt: number, alpha: number) {
    for (const t of this.list) if (t.active) t.pose(dt, alpha);
  }

  /** Applies a bullet hit to tomato `i`: reactions, leg loss, death. Returns 'kill' | 'leg' | ''. */
  hit(i: number, damage: number, point: ArrayLike<number>, dir: ArrayLike<number>, impulse: number, part: string) {
    const t = this.list[i];
    if (!t?.alive) return '';
    const r = t.hit(damage, point, dir, impulse, part);
    if (r === 'leg') for (const g of this.onLeg) g(t, +part.slice(4), point, dir);
    if (r === 'kill') this.kill(t, point, dir, impulse);
    return r;
  }

  private th: ShotHit = { kind: 'target', t: 0, point: [0, 0, 0], normal: [0, 0, 0], surface: 0, owner: '', region: '', part: '', target: null, index: -1, pierced: false, damage: 0 };

  raycast(o: ArrayLike<number>, d: ArrayLike<number>, maxT: number, out: ShotHit): boolean {
    let best = maxT, found = false;
    for (const t of this.list) {
      if (!t.alive) continue;
      const reach = (this.def.radius + 0.9) * t.size;
      // Bounding sphere around body and legs first.
      const tb = raySphere(o, d, t.shown, reach);
      if (tb < 0 && Math.hypot(o[0] - t.shown[0], o[1] - t.shown[1], o[2] - t.shown[2]) > reach) continue;
      if (t.raycast(o, d, best, this.th) && this.th.t < best) {
        best = this.th.t;
        found = true;
        out.t = this.th.t;
        out.point[0] = this.th.point[0]; out.point[1] = this.th.point[1]; out.point[2] = this.th.point[2];
        out.normal[0] = this.th.normal[0]; out.normal[1] = this.th.normal[1]; out.normal[2] = this.th.normal[2];
        out.part = this.th.part;
        out.region = this.th.region;
        out.index = this.th.index;
        out.surface = 0;
      }
    }
    return found;
  }
}
