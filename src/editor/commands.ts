import { mat4, quat, vec3, type Mat4 } from 'wgpu-matrix';
import { isSpatial, type BlockObject, type Entity, type PrefabDocument, type SpatialEntity, type Transform } from '../engine/scene/mapformat';
import { fromPrefabSpace } from '../engine/scene/prefab';
import { BLOCK_MATERIAL, faceIds, STAIR_RISE } from '../engine/scene/blocks';
import { aabbIn, blockCorners, blockFrame, boxCorners, clampOpening, openingBox, resizeFace, subtractBox, wallCoords, wallFrame, type Piece } from './blockedit';
import type { MaterialDef } from '../engine/render/materials';
import type { DocKey, Patch, SceneStore } from '../engine/scene/scene';
import type { AssetRegistry } from './assets';
import { applyDelta, axisAngleQuat, eulerToQuat, rotationAbout, scaleAbout, toMatrix, type V3 } from './xform';

/**
 * Editor operations: the only way the editor (or a tool / AI agent) changes the
 * scene. Each operation is a named, JSON-parameterised function that compiles
 * to entity / document patches; `EditorHistory` applies them and keeps them for
 * undo / redo. The registry is self-describing (`listOps`) so the same
 * operations can be exposed as structured tools (MCP) without UI involvement.
 *
 * Conventions: positions in metres (world space), rotations as Euler degrees
 * (Y-X-Z, see xform.ts) or quaternions, every operation takes ID lists so
 * multi-selection is native. Descendants (outliner children) follow transform
 * edits of their ancestors. Locked entities refuse transform and delete edits.
 */

export interface OpContext {
  scene: SceneStore;
  assets: AssetRegistry | null;
  /** World-space pivot of an entity (bounds-based for world-anchored geometry); null = transform position. */
  pivot(id: string): V3 | null;
  /** A loaded prefab document (instances in the scene have theirs loaded), or null. */
  prefab?(name: string): PrefabDocument | null;
  /** Runtime results some operations turn into document data (scatter instances to entities). */
  runtime?: {
    scatterInstances(id: string): { key: string; asset: string; position: [number, number, number]; yawDeg: number; scale: number }[];
    /** Topmost surface under (x, z): height and the semantic of the entity it belongs to. */
    ground(x: number, z: number): { height: number; semantic?: string; id?: string } | null;
  };
}

/** [x, z] or [x, y, z]; 2D points (or onGround) take the ground height under them. */
function resolvePoint(ctx: OpContext, v: unknown, onGround: boolean | undefined, what: string): V3 {
  if (!Array.isArray(v) || (v.length !== 2 && v.length !== 3) || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) throw new OpError(`${what}: position must be [x, z] or [x, y, z]`);
  const x = v[0], z = v[v.length === 3 ? 2 : 1];
  if (v.length === 3 && !onGround) return [x, v[1], z];
  const g = ctx.runtime?.ground(x, z);
  if (!g) {
    if (v.length === 3) return [x, v[1], z];
    throw new OpError(`${what}: no ground under [${x}, ${z}]`);
  }
  return [x, Math.round(g.height * 1000) / 1000, z];
}

type ParamType = 'string' | 'number' | 'boolean' | 'string[]' | 'vec3' | 'quat' | 'object' | 'any';
export interface ParamSpec {
  type: ParamType;
  description: string;
  optional?: boolean;
  enum?: string[];
}

export interface OpResult<R = unknown> {
  patches: Patch[];
  result?: R;
  label?: string;
}

export interface OpDef<P = any, R = unknown> {
  name: string;
  description: string;
  params: Record<string, ParamSpec>;
  run(ctx: OpContext, p: P): OpResult<R>;
}

export class OpError extends Error {}

const OPS = new Map<string, OpDef>();
function op<P, R = unknown>(def: OpDef<P, R>) {
  OPS.set(def.name, def as OpDef);
}

export function getOp(name: string): OpDef | undefined {
  return OPS.get(name);
}

/** Self-description of every operation (tool schemas for a future MCP server). */
export function listOps() {
  return [...OPS.values()].map((o) => ({ name: o.name, description: o.description, params: o.params }));
}

function validate(def: OpDef, p: Record<string, unknown>) {
  if (!p || typeof p !== 'object') throw new OpError(`${def.name}: params must be an object`);
  for (const [k, s] of Object.entries(def.params)) {
    const v = p[k];
    if (v === undefined || v === null) {
      if (!s.optional) throw new OpError(`${def.name}: missing '${k}'`);
      continue;
    }
    const bad = (t: string) => new OpError(`${def.name}: '${k}' must be ${t}`);
    switch (s.type) {
      case 'string': if (typeof v !== 'string') throw bad('a string'); break;
      case 'number': if (typeof v !== 'number' || !Number.isFinite(v)) throw bad('a number'); break;
      case 'boolean': if (typeof v !== 'boolean') throw bad('a boolean'); break;
      case 'string[]': if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw bad('an array of strings'); break;
      case 'vec3': if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) throw bad('[x, y, z]'); break;
      case 'quat': if (!Array.isArray(v) || v.length !== 4 || !v.every((x) => typeof x === 'number')) throw bad('[x, y, z, w]'); break;
      case 'object': if (typeof v !== 'object' || Array.isArray(v)) throw bad('an object'); break;
    }
    if (s.enum && !s.enum.includes(v as string)) throw bad(`one of ${s.enum.join(', ')}`);
  }
}

// ------------------------------------------------------------------ patch building

/** Stages entity changes for one operation; later stages of the same entity see earlier ones. */
class PatchSet {
  private staged = new Map<string, { before: Entity | null; after: Entity | null }>();
  private order: string[] = [];
  private docs: Patch[] = [];
  constructor(readonly scene: SceneStore) {}

  get(id: string): Entity | undefined {
    const s = this.staged.get(id);
    return s ? s.after ?? undefined : this.scene.get(id);
  }

  set(e: Entity) {
    const s = this.staged.get(e.id);
    if (s) s.after = e;
    else {
      this.staged.set(e.id, { before: this.scene.get(e.id) ?? null, after: e });
      this.order.push(e.id);
    }
  }

  remove(id: string) {
    const s = this.staged.get(id);
    if (s) s.after = null;
    else if (this.scene.has(id)) {
      this.staged.set(id, { before: this.scene.get(id)!, after: null });
      this.order.push(id);
    }
  }

  doc(key: DocKey, after: unknown) {
    this.docs.push({ kind: 'doc', key, before: structuredClone((this.scene.doc as unknown as Record<string, unknown>)[key]), after });
  }

  /** Final patches. Removal indices are sequential (as applied), so undo re-inserts in place. */
  patches(): Patch[] {
    const ids = this.scene.entities.map((e) => e.id);
    const out: Patch[] = [...this.docs];
    for (const id of this.order) {
      const s = this.staged.get(id)!;
      if (s.before === s.after || (s.before && s.after && JSON.stringify(s.before) === JSON.stringify(s.after))) continue;
      const p: Patch = { kind: 'entity', id, before: s.before, after: s.after };
      if (s.before && !s.after) {
        const i = ids.indexOf(id);
        if (i >= 0) {
          p.index = i;
          ids.splice(i, 1);
        }
      }
      out.push(p);
    }
    return out;
  }
}

function need(ps: PatchSet, id: string): Entity {
  const e = ps.get(id);
  if (!e) throw new OpError(`no entity '${id}'`);
  return e;
}

/** Selection roots: existing IDs without an ancestor in the same set. */
function roots(ps: PatchSet, ids: string[]): string[] {
  const set = new Set(ids);
  for (const id of ids) need(ps, id);
  return ids.filter((id, i) => ids.indexOf(id) === i && !ps.scene.ancestors(id).some((a) => set.has(a)));
}

function assertUnlocked(ctx: OpContext, id: string) {
  if (ctx.scene.effectiveLocked(id)) throw new OpError(`'${id}' is locked`);
}

/** Applies world delta D to an entity and all its (unlocked) descendants. */
function transformTree(ctx: OpContext, ps: PatchSet, id: string, D: Mat4) {
  assertUnlocked(ctx, id);
  for (const t of [id, ...ctx.scene.descendants(id)]) {
    const e = ps.get(t);
    if (!e || !isSpatial(e) || (t !== id && ctx.scene.effectiveLocked(t))) continue;
    ps.set({ ...e, transform: applyDelta(D, e.transform) } as Entity);
  }
}

function pivotOf(ctx: OpContext, ps: PatchSet, id: string): V3 {
  const p = ctx.pivot(id);
  if (p) return p;
  const e = ps.get(id);
  if (e && isSpatial(e)) return [...e.transform.position] as V3;
  // Group: centre of its spatial descendants.
  const pts = ctx.scene.descendants(id).map((d) => ps.get(d)).filter((d): d is SpatialEntity => !!d && isSpatial(d)).map((d) => ctx.pivot(d.id) ?? d.transform.position);
  if (!pts.length) return [0, 0, 0];
  return [0, 1, 2].map((k) => pts.reduce((s, v) => s + v[k], 0) / pts.length) as V3;
}

type PivotParam = 'individual' | 'median' | V3 | undefined;
function pivots(ctx: OpContext, ps: PatchSet, ids: string[], pivot: PivotParam): V3[] {
  if (Array.isArray(pivot)) return ids.map(() => pivot);
  const own = ids.map((id) => pivotOf(ctx, ps, id));
  if (pivot === 'individual') return own;
  const m = [0, 1, 2].map((k) => own.reduce((s, v) => s + v[k], 0) / Math.max(1, own.length)) as V3;
  return ids.map(() => m);
}

const count = (n: number) => `${n} entit${n === 1 ? 'y' : 'ies'}`;
const IDS: ParamSpec = { type: 'string[]', description: 'Entity IDs (descendants follow).' };
const PIVOT: ParamSpec = { type: 'any', optional: true, description: "'median' (default: centre of the selection), 'individual' (each about its own pivot) or a world point [x, y, z]." };

const ENTITY_TYPES = ['mesh', 'instances', 'light', 'decal', 'marker', 'probeVolume', 'reflectionProbe', 'sign', 'group', 'scatter', 'spline', 'terrainLayer', 'block', 'prefab'];
const BLOCK_SHAPES = ['box', 'wedge', 'stairs', 'cylinder'];

/** Minimal structural validation of a complete entity. */
export function validateEntity(e: Entity): string | null {
  if (!e.id || typeof e.id !== 'string') return 'id must be a non-empty string';
  if (!ENTITY_TYPES.includes(e.type)) return `unknown type '${(e as { type: string }).type}'`;
  if (isSpatial(e)) {
    const t = e.transform;
    if (!t || !Array.isArray(t.position) || t.position.length !== 3) return 'transform.position [x, y, z] required';
  }
  switch (e.type) {
    case 'mesh': case 'instances': if (typeof e.asset !== 'string' || !e.asset) return 'asset required'; break;
    case 'light': if (!e.light || !['point', 'spot'].includes(e.light.kind)) return "light.kind must be 'point' or 'spot'"; break;
    case 'decal': if (!e.decal?.material || !Array.isArray(e.decal.size)) return 'decal.material and decal.size required'; break;
    case 'sign': if (typeof e.sign?.text !== 'string' || !Array.isArray(e.sign.size)) return 'sign.text and sign.size required'; break;
    case 'reflectionProbe': if (!e.probe?.boxMin || !e.probe?.boxMax) return 'probe.boxMin / boxMax required'; break;
    case 'probeVolume': if (!e.volume?.size || !e.volume?.spacing) return 'volume.size / spacing required'; break;
    case 'scatter': if (typeof e.scatter?.preset !== 'string' || typeof e.scatter.seed !== 'number') return 'scatter.preset and scatter.seed required'; break;
    case 'spline': if (!Array.isArray(e.spline?.points) || typeof e.spline.preset !== 'string') return 'spline.points and spline.preset required'; break;
    case 'terrainLayer': if (!Array.isArray(e.terrain?.strokes)) return 'terrain.strokes required'; break;
    case 'block': {
      const b = e.block;
      if (!b || !BLOCK_SHAPES.includes(b.shape)) return `block.shape must be one of ${BLOCK_SHAPES.join(', ')}`;
      if (!Array.isArray(b.size) || b.size.length !== 3 || !b.size.every((v) => typeof v === 'number' && v > 0 && Number.isFinite(v))) return 'block.size must be [x, y, z] > 0';
      break;
    }
    case 'prefab': if (typeof e.prefab !== 'string' || !e.prefab) return 'prefab (name) required'; break;
  }
  return null;
}

