import { isSpatial, type Entity, type MapDocument, type PrefabDocument, type PrefabObject } from '../engine/scene/mapformat';
import { toPrefabSpace } from '../engine/scene/prefab';
import type { Editor } from './editor';
import type { V3 } from './xform';

/**
 * Prefab files (public/prefabs/<name>.json): reusable groups of entities.
 *
 * - Save as prefab: the selection becomes a prefab file (pivot at the bottom
 *   centre of its bounds) and is replaced by one instance of it.
 * - Edit in place: an instance unpacks into ordinary entities in a group
 *   (everything else stays around it for context); Save writes the prefab and
 *   updates every instance, Close puts the instance back.
 * - Unpack: an instance becomes ordinary entities for good.
 */

export interface PrefabInfo {
  name: string;
  title?: string;
  description?: string;
  category?: string;
  tags?: string[];
  entities: number;
  modified: number;
}

export interface PrefabSession {
  prefab: string;
  /** The edit group the instance unpacked into. */
  group: string;
  /** The instance as it was (restored on Close, with the same ID). */
  instance: PrefabObject;
  /** Scene ID -> prefab-local ID of the unpacked entities (so IDs stay stable across edits). */
  ids: Record<string, string>;
  savedAt?: number;
}

export const PREFAB_NAME = /^[\w-]+$/;

