import { isSpatial, type Entity } from '../engine/scene/mapformat';
import type { Patch } from '../engine/scene/scene';
import type { Editor } from './editor';
import type { EditorTools } from './api';
import type { HistoryEntry } from './commands';

/**
 * The AI layer: an external agent (Claude through the MCP server in
 * tools/mcp/rill-mcp.ts) calls the editor's structured tools over the dev
 * server relay (tools/dev/ai_relay.ts). Its edits are grouped into changesets
 * (transactions the human reviews: Accept / Revert) and checked against the
 * scope the human set in the AI panel (whole map / selection; protected
 * building transforms, street layout, terrain, environment). The agent uses
 * exactly the operations the UI uses; nothing else is reachable.
 */

export interface AiScope {
  mode: 'map' | 'selection';
  /** Selection mode: the entities (and their descendants) the agent may change. */
  ids: string[];
  /** Selection mode: XZ box (selection bounds + margin) where it may add things. */
  area: { min: [number, number]; max: [number, number] } | null;
  protect: { buildings: boolean; streets: boolean; terrain: boolean; environment: boolean };
}

export interface AiCall {
  time: number;
  name: string;
  params: string;
  ms: number;
  ok: boolean;
  error?: string;
}

const PROTECT_SEMANTICS = {
  buildings: ['building', 'structure', 'station', 'wall', 'stairs', 'underpass', 'railing', 'turnstile'],
  streets: ['road', 'path', 'ground', 'kerb', 'parking', 'plaza', 'track'],
  terrain: ['terrain'],
};

export const AI_CONVENTIONS = [
  'Units: metres. Y is up. North is -Z, east is +X. Positions [x, y, z]; most placement tools also take [x, z] and stand things on the ground.',
  'Rotations: rotate_entity / inspector use Euler degrees Y-X-Z; place_asset takes yaw (degrees about +Y, counter-clockwise seen from above). Camera yaw (capture_view, get_camera): 0 = looking north, positive turns right; pitch negative looks down.',
  'Workflow: get_ai_context and get_scene_summary first; describe_area / query_entities / ground_height to understand a place; begin_changeset before editing; then operations; capture_view to look at the result (frame with { target } or { ids }); iterate; commit_changeset with a short summary. The human accepts or reverts it in the editor.',
  'Respect the scope in get_ai_context: refused operations explain why. Locked entities cannot be moved or deleted.',
  'Content: search_assets for props / vegetation / lighting; scatter presets (scatter_vegetation) for forests, shrubs, rocks; splines (create_spline) for paths, roads, kerbs, fences, rail; place_decal for dirt, streaks, cracks; modify_terrain to sculpt; assign_material / set_material_parameter for surfaces.',
].join('\n');

export class AiLayer {
  scope: AiScope = { mode: 'map', ids: [], area: null, protect: { buildings: false, streets: false, terrain: false, environment: false } };
  readonly calls: AiCall[] = [];
  /** Changesets that left the history (reverted while on top, discarded), for the AI tab. */
  readonly archive: HistoryEntry[] = [];
  /** An agent call is running (scope rules apply, human edits wait). */
  calling = false;
  lastCallAt = 0;
  registered = false;
  readonly session = `ed_${Math.random().toString(36).slice(2, 10)}`;
  private listeners = new Set<() => void>();

