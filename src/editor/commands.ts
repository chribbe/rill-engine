import { mat4, quat, vec3, type Mat4 } from 'wgpu-matrix';
import { isSpatial, type Entity, type SpatialEntity, type Transform } from '../engine/scene/mapformat';
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
  /** Runtime results some operations turn into document data (scatter instances to entities). */
  runtime?: {
    scatterInstances(id: string): { key: string; asset: string; position: [number, number, number]; yawDeg: number; scale: number }[];
  };
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

const ENTITY_TYPES = ['mesh', 'instances', 'light', 'decal', 'marker', 'probeVolume', 'reflectionProbe', 'sign', 'group', 'scatter', 'spline'];

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
  spline: ['spline.points', 'spline.closed', 'spline.preset', 'spline.width', 'spline.drape', 'spline.texelDensity', 'castShadow', 'collision', 'lightmap'],
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

op<{ material: string; position: V3; normal?: V3; size?: number | number[]; depth?: number; roll?: number; opacity?: number; parent?: string; name?: string }, { id: string }>({
  name: 'place_decal',
  description: 'Places a projected decal (material: a decal_* material) on the surface at position with outward normal (default up). size: metres (number = square, or [w, h]); depth: projection depth; roll: degrees about the normal. Returns { id }.',
  params: {
    material: { type: 'string', description: 'Decal material (decal_stain, decal_waterstreak, decal_crack, decal_grime_base, decal_oil, decal_manhole, decal_paint_line...).' },
    position: { type: 'vec3', description: 'Surface point (world).' },
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
      transform: { position: p.position.map(round3) as V3, rotation: decalRotation(p.normal ?? [0, 1, 0], p.roll ?? 0) },
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

op<{ asset: string; position: V3; rotation?: [number, number, number, number]; yaw?: number; scale?: number | V3; parent?: string; name?: string }, { id: string; children: string[] }>({
  name: 'place_asset',
  description: 'Places an asset from the registry (id or path) at a world position, with its prefab children (e.g. a streetlight\'s lamp). yaw: degrees about +Y. Returns { id, children }.',
  params: {
    asset: { type: 'string', description: 'Asset ID (registry) or asset path (.glb / .model.json).' },
    position: { type: 'vec3', description: 'World position of the asset origin.' },
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
    const t: Transform = { position: [...p.position] as V3 };
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

// ------------------------------------------------------------------ history

export interface HistoryEntry {
  label: string;
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

  /** Starts grouping operations into one undo entry. */
  begin(label: string) {
    if (this.tx) throw new OpError(`transaction '${this.tx.label}' already open`);
    this.seal();
    this.tx = { label, ops: [], patches: [], time: Date.now() };
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
