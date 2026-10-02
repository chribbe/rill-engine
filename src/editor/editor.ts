import { isSpatial, type Entity, type MapDocument } from '../engine/scene/mapformat';
import type { Renderable } from '../engine/render/renderer';
import type { SceneStore } from '../engine/scene/scene';
import { World } from '../engine/scene/world';
import type { Runtime } from '../app/runtime';
import { EditorHistory, OpError, type OpContext } from './commands';
import type { AssetRegistry } from './assets';
import type { V3 } from './xform';

/**
 * Editor state on top of the runtime: selection, tools, the operation context
 * and history, save / load and play mode. UI panels and the viewport read and
 * change editor state only through this class (and the scene only through
 * `exec`).
 */

export type Tool = 'select' | 'translate' | 'rotate' | 'scale' | 'paint' | 'spline' | 'decal';

export interface MaterialInfo {
  name: string;
  inherits?: string;
  shader?: string;
  alphaMode?: string;
  semantic?: string;
  baseColorFactor?: unknown;
  decal?: boolean;
  notes?: string;
}

export interface LogLine {
  time: number;
  kind: 'op' | 'info' | 'warn' | 'error' | 'job';
  text: string;
}

type EventName = 'selection' | 'history' | 'mode' | 'tool' | 'status' | 'log' | 'scene' | 'environment';

export class Editor {
  readonly scene: SceneStore;
  readonly history: EditorHistory;
  readonly ctx: OpContext;
  selection: string[] = [];
  mode: 'edit' | 'play' = 'edit';
  tool: Tool = 'translate';
  space: 'world' | 'local' = 'world';
  snap = { enabled: true, grid: 0.25, angle: 15, scale: 0.1 };
  /** Which entity kinds the viewport can pick. */
  pick = { meshes: true, lights: true, markers: true, signs: true, decals: false, probes: true };
  /** Helpers drawn in the viewport. */
  show = { lights: true, markers: true, decals: false, probes: true, grid: false };
  materials: MaterialInfo[] = [];
  readonly logLines: LogLine[] = [];
  /** Asset chosen in the browser, placed on the next viewport click. */
  placing: string | null = null;
  /** Scatter paint brush (tool 'paint'): preset for new scatters, radius (m), erase mode. */
  brush = { preset: 'stockholm_mixed_forest', radius: 6, erase: false };
  /** Instance of the selected scatter that was clicked (cell key), for remove / detach. */
  subSelection: string | null = null;
  scatterPresets: { name: string; title: string; description?: string; density: number; species: number }[] = [];
  splinePresets: { name: string; title: string; description?: string }[] = [];
  /** Decal tool: material, size (m), random roll / size jitter, spacing when dragging (m). */
  decalTool = { material: 'decal_stain', size: 1.5, jitter: 0.3, randomRoll: true, spacing: 1.2 };
  /** Spline tool: preset for new splines; the spline being drawn (clicks append points). */
  splineTool: { preset: string; drawing: string | null; pending: V3 | null; key: string } = { preset: 'path_asphalt', drawing: null, pending: null, key: '' };
  private handlers = new Map<EventName, Set<() => void>>();
  private editorCamera: { position: V3; yaw: number; pitch: number } | null = null;

  constructor(readonly rt: Runtime, readonly assets: AssetRegistry) {
    this.scene = rt.world.scene;
    this.ctx = { scene: this.scene, assets, pivot: (id) => this.pivotOf(id), runtime: { scatterInstances: (id) => rt.world.scatterInstances(id) } };
    this.history = new EditorHistory(this.ctx);
    this.history.onChange(() => this.emit('history'));
    this.scene.subscribe((c) => {
      // Drop selected IDs that no longer exist (deleted, undone creation).
      if (this.selection.some((id) => !this.scene.has(id))) this.setSelection(this.selection.filter((id) => this.scene.has(id)));
      this.emit('scene');
      if (c.source === 'load' || c.patches.some((p) => p.kind === 'doc')) this.emit('environment');
    });
    rt.onEnvironment = () => this.emit('environment');
    this.loadMaterials();
  }

  on(ev: EventName, fn: () => void): () => void {
    let s = this.handlers.get(ev);
    if (!s) this.handlers.set(ev, (s = new Set()));
    s.add(fn);
    return () => s!.delete(fn);
  }

