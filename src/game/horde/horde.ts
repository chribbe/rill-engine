import type { Renderer } from '../../engine/render/renderer';
import type { World } from '../../engine/scene/world';
import { raySphere } from '../../engine/physics/shapes';
import type { Hittable, ShotHit } from '../combat/hitscan';
import type { TomatoDef } from './def';
import { loadTomatoModel, type TomatoModel } from './model';
import { Tomato, type Prey } from './tomato';

/**
 * The horde: a pool of tomato bugs, ticked at the game's fixed rate and posed
 * per frame. One Hittable for the whole pool (bullets test a bounding sphere
 * per tomato, then its body and legs). Gore and sound hang off the events.
 */
export class Horde implements Hittable {
  readonly id = 'horde';
  readonly list: Tomato[] = [];
  model!: TomatoModel;
  /** Spawning and AI on. */
  enabled = true;
  /** Most alive at once (kept topped up from the spawn points). */
  maxAlive = 4;
  private serial = 1;
  /** A tomato died (`hit`: the killing shot's point / direction / impulse, or null). */
  onKill: ((t: Tomato, point: ArrayLike<number> | null, dir: ArrayLike<number> | null, impulse: number) => void)[] = [];
  /** A leg came off (index, the hit point and bullet direction). */
  onLeg: ((t: Tomato, leg: number, point: ArrayLike<number>, dir: ArrayLike<number>) => void)[] = [];
  /** A bite landed on the prey. */
  onBite: ((t: Tomato) => void)[] = [];
  private bite = (t: Tomato) => { for (const g of this.onBite) g(t); };

  constructor(private renderer: Renderer, private world: World, public def: TomatoDef, private capacity = 32) {}

  async load() {
    this.model = await loadTomatoModel(this.renderer, this.def.model);
    for (let i = 0; i < this.capacity; i++) this.list.push(new Tomato(i, this.def, this.model, this.renderer, this.world.renderables));
  }

  get alive() {
    let n = 0;
    for (const t of this.list) if (t.alive) n++;
    return n;
  }

  /** Spawns one at `at` (ground point) facing `yawRad`; null when the pool is full. */
  spawn(at: ArrayLike<number>, yawRad: number): Tomato | null {
    const t = this.list.find((x) => !x.active);
    if (!t) return null;
    t.def = this.def;
    t.reset(at, yawRad, (this.serial++ * 2654435761) >>> 0);
    return t;
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
    const C = this.world.collision;
    for (const t of this.list) {
      if (!t.alive) continue;
      t.tick(h, prey, C, this.bite);
      if (t.health <= 0) this.kill(t);
    }
  }

  pose(dt: number, alpha: number) {
    const C = this.world.collision;
    for (const t of this.list) if (t.active) t.pose(dt, alpha, C);
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
    const reach = (this.def.radius + 0.9) * this.def.scale;
    for (const t of this.list) {
      if (!t.alive) continue;
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