  constructor(readonly ed: Editor, readonly tools: EditorTools) {
    this.registerTools();
    this.connect();
    // While Claude's changeset is open, human edits wait (they would end up inside it).
    ed.editLock = () => (this.open && !this.calling ? 'Claude is editing (changeset open): wait, or stop it in the AI tab' : null);
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed() {
    for (const fn of this.listeners) fn();
  }

  // ------------------------------------------------------------------ relay

  private connect() {
    const hot = import.meta.hot;
    if (!hot) return; // production build: no dev server, no agent
    const register = () => {
      hot.send('rill:ai-register', { session: this.session, map: this.ed.mapName, tools: this.tools.list(), conventions: AI_CONVENTIONS });
      this.registered = true;
      this.changed();
    };
    register();
    // Re-register after a dev-server restart; keep the relay's idea of the active tab fresh.
    hot.on('vite:ws:connect', register);
    // Focus marks this tab as the one agents talk to (several editor tabs may be open).
    setInterval(() => { if (document.hasFocus()) hot.send('rill:ai-ping', { session: this.session }); }, 5000);
    window.addEventListener('focus', () => hot.send('rill:ai-ping', { session: this.session }));
    hot.on('rill:ai-call', async (msg: { id: string; name: string; params: Record<string, unknown> }) => {
      const t0 = performance.now();
      let reply: { id: string; ok: boolean; result?: unknown; error?: string };
      try {
        const result = await this.call(msg.name, msg.params);
        reply = { id: msg.id, ok: true, result };
      } catch (e) {
        reply = { id: msg.id, ok: false, error: (e as Error).message };
      }
      const p = JSON.stringify(msg.params ?? {});
      this.calls.push({ time: Date.now(), name: msg.name, params: p.length > 160 ? `${p.slice(0, 157)}...` : p, ms: performance.now() - t0, ok: reply.ok, error: reply.error });
      if (this.calls.length > 300) this.calls.splice(0, 100);
      this.lastCallAt = Date.now();
      hot.send('rill:ai-result', reply);
      this.changed();
    });
  }

  /** One agent tool call: scope rules active, logged as the agent. */
  async call(name: string, params: Record<string, unknown>): Promise<unknown> {
    this.calling = true;
    this.ed.actor = 'Claude';
    this.ed.history.guard = (op, patches) => this.check(op, patches);
    try {
      return await this.tools.call(name, params);
    } finally {
      this.ed.history.guard = null;
      this.ed.actor = '';
      this.calling = false;
    }
  }

  // ------------------------------------------------------------------ scope

  /** Sets the scope to the current selection (plus a margin around it for new things). */
  scopeToSelection(margin = 4) {
    const ed = this.ed;
    const ids = ed.selectionRoots;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const id of ids) {
      const b = ed.boundsOf(id);
      if (!b) continue;
      x0 = Math.min(x0, b.min[0]); z0 = Math.min(z0, b.min[2]); x1 = Math.max(x1, b.max[0]); z1 = Math.max(z1, b.max[2]);
    }
    this.scope = { ...this.scope, mode: 'selection', ids, area: Number.isFinite(x0) ? { min: [x0 - margin, z0 - margin], max: [x1 + margin, z1 + margin] } : null };
    this.changed();
  }

  scopeToMap() {
    this.scope = { ...this.scope, mode: 'map', ids: [], area: null };
    this.changed();
  }

  /** Human-readable scope for get_ai_context. */
  describeScope() {
    const s = this.scope;
    const prot = Object.entries(s.protect).filter(([, v]) => v).map(([k]) => k);
    return {
      mode: s.mode,
      ...(s.mode === 'selection' ? { entities: s.ids, area: s.area } : {}),
      protected: prot,
      rules: [
        s.mode === 'map' ? 'Any entity may be changed; new entities anywhere.' : 'Only the listed entities (and their descendants) may be changed; new entities only inside area (world XZ box).',
        ...(s.protect.buildings ? [`Building transforms are protected (no move / rotate / scale / delete of ${PROTECT_SEMANTICS.buildings.join(', ')}); their materials may change.`] : []),
        ...(s.protect.streets ? [`Street layout is protected (${PROTECT_SEMANTICS.streets.join(', ')}: no transform, delete or spline point changes).`] : []),
        ...(s.protect.terrain ? ['Terrain is protected (no modify_terrain, no terrain transforms).'] : []),
        ...(s.protect.environment ? ['The environment (weather / time of day) is protected.'] : []),
      ],
    };
  }

  private inScopeIds(): Set<string> {
    const set = new Set<string>();
    for (const id of this.scope.ids) {
      set.add(id);
      for (const d of this.ed.scene.descendants(id)) set.add(d);
    }
    return set;
  }

  private inArea(x: number, z: number) {
    const a = this.scope.area;
    return !!a && x >= a.min[0] && x <= a.max[0] && z >= a.min[1] && z <= a.max[1];
  }