  emit(ev: EventName) {
    for (const fn of this.handlers.get(ev) ?? []) fn();
  }

  log(kind: LogLine['kind'], text: string) {
    this.logLines.push({ time: Date.now(), kind, text });
    if (this.logLines.length > 3000) this.logLines.splice(0, 1000);
    this.emit('log');
  }

  // ------------------------------------------------------------------ operations

  /** Runs an editor operation (the single entry point for scene edits). Errors are logged and rethrown. */
  exec<R = unknown>(op: string, params: unknown, opts: { merge?: string; label?: string; quiet?: boolean } = {}): R {
    try {
      const r = this.history.exec<R>(op, params, opts);
      if (!opts.quiet && !opts.merge) this.log('op', `${op} ${JSON.stringify(params)}`);
      return r;
    } catch (e) {
      this.log('error', `${op}: ${(e as Error).message}`);
      throw e;
    }
  }

  /** exec() for UI handlers: failures are logged, not thrown. */
  tryExec<R = unknown>(op: string, params: unknown, opts: { merge?: string; label?: string } = {}): R | undefined {
    try {
      return this.exec<R>(op, params, opts);
    } catch (e) {
      if (!(e instanceof OpError)) console.error(e);
      return undefined;
    }
  }

  undo() {
    const e = this.history.undo();
    if (e) this.log('info', `Undo: ${e.label}`);
  }

  redo() {
    const e = this.history.redo();
    if (e) this.log('info', `Redo: ${e.label}`);
  }

  // ------------------------------------------------------------------ selection

  get primary(): Entity | undefined {
    const id = this.selection[this.selection.length - 1];
    return id ? this.scene.get(id) : undefined;
  }

  setSelection(ids: string[], sub: string | null = null) {
    const next = ids.filter((id, i) => this.scene.has(id) && ids.indexOf(id) === i);
    const same = next.length === this.selection.length && next.every((id, i) => id === this.selection[i]);
    if (same && sub === this.subSelection) return;
    this.subSelection = sub;
    if (same) { this.emit('selection'); return; }
    this.selection = next;
    this.updateHighlight();
    this.emit('selection');
  }

  select(id: string | null, how: 'set' | 'add' | 'toggle' = 'set', sub: string | null = null) {
    if (!id) {
      if (how === 'set') this.setSelection([]);
      return;
    }
    if (how === 'set') this.setSelection([id], sub);
    else if (how === 'add') this.setSelection([...this.selection.filter((s) => s !== id), id]);
    else this.setSelection(this.selection.includes(id) ? this.selection.filter((s) => s !== id) : [...this.selection, id]);
  }

  /** Selection with group / ancestor duplicates removed (the entities edits apply to). */
  get selectionRoots(): string[] {
    const set = new Set(this.selection);
    return this.selection.filter((id) => !this.scene.ancestors(id).some((a) => set.has(a)));
  }

  /** Set while capture_view renders: no selection outline in the image. */
  suppressHighlight = false;

