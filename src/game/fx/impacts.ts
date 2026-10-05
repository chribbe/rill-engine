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
  surfaces: Record<string, SurfaceImpact>;
}

export class ImpactFx {
  /** Resolved entries (inheritance and tints applied), rebuilt when the table changes. */
  private resolved = new Map<string, SurfaceImpact>();
  decals = true;

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
    const e = this.entry(surfaceName(h.surface));
    const n = h.normal;
    const p: [number, number, number] = [h.point[0] + n[0] * 0.02, h.point[1] + n[1] * 0.02, h.point[2] + n[2] * 0.02];
    const dn = dir[0] * n[0] + dir[1] * n[1] + dir[2] * n[2];
    const ricochet = [0, 1, 2].map((i) => (dir[i] - 2 * dn * n[i]) * 0.5 + n[i] * 0.5);
    if (this.decals && e.decal) {
      const [a, b] = e.decalSize ?? [0.15, 0.2];
      this.world.addDecal(e.decal, h.point, n, a + Math.random() * (b - a), true);
    }
    for (const m of e.emit ?? []) {
      const d = m.dir === 'normal' ? n : m.dir === 'through' ? dir : ricochet;
      this.particles.emit(m.kind, { count: m.count, pos: p, dir: d, spread: m.spread, speed: m.speed, life: m.life, size: m.size, color: m.color, alpha: m.alpha, emissive: m.emissive, drag: m.drag, gravity: m.gravity });
    }
    if (e.flash) this.pulses.emit(p, e.flash.color, e.flash.peak, e.flash.range, e.flash.life, 0.1);
  }
}
