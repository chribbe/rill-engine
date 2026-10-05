import { mat4, quat, type Mat4, type Quat } from 'wgpu-matrix';
import type { GpuMesh } from '../render/geometry';
import type { Material } from '../render/materials';
import type { Renderable, Renderer } from '../render/renderer';
import { transformAabb } from '../render/culling';

/**
 * Rigid-part rig: a hierarchy of meshes (weapon receiver / bolt / trigger,
 * creature body parts) posed every frame. Each part has a rest transform
 * (relative to its parent; the part's mesh origin is its pivot) and a pose
 * offset (translation + rotation) layered on top by gameplay or procedural
 * animation. World matrices go straight into the parts' instance slots; no
 * allocation per frame. Skinned meshes are a later, separate system.
 */
export interface RigPart {
  name: string;
  parent: number;
  rest: Mat4;
  /** Pose offset in the part's rest frame. */
  pos: [number, number, number];
  rot: Quat;
  /** Uniform-ish scale offset (squash), 1 = none. */
  scale: [number, number, number];
  world: Mat4;
  r: Renderable | null;
  visible: boolean;
}

export interface RigPartSource {
  name: string;
  parent?: string;
  rest: Mat4;
  mesh: GpuMesh | null;
  materials: Material[];
}

const TMP = mat4.create();
const TMP2 = mat4.create();

export class Rig {
  readonly parts: RigPart[] = [];
  private byName = new Map<string, number>();
  visible = true;

  constructor(private renderer: Renderer, readonly id: string, private opts: { viewmodel?: boolean; castShadow?: boolean } = {}) {}

  /** Adds parts (any order: parents are placed before their children). Returns the rig for chaining. */
  add(src: RigPartSource[], renderables: Renderable[]) {
    const names = new Set(src.map((s) => s.name));
    const ordered: RigPartSource[] = [];
    const placed = new Set<string>([...this.byName.keys()]);
    let pending = src.slice();
    while (pending.length) {
      const next = pending.filter((s) => !s.parent || placed.has(s.parent) || !names.has(s.parent));
      if (!next.length) throw new Error(`rig ${this.id}: parent cycle among ${pending.map((s) => s.name).join(', ')}`);
      for (const s of next) { ordered.push(s); placed.add(s.name); }
      pending = pending.filter((s) => !next.includes(s));
    }
    for (const s of ordered) {
      const parent = s.parent ? this.byName.get(s.parent) ?? -1 : -1;
      let r: Renderable | null = null;
      if (s.mesh) {
        r = {
          slot: this.renderer.instances.alloc(), mesh: s.mesh, materials: s.materials, viewmodel: this.opts.viewmodel,
          castShadow: this.opts.castShadow ?? !this.opts.viewmodel, visible: false, id: `${this.id}/${s.name}`,
          worldMin: new Float32Array(3), worldMax: new Float32Array(3),
        };
        renderables.push(r);
      }
      this.byName.set(s.name, this.parts.length);
      this.parts.push({ name: s.name, parent, rest: mat4.clone(s.rest), pos: [0, 0, 0], rot: quat.identity(), scale: [1, 1, 1], world: mat4.identity(), r, visible: true });
    }
    return this;
  }

  part(name: string): RigPart | undefined {
    const i = this.byName.get(name);
    return i === undefined ? undefined : this.parts[i];
  }

  /** Resets every pose offset. */
  resetPose() {
    for (const p of this.parts) {
      p.pos[0] = p.pos[1] = p.pos[2] = 0;
      quat.identity(p.rot);
      p.scale[0] = p.scale[1] = p.scale[2] = 1;
    }
  }

  /**
   * Computes world matrices under `root` and writes visible parts to their
   * instance slots. `instanceFlags`: renderer instance bits (viewmodel etc.).
   */
  update(root: Mat4, instanceFlags = 0) {
    for (const p of this.parts) {
      const parent = p.parent >= 0 ? this.parts[p.parent].world : root;
      // world = parent * rest * T(pos) * R(rot) * S(scale)
      mat4.multiply(parent, p.rest, TMP);
      mat4.translate(TMP, p.pos, TMP);
      mat4.fromQuat(p.rot, TMP2);
      mat4.multiply(TMP, TMP2, p.world);
      if (p.scale[0] !== 1 || p.scale[1] !== 1 || p.scale[2] !== 1) mat4.scale(p.world, p.scale, p.world);
    }
    this.commit(instanceFlags);
  }

  /** Writes the parts' current world matrices (set by `update` or by a simulation) to their instances. */
  commit(instanceFlags = 0) {
    const R = this.renderer;
    for (const p of this.parts) {
      const r = p.r;
      if (!r) continue;
      r.visible = this.visible && p.visible;
      if (!r.visible) continue;
      transformAabb(p.world, r.mesh.aabb.min, r.mesh.aabb.max, r.worldMin, r.worldMax);
      R.instances.set(r.slot, p.world, null, -1, instanceFlags | R.probeBits(r.worldMin, r.worldMax), 1, 0x5eed);
    }
  }

  /** A part's origin in the rig's rest space (rests are composed up the chain). */
  restOrigin(part: RigPart, out: [number, number, number]) {
    out[0] = out[1] = out[2] = 0;
    let p: RigPart | undefined = part;
    while (p) {
      out[0] += p.rest[12]; out[1] += p.rest[13]; out[2] += p.rest[14];
      p = p.parent >= 0 ? this.parts[p.parent] : undefined;
    }
    return out;
  }

  /** World-space point given in a part's local frame. */
  point(part: RigPart, local: ArrayLike<number>, out: [number, number, number]) {
    const m = part.world, x = local[0], y = local[1], z = local[2];
    out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    return out;
  }

  /** World-space direction given in a part's local frame (not normalised). */
  dir(part: RigPart, local: ArrayLike<number>, out: [number, number, number]) {
    const m = part.world, x = local[0], y = local[1], z = local[2];
    out[0] = m[0] * x + m[4] * y + m[8] * z;
    out[1] = m[1] * x + m[5] * y + m[9] * z;
    out[2] = m[2] * x + m[6] * y + m[10] * z;
    return out;
  }
}