// ------------------------------------------------------------------ operations

op<{ entity: Partial<Entity> & { type: Entity['type'] }; parent?: string }, { id: string }>({
  name: 'create_entity',
  description: 'Creates an entity from a (partial) definition. A missing id is generated (never reused). Returns { id }.',
  params: {
    entity: { type: 'object', description: 'Entity fields (type required; transform for spatial types).' },
    parent: { type: 'string', optional: true, description: 'Outliner parent ID.' },
  },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    const src = structuredClone(p.entity) as Entity;
    const id = src.id && !ctx.scene.has(src.id) ? src.id : ctx.scene.newId(src.id ?? src.name ?? src.semantic ?? src.type);
    const e = { ...src, id } as Entity;
    if (p.parent !== undefined) e.parent = p.parent || undefined;
    if (e.parent && !ctx.scene.has(e.parent)) throw new OpError(`no parent '${e.parent}'`);
    const err = validateEntity(e);
    if (err) throw new OpError(`create_entity: ${err}`);
    ps.set(e);
    return { patches: ps.patches(), result: { id }, label: `Create ${e.name ?? id}` };
  },
});

op<{ ids: string[] }, { deleted: string[] }>({
  name: 'delete_entity',
  description: 'Deletes entities and their descendants.',
  params: { ids: IDS },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    const del: string[] = [];
    for (const id of roots(ps, p.ids)) {
      assertUnlocked(ctx, id);
      // Children first, so undo re-creates parents before their children.
      const sub = [id, ...ctx.scene.descendants(id)];
      for (const d of sub.reverse()) {
        ps.remove(d);
        del.push(d);
      }
    }
    return { patches: ps.patches(), result: { deleted: del }, label: `Delete ${count(del.length)}` };
  },
});

op<{ ids: string[]; offset?: V3 }, { ids: string[]; map: Record<string, string> }>({
  name: 'duplicate_entity',
  description: 'Duplicates entities with their descendants (new IDs), optionally offset by [dx, dy, dz]. Returns the new root IDs and an old -> new ID map.',
  params: { ids: IDS, offset: { type: 'vec3', optional: true, description: 'World offset of the copies (m).' } },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    const D = mat4.translation(p.offset ?? [0, 0, 0]);
    const map: Record<string, string> = {};
    const out: string[] = [];
    for (const id of roots(ps, p.ids)) {
      const sub = [id, ...ctx.scene.descendants(id)];
      for (const s of sub) map[s] = ctx.scene.newId(s);
      for (const s of sub) {
        const e = structuredClone(need(ps, s));
        const c = { ...e, id: map[s], parent: s === id ? e.parent : map[e.parent!] ?? e.parent } as Entity;
        if (isSpatial(c)) c.transform = applyDelta(D, c.transform);
        ps.set(c);
      }
      out.push(map[id]);
    }
    return { patches: ps.patches(), result: { ids: out, map }, label: `Duplicate ${count(out.length)}` };
  },
});

op<{ transforms: Record<string, Transform> }>({
  name: 'set_transform',
  description: 'Sets absolute world transforms ({ id: { position, rotation?, scale? } }); descendants follow.',
  params: { transforms: { type: 'object', description: 'Map of entity ID to transform (rotation as quaternion [x, y, z, w]).' } },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    const ids = roots(ps, Object.keys(p.transforms));
    for (const id of ids) {
      const e = need(ps, id);
      if (!isSpatial(e)) throw new OpError(`'${id}' has no transform`);
      const t = p.transforms[id];
      if (!Array.isArray(t?.position) || t.position.length !== 3) throw new OpError(`set_transform: '${id}' needs position [x, y, z]`);
      const next: Transform = { position: [...t.position] as V3 };
      if (t.rotation) next.rotation = [...t.rotation] as [number, number, number, number];
      if (t.scale) next.scale = [...t.scale] as V3;
      // Delta from the current transform, so descendants follow.
      const D = mat4.multiply(toMatrix(next), mat4.inverse(toMatrix(e.transform)));
      transformTree(ctx, ps, id, D);
      ps.set({ ...ps.get(id)!, transform: next } as Entity);
    }
    return { patches: ps.patches(), label: `Transform ${count(ids.length)}` };
  },
});

op<{ ids: string[]; delta?: V3; position?: V3 }>({
  name: 'move_entity',
  description: 'Moves entities by a world delta [dx, dy, dz], or (single entity) to an absolute pivot position.',
  params: { ids: IDS, delta: { type: 'vec3', optional: true, description: 'World translation (m).' }, position: { type: 'vec3', optional: true, description: 'Target position of the first entity (others keep their offsets).' } },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    const ids = roots(ps, p.ids);
    let d = p.delta;
    if (p.position) {
      const c = pivotOf(ctx, ps, ids[0]);
      d = [p.position[0] - c[0], p.position[1] - c[1], p.position[2] - c[2]];
    }
    if (!d) throw new OpError('move_entity: delta or position required');
    const D = mat4.translation(d);
    for (const id of ids) transformTree(ctx, ps, id, D);
    return { patches: ps.patches(), label: `Move ${count(ids.length)}` };
  },
});

op<{ ids: string[]; euler?: V3; axis?: V3; angle?: number; rotation?: [number, number, number, number]; pivot?: PivotParam; space?: 'world' | 'local' }>({
  name: 'rotate_entity',
  description: "Rotates entities: euler [x, y, z] degrees (Y-X-Z), or axis + angle (degrees), or a quaternion. Pivot: 'median' (default), 'individual' or [x, y, z]. space 'local' rotates about each entity's own axes.",
  params: {
    ids: IDS,
    euler: { type: 'vec3', optional: true, description: 'Euler degrees [x, y, z] applied Y, X, Z.' },
    axis: { type: 'vec3', optional: true, description: 'Rotation axis (with angle).' },
    angle: { type: 'number', optional: true, description: 'Degrees about axis.' },
    rotation: { type: 'quat', optional: true, description: 'Quaternion delta.' },
    pivot: PIVOT,
    space: { type: 'string', optional: true, enum: ['world', 'local'], description: "'world' (default) or 'local'." },
  },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    const ids = roots(ps, p.ids);
    const q = p.rotation ?? (p.euler ? eulerToQuat(p.euler) : p.axis && p.angle !== undefined ? axisAngleQuat(p.axis, p.angle) : null);
    if (!q) throw new OpError('rotate_entity: euler, axis + angle or rotation required');
    const pv = pivots(ctx, ps, ids, p.space === 'local' && p.pivot === undefined ? 'individual' : p.pivot);
    ids.forEach((id, i) => {
      const e = ps.get(id);
      if (p.space === 'local' && e && isSpatial(e) && e.transform.rotation) {
        // Local axes: R_e · q · R_e^-1 about the pivot.
        const R = mat4.fromQuat(e.transform.rotation);
        const L = mat4.multiply(mat4.multiply(R, mat4.fromQuat(q)), mat4.transpose(R));
        const D = mat4.multiply(mat4.multiply(mat4.translation(pv[i]), L), mat4.translation([-pv[i][0], -pv[i][1], -pv[i][2]]));
        transformTree(ctx, ps, id, D);
      } else {
        transformTree(ctx, ps, id, rotationAbout(q, pv[i]));
      }
    });
    return { patches: ps.patches(), label: `Rotate ${count(ids.length)}` };
  },
});

op<{ ids: string[]; factor: number | V3; pivot?: PivotParam; space?: 'world' | 'local' }>({
  name: 'scale_entity',
  description: "Scales entities by a factor (number or [x, y, z]) about a pivot ('median' default, 'individual', or a point). Non-uniform factors use each entity's local axes unless space is 'world'.",
  params: { ids: IDS, factor: { type: 'any', description: 'Uniform factor or per-axis [x, y, z].' }, pivot: PIVOT, space: { type: 'string', optional: true, enum: ['world', 'local'], description: "'local' (default) or 'world' axes." } },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    const ids = roots(ps, p.ids);
    const f: V3 = typeof p.factor === 'number' ? [p.factor, p.factor, p.factor] : p.factor;
    if (!Array.isArray(f) || f.length !== 3 || f.some((v) => !Number.isFinite(v) || v === 0)) throw new OpError('scale_entity: factor must be a non-zero number or [x, y, z]');
    const pv = pivots(ctx, ps, ids, p.pivot);
    ids.forEach((id, i) => {
      const e = ps.get(id);
      const q = p.space !== 'world' && e && isSpatial(e) ? e.transform.rotation : undefined;
      transformTree(ctx, ps, id, scaleAbout(f, pv[i], q));
    });
    return { patches: ps.patches(), label: `Scale ${count(ids.length)}` };
  },
});

/** Properties `set_property` may change, per entity type ('*' = all types). Dotted paths reach nested data. */
const PROPERTIES: Record<string, string[]> = {
  '*': ['name', 'semantic', 'tags', 'visible', 'locked'],
  mesh: ['static', 'castShadow', 'collision', 'receiveDecals', 'asset', 'lightmap'],
  instances: ['castShadow', 'collision', 'asset'],
  light: ['light.kind', 'light.color', 'light.intensity', 'light.range', 'light.innerAngle', 'light.outerAngle', 'light.sourceRadius', 'light.fogScatter', 'light.always'],
  decal: ['decal.material', 'decal.size', 'decal.opacity', 'decal.repeat'],
  marker: ['yaw', 'pitch'],
  sign: ['sign.text', 'sign.size', 'sign.font', 'sign.weight', 'sign.italic', 'sign.color', 'sign.background', 'sign.border', 'sign.align', 'sign.textHeight', 'sign.letterSpacing', 'sign.padding', 'sign.uppercase', 'sign.backlit', 'sign.depth', 'sign.doubleSided'],
  reflectionProbe: ['probe.boxMin', 'probe.boxMax', 'probe.blend', 'probe.priority'],
  probeVolume: ['volume.size', 'volume.spacing'],
  scatter: ['scatter.preset', 'scatter.density', 'scatter.seed', 'scatter.area', 'scatter.brush', 'scatter.exclude', 'scatter.surfaces', 'scatter.slopeMax'],
  terrainLayer: ['terrain.strokes', 'terrain.targets', 'terrain.cell'],
  spline: ['spline.points', 'spline.closed', 'spline.preset', 'spline.width', 'spline.drape', 'spline.texelDensity', 'castShadow', 'collision', 'lightmap'],
  block: ['block.shape', 'block.size', 'block.material', 'block.faces', 'block.steps', 'block.segments', 'block.texelDensity', 'static', 'castShadow', 'collision'],
  prefab: ['prefab'],
};

export function editableProperties(type: Entity['type']): string[] {
  return [...PROPERTIES['*'], ...(PROPERTIES[type] ?? [])];
}

function setPath(e: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const [head, ...rest] = path.split('.');
  const out = { ...e };
  if (rest.length === 0) {
    if (value === null || value === undefined) delete out[head];
    else out[head] = structuredClone(value);
    return out;
  }
  out[head] = setPath((e[head] as Record<string, unknown>) ?? {}, rest.join('.'), value);
  return out;
}

