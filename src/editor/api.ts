import { isSpatial, type Entity } from '../engine/scene/mapformat';
import { getOp, listOps, type ParamSpec } from './commands';
import type { Editor } from './editor';
import type { BlenderBridge } from './bridge';
import { quatToEuler, type V3 } from './xform';

/**
 * Structured editor tools: scene queries, selection, viewport capture,
 * transactions, save / bake, plus every editor operation (commands.ts). This
 * is the surface a future MCP server exposes to an AI agent; the editor UI
 * uses the same operations. `window.rill.editor.tools` in the running editor.
 */

interface ToolDef {
  name: string;
  description: string;
  params: Record<string, ParamSpec>;
  run: (p: any) => unknown;
}

export interface CaptureOptions {
  /** 'editor' (current view, default), 'spawn', a viewpoint marker ID, or an explicit camera. */
  camera?: string | { position: V3; yaw?: number; pitch?: number; fov?: number };
  width?: number;
  height?: number;
  /** Also write screenshots/<save>.png (dev server). */
  save?: string;
  /** Keep the selection outline in the image. */
  overlays?: boolean;
  /** Return the PNG as a data URL (default true). */
  image?: boolean;
}

export class EditorTools {
  private tools = new Map<string, ToolDef>();

  constructor(readonly ed: Editor, readonly bridge: BlenderBridge) {
    const T = (t: ToolDef) => this.tools.set(t.name, t);
    const S = (description: string, type: ParamSpec['type'] = 'string', optional = true): ParamSpec => ({ type, description, optional });

    T({ name: 'get_scene_summary', description: 'Overview: entity counts by type and semantic, top-level groups, bounds, environment, lighting / save state, selection.', params: {}, run: () => this.summary() });
    T({ name: 'get_selection', description: 'Selected entity IDs (last = primary) with brief descriptions.', params: {}, run: () => ({ ids: [...ed.selection], entities: ed.selection.map((id) => this.brief(ed.scene.get(id)!)) }) });
    T({ name: 'set_selection', description: 'Selects entities (UI state, not an undoable edit).', params: { ids: S('Entity IDs.', 'string[]', false) }, run: (p) => { ed.setSelection(p.ids); return { ids: ed.selection }; } });
    T({ name: 'get_entity', description: 'Full entity document plus derived data: world bounds, pivot, Euler rotation, children, material slots, lightmap state.', params: { id: S('Entity ID.', 'string', false) }, run: (p) => this.entity(p.id) });
    T({
      name: 'query_entities', description: 'Finds entities by type, semantic, tag, text (name / id), parent subtree, a world box or a radius. Returns brief records.',
      params: {
        type: S('Entity type (mesh, light, decal, sign, marker, group, ...).'), semantic: S('Semantic class.'), tag: S('Tag.'), text: S('Substring of name or id.'),
        parent: S('Only descendants of this entity.'), within: S('{ min: [x,y,z], max: [x,y,z] } world box.', 'object'), near: S('{ point: [x,y,z], radius: m }.', 'object'),
        limit: S('Maximum results (default 200).', 'number'),
      },
      run: (p) => this.query(p),
    });
    T({ name: 'search_assets', description: 'Searches the asset registry (all words must match id / name / category / tags).', params: { query: S('Search words.', 'string', false), category: S('Category.'), includeUnique: S('Include map-specific pieces.', 'boolean'), limit: S('Max results.', 'number') }, run: (p) => ed.assets.search(p.query, { category: p.category, includeUnique: p.includeUnique, limit: p.limit ?? 50 }).map((a) => ({ id: a.id, name: a.name, category: a.category, semantic: a.semantic, tags: a.tags, bounds: a.bounds, prefabChildren: a.children?.length ?? 0 })) });
    T({ name: 'list_materials', description: 'Material library (optionally filtered by a substring).', params: { query: S('Substring.') }, run: (p) => ed.materials.filter((m) => !p.query || m.name.includes(p.query)).map((m) => ({ name: m.name, inherits: m.inherits, shader: m.shader, alphaMode: m.alphaMode, decal: m.decal })) });
    T({ name: 'capture_view', description: "Renders the scene and returns a PNG (data URL) with the camera used. camera: 'editor' | 'spawn' | viewpoint id | { position, yaw, pitch, fov }.", params: { camera: S('Camera.', 'any'), width: S('Pixels (default 1600).', 'number'), height: S('Pixels (default 900).', 'number'), save: S('Also save screenshots/<save>.png.'), overlays: S('Keep selection outline.', 'boolean'), image: S('Return the data URL (default true).', 'boolean') }, run: (p) => this.captureView(p) });
    T({ name: 'get_camera', description: 'Editor camera: position, yaw / pitch (degrees, yaw 0 = north / -Z, positive = clockwise), fov.', params: {}, run: () => this.camera() });
    T({ name: 'set_camera', description: 'Moves the editor camera.', params: { position: S('[x, y, z].', 'vec3', false), yaw: S('Degrees.', 'number'), pitch: S('Degrees.', 'number') }, run: (p) => { const c = ed.rt.camera; c.position[0] = p.position[0]; c.position[1] = p.position[1]; c.position[2] = p.position[2]; if (p.yaw !== undefined) c.yaw = (p.yaw * Math.PI) / 180; if (p.pitch !== undefined) c.pitch = (p.pitch * Math.PI) / 180; return this.camera(); } });
    T({ name: 'begin_transaction', description: 'Groups the following operations into one undo entry (an AI changeset).', params: { label: S('Changeset label.', 'string', false) }, run: (p) => { ed.history.begin(p.label); return { open: p.label }; } });
    T({ name: 'commit_transaction', description: 'Closes the open transaction as one undo entry; returns its change count.', params: {}, run: () => { const e = ed.history.commit(); return { label: e?.label, changes: e?.patches.length ?? 0, operations: e?.ops.map((o) => o.op) ?? [] }; } });
    T({ name: 'rollback_transaction', description: 'Reverts everything since begin_transaction.', params: {}, run: () => { ed.history.rollback(); return { rolledBack: true }; } });
    T({ name: 'undo', description: 'Undoes the last edit.', params: {}, run: () => { ed.undo(); return { undo: ed.history.undoStack.length, redo: ed.history.redoStack.length }; } });
    T({ name: 'redo', description: 'Redoes the last undone edit.', params: {}, run: () => { ed.redo(); return { undo: ed.history.undoStack.length, redo: ed.history.redoStack.length }; } });
    T({ name: 'save_map', description: 'Writes the map document to disk.', params: {}, run: async () => ({ saved: await ed.save() }) });
    T({ name: 'reload_map', description: 'Reloads the map from disk (discards unsaved edits and the undo history).', params: {}, run: async () => { await ed.reload(); return { entities: ed.scene.entities.length }; } });
    T({ name: 'bake_lighting', description: 'Saves, then bakes lightmaps + probes with Blender/Cycles in the background (minutes); the result reloads automatically.', params: { samples: S('Cycles samples (default 256).', 'number'), size: S('Atlas page size.', 'number') }, run: async (p) => ({ job: await bridge.bakeLighting(p) }) });
    T({ name: 'get_job', description: 'State of the running / last Blender job.', params: {}, run: () => bridge.job });
    T({ name: 'play', description: "Enters play mode (from: 'camera' or 'spawn').", params: { from: S("'camera' | 'spawn'.") }, run: (p) => { ed.play(p.from === 'spawn' ? 'spawn' : 'camera'); return { mode: ed.mode }; } });
    T({ name: 'stop', description: 'Leaves play mode.', params: {}, run: () => { ed.stop(); return { mode: ed.mode }; } });
    T({ name: 'list_operations', description: 'Editor operations and their parameters.', params: {}, run: () => listOps() });
  }