  /** Scope rules for one operation's patches; returns a refusal message or null. */
  check(op: string, patches: Patch[]): string | null {
    const s = this.scope, P = s.protect;
    const problems: string[] = [];
    const ids = s.mode === 'selection' ? this.inScopeIds() : null;
    const prot = (e: Entity | null | undefined, kind: keyof typeof PROTECT_SEMANTICS) => !!e && P[kind] && PROTECT_SEMANTICS[kind].includes(e.semantic ?? '');
    for (const p of patches) {
      if (p.kind === 'doc') {
        if (p.key === 'environment' && P.environment) problems.push('the environment is protected');
        else if (s.mode === 'selection' && p.key !== 'environment') problems.push(`map setting '${p.key}' is outside the selection scope`);
        continue;
      }
      const b = p.before, a = p.after;
      if (b?.type === 'terrainLayer' || a?.type === 'terrainLayer') {
        if (P.terrain) { problems.push('terrain is protected'); continue; }
        if (s.mode === 'selection' && a?.type === 'terrainLayer') {
          const old = b?.type === 'terrainLayer' ? b.terrain.strokes.length : 0;
          const bad = a.terrain.strokes.slice(old).filter((st) => !this.inArea(st[1], st[2]));
          if (bad.length) problems.push(`${bad.length} terrain stroke(s) outside the allowed area`);
        }
        continue;
      }
      if (b) {
        // Changing / deleting an existing entity.
        if (ids && !ids.has(p.id)) { problems.push(`'${p.id}' (${b.semantic ?? b.type}) is outside the selection scope`); continue; }
        const moved = !a || (isSpatial(b) && a && isSpatial(a) && JSON.stringify(b.transform) !== JSON.stringify(a.transform));
        const reshaped = b.type === 'spline' && a?.type === 'spline' && JSON.stringify(b.spline.points) !== JSON.stringify(a.spline.points);
        if ((moved || reshaped) && prot(b, 'buildings')) problems.push(`'${p.id}' (${b.semantic}): building transforms are protected`);
        if ((moved || reshaped) && prot(b, 'streets')) problems.push(`'${p.id}' (${b.semantic}): the street layout is protected`);
        if (moved && prot(b, 'terrain')) problems.push(`'${p.id}': terrain is protected`);
      } else if (a && s.mode === 'selection') {
        // New entity: inside the area, or a child of something in scope.
        const parentOk = a.parent && ids?.has(a.parent);
        if (!parentOk && isSpatial(a)) {
          const q = a.transform.position;
          if (!this.inArea(q[0], q[2])) problems.push(`new '${a.id}' at [${q[0].toFixed(1)}, ${q[2].toFixed(1)}] is outside the allowed area`);
        }
      }
    }
    if (!problems.length) return null;
    const more = problems.length > 5 ? ` (+${problems.length - 5} more)` : '';
    return `scope: ${op} refused - ${problems.slice(0, 5).join('; ')}${more}. See get_ai_context for the rules.`;
  }

  // ------------------------------------------------------------------ changesets

  get open(): HistoryEntry | null {
    const t = this.ed.history.transaction;
    return t?.changeset?.status === 'open' ? t : null;
  }

  get pending(): HistoryEntry[] {
    return this.ed.history.undoStack.filter((e) => e.changeset?.status === 'pending');
  }

  begin(title: string, prompt?: string) {
    if (this.ed.history.transaction) throw new Error(`a changeset is already open: '${this.ed.history.transaction.label}'`);
    if (this.ed.mode === 'play') this.ed.stop();
    this.ed.history.begin(`AI: ${title}`, { title, prompt, status: 'open', author: 'claude', started: Date.now() });
    this.ed.log('info', `Claude started a changeset: ${title}`);
    this.changed();
  }

  commit(summary?: string): HistoryEntry | null {
    const t = this.open;
    if (!t) throw new Error('no open changeset (begin_changeset first)');
    t.changeset!.status = 'pending';
    if (summary) t.changeset!.summary = summary;
    const e = this.ed.history.commit();
    this.ed.log('info', e ? `Claude finished '${t.changeset!.title}': ${this.describe(e).lines.join(', ')} - review it in the AI tab` : `Claude's changeset '${t.changeset!.title}' changed nothing`);
    this.changed();
    return e;
  }

  discard() {
    const t = this.open;
    if (!t) throw new Error('no open changeset');
    this.ed.history.rollback();
    this.ed.log('info', `Changeset '${t.changeset!.title}' discarded`);
    this.changed();
  }

  accept(e: HistoryEntry) {
    if (e.changeset) e.changeset.status = 'accepted';
    this.ed.log('info', `Accepted: ${e.changeset?.title}`);
    this.changed();
    this.ed.emit('history');
  }

  revert(e: HistoryEntry) {
    const H = this.ed.history;
    if (H.undoStack[H.undoStack.length - 1] === e) {
      H.undo();
      // Not redoable: it was rejected.
      const i = H.redoStack.indexOf(e);
      if (i >= 0) H.redoStack.splice(i, 1);
      this.archive.push(e);
    } else {
      H.revertEntry(e, `Revert AI: ${e.changeset?.title}`);
    }
    if (e.changeset) e.changeset.status = 'reverted';
    this.ed.log('info', `Reverted: ${e.changeset?.title}`);
    this.changed();
    this.ed.emit('history');
  }