op<{ ids: string[]; key: string; value: unknown }>({
  name: 'set_property',
  description: "Sets a property on entities (null removes it). Keys: name, semantic, tags, visible, locked, static, castShadow, collision, receiveDecals, light.*, decal.*, sign.*, yaw, pitch, probe.*, volume.* (see editableProperties).",
  params: { ids: IDS, key: { type: 'string', description: 'Property path, e.g. "light.intensity".' }, value: { type: 'any', optional: true, description: 'New value (null / omitted removes the property).' } },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    for (const id of p.ids) {
      const e = need(ps, id);
      if (!editableProperties(e.type).includes(p.key)) throw new OpError(`set_property: '${p.key}' is not editable on ${e.type} '${id}'`);
      const next = setPath(e as unknown as Record<string, unknown>, p.key, p.value) as unknown as Entity;
      const err = validateEntity(next);
      if (err) throw new OpError(`set_property: ${err}`);
      ps.set(next);
    }
    return { patches: ps.patches(), label: `Set ${p.key}` };
  },
});

op<{ ids: string[]; visible: boolean }>({
  name: 'set_visibility',
  description: 'Shows or hides entities (hidden: not rendered, no collision; descendants inherit).',
  params: { ids: IDS, visible: { type: 'boolean', description: 'Visible?' } },
  run(ctx, p) {
    return { ...getOp('set_property')!.run(ctx, { ids: p.ids, key: 'visible', value: p.visible ? null : false }), label: p.visible ? 'Show' : 'Hide' };
  },
});

op<{ ids: string[]; locked: boolean }>({
  name: 'set_locked',
  description: 'Locks entities against viewport picking, transform and delete edits (descendants inherit).',
  params: { ids: IDS, locked: { type: 'boolean', description: 'Locked?' } },
  run(ctx, p) {
    return { ...getOp('set_property')!.run(ctx, { ids: p.ids, key: 'locked', value: p.locked ? true : null }), label: p.locked ? 'Lock' : 'Unlock' };
  },
});

op<{ ids: string[]; static: boolean }>({
  name: 'set_static_state',
  description: 'Marks mesh entities static (baked into lightmaps, collides) or dynamic.',
  params: { ids: IDS, static: { type: 'boolean', description: 'Static?' } },
  run(ctx, p) {
    return { ...getOp('set_property')!.run(ctx, { ids: p.ids, key: 'static', value: p.static }), label: p.static ? 'Make static' : 'Make dynamic' };
  },
});

op<{ id: string; name: string }>({
  name: 'rename_entity',
  description: 'Sets the display name.',
  params: { id: { type: 'string', description: 'Entity ID.' }, name: { type: 'string', description: 'New name.' } },
  run(ctx, p) {
    return { ...getOp('set_property')!.run(ctx, { ids: [p.id], key: 'name', value: p.name || null }), label: `Rename to ${p.name}` };
  },
});

op<{ ids: string[]; parent: string | null }>({
  name: 'reparent_entity',
  description: 'Moves entities under a new outliner parent (null / "" = top level). World transforms are unchanged.',
  params: { ids: IDS, parent: { type: 'string', optional: true, description: 'New parent ID.' } },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    const parent = p.parent || undefined;
    if (parent && !ctx.scene.has(parent)) throw new OpError(`no parent '${parent}'`);
    for (const id of roots(ps, p.ids)) {
      if (parent && (parent === id || ctx.scene.descendants(id).includes(parent))) throw new OpError(`cannot parent '${id}' under its own descendant`);
      const e = need(ps, id);
      const next = { ...e } as Entity;
      if (parent) next.parent = parent;
      else delete next.parent;
      ps.set(next);
    }
    return { patches: ps.patches(), label: parent ? `Move into ${ctx.scene.get(parent)?.name ?? parent}` : 'Move to top level' };
  },
});

op<{ name: string; ids?: string[]; parent?: string }, { id: string }>({
  name: 'create_group',
  description: 'Creates an outliner group, optionally moving entities into it. Returns { id }.',
  params: { name: { type: 'string', description: 'Group name.' }, ids: { type: 'string[]', optional: true, description: 'Entities to move into the group.' }, parent: { type: 'string', optional: true, description: 'Parent of the group (default: the first entity\'s parent).' } },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    const id = ctx.scene.newId(p.name || 'group');
    const parent = p.parent ?? (p.ids?.length ? ctx.scene.get(p.ids[0])?.parent : undefined);
    ps.set({ id, name: p.name, type: 'group', ...(parent ? { parent } : {}) });
    for (const c of p.ids ? roots(ps, p.ids) : []) {
      ps.set({ ...need(ps, c), parent: id } as Entity);
    }
    return { patches: ps.patches(), result: { id }, label: `Group ${p.name}` };
  },
});

op<{ ids: string[]; slot: string; material: string | null }>({
  name: 'assign_material',
  description: 'Assigns a material (public/materials/<name>.json) to a mesh material slot; null restores the asset\'s own material.',
  params: { ids: IDS, slot: { type: 'string', description: 'Material slot (the asset\'s material name).' }, material: { type: 'string', optional: true, description: 'Material name, or null to clear the override.' } },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    for (const id of p.ids) {
      const e = need(ps, id);
      if (e.type !== 'mesh' && e.type !== 'instances') throw new OpError(`'${id}' has no materials`);
      const ov = { ...(e.materialOverrides ?? {}) };
      if (!p.material || p.material === p.slot) delete ov[p.slot];
      else ov[p.slot] = p.material;
      const next = { ...e } as typeof e;
      if (Object.keys(ov).length) next.materialOverrides = ov;
      else delete next.materialOverrides;
      ps.set(next);
    }
    return { patches: ps.patches(), label: `Material ${p.slot} → ${p.material ?? 'default'}` };
  },
});

op<{ ids: string[]; slot: string; param: string; value: unknown }>({
  name: 'set_material_parameter',
  description: 'Overrides one material parameter (e.g. baseColorFactor, roughness) for a slot on these entities only: an inline material inheriting the current one.',
  params: { ids: IDS, slot: { type: 'string', description: 'Material slot.' }, param: { type: 'string', description: 'MaterialDef field.' }, value: { type: 'any', optional: true, description: 'Value (null removes the override).' } },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    for (const id of p.ids) {
      const e = need(ps, id);
      if (e.type !== 'mesh' && e.type !== 'instances') throw new OpError(`'${id}' has no materials`);
      const ov = { ...(e.materialOverrides ?? {}) };
      const cur = ov[p.slot];
      const def: MaterialDef = typeof cur === 'object' ? { ...cur } : { inherits: cur ?? p.slot };
      if (p.value === null || p.value === undefined) delete (def as Record<string, unknown>)[p.param];
      else (def as Record<string, unknown>)[p.param] = structuredClone(p.value);
      const keys = Object.keys(def);
      if (keys.length === 1 && def.inherits) {
        if (def.inherits === p.slot) delete ov[p.slot];
        else ov[p.slot] = def.inherits;
      } else ov[p.slot] = def;
      const next = { ...e } as typeof e;
      if (Object.keys(ov).length) next.materialOverrides = ov;
      else delete next.materialOverrides;
      ps.set(next);
    }
    return { patches: ps.patches(), label: `Material ${p.slot}.${p.param}` };
  },
});

op<{ preset?: string; overrides?: Record<string, unknown> | null }>({
  name: 'set_environment',
  description: 'Sets the map\'s environment: a preset (public/environments) and/or overrides of its fields (null clears them).',
  params: { preset: { type: 'string', optional: true, description: 'Preset name (clear, overcast, foggy, dusk, winter, bluehour, november, november_evening).' }, overrides: { type: 'any', optional: true, description: 'Partial EnvironmentState merged over the preset (replaces the previous overrides).' } },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    const cur = ctx.scene.doc.environment;
    const next: { preset: string; overrides?: Record<string, unknown> } = { preset: p.preset ?? cur.preset };
    const ov = p.overrides === undefined ? (p.preset && p.preset !== cur.preset ? undefined : cur.overrides) : p.overrides ?? undefined;
    if (ov && Object.keys(ov).length) next.overrides = structuredClone(ov);
    if (JSON.stringify(next) !== JSON.stringify(cur)) ps.doc('environment', next);
    return { patches: ps.patches(), label: p.preset && p.preset !== cur.preset ? `Environment ${p.preset}` : 'Environment settings' };
  },
});

// ------------------------------------------------------------------ scatter

/** World XZ -> scatter-local XZ (position + yaw of the entity transform). */
function scatterLocal(e: Entity, x: number, z: number): [number, number] {
  if (!isSpatial(e)) return [x, z];
  const p = e.transform.position, q = e.transform.rotation ?? [0, 0, 0, 1];
  const m = mat4.fromQuat(q);
  const dx = x - p[0], dz = z - p[2];
  // Inverse rotation = transpose (XZ part).
  return [round3(m[0] * dx + m[2] * dz), round3(m[8] * dx + m[10] * dz)];
}
const round3 = (v: number) => Math.round(v * 1000) / 1000;

op<{ preset: string; area?: [number, number][]; center?: number[]; radius?: number; density?: number; seed?: number; name?: string; parent?: string }, { id: string }>({
  name: 'scatter_vegetation',
  description: 'Creates a vegetation / rock scatter: a preset (public/scatter/*.json, e.g. stockholm_mixed_forest, pine_heath, spruce_forest, birch_grove, shrubs, park_trees, rock_outcrops) over a world polygon area [[x, z], ...] or a circle (center + radius). Deterministic per seed; density = instances per 100 m² (default: preset). Returns { id }.',
  params: {
    preset: { type: 'string', description: 'Scatter preset name.' },
    area: { type: 'any', optional: true, description: 'World polygon [[x, z], ...] (3+ points).' },
    center: { type: 'any', optional: true, description: 'Circle centre [x, z] or [x, y, z].' },
    radius: { type: 'number', optional: true, description: 'Circle radius (m).' },
    density: { type: 'number', optional: true, description: 'Instances per 100 m².' },
    seed: { type: 'number', optional: true, description: 'Random seed.' },
    name: { type: 'string', optional: true, description: 'Display name.' },
    parent: { type: 'string', optional: true, description: 'Outliner parent.' },
  },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    // Points may be [x, z] or [x, y, z].
    const poly = Array.isArray(p.area) && p.area.length >= 3 ? (p.area as number[][]).map((v) => [v[0], v[v.length === 3 ? 2 : 1]] as [number, number]) : null;
    let c: [number, number];
    if (poly) c = [poly.reduce((a, v) => a + v[0], 0) / poly.length, poly.reduce((a, v) => a + v[1], 0) / poly.length];
    else if (p.center && p.radius) c = [p.center[0], p.center[p.center.length === 3 ? 2 : 1]];
    else throw new OpError('scatter_vegetation: area (polygon) or center + radius required');
    c = [round3(c[0]), round3(c[1])];
    const y = p.center && p.center.length === 3 ? p.center[1] : 0;
    const id = ctx.scene.newId(p.preset);
    const e: Entity = {
      id, name: p.name ?? p.preset.replace(/_/g, ' '), type: 'scatter', semantic: 'vegetation', ...(p.parent ? { parent: p.parent } : {}),
      transform: { position: [c[0], y, c[1]] },
      scatter: {
        preset: p.preset, seed: p.seed ?? (fnvHash(id) % 100000), ...(p.density ? { density: p.density } : {}),
        ...(poly ? { area: poly.map(([x, z]) => [round3(x - c[0]), round3(z - c[1])] as [number, number]) } : { brush: [[0, 0, round3(p.radius!), 1]] }),
      },
    };
    if (p.parent && !ctx.scene.has(p.parent)) throw new OpError(`no parent '${p.parent}'`);
    ps.set(e);
    return { patches: ps.patches(), result: { id }, label: `Scatter ${p.preset}` };
  },
});