  list() {
    return [...[...this.tools.values()].map((t) => ({ name: t.name, description: t.description, params: t.params, kind: 'tool' })), ...listOps().map((o) => ({ ...o, kind: 'operation' }))];
  }

  async call(name: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const t = this.tools.get(name);
    if (t) return await t.run(params);
    if (getOp(name)) return this.ed.exec(name, params);
    throw new Error(`unknown tool or operation '${name}' (try: help)`);
  }

  // ------------------------------------------------------------------ implementations

  brief(e: Entity) {
    const out: Record<string, unknown> = { id: e.id, type: e.type };
    if (e.name) out.name = e.name;
    if (e.semantic) out.semantic = e.semantic;
    if (e.parent) out.parent = e.parent;
    if (isSpatial(e)) out.position = e.transform.position;
    if (e.type === 'mesh') out.asset = e.asset;
    if (e.locked) out.locked = true;
    if (e.visible === false) out.visible = false;
    return out;
  }

  entity(id: string) {
    const ed = this.ed;
    const e = ed.scene.get(id);
    if (!e) throw new Error(`no entity '${id}'`);
    const r = ed.renderablesOf(id)[0];
    return {
      entity: structuredClone(e),
      bounds: ed.boundsOf(id),
      pivot: ed.pivotOf(id),
      rotationEuler: isSpatial(e) ? quatToEuler(e.transform.rotation) : undefined,
      children: ed.scene.children(id),
      materialSlots: r ? [...new Set(r.mesh.primitives.map((p) => p.material))] : undefined,
      lightmap: e.type === 'mesh' && e.lightmap ? (ed.rt.world.lightmaps?.doc.objects[id] ? 'baked' : 'not baked') : undefined,
      locked: ed.scene.effectiveLocked(id),
      visible: ed.scene.effectiveVisible(id),
    };
  }

