import type { CollisionWorld, RayHit } from '../../engine/scene/collision';
import { surfaceId } from '../../engine/scene/surfaces';

/** Something a bullet can hit besides the static world (enemies). */
export interface Hittable {
  readonly id: string;
  /** Nearest hit along the ray within maxT: fills `out` (point, normal, region, surface) and returns true. */
  raycast(o: ArrayLike<number>, d: ArrayLike<number>, maxT: number, out: ShotHit): boolean;
}

export interface ShotHit {
  kind: 'world' | 'target';
  t: number;
  point: [number, number, number];
  normal: [number, number, number];
  surface: number;
  /** World: owning map entity id; target: the hittable's id. */
  owner: string;
  /** Target body region (head, torso, ...) and rig part. */
  region: string;
  part: string;
  target: Hittable | null;
  /** Which of the target's members was hit (e.g. a horde agent), -1 = none. */
  index: number;
  /** The bullet continued through this surface (glass). */
  pierced: boolean;
  /** Filled by the weapon. */
  damage: number;
}

const newHit = (): ShotHit => ({ kind: 'world', t: 0, point: [0, 0, 0], normal: [0, 0, 0], surface: 0, owner: '', region: '', part: '', target: null, index: -1, pierced: false, damage: 0 });

const GLASS = surfaceId('glass');
const MAX_HITS = 4;

/**
 * Hitscan against the static collision world and registered targets. A shot
 * ends at the first opaque hit; glass is pierced (recorded, then the trace
 * continues) when allowed. Results are pooled: no allocation per shot.
 */
export class Hitscan {
  readonly targets: Hittable[] = [];
  readonly hits: ShotHit[] = Array.from({ length: MAX_HITS }, newHit);
  private ray: RayHit = { t: 0, point: [0, 0, 0], normal: [0, 0, 0], surface: 0, owner: '', tri: -1 };
  private th = newHit();
  private o: [number, number, number] = [0, 0, 0];

  constructor(private collision: () => CollisionWorld) {}

  /** Traces a shot; returns the number of entries written to `hits` (last = the stopping hit, if any). */
  trace(origin: ArrayLike<number>, dir: ArrayLike<number>, range: number, pierceGlass: boolean): number {
    const C = this.collision();
    const o = this.o;
    o[0] = origin[0]; o[1] = origin[1]; o[2] = origin[2];
    let travelled = 0, n = 0;
    while (n < MAX_HITS && travelled < range) {
      const maxT = range - travelled;
      const w = C.raycast(o, dir, maxT, undefined, this.ray);
      // Nearest target in front of the world hit.
      let best: Hittable | null = null, bestT = w ? w.t : maxT;
      for (const tg of this.targets) {
        if (tg.raycast(o, dir, bestT, this.th) && this.th.t < bestT) {
          bestT = this.th.t;
          best = tg;
        }
      }
      const h = this.hits[n++];
      if (best) {
        best.raycast(o, dir, bestT + 1e-4, h);
        h.kind = 'target';
        h.target = best;
        h.owner = best.id;
        h.t += travelled;
        h.pierced = false;
        return n;
      }
      if (!w) return n - 1;
      h.kind = 'world';
      h.t = travelled + w.t;
      h.point[0] = w.point[0]; h.point[1] = w.point[1]; h.point[2] = w.point[2];
      h.normal[0] = w.normal[0]; h.normal[1] = w.normal[1]; h.normal[2] = w.normal[2];
      h.surface = w.surface;
      h.owner = w.owner;
      h.region = '';
      h.part = '';
      h.target = null;
      h.index = -1;
      h.pierced = pierceGlass && w.surface === GLASS;
      if (!h.pierced) return n;
      // Continue just beyond the pane.
      travelled += w.t + 0.01;
      o[0] = w.point[0] + dir[0] * 0.01; o[1] = w.point[1] + dir[1] * 0.01; o[2] = w.point[2] + dir[2] * 0.01;
    }
    return n;
  }
}
