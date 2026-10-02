import type { Entity, MapDocument } from './mapformat';

/**
 * The authoritative scene: a MapDocument plus indices, changed only by
 * applying patches. Editor commands (src/editor/commands.ts) compile to
 * patches; the runtime World and the editor UI subscribe to the resulting
 * change notifications. Nothing here knows about rendering or UI.
 *
 * Entities are treated as immutable values: a patch replaces an entity with a
 * new object, so `before` snapshots held by the undo history stay valid.
 */

export type DocKey = 'name' | 'description' | 'environment' | 'lightmaps';

export type Patch =
  | {
      kind: 'entity';
      id: string;
      before: Entity | null;
      after: Entity | null;
      /** Array position of `before` (removals), so undo restores the original order. */
      index?: number;
    }
  | { kind: 'doc'; key: DocKey; before: unknown; after: unknown };

export interface SceneChange {
  patches: Patch[];
  /** 'load' replaces the whole document (no patches). */
  source: 'do' | 'undo' | 'redo' | 'load';
}

export class SceneStore {
  doc: MapDocument;
  private byId = new Map<string, Entity>();
  private kids: Map<string, string[]> | null = null;
  private listeners = new Set<(c: SceneChange) => void>();
  /** Bumped on every change (UI caches compare it). */
  revision = 0;

  constructor(doc: MapDocument) {
    this.doc = doc;
    this.reindex();
  }

  private reindex() {
    this.byId.clear();
    for (const e of this.doc.entities) {
      if (this.byId.has(e.id)) console.warn(`[scene] duplicate entity id '${e.id}'`);
      this.byId.set(e.id, e);
    }
    this.kids = null;
  }

  /** Replaces the whole document (load / revert). */
  load(doc: MapDocument) {
    this.doc = doc;
    this.reindex();
    this.revision++;
    this.emit({ patches: [], source: 'load' });
  }

  subscribe(fn: (c: SceneChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(c: SceneChange) {
    for (const fn of this.listeners) fn(c);
  }

  get(id: string): Entity | undefined {
    return this.byId.get(id);
  }

  has(id: string) {
    return this.byId.has(id);
  }

  get entities(): readonly Entity[] {
    return this.doc.entities;
  }

  indexOf(id: string) {
    return this.doc.entities.findIndex((e) => e.id === id);
  }

  /** Direct children in document order. Top level: parent ''. */
  children(id: string): string[] {
    if (!this.kids) {
      this.kids = new Map();
      for (const e of this.doc.entities) {
        const p = e.parent && this.byId.has(e.parent) ? e.parent : '';
        let l = this.kids.get(p);
        if (!l) this.kids.set(p, (l = []));
        l.push(e.id);
      }
    }
    return this.kids.get(id) ?? [];
  }

  /** All descendants (depth first, document order), excluding `id`. */
  descendants(id: string, out: string[] = []): string[] {
    for (const c of this.children(id)) {
      out.push(c);
      this.descendants(c, out);
    }
    return out;
  }

  ancestors(id: string): string[] {
    const out: string[] = [];
    let e = this.byId.get(id);
    while (e?.parent && this.byId.has(e.parent) && !out.includes(e.parent)) {
      out.push(e.parent);
      e = this.byId.get(e.parent);
    }
    return out;
  }

  /** Visible unless the entity or any ancestor is hidden. */
  effectiveVisible(id: string): boolean {
    const e = this.byId.get(id);
    if (!e || e.visible === false) return false;
    return this.ancestors(id).every((a) => this.byId.get(a)?.visible !== false);
  }

  /** Locked if the entity or any ancestor is locked. */
  effectiveLocked(id: string): boolean {
    const e = this.byId.get(id);
    if (!e) return false;
    return e.locked === true || this.ancestors(id).some((a) => this.byId.get(a)?.locked === true);
  }

  /** A new never-used ID: `<base>_<n>` from the document counter. */
  newId(base: string): string {
    const b = base.replace(/[^\w-]+/g, '_').replace(/_\d+$/, '').slice(0, 40) || 'entity';
    let n = this.doc.nextId ?? 1;
    while (this.byId.has(`${b}_${n}`)) n++;
    this.doc.nextId = n + 1;
    return `${b}_${n}`;
  }

  /** Applies patches forward (do / redo) or inverted in reverse order (undo). */
  apply(patches: Patch[], source: 'do' | 'undo' | 'redo') {
    const list = source === 'undo' ? [...patches].reverse() : patches;
    for (const p of list) {
      const to = source === 'undo' ? p.before : p.after;
      if (p.kind === 'doc') {
        (this.doc as unknown as Record<string, unknown>)[p.key] = structuredClone(to);
        continue;
      }
      const ents = this.doc.entities;
      const cur = this.byId.has(p.id) ? this.indexOf(p.id) : -1;
      const next = to as Entity | null;
      if (next && next.id !== p.id) throw new Error(`patch id mismatch: ${p.id} vs ${next.id}`);
      if (cur >= 0 && next) ents[cur] = next;
      else if (cur >= 0) ents.splice(cur, 1);
      else if (next) {
        // Re-insert at the recorded position (undo of a delete), else after the parent's subtree.
        let at = source === 'undo' && p.index !== undefined ? Math.min(p.index, ents.length) : -1;
        if (at < 0) at = this.insertionIndex(next.parent);
        ents.splice(at, 0, next);
      }
      if (next) this.byId.set(p.id, next);
      else this.byId.delete(p.id);
    }
    this.kids = null;
    this.revision++;
    this.emit({ patches: list, source });
  }

  /** Document index just after `parent`'s last descendant (end of document without a parent). */
  private insertionIndex(parent?: string): number {
    if (!parent || !this.byId.has(parent)) return this.doc.entities.length;
    const sub = new Set([parent, ...this.descendants(parent)]);
    let last = -1;
    this.doc.entities.forEach((e, i) => { if (sub.has(e.id)) last = i; });
    return last + 1;
  }

  toJSON(): MapDocument {
    return this.doc;
  }
}