/** Key-order independent JSON, numbers to 5 decimals (round trips through world space wobble in the last digits). */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => `${k}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  if (typeof v === 'number') return String(Math.round(v * 1e5) / 1e5);
  return JSON.stringify(v);
}

export class PrefabEditor {
  list: PrefabInfo[] = [];
  session: PrefabSession | null = null;

  constructor(readonly ed: Editor) {
    void this.refresh();
    // Undoing past the unpack (or deleting the group) ends the session.
    ed.on('scene', () => {
      if (this.session && !ed.scene.has(this.session.group)) {
        this.session = null;
        ed.emit('status');
      }
    });
  }

  get world() { return this.ed.rt.world; }

  async refresh() {
    try {
      const r = await fetch('/__editor/prefabs', { cache: 'no-store' });
      if (r.ok) this.list = await r.json();
      this.ed.emit('status');
    } catch {
      /* no dev server */
    }
  }

  /** Entities a set of roots covers (roots and descendants, document order). */
  private collect(roots: string[]): Entity[] {
    const sc = this.ed.scene;
    const ids = new Set<string>();
    for (const r of roots) for (const d of [r, ...sc.descendants(r)]) ids.add(d);
    return sc.entities.filter((e) => ids.has(e.id) && e.type !== 'terrainLayer');
  }

  /** Bottom centre of the roots' bounds, x / z on the grid. */
  private pivot(roots: string[]): V3 {
    const ed = this.ed;
    const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
    for (const id of roots) {
      const b = ed.boundsOf(id);
      if (!b) continue;
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], b.min[k]); max[k] = Math.max(max[k], b.max[k]); }
    }
    if (!Number.isFinite(min[0])) {
      const e = ed.scene.get(roots[0]);
      return e && isSpatial(e) ? [...e.transform.position] as V3 : [0, 0, 0];
    }
    const g = ed.snap.enabled ? ed.snap.grid : 0.001;
    const sn = (v: number) => Math.round(Math.round(v / g) * g * 1000) / 1000;
    return [sn((min[0] + max[0]) / 2), Math.round(min[1] * 1000) / 1000, sn((min[2] + max[2]) / 2)];
  }

  private async write(name: string, doc: PrefabDocument, create: boolean): Promise<{ file: string; backup?: string } | { exists: true }> {
    const r = await fetch(`/__editor/prefab-save?name=${encodeURIComponent(name)}${create ? '&create=1' : ''}`, { method: 'POST', body: JSON.stringify(doc) });
    const j = await r.json();
    if (r.status === 409) return { exists: true };
    if (!r.ok) throw new Error(j.error ?? r.statusText);
    return j;
  }

  /**
   * Saves entities (default: the selection) as a prefab and replaces them by an
   * instance. `overwrite` replaces an existing prefab of that name.
   */
  async create(name: string, opts: { ids?: string[]; title?: string; description?: string; category?: string; overwrite?: boolean; replace?: boolean } = {}): Promise<{ id?: string; prefab: string; entities: number }> {
    const ed = this.ed;
    if (!PREFAB_NAME.test(name)) throw new Error('prefab names: letters, digits, _ and - (e.g. lamp_post)');
    if (this.session) throw new Error(`finish editing prefab '${this.session.prefab}' first`);
    const sel = opts.ids ?? ed.selection;
    const set = new Set(sel);
    const roots = sel.filter((id) => ed.scene.has(id) && !ed.scene.ancestors(id).some((a) => set.has(a)));
    const ents = this.collect(roots);
    if (!ents.length) throw new Error('nothing to save (select entities first)');
    const locked = roots.filter((id) => ed.scene.effectiveLocked(id));
    if (locked.length && opts.replace !== false) throw new Error(`locked: ${locked.join(', ')}`);
    const pivot = this.pivot(roots);
    const inside = new Set(ents.map((e) => e.id));
    const local = toPrefabSpace(ents, { position: pivot }).map((e) => {
      if (e.parent && !inside.has(e.parent)) delete e.parent;
      return e;
    });
    const doc: PrefabDocument = {
      format: 'rill.prefab', version: 1, name: opts.title ?? (name.replace(/_/g, ' ').trim() || name),
      ...(opts.description ? { description: opts.description } : {}), ...(opts.category ? { category: opts.category } : {}), entities: local,
    };
    const w = await this.write(name, doc, !opts.overwrite);
    if ('exists' in w) throw new Error(`a prefab '${name}' exists (overwrite to replace it)`);
    this.world.forgetPrefab(name);
    await this.world.prefabDoc(name);
    let id: string | undefined;
    if (opts.replace !== false) {
      id = ed.exec<{ id: string }>('replace_with_prefab', { ids: roots, prefab: name, position: pivot, name: doc.name }).id;
      ed.select(id);
    }
    await this.world.reloadPrefab(name);
    ed.log('info', `Saved prefab ${w.file} (${local.length} entities)${w.backup ? `; previous version kept as ${w.backup}` : ''}`);
    void this.refresh();
    return { id, prefab: name, entities: local.length };
  }

  /** Opens an instance for editing in place. */
  async open(id: string) {
    const ed = this.ed;
    if (this.session) {
      if (this.session.instance.id === id) return;
      ed.log('warn', `Finish editing prefab '${this.session.prefab}' first (Save prefab / Close in the banner)`);
      return;
    }
    const inst = ed.scene.get(id);
    if (inst?.type !== 'prefab') return;
    if (ed.scene.effectiveLocked(id)) { ed.log('warn', `'${id}' is locked`); return; }
    try {
      await this.world.prefabDoc(inst.prefab);
    } catch (e) {
      ed.log('error', (e as Error).message);
      return;
    }
    const before = structuredClone(inst);
    const r = ed.tryExec<{ group: string; map: Record<string, string> }>('unpack_prefab', { id, name: `✎ ${inst.name ?? inst.prefab}` }, { label: `Edit prefab ${inst.prefab}` });
    if (!r) return;
    this.session = { prefab: inst.prefab, group: r.group, instance: before, ids: Object.fromEntries(Object.entries(r.map).map(([k, v]) => [v, k])) };
    ed.setSelection(ed.scene.children(r.group));
    ed.log('info', `Editing prefab '${inst.prefab}' in place - Save prefab writes it and updates every instance; Close puts the instance back`);
    ed.emit('status');
  }

  /** Scene ID -> prefab ID for the edit group: unpacked entities keep their prefab IDs, new ones get their scene ID (made unique). */
  private mapping(): Record<string, string> {
    const s = this.session!;
    const taken = new Set(Object.values(s.ids));
    const out: Record<string, string> = {};
    for (const id of this.ed.scene.descendants(s.group)) {
      let lid = s.ids[id];
      if (!lid) {
        lid = id;
        for (let n = 2; taken.has(lid); n++) lid = `${id}_${n}`;
        taken.add(lid);
      }
      out[id] = lid;
    }
    return out;
  }

  /** The edit group's contents in prefab space (document order), IDs mapped back to the prefab's own. */
  private sessionEntities(map = this.mapping()): Entity[] {
    const s = this.session!;
    // The prefab's own order (new entities after), so saves do not shuffle the file.
    const pd = this.world.prefabsLoaded.get(s.prefab);
    const rank = new Map((pd?.entities ?? []).map((e, i) => [e.id, i]));
    const ents = this.ed.scene.entities.filter((e) => map[e.id] !== undefined)
      .map((e, i) => ({ e, k: rank.get(map[e.id]) ?? 1e6 + i })).sort((a, b) => a.k - b.k).map((x) => x.e);
    return toPrefabSpace(ents, s.instance.transform).map((e) => {
      const out = { ...e, id: map[e.id] } as Entity;
      const parent = e.parent && e.parent !== s.group ? map[e.parent] : undefined;
      if (parent) out.parent = parent;
      else delete out.parent;
      return out;
    });
  }

  /** Whether the edit group differs from the prefab file. */
  get changed(): boolean {
    const s = this.session;
    if (!s) return false;
    const pd = this.world.prefabsLoaded.get(s.prefab);
    if (!pd) return true;
    return stable(this.sessionEntities()) !== stable(pd.entities);
  }

  /** Writes the open prefab and updates every instance (the edit stays open). */
  async save(): Promise<boolean> {
    const ed = this.ed, s = this.session;
    if (!s) return false;
    try {
      const pd = this.world.prefabsLoaded.get(s.prefab) ?? (await this.world.prefabDoc(s.prefab));
      const map = this.mapping();
      const entities = this.sessionEntities(map);
      const w = await this.write(s.prefab, { ...pd, entities }, false);
      if ('exists' in w) return false;
      // Entities added in this edit keep their new prefab IDs from now on.
      s.ids = map;
      s.savedAt = Date.now();
      await this.world.reloadPrefab(s.prefab);
      await this.world.prefabDoc(s.prefab);
      ed.log('info', `Saved prefab ${w.file} (${entities.length} entities; every instance updated)${w.backup ? `; previous version kept as ${w.backup}` : ''}`);
      void this.refresh();
      ed.emit('status');
      return true;
    } catch (e) {
      ed.log('error', `Save prefab: ${(e as Error).message}`);
      return false;
    }
  }

  /** Ends the edit: the group goes, the instance comes back (asks about unsaved changes unless `discard`). */
  async close(opts: { save?: boolean; discard?: boolean } = {}): Promise<boolean> {
    const ed = this.ed, s = this.session;
    if (!s) return true;
    if (opts.save) {
      if (!(await this.save())) return false;
    } else if (!opts.discard && this.changed) {
      const keep = confirm(`Save your changes to prefab '${s.prefab}' before closing?\n\nOK saves (every instance updates), Cancel discards them.`);
      if (keep && !(await this.save())) return false;
    }
    ed.history.begin(`Close prefab ${s.prefab}`);
    try {
      ed.exec('delete_entity', { ids: [s.group] }, { quiet: true });
      ed.exec('create_entity', { entity: s.instance }, { quiet: true });
      ed.history.commit();
    } catch (e) {
      ed.history.rollback();
      ed.log('error', `Close prefab: ${(e as Error).message}`);
      return false;
    }
    this.session = null;
    ed.select(s.instance.id);
    ed.emit('status');
    return true;
  }

  /** The map as it should be saved while a prefab is open: the instance in place of the edit group. */
  docForSave(doc: MapDocument): MapDocument {
    const s = this.session;
    if (!s || !this.ed.scene.has(s.group)) return doc;
    const drop = new Set([s.group, ...this.ed.scene.descendants(s.group)]);
    const at = doc.entities.findIndex((e) => e.id === s.group);
    const entities = doc.entities.filter((e) => !drop.has(e.id));
    entities.splice(Math.max(0, Math.min(at, entities.length)), 0, s.instance);
    return { ...doc, entities };
  }
}