op<{ id: string; strokes: [number, number, number][]; erase?: boolean }>({
  name: 'paint_scatter',
  description: 'Paints (or erases) circles [[x, z, radius], ...] (world) into a scatter. Later circles override earlier ones, so painting over an erased patch restores it.',
  params: { id: { type: 'string', description: 'Scatter entity.' }, strokes: { type: 'any', description: '[[x, z, radius], ...] world.' }, erase: { type: 'boolean', optional: true, description: 'Erase instead of paint.' } },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    const e = need(ps, p.id);
    if (e.type !== 'scatter') throw new OpError(`'${p.id}' is not a scatter`);
    if (!Array.isArray(p.strokes) || !p.strokes.length) throw new OpError('paint_scatter: strokes required');
    const add = p.strokes.map(([x, z, r]) => [...scatterLocal(e, x, z), round3(Math.max(0.1, r)), p.erase ? 0 : 1] as [number, number, number, 0 | 1]);
    // Circles fully covered by a newer one no longer matter.
    const old = (e.scatter.brush ?? []).filter(([x, z, r]) => !add.some(([ax, az, ar]) => Math.hypot(x - ax, z - az) + r <= ar));
    ps.set({ ...e, scatter: { ...e.scatter, brush: [...old, ...add] } });
    return { patches: ps.patches(), label: p.erase ? 'Erase scatter' : 'Paint scatter' };
  },
});

op<{ id: string; keys: string[]; restore?: boolean }>({
  name: 'scatter_remove',
  description: 'Removes individual scatter instances by cell key (from get_entity / picking), or restores them.',
  params: { id: { type: 'string', description: 'Scatter entity.' }, keys: { type: 'string[]', description: 'Instance keys "ix,iz".' }, restore: { type: 'boolean', optional: true, description: 'Bring them back.' } },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    const e = need(ps, p.id);
    if (e.type !== 'scatter') throw new OpError(`'${p.id}' is not a scatter`);
    const ex = new Set(e.scatter.exclude ?? []);
    for (const k of p.keys) if (p.restore) ex.delete(k); else ex.add(k);
    const next = { ...e, scatter: { ...e.scatter } };
    if (ex.size) next.scatter.exclude = [...ex].sort();
    else delete next.scatter.exclude;
    ps.set(next);
    return { patches: ps.patches(), label: p.restore ? 'Restore scatter instances' : `Remove ${p.keys.length} scatter instance${p.keys.length === 1 ? '' : 's'}` };
  },
});

op<{ id: string; keys?: string[]; group?: boolean }, { ids: string[]; group?: string }>({
  name: 'scatter_detach',
  description: 'Turns scatter instances (keys, or all) into ordinary mesh entities for hand placement; they are removed from the scatter. All instances: the scatter is replaced by a group of entities.',
  params: { id: { type: 'string', description: 'Scatter entity.' }, keys: { type: 'string[]', optional: true, description: 'Instance keys (default: all).' } },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    const e = need(ps, p.id);
    if (e.type !== 'scatter') throw new OpError(`'${p.id}' is not a scatter`);
    if (!ctx.runtime) throw new OpError('scatter_detach needs the runtime');
    const all = ctx.runtime.scatterInstances(p.id);
    const want = p.keys ? new Set(p.keys) : null;
    const list = all.filter((i) => !want || want.has(i.key));
    if (!list.length) throw new OpError('scatter_detach: no matching instances');
    let parent = e.parent;
    let group: string | undefined;
    if (!want) {
      group = ctx.scene.newId(`${e.id}_detached`);
      ps.set({ id: group, name: `${e.name ?? e.id} (entities)`, type: 'group', ...(e.parent ? { parent: e.parent } : {}) });
      parent = group;
    }
    const ids: string[] = [];
    for (const i of list) {
      const nid = ctx.scene.newId(i.asset.split('/').pop()!.replace(/\.(glb|model\.json)$/, ''));
      const a = (-i.yawDeg * Math.PI) / 360;
      ps.set({
        id: nid, type: 'mesh', semantic: e.semantic ?? 'vegetation', ...(parent ? { parent } : {}), asset: i.asset,
        transform: { position: i.position.map(round3) as V3, rotation: [0, +Math.sin(a).toFixed(7), 0, +Math.cos(a).toFixed(7)], ...(i.scale !== 1 ? { scale: [round3(i.scale), round3(i.scale), round3(i.scale)] as V3 } : {}) },
        collision: false, receiveDecals: false,
      });
      ids.push(nid);
    }
    if (!want) ps.remove(e.id);
    else ps.set({ ...e, scatter: { ...e.scatter, exclude: [...new Set([...(e.scatter.exclude ?? []), ...list.map((i) => i.key)])].sort() } });
    return { patches: ps.patches(), result: { ids, group }, label: want ? `Detach ${ids.length} instance${ids.length === 1 ? '' : 's'}` : `Convert ${e.name ?? e.id} to entities` };
  },
});

// ------------------------------------------------------------------ splines

/** World point -> spline-local point (inverse of the entity's position + rotation). [x, z] points take the entity's height. */
function splineLocal(e: Entity, w: number[], _drape: boolean): [number, number, number] {
  if (!isSpatial(e)) return [w[0], w[1] ?? 0, w[2]];
  const p = e.transform.position, q = e.transform.rotation ?? [0, 0, 0, 1];
  const m = mat4.fromQuat(q);
  const d = [w[0] - p[0], (w.length === 3 ? w[1] : p[1]) - p[1], w[w.length === 3 ? 2 : 1] - p[2]];
  // Inverse rotation = transpose.
  const x = m[0] * d[0] + m[1] * d[1] + m[2] * d[2], y = m[4] * d[0] + m[5] * d[1] + m[6] * d[2], z = m[8] * d[0] + m[9] * d[1] + m[10] * d[2];
  return [round3(x), round3(y), round3(z)];
}

op<{ preset: string; points: number[][]; closed?: boolean; width?: number; drape?: boolean; name?: string; parent?: string }, { id: string }>({
  name: 'create_spline',
  description: 'Creates a spline (path_asphalt, path_gravel, road_kerbed, kerb_granite, fence_chainlink, low_wall, rail_track: public/splines/*.json) through world points [[x, z] or [x, y, z], ...]. Draped on the ground by default. Returns { id }.',
  params: {
    preset: { type: 'string', description: 'Spline preset.' },
    points: { type: 'any', description: 'World control points, 2 or more.' },
    closed: { type: 'boolean', optional: true, description: 'Closed loop.' },
    width: { type: 'number', optional: true, description: 'Width override (m) for paths / roads.' },
    drape: { type: 'boolean', optional: true, description: 'Follow the ground (default true).' },
    name: { type: 'string', optional: true, description: 'Display name.' },
    parent: { type: 'string', optional: true, description: 'Outliner parent.' },
  },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    if (!Array.isArray(p.points) || p.points.length < 2) throw new OpError('create_spline: 2+ points required');
    if (p.parent && !ctx.scene.has(p.parent)) throw new OpError(`no parent '${p.parent}'`);
    const f = p.points[0];
    const origin: V3 = [round3(f[0]), f.length === 3 ? round3(f[1]) : 0, round3(f[f.length === 3 ? 2 : 1])];
    const drape = p.drape !== false;
    const id = ctx.scene.newId(p.preset);
    const shell = { id, type: 'group', transform: { position: origin } } as unknown as Entity;
    const e: Entity = {
      id, name: p.name ?? p.preset.replace(/_/g, ' '), type: 'spline', semantic: p.preset.split('_')[0], ...(p.parent ? { parent: p.parent } : {}),
      transform: { position: origin },
      spline: {
        preset: p.preset, points: p.points.map((w) => splineLocal({ ...shell, type: 'marker' } as Entity, w, drape)),
        ...(p.closed ? { closed: true } : {}), ...(p.width ? { width: p.width } : {}), ...(drape ? {} : { drape: false }),
      },
    };
    ps.set(e);
    return { patches: ps.patches(), result: { id }, label: `Spline ${p.preset}` };
  },
});

op<{ id: string; points?: number[][]; insert?: { index: number; point: number[] }; remove?: number; move?: { index: number; point: number[] }; closed?: boolean; width?: number | null; preset?: string }>({
  name: 'modify_spline',
  description: 'Edits a spline: replace all points (world), insert a point before index, move one point, remove one point, set closed / width / preset.',
  params: {
    id: { type: 'string', description: 'Spline entity.' },
    points: { type: 'any', optional: true, description: 'All control points (world).' },
    insert: { type: 'object', optional: true, description: '{ index, point } (world point inserted before index; index = count appends).' },
    move: { type: 'object', optional: true, description: '{ index, point } (world).' },
    remove: { type: 'number', optional: true, description: 'Index of a point to remove (2 points minimum remain).' },
    closed: { type: 'boolean', optional: true, description: 'Closed loop.' },
    width: { type: 'number', optional: true, description: 'Width (m); null restores the preset width.' },
    preset: { type: 'string', optional: true, description: 'Preset.' },
  },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    const e = need(ps, p.id);
    if (e.type !== 'spline') throw new OpError(`'${p.id}' is not a spline`);
    const drape = e.spline.drape !== false;
    let pts = e.spline.points.map((q) => [...q] as [number, number, number]);
    if (p.points) pts = p.points.map((w) => splineLocal(e, w, drape));
    if (p.insert) pts.splice(Math.max(0, Math.min(pts.length, p.insert.index)), 0, splineLocal(e, p.insert.point, drape));
    if (p.move) {
      if (p.move.index < 0 || p.move.index >= pts.length) throw new OpError('modify_spline: bad point index');
      pts[p.move.index] = splineLocal(e, p.move.point, drape);
    }
    if (p.remove !== undefined) {
      if (pts.length <= 2) throw new OpError('modify_spline: a spline keeps at least 2 points');
      pts.splice(p.remove, 1);
    }
    const sp = { ...e.spline, points: pts };
    if (p.closed !== undefined) { if (p.closed) sp.closed = true; else delete sp.closed; }
    if (p.width !== undefined) { if (p.width) sp.width = p.width; else delete sp.width; }
    if (p.preset) sp.preset = p.preset;
    ps.set({ ...e, spline: sp });
    return { patches: ps.patches(), label: p.move ? 'Move spline point' : p.insert ? 'Add spline point' : p.remove !== undefined ? 'Remove spline point' : 'Edit spline' };
  },
});

// ------------------------------------------------------------------ terrain

const TERRAIN_OPS = ['raise', 'lower', 'smooth', 'flatten', 'paint', 'unpaint'];