  /** What a changeset did: grouped counts ("+ 12 vegetation", "~ 2 building (material)"). */
  describe(e: HistoryEntry) {
    const created = new Map<string, number>(), changed = new Map<string, { n: number; what: Set<string> }>(), deleted = new Map<string, number>();
    const ids = { created: [] as string[], changed: [] as string[], deleted: [] as string[] };
    let env = false;
    for (const p of e.patches) {
      if (p.kind === 'doc') { if (p.key === 'environment') env = true; continue; }
      const b = p.before, a = p.after;
      const ent = (a ?? b)!;
      const k = ent.type === 'mesh' ? ent.semantic ?? 'mesh' : ent.semantic && ent.type !== 'decal' && ent.type !== 'light' ? `${ent.semantic} ${ent.type}` : ent.type;
      if (!b && a) { created.set(k, (created.get(k) ?? 0) + 1); ids.created.push(p.id); }
      else if (b && !a) { deleted.set(k, (deleted.get(k) ?? 0) + 1); ids.deleted.push(p.id); }
      else if (b && a) {
        const what = new Set<string>();
        for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
          if (JSON.stringify((b as unknown as Record<string, unknown>)[key]) === JSON.stringify((a as unknown as Record<string, unknown>)[key])) continue;
          what.add(key === 'transform' ? 'moved' : key === 'materialOverrides' ? 'material' : key);
        }
        const c = changed.get(k) ?? { n: 0, what: new Set<string>() };
        c.n++;
        for (const w of what) c.what.add(w);
        changed.set(k, c);
        ids.changed.push(p.id);
      }
    }
    const lines = [
      ...[...created].map(([k, n]) => `+ ${n} ${k}`),
      ...[...changed].map(([k, c]) => `~ ${c.n} ${k} (${[...c.what].join(', ')})`),
      ...[...deleted].map(([k, n]) => `- ${n} ${k}`),
      ...(env ? ['~ environment'] : []),
    ];
    return { lines, ids, operations: e.ops.length };
  }

  // ------------------------------------------------------------------ agent tools

  private registerTools() {
    const T = this.tools, S = (description: string, type: 'string' | 'number' | 'boolean' | 'any' = 'string', optional = true) => ({ type, description, optional });
    T.register({
      name: 'get_ai_context', description: 'Start here: the map, the human\'s scope rules for you (what you may change), the current selection, the camera, open / pending changesets and the conventions (units, axes, rotations, workflow).',
      params: {},
      run: () => ({
        map: this.ed.mapName,
        scope: this.describeScope(),
        selection: this.ed.selection.map((id) => this.tools.brief(this.ed.scene.get(id)!)),
        camera: this.tools.camera(),
        openChangeset: this.open ? { title: this.open.changeset!.title, operations: this.open.ops.length } : null,
        pendingChangesets: this.pending.map((e) => ({ title: e.changeset!.title, ...this.describe(e) })),
        conventions: AI_CONVENTIONS,
      }),
    });
    T.register({
      name: 'begin_changeset', description: 'Opens a changeset: every following edit is grouped into one reviewable unit the human accepts or reverts. Title = what you are doing; prompt = the request you are working on.',
      params: { title: S('Short title.', 'string', false), prompt: S('The request being worked on.') },
      run: (p) => { this.begin(p.title, p.prompt); return { open: p.title }; },
    });
    T.register({
      name: 'commit_changeset', description: 'Closes the open changeset for review (it stays applied until the human accepts or reverts it). Returns what it changed.',
      params: { summary: S('One or two sentences: what you changed and why.') },
      run: (p) => {
        const e = this.commit(p.summary);
        return e ? { title: e.changeset!.title, ...this.describe(e), status: 'pending review' } : { changed: 0 };
      },
    });
    T.register({
      name: 'discard_changeset', description: 'Throws away everything since begin_changeset.',
      params: {},
      run: () => { this.discard(); return { discarded: true }; },
    });
    T.register({
      name: 'get_changeset', description: 'The open changeset so far (operations, changes grouped).',
      params: {},
      run: () => {
        const t = this.open;
        return t ? { title: t.changeset!.title, ...this.describe(t) } : { open: null, pending: this.pending.map((e) => e.changeset!.title) };
      },
    });
  }
}