  /** Renderables of entities (and their descendants) for the selection outline. */
  updateHighlight() {
    if (this.suppressHighlight) {
      this.rt.renderer.highlight = [];
      return;
    }
    const out: Renderable[] = [];
    const seen = new Set<string>();
    const add = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const rt = this.rt.world.objects.get(id);
      if (rt) out.push(...rt.renderables);
    };
    for (const id of this.selection) {
      if (this.scene.get(id)?.type === 'scatter') {
        // A forest outline would be millions of edges: outline only the clicked instance.
        const k = this.subSelection;
        const r = k ? this.renderablesOf(id).find((x) => x.id === `${id}#${k}`) : undefined;
        if (r) out.push(r);
        seen.add(id);
        continue;
      }
      add(id);
      // Groups outline their members; meshes only themselves (children are lights, decals...).
      if (this.scene.get(id)?.type === 'group') for (const d of this.scene.descendants(id)) add(d);
    }
    // Huge selections (a whole terrain group) would draw millions of edges: cap the outline.
    let tris = 0;
    this.rt.renderer.highlight = this.mode === 'edit' ? out.filter((r) => (tris += r.mesh.triangles) < 400000) : [];
  }

  // ------------------------------------------------------------------ geometry queries

  renderablesOf(id: string): Renderable[] {
    return this.rt.world.objects.get(id)?.renderables ?? [];
  }

  /** World AABB of an entity (meshes: render bounds; helpers: their extent). Groups: union of descendants. */
  boundsOf(id: string, deep = true): { min: V3; max: V3 } | null {
    const e = this.scene.get(id);
    if (!e) return null;
    const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
    const grow = (a: ArrayLike<number>, b: ArrayLike<number>) => {
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], a[k]); max[k] = Math.max(max[k], b[k]); }
    };
    const own = (x: Entity) => {
      if (x.type === 'mesh' || x.type === 'instances' || x.type === 'scatter' || x.type === 'spline') {
        for (const r of this.renderablesOf(x.id)) grow(r.worldMin, r.worldMax);
        return;
      }
      if (!isSpatial(x)) return;
      const p = x.transform.position;
      let h: V3 = [0.25, 0.25, 0.25];
      if (x.type === 'decal') { const s = Math.max(...x.decal.size) / 2; h = [s, s, s]; }
      else if (x.type === 'sign') { const s = Math.max(...x.sign.size) / 2; h = [s, s, s]; }
      else if (x.type === 'reflectionProbe') { grow(x.probe.boxMin, x.probe.boxMax); return; }
      else if (x.type === 'probeVolume') { h = x.volume.size.map((v) => v / 2) as V3; }
      grow([p[0] - h[0], p[1] - h[1], p[2] - h[2]], [p[0] + h[0], p[1] + h[1], p[2] + h[2]]);
    };
    own(e);
    if (deep && (e.type === 'group' || !isSpatial(e))) for (const d of this.scene.descendants(id)) { const x = this.scene.get(d); if (x) own(x); }
    return Number.isFinite(min[0]) ? { min, max } : null;
  }

  /**
   * Gizmo / rotation pivot. Entities whose geometry sits far from their origin
   * (world-anchored chunks: terrain, streets) pivot about their bounds' bottom
   * centre; everything else about its transform position.
   */
  pivotOf(id: string): V3 | null {
    const e = this.scene.get(id);
    if (!e) return null;
    if (e.type === 'group' || ((e.type === 'scatter' || e.type === 'spline') && this.renderablesOf(id).length)) {
      const b = this.boundsOf(id);
      return b ? [(b.min[0] + b.max[0]) / 2, b.min[1], (b.min[2] + b.max[2]) / 2] : null;
    }
    if (!isSpatial(e)) return null;
    const p = e.transform.position;
    if (e.type === 'mesh') {
      const r = this.renderablesOf(id)[0];
      if (r) {
        const a = r.mesh.aabb;
        // Asset origin outside its own bounds (+1 m): world-anchored geometry.
        const inside = [0, 1, 2].every((k) => a.min[k] - 1 <= 0 && a.max[k] + 1 >= 0);
        if (!inside) return [(r.worldMin[0] + r.worldMax[0]) / 2, r.worldMin[1], (r.worldMin[2] + r.worldMax[2]) / 2];
      }
    }
    return [p[0], p[1], p[2]];
  }

  // ------------------------------------------------------------------ files

  get mapName() {
    return this.rt.mapName;
  }

  async loadMaterials() {
    try {
      const [r, s, sp] = await Promise.all([fetch('/__editor/materials'), fetch('/__editor/scatter-presets'), fetch('/__editor/spline-presets')]);
      if (r.ok) this.materials = await r.json();
      if (s.ok) this.scatterPresets = await s.json();
      if (sp.ok) this.splinePresets = await sp.json();
      this.emit('status');
    } catch {
      /* production build: no dev server */
    }
  }

  /** Writes the map document (dev server). */
  async save(): Promise<boolean> {
    if (this.history.transaction) {
      this.log('warn', 'Commit or roll back the open transaction before saving.');
      return false;
    }
    try {
      const r = await fetch(`/__editor/save?map=${encodeURIComponent(this.mapName)}`, { method: 'POST', body: JSON.stringify(this.scene.doc) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? r.statusText);
      this.history.markSaved();
      this.log('info', `Saved ${j.file} (${j.entities} entities, ${(j.bytes / 1024).toFixed(0)} KB)${j.backup ? `; previous version kept as ${j.backup}` : ''}`);
      return true;
    } catch (e) {
      this.log('error', `Save failed: ${(e as Error).message}`);
      return false;
    }
  }

  /** Re-reads the map from disk (discarding unsaved edits) and rebuilds the world in place. */
  async reload(doc?: MapDocument, opts: { unsaved?: boolean; label?: string } = {}) {
    const d = doc ?? (await World.fetchDocument(`/maps/${this.mapName}/map.json`));
    this.setSelection([]);
    await this.rt.world.reload(d);
    this.history.clear();
    this.history.markSaved();
    // A restored backup is not on disk yet: it stays "unsaved" until Save.
    if (opts.unsaved) this.history.forceDirty = true;
    this.log('info', `Loaded ${opts.label ?? this.mapName} (${d.entities.length} entities)${opts.unsaved ? ' - not saved yet: Save to keep it' : ''}`);
    this.emit('scene');
    this.emit('history');
  }

  /** Saved versions of this map (dev server), newest first. */
  async backups(): Promise<{ file: string; bytes: number; time: number }[]> {
    const r = await fetch(`/__editor/backups?map=${encodeURIComponent(this.mapName)}`);
    return r.ok ? r.json() : [];
  }

  /** Loads a saved version into the editor (unsaved until Save). */
  async restoreBackup(file: string) {
    const r = await fetch(`/__editor/backup?map=${encodeURIComponent(this.mapName)}&file=${encodeURIComponent(file)}`);
    if (!r.ok) throw new Error(`backup ${file}: ${r.status}`);
    const doc = (await r.json()) as MapDocument;
    if (doc.version !== 2 || !Array.isArray(doc.entities)) throw new Error(`${file} is not a v2 map`);
    await this.reload(doc, { unsaved: true, label: `backup ${file}` });
  }

  /** Writes the current document as a new map and returns its name (open it with ?map=). */
  async saveAs(name: string): Promise<string> {
    const r = await fetch(`/__editor/save-as?map=${encodeURIComponent(name)}&from=${encodeURIComponent(this.mapName)}`, { method: 'POST', body: JSON.stringify(this.scene.doc) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? r.statusText);
    this.log('info', `Saved as ${j.file}`);
    return j.map;
  }

  // ------------------------------------------------------------------ play mode

  /** Play from the editor camera (default) or the player start. */
  play(from: 'camera' | 'spawn' = 'camera') {
    if (this.mode === 'play') return;
    const { camera, player, world } = this.rt;
    this.editorCamera = { position: [camera.position[0], camera.position[1], camera.position[2]], yaw: camera.yaw, pitch: camera.pitch };
    world.flush();
    world.ensureCollision();
    world.resetBehaviour();
    player.fly = false;
    if (from === 'spawn') {
      const s = world.spawn();
      player.teleport(s.position, s.yaw, s.pitch);
    } else {
      // Drop to the ground under the camera (stay put if there is none).
      const p = camera.position;
      const g = world.collision.groundHeight(p[0], p[1], p[2], 200);
      player.teleport([p[0], g > -Infinity ? g : p[1] - player.eyeHeight, p[2]], (camera.yaw * 180) / Math.PI, (camera.pitch * 180) / Math.PI);
      if (g === -Infinity) player.fly = true;
    }
    player.enabled = true;
    this.mode = 'play';
    this.updateHighlight();
    this.log('info', `Play (${from === 'spawn' ? 'player start' : 'from camera'}) - click the view to capture the mouse, Esc to release, F5 / Stop to return`);
    this.emit('mode');
  }

  stop() {
    if (this.mode !== 'play') return;
    const { camera, player, sandbox, world, renderer } = this.rt;
    if (document.pointerLockElement) document.exitPointerLock();
    player.enabled = false;
    sandbox.trigger = false;
    if (sandbox.weapon) sandbox.toggleWeapon();
    sandbox.flashlight = false;
    renderer.dynamicLights = [];
    world.resetBehaviour();
    world.clearRuntimeDecals();
    if (this.editorCamera) {
      const c = this.editorCamera;
      camera.position[0] = c.position[0]; camera.position[1] = c.position[1]; camera.position[2] = c.position[2];
      camera.yaw = c.yaw;
      camera.pitch = c.pitch;
    }
    this.mode = 'edit';
    this.updateHighlight();
    this.log('info', 'Stopped - back in the editor');
    this.emit('mode');
  }
}