  private summary() {
    const ed = this.ed, sc = ed.scene;
    const byType: Record<string, number> = {}, bySemantic: Record<string, number> = {};
    for (const e of sc.entities) {
      byType[e.type] = (byType[e.type] ?? 0) + 1;
      if (e.semantic) bySemantic[e.semantic] = (bySemantic[e.semantic] ?? 0) + 1;
    }
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const r of ed.rt.world.renderables) {
      if (r.viewmodel || r.id.startsWith('__')) continue;
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], r.worldMin[k]); max[k] = Math.max(max[k], r.worldMax[k]); }
    }
    const w = ed.rt.world;
    return {
      map: ed.mapName, name: sc.doc.name, description: sc.doc.description,
      entities: sc.entities.length, byType, bySemantic,
      groups: sc.children('').map((id) => ({ id, name: sc.get(id)?.name, type: sc.get(id)?.type, descendants: sc.descendants(id).length, locked: sc.get(id)?.locked === true })),
      bounds: { min, max },
      environment: sc.doc.environment,
      lighting: { lightmapped: Object.keys(w.lightmaps?.doc.objects ?? {}).length, stale: w.lightingStale },
      unsaved: ed.history.dirty, undo: ed.history.undoStack.length, selection: [...ed.selection],
      transaction: ed.history.transaction?.label ?? null,
    };
  }

  private query(p: { type?: string; semantic?: string; tag?: string; text?: string; parent?: string; within?: { min: V3; max: V3 }; near?: { point: V3; radius: number }; limit?: number }) {
    const ed = this.ed, sc = ed.scene;
    const sub = p.parent ? new Set(sc.descendants(p.parent)) : null;
    const text = p.text?.toLowerCase();
    const out: unknown[] = [];
    let total = 0;
    for (const e of sc.entities) {
      if (p.type && e.type !== p.type) continue;
      if (p.semantic && e.semantic !== p.semantic) continue;
      if (p.tag && !(e.tags ?? []).includes(p.tag)) continue;
      if (text && !e.id.toLowerCase().includes(text) && !(e.name ?? '').toLowerCase().includes(text)) continue;
      if (sub && !sub.has(e.id)) continue;
      if (p.within || p.near) {
        const pos = ed.pivotOf(e.id);
        if (!pos) continue;
        if (p.within && [0, 1, 2].some((k) => pos[k] < p.within!.min[k] || pos[k] > p.within!.max[k])) continue;
        if (p.near && Math.hypot(pos[0] - p.near.point[0], pos[1] - p.near.point[1], pos[2] - p.near.point[2]) > p.near.radius) continue;
      }
      total++;
      if (out.length < (p.limit ?? 200)) out.push(this.brief(e));
    }
    return { total, entities: out };
  }

  private camera() {
    const c = this.ed.rt.camera;
    return { position: Array.from(c.position).map((v) => Math.round(v * 1000) / 1000), yaw: Math.round(((c.yaw * 180) / Math.PI) * 100) / 100, pitch: Math.round(((c.pitch * 180) / Math.PI) * 100) / 100, fov: Math.round(((c.fovY * 180) / Math.PI) * 10) / 10 };
  }

  /** capture_view: renders an exact-size frame from a camera without editor overlays. */
  async captureView(o: CaptureOptions = {}) {
    const ed = this.ed, rt = ed.rt, cam = rt.camera;
    const saved = { p: [cam.position[0], cam.position[1], cam.position[2]], yaw: cam.yaw, pitch: cam.pitch, fov: cam.fovY };
    try {
      const c = o.camera;
      if (c === 'spawn') {
        const s = rt.world.spawn();
        cam.position[0] = s.position[0]; cam.position[1] = s.position[1] + 1.65; cam.position[2] = s.position[2];
        cam.yaw = (s.yaw * Math.PI) / 180; cam.pitch = (s.pitch * Math.PI) / 180;
      } else if (typeof c === 'string' && c !== 'editor') {
        const m = ed.scene.get(c);
        if (m?.type !== 'marker') throw new Error(`capture_view: '${c}' is not a viewpoint marker`);
        const p = m.transform.position;
        cam.position[0] = p[0]; cam.position[1] = p[1] + 1.65; cam.position[2] = p[2];
        cam.yaw = ((m.yaw ?? 0) * Math.PI) / 180; cam.pitch = ((m.pitch ?? 0) * Math.PI) / 180;
      } else if (c && typeof c === 'object') {
        cam.position[0] = c.position[0]; cam.position[1] = c.position[1]; cam.position[2] = c.position[2];
        if (c.yaw !== undefined) cam.yaw = (c.yaw * Math.PI) / 180;
        if (c.pitch !== undefined) cam.pitch = (c.pitch * Math.PI) / 180;
        if (c.fov !== undefined) cam.fovY = (c.fov * Math.PI) / 180;
      }
      if (!o.overlays) {
        ed.suppressHighlight = true;
        ed.updateHighlight();
      }
      const camera = this.camera();
      const img = await rt.renderImage(o.width ?? 1600, o.height ?? 900);
      const file = o.save ? await rt.saveImage(o.save, img) : undefined;
      let image: string | undefined;
      if (o.image !== false) {
        const cv = new OffscreenCanvas(img.width, img.height);
        cv.getContext('2d')!.putImageData(img, 0, 0);
        const blob = await cv.convertToBlob({ type: 'image/png' });
        image = await new Promise<string>((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result as string); fr.readAsDataURL(blob); });
      }
      return { width: img.width, height: img.height, camera, file, image };
    } finally {
      cam.position[0] = saved.p[0]; cam.position[1] = saved.p[1]; cam.position[2] = saved.p[2];
      cam.yaw = saved.yaw; cam.pitch = saved.pitch; cam.fovY = saved.fov;
      ed.suppressHighlight = false;
      ed.updateHighlight();
    }
  }
}