op<{ op: string; points?: number[][]; center?: number[]; radius: number; strength?: number; value?: number }, { id: string; strokes: number }>({
  name: 'modify_terrain',
  description: "Sculpts / paints the terrain with brush dabs at world points [[x, z], ...] (or one center): op raise / lower (strength = metres per dab, default 0.3), smooth / flatten (strength 0..1; flatten needs value = target height), paint / unpaint (ground blend layer: forest floor / worn earth; strength 0..1). Edits live in the map's terrain layer (created on first use); the terrain assets are untouched.",
  params: {
    op: { type: 'string', enum: TERRAIN_OPS, description: 'Brush operation.' },
    points: { type: 'any', optional: true, description: 'Dab positions [[x, z] | [x, y, z], ...].' },
    center: { type: 'any', optional: true, description: 'One dab position.' },
    radius: { type: 'number', description: 'Brush radius (m).' },
    strength: { type: 'number', optional: true, description: 'Per dab (see op).' },
    value: { type: 'number', optional: true, description: 'Flatten target height (m).' },
  },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    const pts = (p.points ?? (p.center ? [p.center] : [])).map((v) => [v[0], v[v.length === 3 ? 2 : 1]]);
    if (!pts.length) throw new OpError('modify_terrain: points or center required');
    if (p.op === 'flatten' && typeof p.value !== 'number') throw new OpError('modify_terrain: flatten needs value (target height)');
    const s = p.strength ?? (p.op === 'raise' || p.op === 'lower' ? 0.3 : 0.5);
    let layer = ctx.scene.entities.find((e) => e.type === 'terrainLayer');
    if (!layer) {
      layer = { id: ctx.scene.has('terrain_edits') ? ctx.scene.newId('terrain_edits') : 'terrain_edits', name: 'Terrain edits', type: 'terrainLayer', ...(ctx.scene.has('grp_terrain') ? { parent: 'grp_terrain' } : {}), terrain: { strokes: [] } };
    }
    if (layer.type !== 'terrainLayer') throw new OpError('modify_terrain: no terrain layer');
    const add = pts.map(([x, z]) => {
      const st: [string, number, number, number, number, number?] = [p.op, round3(x), round3(z), round3(Math.max(0.25, p.radius)), round3(s)];
      if (p.op === 'flatten') st.push(round3(p.value!));
      return st;
    });
    ps.set({ ...layer, terrain: { ...layer.terrain, strokes: [...layer.terrain.strokes, ...add] } });
    return { patches: ps.patches(), result: { id: layer.id, strokes: layer.terrain.strokes.length + add.length }, label: `Terrain ${p.op}` };
  },
});

// ------------------------------------------------------------------ decals

/**
 * Orientation of a decal box projecting onto a surface: +Z = the surface normal; on
 * walls +Y points up (streaks hang down), on floors +X follows world X; then `roll`
 * degrees about the normal.
 */
export function decalRotation(normal: number[], rollDeg = 0): [number, number, number, number] {
  const n = vec3.normalize(vec3.fromValues(normal[0], normal[1], normal[2]));
  const up = Math.abs(n[1]) < 0.85 ? vec3.fromValues(0, 1, 0) : vec3.fromValues(0, 0, -1);
  const x0 = vec3.normalize(vec3.cross(up, n));
  const y0 = vec3.cross(n, x0);
  const a = (rollDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const x = vec3.add(vec3.scale(x0, c), vec3.scale(y0, s)), y = vec3.cross(n, x);
  const q = quat.fromMat(mat4.create(x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, n[0], n[1], n[2], 0, 0, 0, 0, 1));
  if (q[3] < 0) quat.scale(q, -1, q);
  return [round6(q[0]), round6(q[1]), round6(q[2]), round6(q[3])];
}
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

op<{ material: string; position: number[]; normal?: V3; size?: number | number[]; depth?: number; roll?: number; opacity?: number; parent?: string; name?: string }, { id: string }>({
  name: 'place_decal',
  description: 'Places a projected decal (material: a decal_* material) on the surface at position with outward normal (default up). position [x, z] lands on the ground there. size: metres (number = square, or [w, h]); depth: projection depth; roll: degrees about the normal. Returns { id }.',
  params: {
    material: { type: 'string', description: 'Decal material (decal_stain, decal_waterstreak, decal_crack, decal_grime_base, decal_oil, decal_manhole, decal_paint_line...).' },
    position: { type: 'any', description: 'Surface point (world) [x, y, z], or [x, z] on the ground.' },
    normal: { type: 'vec3', optional: true, description: 'Outward surface normal (default [0, 1, 0]).' },
    size: { type: 'any', optional: true, description: 'Metres: number or [w, h] (default 1.5).' },
    depth: { type: 'number', optional: true, description: 'Projection depth (m, default 0.3).' },
    roll: { type: 'number', optional: true, description: 'Rotation about the normal (degrees).' },
    opacity: { type: 'number', optional: true, description: '0..1.' },
    parent: { type: 'string', optional: true, description: 'Outliner parent (e.g. the building it is on).' },
    name: { type: 'string', optional: true, description: 'Display name.' },
  },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    if (p.parent && !ctx.scene.has(p.parent)) throw new OpError(`no parent '${p.parent}'`);
    const sz = typeof p.size === 'number' ? [p.size, p.size] : Array.isArray(p.size) ? p.size : [1.5, 1.5];
    const id = ctx.scene.newId(p.material);
    ps.set({
      id, name: p.name ?? p.material.replace(/^decal_/, '').replace(/_/g, ' '), type: 'decal', semantic: 'decal', ...(p.parent ? { parent: p.parent } : {}),
      transform: { position: resolvePoint(ctx, p.position, false, 'place_decal').map(round3) as V3, rotation: decalRotation(p.normal ?? [0, 1, 0], p.roll ?? 0) },
      decal: { material: p.material, size: [round3(sz[0]), round3(sz[1] ?? sz[0]), round3(p.depth ?? 0.3)], ...(p.opacity !== undefined && p.opacity !== 1 ? { opacity: p.opacity } : {}) },
    });
    return { patches: ps.patches(), result: { id }, label: `Decal ${p.material}` };
  },
});

function fnvHash(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

op<{ name?: string; description?: string; lightmaps?: string | null }>({
  name: 'set_map_settings',
  description: 'Sets document-level map settings: display name, description, lightmap set path (relative to the map directory).',
  params: { name: { type: 'string', optional: true, description: 'Map name.' }, description: { type: 'string', optional: true, description: 'Description.' }, lightmaps: { type: 'string', optional: true, description: 'LightmapSet manifest path, e.g. lightmaps/lightmapset.json.' } },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    const d = ctx.scene.doc;
    if (p.name !== undefined && p.name !== d.name) ps.doc('name', p.name);
    if (p.description !== undefined && p.description !== d.description) ps.doc('description', p.description || undefined);
    if (p.lightmaps !== undefined && p.lightmaps !== d.lightmaps) ps.doc('lightmaps', p.lightmaps || undefined);
    return { patches: ps.patches(), label: 'Map settings' };
  },
});

op<{ asset: string; position: number[]; onGround?: boolean; rotation?: [number, number, number, number]; yaw?: number; scale?: number | V3; parent?: string; name?: string }, { id: string; children: string[] }>({
  name: 'place_asset',
  description: 'Places an asset from the registry (id or path) at a world position, with its prefab children (e.g. a streetlight\'s lamp). position [x, z] (or onGround) stands it on the ground there. yaw: degrees about +Y (counter-clockwise from above). Returns { id, children }.',
  params: {
    asset: { type: 'string', description: 'Asset ID (registry) or asset path (.glb / .model.json).' },
    position: { type: 'any', description: 'World position of the asset origin: [x, y, z], or [x, z] to stand on the ground.' },
    onGround: { type: 'boolean', optional: true, description: 'Use the ground height under [x, z] even if y is given.' },
    rotation: { type: 'quat', optional: true, description: 'Quaternion.' },
    yaw: { type: 'number', optional: true, description: 'Degrees about +Y (when no rotation is given).' },
    scale: { type: 'any', optional: true, description: 'Uniform or [x, y, z].' },
    parent: { type: 'string', optional: true, description: 'Outliner parent.' },
    name: { type: 'string', optional: true, description: 'Display name.' },
  },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    const a = ctx.assets?.get(p.asset);
    const path = a?.path ?? p.asset;
    if (!a && !/\.(glb|model\.json)$|^builtin:/.test(path)) throw new OpError(`place_asset: unknown asset '${p.asset}'`);
    if (p.parent && !ctx.scene.has(p.parent)) throw new OpError(`no parent '${p.parent}'`);
    const base = (a?.id ?? path).split('/').pop()!.replace(/\.(glb|model\.json)$/, '').replace(/^builtin:(\w+).*/, '$1');
    const id = ctx.scene.newId(base);
    const t: Transform = { position: resolvePoint(ctx, p.position, p.onGround, 'place_asset') };
    const rot = p.rotation ?? (p.yaw ? axisAngleQuat([0, 1, 0], p.yaw) : undefined);
    if (rot) t.rotation = rot;
    if (p.scale !== undefined) t.scale = typeof p.scale === 'number' ? [p.scale, p.scale, p.scale] : p.scale;
    const e: Entity = {
      id, name: p.name ?? a?.name ?? base, type: 'mesh', ...(a?.semantic ? { semantic: a.semantic } : {}), ...(a?.tags?.length ? { tags: [...a.tags] } : {}),
      ...(p.parent ? { parent: p.parent } : {}), asset: path, transform: t, static: true, ...structuredClone(a?.defaults ?? {}),
    };
    ps.set(e);
    const M = toMatrix(t);
    const kids: string[] = [];
    for (const c of a?.children ?? []) {
      const cid = ctx.scene.newId(`${base}_${c.type}`);
      const k = { ...structuredClone(c), id: cid, parent: id } as Entity;
      if (isSpatial(k)) k.transform = applyDelta(M, k.transform);
      const err = validateEntity(k);
      if (err) throw new OpError(`place_asset: prefab child: ${err}`);
      ps.set(k);
      kids.push(cid);
    }
    return { patches: ps.patches(), result: { id, children: kids }, label: `Place ${e.name}` };
  },
});

// ------------------------------------------------------------------ blockout

const SHAPE_NAMES: Record<string, string> = { box: 'Block', wedge: 'Ramp', stairs: 'Stairs', cylinder: 'Pillar' };
const SIDE_NAMES: Record<string, string> = { ny: 'Floor', py: 'Ceiling', nx: 'Wall −X', px: 'Wall +X', nz: 'Wall −Z', pz: 'Wall +Z' };

function needBlock(ps: PatchSet, id: string): BlockObject {
  const e = need(ps, id);
  if (e.type !== 'block') throw new OpError(`'${id}' is not a block`);
  return e;
}

/** Block entity with its scale folded into the size. */
function withSize(e: BlockObject, size: V3, transform?: Transform): BlockObject {
  const t = transform ?? blockFrame(e).transform;
  return { ...e, transform: t, block: { ...e.block, size: size.map(round3) as V3 } };
}

function pieceEntity(ctx: OpContext, src: BlockObject, pc: Piece, id: string, name?: string): BlockObject {
  const t: Transform = { position: pc.position };
  if (src.transform.rotation) t.rotation = [...src.transform.rotation] as Transform['rotation'];
  return { ...structuredClone(src), id, ...(name ? { name } : {}), transform: t, block: { ...structuredClone(src.block), size: pc.size } };
}

