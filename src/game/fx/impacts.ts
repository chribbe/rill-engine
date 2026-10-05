import type { ParticleKind, ParticleSystem } from '../../engine/render/particles';
import type { LightPulses } from '../../engine/render/lightpulses';
import type { World } from '../../engine/scene/world';
import { surfaceName } from '../../engine/scene/surfaces';
import type { ShotHit } from '../combat/hitscan';

/**
 * World impact feedback per surface class, from public/game/impacts.json:
 * a decal (through the engine's decal system), particle bursts and an
 * optional light flash. Entries can inherit (`like`) and tint another entry.
 * Emission directions: `normal` (out of the surface), `ricochet` (reflected
 * shot, biased to the normal), `through` (continuing with the bullet).
 */
interface Emit {
  kind: ParticleKind;
  count: number;
  dir: 'normal' | 'ricochet' | 'through';
  spread: number;
  speed: [number, number];
  life: [number, number];
  size: [number, number];
  color: [number, number, number];
  alpha?: number;
  emissive?: number;
  drag?: number;
  gravity?: number;
  /** Debris: land and bounce on the ground below the hit. */
  floor?: boolean;
  /** Stretch along the velocity (a fast directional jet of dust). */
  stretch?: boolean;
}

export interface SurfaceImpact {
  like?: string;
  tint?: [number, number, number];
  /** Multiplier on spark counts (0 removes them). */
  sparks?: number;
  decal?: string | null;
  decalSize?: [number, number];
  flash?: { color: [number, number, number]; peak: number; range: number; life: number };
  emit?: Emit[];
}

export interface ImpactTable {
  fallback: string;
  /** How much of the map's wind gun smoke and impact dust drift with (1 = all of it). */
  wind?: number;
  surfaces: Record<string, SurfaceImpact>;
}

/** Emitters living longer than this count as lingering haze (thinned where hits crowd). */
const HAZE_LIFE = 1.5;
const RECENT = 16;

export class ImpactFx {
  /** Resolved entries (inheritance and tints applied), rebuilt when the table changes. */
  private resolved = new Map<string, SurfaceImpact>();
  decals = true;
  /** Recent hit points and times (ring): a burst into one spot builds haze, not a wall of fog. */
  private recent = new Float32Array(RECENT * 4).fill(-1e9);
  private recentAt = 0;
  private time = 0;

  /** Advances the crowding clock (seconds). */
  update(dt: number) {
    this.time += dt;
  }

  /** Recent hits within ~0.8 m of `p` (weighted by age), and records this one. */
  private crowding(p: ArrayLike<number>) {
    let n = 0;
    const R = this.recent;
    for (let i = 0; i < RECENT; i++) {
      const age = this.time - R[i * 4 + 3];
      if (age > 2) continue;
      const d2 = (R[i * 4] - p[0]) ** 2 + (R[i * 4 + 1] - p[1]) ** 2 + (R[i * 4 + 2] - p[2]) ** 2;
      if (d2 < 0.64) n += 1 - age / 2;
    }
    const o = this.recentAt * 4;
    R[o] = p[0]; R[o + 1] = p[1]; R[o + 2] = p[2]; R[o + 3] = this.time;
    this.recentAt = (this.recentAt + 1) % RECENT;
    return n;
  }

  constructor(private table: ImpactTable, private world: World, private particles: ParticleSystem, private pulses: LightPulses) {}

  setTable(t: ImpactTable) {
    this.table = t;
    this.resolved.clear();
  }

  private entry(name: string, depth = 0): SurfaceImpact {
    const hit = this.resolved.get(name);
    if (hit) return hit;
    const raw = this.table.surfaces[name] ?? (depth === 0 ? this.table.surfaces[this.table.fallback] : undefined) ?? {};
    let e: SurfaceImpact = raw;
    if (raw.like && depth < 4) {
      const base = this.entry(raw.like, depth + 1);
      const tint = raw.tint ?? [1, 1, 1], sparks = raw.sparks ?? 1;
      e = {
        ...base, ...raw,
        emit: (raw.emit ?? base.emit ?? [])
          .map((m) => ({ ...m, color: m.kind === 'spark' ? m.color : [m.color[0] * tint[0], m.color[1] * tint[1], m.color[2] * tint[2]] as [number, number, number], count: m.kind === 'spark' ? Math.round(m.count * sparks) : m.count }))
          .filter((m) => m.count > 0),
      };
    }
    this.resolved.set(name, e);
    return e;
  }

  /** Feedback for one world hit of a shot travelling along `dir`. */
  play(h: ShotHit, dir: ArrayLike<number>) {
    this.playSurface(surfaceName(h.surface), h.point, h.normal, dir, true);
  }

  /** Feedback for surface `name` at `point` (decal only when `decal`: not on moving targets). */
  playSurface(name: string, point: ArrayLike<number>, n: ArrayLike<number>, dir: ArrayLike<number>, decal: boolean) {
    const e = this.entry(name);
    const h = { point };
    const p: [number, number, number] = [h.point[0] + n[0] * 0.02, h.point[1] + n[1] * 0.02, h.point[2] + n[2] * 0.02];
    const dn = dir[0] * n[0] + dir[1] * n[1] + dir[2] * n[2];
    const ricochet = [0, 1, 2].map((i) => (dir[i] - 2 * dn * n[i]) * 0.5 + n[i] * 0.5);
    if (decal && this.decals && e.decal) {
      const [a, b] = e.decalSize ?? [0.15, 0.2];
      this.world.addDecal(e.decal, h.point, n, a + Math.random() * (b - a), true);
    }
    let floor: number | undefined;
    const crowd = this.crowding(p);
    for (const m of e.emit ?? []) {
      const d = m.dir === 'normal' ? n : m.dir === 'through' ? dir : ricochet;
      // Haze already hanging here: add less (fewer, thinner) so sustained fire thickens it gradually.
      const haze = (m.kind === 'dust' || m.kind === 'smoke') && m.life[1] > HAZE_LIFE;
      const thin = haze ? 1 / (1 + crowd * 0.7) : 1;
      const count = haze ? Math.max(crowd > 3 ? 0 : 1, Math.round(m.count * thin)) : m.count;
      if (count <= 0) continue;
      if (m.floor && floor === undefined) {
        const g = this.world.collision.groundHeight(p[0], p[1] + 0.05, p[2], 6);
        floor = g > -Infinity ? g : p[1] - 6;
      }
      this.particles.emit(m.kind, { count, pos: p, dir: d, spread: m.spread, speed: m.speed, life: m.life, size: m.size, color: m.color, alpha: m.alpha === undefined ? undefined : m.alpha * thin, emissive: m.emissive, drag: m.drag, gravity: m.gravity, floor: m.floor ? floor : undefined, stretch: m.stretch });
    }
    if (e.flash) this.pulses.emit(p, e.flash.color, e.flash.peak, e.flash.range, e.flash.life, 0.1);
  }
}