/** Replaces block `id` by pieces; the largest keeps the ID. Returns the piece IDs. */
function replaceWithPieces(ctx: OpContext, ps: PatchSet, e: BlockObject, pieces: Piece[], names?: (p: Piece) => string | undefined, parent?: string): string[] {
  const order = pieces.map((_, i) => i).sort((a, b) => pieces[b].volume - pieces[a].volume);
  const out: string[] = [];
  ps.remove(e.id);
  order.forEach((k, j) => {
    const pc = pieces[k];
    const name = names?.(pc);
    const id = j === 0 && !parent ? e.id : ctx.scene.newId(name ? name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') : e.id.replace(/_\d+$/, ''));
    const b = pieceEntity(ctx, e, pc, id, name);
    if (parent) b.parent = parent;
    ps.set(b);
    out.push(id);
  });
  return out;
}

/** Box blocks (other than `skip`) sharing axes with the cutter and overlapping it, cut. */
function cutAll(ctx: OpContext, ps: PatchSet, cutter: V3[], targets: string[] | null, skip: Set<string>): { cut: string[]; pieces: string[]; skipped: string[] } {
  const cut: string[] = [], pieces: string[] = [], skipped: string[] = [];
  const ids = targets ?? ctx.scene.entities.filter((e) => e.type === 'block').map((e) => e.id);
  for (const id of ids) {
    if (skip.has(id)) continue;
    const e = ps.get(id);
    if (!e || e.type !== 'block' || !ctx.scene.effectiveVisible(id)) continue;
    if (ctx.scene.effectiveLocked(id)) { if (targets) skipped.push(`${id} (locked)`); continue; }
    if (e.block.shape !== 'box') { if (targets) skipped.push(`${id} (${e.block.shape}: only boxes cut)`); continue; }
    const r = subtractBox(e, cutter);
    if (r === 'none') continue;
    if (r === 'unaligned') { skipped.push(`${id} (rotated relative to the cut)`); continue; }
    cut.push(id);
    pieces.push(...replaceWithPieces(ctx, ps, e, r));
  }
  return { cut, pieces, skipped };
}

op<{ position: number[]; size: V3; shape?: string; yaw?: number; rotation?: [number, number, number, number]; material?: string; faces?: Record<string, string>; steps?: number; segments?: number; name?: string; parent?: string; onGround?: boolean }, { id: string }>({
  name: 'create_block',
  description: 'Creates a blockout block: shape box (default), wedge (ramp rising towards local -Z), stairs (climbing towards local -Z; steps default to ~17 cm risers) or cylinder. position is the bottom centre ([x, z] stands it on the ground). size [width x, height y, depth z] metres. Textures are world-aligned (measured dev grids: dev_wall default, dev_grey, dev_dark, dev_orange, dev_blue, dev_green; or any material). Returns { id }.',
  params: {
    position: { type: 'any', description: 'Bottom centre (world): [x, y, z], or [x, z] on the ground.' },
    size: { type: 'vec3', description: '[width (x), height (y), depth (z)] metres.' },
    shape: { type: 'string', optional: true, enum: BLOCK_SHAPES, description: 'box (default), wedge, stairs, cylinder.' },
    yaw: { type: 'number', optional: true, description: 'Degrees about +Y.' },
    rotation: { type: 'quat', optional: true, description: 'Quaternion (instead of yaw).' },
    material: { type: 'string', optional: true, description: 'Material for all faces (default dev_wall).' },
    faces: { type: 'object', optional: true, description: 'Per-face materials { py, ny, px, nx, pz, nz, side }.' },
    steps: { type: 'number', optional: true, description: 'Stairs: number of steps.' },
    segments: { type: 'number', optional: true, description: 'Cylinder: sides (default 16).' },
    name: { type: 'string', optional: true, description: 'Display name.' },
    parent: { type: 'string', optional: true, description: 'Outliner parent.' },
    onGround: { type: 'boolean', optional: true, description: 'Stand on the ground under [x, z] even if y is given.' },
  },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    const shape = (p.shape ?? 'box') as BlockObject['block']['shape'];
    if (p.parent && !ctx.scene.has(p.parent)) throw new OpError(`no parent '${p.parent}'`);
    if (!p.size.every((v) => v > 0)) throw new OpError('create_block: size must be > 0');
    const name = p.name ?? SHAPE_NAMES[shape];
    const id = ctx.scene.newId(name.toLowerCase().replace(/[^a-z0-9]+/g, '_'));
    const t: Transform = { position: resolvePoint(ctx, p.position, p.onGround, 'create_block').map(round3) as V3 };
    const rot = p.rotation ?? (p.yaw ? axisAngleQuat([0, 1, 0], p.yaw) : undefined);
    if (rot) t.rotation = rot;
    const block: BlockObject['block'] = { shape, size: p.size.map(round3) as V3 };
    if (p.material && p.material !== BLOCK_MATERIAL) block.material = p.material;
    if (p.faces && Object.keys(p.faces).length) block.faces = { ...p.faces };
    if (p.steps) block.steps = Math.round(p.steps);
    if (p.segments) block.segments = Math.round(p.segments);
    const e: BlockObject = { id, name, type: 'block', semantic: 'blockout', ...(p.parent ? { parent: p.parent } : {}), transform: t, block, static: true };
    const err = validateEntity(e);
    if (err) throw new OpError(`create_block: ${err}`);
    ps.set(e);
    return { patches: ps.patches(), result: { id }, label: `Create ${name.toLowerCase()}` };
  },
});

op<{ ids: string[]; shape?: string; size?: V3; material?: string | null; steps?: number | null; segments?: number | null; texelDensity?: number | null }>({
  name: 'set_block',
  description: 'Changes block parameters: shape, size [x, y, z] (bottom centre stays put), material (all faces; null = dev_wall), steps (stairs, null = automatic), segments (cylinder), texelDensity (lightmap texels per metre).',
  params: {
    ids: IDS,
    shape: { type: 'string', optional: true, enum: BLOCK_SHAPES, description: 'New shape.' },
    size: { type: 'vec3', optional: true, description: 'New size [x, y, z] metres.' },
    material: { type: 'string', optional: true, description: 'Material for all faces (clears per-face materials).' },
    steps: { type: 'number', optional: true, description: 'Stairs: step count.' },
    segments: { type: 'number', optional: true, description: 'Cylinder sides.' },
    texelDensity: { type: 'number', optional: true, description: 'Lightmap texels per metre (default 8).' },
  },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    for (const id of p.ids) {
      const e = needBlock(ps, id);
      assertUnlocked(ctx, id);
      const f = blockFrame(e);
      const b = { ...e.block, size: f.size };
      if (p.shape) b.shape = p.shape as typeof b.shape;
      if (p.size) {
        if (!p.size.every((v) => v > 0)) throw new OpError('set_block: size must be > 0');
        b.size = p.size;
      }
      if (p.material !== undefined) {
        if (p.material && p.material !== BLOCK_MATERIAL) b.material = p.material;
        else delete b.material;
        delete b.faces;
      }
      for (const k of ['steps', 'segments', 'texelDensity'] as const) {
        const v = p[k];
        if (v === undefined) continue;
        if (v === null || v <= 0) delete b[k];
        else b[k] = k === 'texelDensity' ? v : Math.round(v);
      }
      if (b.faces) {
        const valid = new Set(faceIds(b.shape));
        b.faces = Object.fromEntries(Object.entries(b.faces).filter(([k]) => valid.has(k)));
        if (!Object.keys(b.faces).length) delete b.faces;
      }
      ps.set(withSize({ ...e, block: b }, b.size as V3, f.transform));
    }
    return { patches: ps.patches(), label: p.shape ? `Shape ${p.shape}` : p.size ? 'Resize block' : 'Block settings' };
  },
});

op<{ ids: string[]; face?: string; material?: string | null }>({
  name: 'set_block_material',
  description: "Sets a block face's material (face py top, ny bottom, px / nx, pz / nz, side for cylinders), or every face when face is omitted. null clears the face back to the block's material.",
  params: { ids: IDS, face: { type: 'string', optional: true, description: 'Face ID (omit for the whole block).' }, material: { type: 'string', optional: true, description: 'Material name (null clears).' } },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    for (const id of p.ids) {
      const e = needBlock(ps, id);
      const b = structuredClone(e.block);
      if (!p.face) {
        if (p.material && p.material !== BLOCK_MATERIAL) b.material = p.material;
        else delete b.material;
        delete b.faces;
      } else {
        if (!faceIds(b.shape).includes(p.face)) throw new OpError(`set_block_material: ${b.shape} has no face '${p.face}' (${faceIds(b.shape).join(', ')})`);
        const f = { ...(b.faces ?? {}) };
        if (p.material && p.material !== (b.material ?? BLOCK_MATERIAL)) f[p.face] = p.material;
        else delete f[p.face];
        if (Object.keys(f).length) b.faces = f;
        else delete b.faces;
      }
      ps.set({ ...e, block: b });
    }
    return { patches: ps.patches(), label: `Material ${p.face ?? 'block'} → ${p.material ?? 'default'}` };
  },
});

op<{ id: string; face: string; distance?: number; size?: number }>({
  name: 'resize_block',
  description: 'Pushes / pulls one face of a block along its normal (the opposite face stays): distance in metres (+ outward), or the new size along that axis. Faces: px nx (width), py ny (height), pz nz (depth).',
  params: { id: { type: 'string', description: 'Block ID.' }, face: { type: 'string', enum: ['px', 'nx', 'py', 'ny', 'pz', 'nz'], description: 'Face to move.' }, distance: { type: 'number', optional: true, description: 'Metres outward (negative = inward).' }, size: { type: 'number', optional: true, description: 'New size along the face axis (instead of distance).' } },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    const e = needBlock(ps, p.id);
    assertUnlocked(ctx, p.id);
    const f = blockFrame(e);
    const axis = { px: 0, nx: 0, py: 1, ny: 1, pz: 2, nz: 2 }[p.face]!;
    const d = p.size !== undefined ? p.size - f.size[axis] : p.distance;
    if (d === undefined) throw new OpError('resize_block: distance or size required');
    const r = resizeFace(e, p.face, d);
    ps.set(withSize(e, r.size, r.transform));
    return { patches: ps.patches(), label: 'Resize block' };
  },
});

const OPENING_PRESETS: Record<string, { size: [number, number]; bottom: number }> = {
  door: { size: [0.9, 2.1], bottom: 0 },
  double_door: { size: [1.6, 2.1], bottom: 0 },
  window: { size: [1.2, 1.2], bottom: 0.9 },
  wide_window: { size: [2.4, 1.2], bottom: 0.9 },
  passage: { size: [1.8, 2.5], bottom: 0 },
};

op<{ id: string; face: string; preset?: string; size?: [number, number]; along?: number; bottom?: number; point?: number[]; offset?: [number, number] }, { pieces: string[]; cut: string[]; skipped: string[] }>({
  name: 'cut_opening',
  description: "Cuts a door / window opening through a box block (and any neighbouring blocks it overlaps, e.g. a wall already split by another opening). face: the face it is cut from (pz / nz / px / nx for walls, py / ny for floor and ceiling holes). preset: door (0.9 x 2.1), double_door, window (1.2 x 1.2, sill 0.9), wide_window, passage; or size [width, height]. Placement is relative to the whole wall (the block plus the coplanar pieces earlier openings left): along (m from the wall's centre, + to the right seen from outside, default 0) and bottom (m above the wall's base, e.g. the floor); or point (a world point on the face). Floors: offset [x, z] from the centre, or point. The block is replaced by pieces around the hole (the largest keeps its ID). Returns { pieces, cut, skipped }.",
  params: {
    id: { type: 'string', description: 'Block (box) to cut.' },
    face: { type: 'string', enum: ['px', 'nx', 'py', 'ny', 'pz', 'nz'], description: 'Face the opening is on.' },
    preset: { type: 'string', optional: true, enum: Object.keys(OPENING_PRESETS), description: 'Standard opening size.' },
    size: { type: 'any', optional: true, description: '[width, height] metres (floors: [x, z]).' },
    along: { type: 'number', optional: true, description: 'Walls: horizontal offset from the wall centre (m, + right seen from outside).' },
    bottom: { type: 'number', optional: true, description: 'Walls: height of the opening\'s bottom above the wall base (m).' },
    point: { type: 'any', optional: true, description: 'World point on the face: walls centre the opening horizontally on it (bottom still from preset / bottom), floors centre it.' },
    offset: { type: 'any', optional: true, description: 'Floors: [x, z] from the face centre in the block frame.' },
  },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    const e = needBlock(ps, p.id);
    assertUnlocked(ctx, p.id);
    if (e.block.shape !== 'box') throw new OpError('cut_opening: only box blocks can be cut');
    const pre = p.preset ? OPENING_PRESETS[p.preset] : undefined;
    const size = (p.size ?? pre?.size ?? [0.9, 2.1]) as [number, number];
    if (!Array.isArray(size) || size.length !== 2 || size.some((v) => !(v > 0))) throw new OpError('cut_opening: size must be [width, height] > 0');
    const wall = p.face !== 'py' && p.face !== 'ny';
    const others = ctx.scene.entities.filter((x): x is BlockObject => x.type === 'block' && x.id !== p.id && x.block.shape === 'box' && ctx.scene.effectiveVisible(x.id));
    const wf = wallFrame(e, p.face, others);
    const fc = p.point ? wallCoords(wf, p.point as V3) : null;
    const off = clampOpening(wf, size, wall ? [p.along ?? fc?.[0] ?? 0, p.bottom ?? pre?.bottom ?? 0] : ((p.offset ?? fc ?? [0, 0]) as [number, number]));
    const [cmin, cmax] = openingBox(wf, size, off);
    const c = { min: cmin, max: cmax, axis: wf.axis, M: wf.M };
    // Through the wall stack: thin aligned blocks right behind (back-to-back walls,
    // a ceiling under a floor) that the opening also covers are cut as well.
    const inv = wf.inv, k = c.axis, o = [0, 1, 2].filter((a) => a !== k);
    const boxes = others.map((x) => aabbIn(x, inv)).filter((b): b is [V3, V3] => !!b);
    for (let grew = true; grew;) {
      grew = false;
      for (const [mn, mx] of boxes) {
        if (mx[k] - mn[k] > 0.6 || o.some((a) => Math.min(mx[a], c.max[a]) - Math.max(mn[a], c.min[a]) < 1e-3)) continue;
        if (mn[k] < c.min[k] - 1e-4 && mx[k] >= c.min[k] - 0.02) { c.min[k] = mn[k] - 2e-4; grew = true; }
        if (mx[k] > c.max[k] + 1e-4 && mn[k] <= c.max[k] + 0.02) { c.max[k] = mx[k] + 2e-4; grew = true; }
      }
    }
    const r = cutAll(ctx, ps, boxCorners(c.min, c.max, c.M), null, new Set());
    if (!r.cut.some((id) => wf.ids.includes(id))) throw new OpError(`cut_opening: the opening does not cut the wall of '${p.id}'${r.skipped.length ? ` (${r.skipped.join(', ')})` : ''}`);
    return { patches: ps.patches(), result: r, label: `Cut ${p.preset?.replace('_', ' ') ?? 'opening'}` };
  },
});

op<{ cutter: string; ids?: string[]; keepCutter?: boolean }, { pieces: string[]; cut: string[]; skipped: string[] }>({
  name: 'carve_blocks',
  description: 'Carves the volume of a cutter block out of every box block it overlaps (or only ids): corridors through several walls, notches, holes. The cutter is deleted unless keepCutter. Blocks rotated relative to the cutter (not by multiples of 90°) are skipped. Returns { pieces, cut, skipped }.',
  params: { cutter: { type: 'string', description: 'Block whose box is carved out.' }, ids: { type: 'string[]', optional: true, description: 'Only these blocks (default: all overlapping).' }, keepCutter: { type: 'boolean', optional: true, description: 'Keep the cutter block.' } },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    const c = needBlock(ps, p.cutter);
    const r = cutAll(ctx, ps, blockCorners(c), p.ids ?? null, new Set([p.cutter, ...ctx.scene.descendants(p.cutter)]));
    if (!r.cut.length) throw new OpError(`carve_blocks: '${p.cutter}' overlaps no box block${r.skipped.length ? ` (${r.skipped.join(', ')})` : ''}`);
    if (!p.keepCutter) ps.remove(p.cutter);
    return { patches: ps.patches(), result: r, label: `Carve ${count(r.cut.length)}` };
  },
});

/** Hollows a block into floor, ceiling and walls in a new group (shared by hollow_block and create_room). */
function hollow(ctx: OpContext, ps: PatchSet, e: BlockObject, thickness: number, open: string[], name: string, materials?: { floor?: string; walls?: string; ceiling?: string }) {
  const f = blockFrame(e);
  const t = Math.max(0.02, thickness);
  if (f.size.some((s, k) => s <= 2 * t + (k === 1 ? 0 : 0.05))) throw new OpError(`hollow: ${f.size.map((v) => v.toFixed(2)).join(' x ')} m is too small for ${t} m walls`);
  const min: V3 = [-f.size[0] / 2 + t, t, -f.size[2] / 2 + t], max: V3 = [f.size[0] / 2 - t, f.size[1] - t, f.size[2] / 2 - t];
  const out = 0.5;
  for (const o of open) {
    const k = { px: 0, nx: 0, py: 1, ny: 1, pz: 2, nz: 2 }[o];
    if (k === undefined) throw new OpError(`hollow: unknown face '${o}'`);
    if (o[0] === 'p') max[k] += t + out;
    else min[k] -= t + out;
  }
  const corners: V3[] = [];
  for (let i = 0; i < 8; i++) {
    const q: V3 = [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
    const w = mat4.multiply(f.M, mat4.translation(q));
    corners.push([w[12], w[13], w[14]]);
  }
  const pieces = subtractBox(withSize(e, f.size, f.transform), corners);
  if (!Array.isArray(pieces)) throw new OpError('hollow: nothing left to hollow');
  const gid = ctx.scene.newId(name.toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'room');
  ps.set({ id: gid, name, type: 'group', semantic: 'blockout', ...(e.parent ? { parent: e.parent } : {}) });
  const src = { ...e, parent: gid } as BlockObject;
  const ids = replaceWithPieces(ctx, ps, src, pieces, (pc) => SIDE_NAMES[pc.side], gid);
  if (materials) {
    for (const id of ids) {
      const b = ps.get(id) as BlockObject;
      const m = b.name === 'Floor' ? materials.floor : b.name === 'Ceiling' ? materials.ceiling : materials.walls;
      if (m) ps.set({ ...b, block: { ...b.block, material: m, faces: undefined } });
    }
  }
  ps.remove(e.id);
  return { group: gid, pieces: ids };
}

op<{ id: string; thickness?: number; open?: string[]; name?: string }, { group: string; pieces: string[] }>({
  name: 'hollow_block',
  description: 'Hollows a box block into a room: floor, ceiling and four walls of the given thickness (default 0.2 m), grouped. open: faces to leave out (e.g. ["py"] for no ceiling). The pieces keep the block\'s outer size and materials. Returns { group, pieces }.',
  params: { id: { type: 'string', description: 'Box block.' }, thickness: { type: 'number', optional: true, description: 'Wall / floor thickness (m, default 0.2).' }, open: { type: 'string[]', optional: true, description: 'Faces to leave open (py nz ...).' }, name: { type: 'string', optional: true, description: 'Group name (default: the block name).' } },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    const e = needBlock(ps, p.id);
    assertUnlocked(ctx, p.id);
    if (e.block.shape !== 'box') throw new OpError('hollow_block: only box blocks can be hollowed');
    const r = hollow(ctx, ps, e, p.thickness ?? 0.2, p.open ?? [], p.name ?? (e.name && e.name !== 'Block' ? e.name : 'Room'));
    return { patches: ps.patches(), result: r, label: 'Hollow block' };
  },
});

op<{ position: number[]; size: V3; yaw?: number; thickness?: number; ceiling?: boolean; open?: string[]; name?: string; parent?: string; materials?: { floor?: string; walls?: string; ceiling?: string } }, { group: string; pieces: string[] }>({
  name: 'create_room',
  description: 'Creates a blockout room: floor, walls and (unless ceiling: false) ceiling as blocks in a group. position: floor centre at the bottom (world; [x, z] on the ground). size: outer [width x, height y, depth z]. thickness: walls (default 0.2 m). open: walls to leave out (px nx pz nz). materials: { floor, walls, ceiling }. Doors / windows: cut_opening on the wall pieces afterwards. Returns { group, pieces }.',
  params: {
    position: { type: 'any', description: 'Bottom centre (world): [x, y, z] or [x, z].' },
    size: { type: 'vec3', description: 'Outer size [x, y, z] metres (height includes floor and ceiling).' },
    yaw: { type: 'number', optional: true, description: 'Degrees about +Y.' },
    thickness: { type: 'number', optional: true, description: 'Wall thickness (m).' },
    ceiling: { type: 'boolean', optional: true, description: 'Include a ceiling (default true).' },
    open: { type: 'string[]', optional: true, description: 'Walls to leave out.' },
    name: { type: 'string', optional: true, description: 'Group name.' },
    parent: { type: 'string', optional: true, description: 'Outliner parent.' },
    materials: { type: 'object', optional: true, description: '{ floor, walls, ceiling } material names.' },
  },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    if (p.parent && !ctx.scene.has(p.parent)) throw new OpError(`no parent '${p.parent}'`);
    const t: Transform = { position: resolvePoint(ctx, p.position, false, 'create_room').map(round3) as V3 };
    if (p.yaw) t.rotation = axisAngleQuat([0, 1, 0], p.yaw);
    const tmp: BlockObject = { id: ctx.scene.newId('room_block'), type: 'block', ...(p.parent ? { parent: p.parent } : {}), transform: t, block: { shape: 'box', size: p.size }, static: true, semantic: 'blockout' };
    const open = [...(p.open ?? []), ...(p.ceiling === false ? ['py'] : [])];
    const r = hollow(ctx, ps, tmp, p.thickness ?? 0.2, open, p.name ?? 'Room', p.materials);
    return { patches: ps.patches(), result: r, label: `Create ${p.name ?? 'room'}` };
  },
});

op<{ id: string; height?: number; rise?: number }>({
  name: 'fit_stairs',
  description: 'Stairs: sets the step count from the height for a comfortable rise (default 0.17 m), optionally changing the height first.',
  params: { id: { type: 'string', description: 'Stairs block.' }, height: { type: 'number', optional: true, description: 'New height (m).' }, rise: { type: 'number', optional: true, description: 'Target riser height (m).' } },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    const e = needBlock(ps, p.id);
    const f = blockFrame(e);
    const size = [...f.size] as V3;
    if (p.height) size[1] = p.height;
    const steps = Math.max(1, Math.round(size[1] / (p.rise ?? STAIR_RISE)));
    ps.set(withSize({ ...e, block: { ...e.block, shape: 'stairs', steps } }, size, f.transform));
    return { patches: ps.patches(), label: 'Fit stairs' };
  },
});

// ------------------------------------------------------------------ prefabs

const PREFAB_NAME = /^[\w-]+$/;

op<{ prefab: string; position: number[]; onGround?: boolean; yaw?: number; rotation?: [number, number, number, number]; scale?: number | V3; parent?: string; name?: string }, { id: string }>({
  name: 'place_prefab',
  description: 'Places an instance of a prefab (public/prefabs/<name>.json, see list_prefabs) at a world position: its pivot lands there ([x, z] or onGround: on the ground). Editing the prefab later updates every instance. Returns { id }.',
  params: {
    prefab: { type: 'string', description: 'Prefab name.' },
    position: { type: 'any', description: 'Pivot position (world): [x, y, z], or [x, z] on the ground.' },
    onGround: { type: 'boolean', optional: true, description: 'Ground height under [x, z] even if y is given.' },
    yaw: { type: 'number', optional: true, description: 'Degrees about +Y.' },
    rotation: { type: 'quat', optional: true, description: 'Quaternion (instead of yaw).' },
    scale: { type: 'any', optional: true, description: 'Uniform or [x, y, z].' },
    parent: { type: 'string', optional: true, description: 'Outliner parent.' },
    name: { type: 'string', optional: true, description: 'Display name (default: the prefab\'s).' },
  },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    if (!PREFAB_NAME.test(p.prefab)) throw new OpError(`place_prefab: bad prefab name '${p.prefab}'`);
    if (p.parent && !ctx.scene.has(p.parent)) throw new OpError(`no parent '${p.parent}'`);
    const pd = ctx.prefab?.(p.prefab);
    const id = ctx.scene.newId(p.prefab);
    const t: Transform = { position: resolvePoint(ctx, p.position, p.onGround, 'place_prefab').map(round3) as V3 };
    const rot = p.rotation ?? (p.yaw ? axisAngleQuat([0, 1, 0], p.yaw) : undefined);
    if (rot) t.rotation = rot;
    if (p.scale !== undefined) t.scale = typeof p.scale === 'number' ? [p.scale, p.scale, p.scale] : p.scale;
    ps.set({ id, name: p.name ?? pd?.name ?? p.prefab, type: 'prefab', semantic: 'prefab', ...(p.parent ? { parent: p.parent } : {}), prefab: p.prefab, transform: t });
    return { patches: ps.patches(), result: { id }, label: `Place ${pd?.name ?? p.prefab}` };
  },
});

op<{ ids: string[]; prefab: string; position: V3; rotation?: [number, number, number, number]; name?: string }, { id: string }>({
  name: 'replace_with_prefab',
  description: 'Replaces entities (with their descendants) by one instance of a prefab whose pivot is at position (used after saving them as that prefab). Returns { id }.',
  params: { ids: IDS, prefab: { type: 'string', description: 'Prefab name.' }, position: { type: 'vec3', description: 'Instance pivot (world).' }, rotation: { type: 'quat', optional: true, description: 'Instance rotation.' }, name: { type: 'string', optional: true, description: 'Instance name.' } },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    if (!PREFAB_NAME.test(p.prefab)) throw new OpError(`replace_with_prefab: bad prefab name '${p.prefab}'`);
    const rs = roots(ps, p.ids);
    if (!rs.length) throw new OpError('replace_with_prefab: nothing to replace');
    const parent = ctx.scene.get(rs[0])?.parent;
    for (const id of rs) {
      assertUnlocked(ctx, id);
      for (const d of [id, ...ctx.scene.descendants(id)].reverse()) ps.remove(d);
    }
    const id = ctx.scene.newId(p.prefab);
    const t: Transform = { position: p.position.map(round3) as V3 };
    if (p.rotation) t.rotation = p.rotation;
    ps.set({ id, name: p.name ?? p.prefab, type: 'prefab', semantic: 'prefab', ...(parent && !rs.includes(parent) ? { parent } : {}), prefab: p.prefab, transform: t });
    return { patches: ps.patches(), result: { id }, label: `Make prefab ${p.prefab}` };
  },
});

op<{ id: string; name?: string }, { group: string; ids: string[]; map: Record<string, string> }>({
  name: 'unpack_prefab',
  description: 'Replaces a prefab instance by ordinary copies of its entities (in a group named after it); they no longer follow the prefab. Nested prefab instances stay instances. Returns { group, ids, map } (prefab entity ID -> new ID).',
  params: { id: { type: 'string', description: 'Prefab instance.' }, name: { type: 'string', optional: true, description: 'Group name.' } },
  run(ctx, p) {
    const ps = new PatchSet(ctx.scene);
    const inst = need(ps, p.id);
    if (inst.type !== 'prefab') throw new OpError(`'${p.id}' is not a prefab instance`);
    assertUnlocked(ctx, p.id);
    const pd = ctx.prefab?.(inst.prefab);
    if (!pd) throw new OpError(`unpack_prefab: prefab '${inst.prefab}' is not loaded`);
    const gid = ctx.scene.newId(`${inst.prefab}_group`);
    ps.set({ id: gid, name: p.name ?? inst.name ?? pd.name ?? inst.prefab, type: 'group', ...(inst.parent ? { parent: inst.parent } : {}), ...(inst.semantic && inst.semantic !== 'prefab' ? { semantic: inst.semantic } : {}) });
    const map: Record<string, string> = {};
    for (const c of pd.entities) map[c.id] = ctx.scene.newId(c.id);
    const placed = fromPrefabSpace(pd.entities, inst.transform);
    const ids: string[] = [];
    placed.forEach((c, i) => {
      const src = pd.entities[i];
      const e = { ...c, id: map[src.id], parent: src.parent ? map[src.parent] ?? gid : gid } as Entity;
      if (inst.visible === false && !src.parent) e.visible = false;
      const err = validateEntity(e);
      if (err) throw new OpError(`unpack_prefab: ${src.id}: ${err}`);
      ps.set(e);
      ids.push(e.id);
    });
    ps.remove(p.id);
    return { patches: ps.patches(), result: { group: gid, ids, map }, label: `Unpack ${inst.name ?? inst.prefab}` };
  },
});

// ------------------------------------------------------------------ history

/** An AI changeset: a transaction made by an agent, reviewed in the editor (Accept / Revert). */
export interface ChangesetMeta {
  title: string;
  prompt?: string;
  /** Agent's own summary at commit. */
  summary?: string;
  status: 'open' | 'pending' | 'accepted' | 'reverted';
  author: string;
  started: number;
}

export interface HistoryEntry {
  label: string;
  /** Set for AI changesets. */
  changeset?: ChangesetMeta;
  /** The operations (name + params) that produced the patches, in order. */
  ops: { op: string; params: unknown }[];
  patches: Patch[];
  time: number;
  /** Open gesture key: following executions with the same key merge into this entry. */
  mergeKey?: string;
}

function mergeInto(a: HistoryEntry, b: HistoryEntry) {
  for (const p of b.patches) {
    const q = p.kind === 'entity' ? a.patches.find((x) => x.kind === 'entity' && x.id === p.id) : a.patches.find((x) => x.kind === 'doc' && x.key === p.key);
    if (q) q.after = p.after;
    else a.patches.push(p);
  }
  a.ops.push(...b.ops);
}

/**
 * Undo / redo over operation patches. `exec` runs an operation; a `merge` key
 * folds consecutive executions (a gizmo drag, a slider) into one entry until
 * `seal()`. Transactions group several operations into one entry - the unit an
 * AI changeset will later be accepted or reverted as.
 */
export class EditorHistory {
  undoStack: HistoryEntry[] = [];
  redoStack: HistoryEntry[] = [];
  private tx: HistoryEntry | null = null;
  private saved: HistoryEntry | null | undefined = null;
  private listeners = new Set<() => void>();
  /** Every executed operation (console / AI transcript). */
  readonly log: { op: string; params: unknown; label: string; time: number; error?: string }[] = [];
  limit = 400;

  /**
   * Checked before an operation's patches are applied: return an error to refuse
   * (agent scope rules). Null = allowed. Set by the AI layer for agent calls.
   */
  guard: ((op: string, patches: Patch[]) => string | null) | null = null;

  constructor(readonly ctx: OpContext) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }

  exec<R = unknown>(name: string, params: unknown, opts: { merge?: string; label?: string } = {}): R {
    const def = OPS.get(name);
    if (!def) throw new OpError(`unknown operation '${name}'`);
    const log = { op: name, params, label: name, time: Date.now() } as (typeof this.log)[number];
    try {
      validate(def, params as Record<string, unknown>);
      const r = def.run(this.ctx, params);
      const refused = this.guard?.(name, r.patches);
      if (refused) throw new OpError(refused);
      log.label = opts.label ?? r.label ?? name;
      this.log.push(log);
      if (this.log.length > 2000) this.log.splice(0, this.log.length - 2000);
      if (r.patches.length) {
        this.ctx.scene.apply(r.patches, 'do');
        this.record({ label: log.label, ops: [{ op: name, params }], patches: r.patches, time: log.time }, opts.merge);
      }
      return r.result as R;
    } catch (e) {
      log.error = (e as Error).message;
      this.log.push(log);
      this.changed();
      throw e;
    }
  }

  private record(entry: HistoryEntry, merge?: string) {
    if (this.tx) {
      this.tx.patches.push(...entry.patches);
      this.tx.ops.push(...entry.ops);
      this.changed();
      return;
    }
    const top = this.undoStack[this.undoStack.length - 1];
    if (merge && top && top.mergeKey === merge) {
      if (this.saved === top) this.saved = undefined;
      mergeInto(top, entry);
    } else {
      if (top) top.mergeKey = undefined;
      entry.mergeKey = merge;
      this.undoStack.push(entry);
      if (this.undoStack.length > this.limit) this.undoStack.shift();
    }
    this.redoStack.length = 0;
    this.changed();
  }

  /** Ends the current gesture: the next execution starts a new entry. */
  seal() {
    const top = this.undoStack[this.undoStack.length - 1];
    if (top) top.mergeKey = undefined;
  }

  get canUndo() {
    return !this.tx && this.undoStack.length > 0;
  }

  get canRedo() {
    return !this.tx && this.redoStack.length > 0;
  }

  undo(): HistoryEntry | null {
    if (this.tx) throw new OpError('cannot undo inside a transaction');
    const e = this.undoStack.pop();
    if (!e) return null;
    e.mergeKey = undefined;
    this.ctx.scene.apply(e.patches, 'undo');
    this.redoStack.push(e);
    this.changed();
    return e;
  }

  redo(): HistoryEntry | null {
    if (this.tx) throw new OpError('cannot redo inside a transaction');
    const e = this.redoStack.pop();
    if (!e) return null;
    this.ctx.scene.apply(e.patches, 'redo');
    this.undoStack.push(e);
    this.changed();
    return e;
  }

  /** Starts grouping operations into one undo entry (optionally an AI changeset). */
  begin(label: string, changeset?: ChangesetMeta) {
    if (this.tx) throw new OpError(`transaction '${this.tx.label}' already open`);
    this.seal();
    this.tx = { label, ops: [], patches: [], time: Date.now(), ...(changeset ? { changeset } : {}) };
    this.changed();
  }

  /** Applies an entry's inverse as a new entry (reverting something that is not on top of the stack). */
  revertEntry(e: HistoryEntry, label: string) {
    if (this.tx) throw new OpError('cannot revert inside a transaction');
    const inverse: Patch[] = [...e.patches].reverse().map((p) => {
      if (p.kind === 'doc') return { ...p, before: p.after, after: p.before };
      // Revert to the entry's before state from whatever is there now.
      return { kind: 'entity', id: p.id, before: this.ctx.scene.get(p.id) ?? null, after: p.before, index: p.index };
    });
    const live = inverse.filter((p) => p.kind === 'doc' || p.before !== p.after);
    if (!live.length) return;
    this.ctx.scene.apply(live, 'do');
    this.undoStack.push({ label, ops: [{ op: 'revert', params: { entry: e.label } }], patches: live, time: Date.now() });
    this.redoStack.length = 0;
    this.changed();
  }

  /** Closes the transaction as one undo entry (nothing recorded if it changed nothing). */
  commit(): HistoryEntry | null {
    const t = this.tx;
    if (!t) throw new OpError('no open transaction');
    this.tx = null;
    if (t.patches.length) {
      this.undoStack.push(t);
      this.redoStack.length = 0;
    }
    this.changed();
    return t.patches.length ? t : null;
  }

  /** Reverts everything done since `begin`. */
  rollback() {
    const t = this.tx;
    if (!t) throw new OpError('no open transaction');
    this.tx = null;
    if (t.patches.length) this.ctx.scene.apply(t.patches, 'undo');
    this.changed();
  }

  get transaction(): HistoryEntry | null {
    return this.tx;
  }

  markSaved() {
    this.forceDirty = false;
    this.saved = this.undoStack[this.undoStack.length - 1] ?? null;
    this.changed();
  }

  /** Set when the document differs from disk without an undo entry (a restored backup). */
  forceDirty = false;

  /** Unsaved changes since `markSaved` (undoing back to the saved state counts as clean). */
  get dirty() {
    return this.forceDirty || !!this.tx || (this.undoStack[this.undoStack.length - 1] ?? null) !== this.saved;
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.tx = null;
    this.saved = null;
    this.changed();
  }
}
