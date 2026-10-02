import { createPlayground } from '../../engine/ui/playground';
import { Environment } from '../../engine/scene/environment';
import { deepDiff, loadPreset } from '../../app/runtime';
import type { Editor } from '../editor';
import { ENTITY_TEMPLATES, type Viewport } from '../viewport';
import type { EditorTools } from '../api';
import { checkbox, clear, h } from './dom';

/** Bottom tab panels: assets, materials, environment & rendering, debug, console. */

const CAT_ICON: Record<string, string> = {
  entities: '✦', buildings: '▥', structural: '▤', props: '◇', vegetation: '♣', roads: '═', lighting: '✸', vehicles: '▬', terrain: '◢', environment: '◠', reference: '⚲',
};

const TEMPLATE_NAMES: Record<string, string> = {
  'entity:point_light': 'Point light', 'entity:spot_light': 'Spot light', 'entity:decal': 'Decal', 'entity:sign': 'Sign',
  'entity:viewpoint': 'Viewpoint', 'entity:reflection_probe': 'Reflection probe', 'entity:group': 'Group',
};

export class AssetsPanel {
  readonly el: HTMLElement;
  private grid: HTMLElement;
  private cats: HTMLElement;
  private cat = 'all';
  private query = '';
  private unique = false;

  constructor(readonly ed: Editor) {
    const search = h('input', { type: 'search', placeholder: 'Search assets…', class: 'as-search' });
    search.addEventListener('input', () => { this.query = search.value; this.render(); });
    search.addEventListener('keydown', (e) => e.stopPropagation());
    this.cats = h('div', { class: 'as-cats' });
    this.grid = h('div', { class: 'as-grid' });
    this.el = h('div', { class: 'assets' }, this.cats, h('div', { class: 'as-main' },
      h('div', { class: 'as-bar' }, search, checkbox(false, (v) => { this.unique = v; this.render(); }, 'Map-specific pieces', 'Terrain chunks, street surfaces, building shells…'),
        h('span', { class: 'as-hint' }, 'Click an asset, then click in the view to place it (Shift: place several) - or drag it into the view.')),
      this.grid));
    ed.on('tool', () => this.render());
    this.render();
  }

  private render() {
    const ed = this.ed;
    const cats = ['all', 'entities', ...ed.assets.doc.categories.filter((c) => ed.assets.all.some((a) => a.category === c && (this.unique || !a.unique)))];
    clear(this.cats);
    for (const c of cats) {
      this.cats.append(h('div', { class: `as-cat${c === this.cat ? ' on' : ''}`, onclick: () => { this.cat = c; this.render(); } }, `${CAT_ICON[c] ?? '•'} ${c}`));
    }
    clear(this.grid);
    const tile = (id: string, name: string, sub: string, cat: string) => {
      const t = h('div', { class: `as-tile${ed.placing === id ? ' on' : ''}`, draggable: true, title: `${id}\n${sub}` },
        h('div', { class: 'as-glyph' }, CAT_ICON[cat] ?? '•'), h('div', { class: 'as-name' }, name), h('div', { class: 'as-sub' }, sub));
      t.addEventListener('click', () => { ed.placing = ed.placing === id ? null : id; ed.emit('tool'); });
      t.addEventListener('dragstart', (e) => { e.dataTransfer!.setData('application/x-rill-asset', id); e.dataTransfer!.effectAllowed = 'copy'; });
      this.grid.append(t);
    };
    const q = this.query.toLowerCase();
    if (this.cat === 'all' || this.cat === 'entities') {
      for (const id of Object.keys(ENTITY_TEMPLATES)) if (!q || TEMPLATE_NAMES[id].toLowerCase().includes(q)) tile(id, TEMPLATE_NAMES[id], 'entity', 'entities');
    }
    if (this.cat !== 'entities') {
      const list = ed.assets.search(this.query, { category: this.cat === 'all' ? undefined : this.cat, includeUnique: this.unique });
      for (const a of list.slice(0, 400)) {
        const b = a.bounds;
        const size = b ? `${(b.max[0] - b.min[0]).toFixed(1)}×${(b.max[1] - b.min[1]).toFixed(1)}×${(b.max[2] - b.min[2]).toFixed(1)} m` : '';
        tile(a.id, a.name, `${a.id.split('/')[0]} · ${size}`, a.category);
      }
    }
  }
}

export class MaterialsPanel {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private query = '';

  constructor(readonly ed: Editor) {
    const search = h('input', { type: 'search', placeholder: 'Search materials…', class: 'as-search' });
    search.addEventListener('input', () => { this.query = search.value.toLowerCase(); this.render(); });
    search.addEventListener('keydown', (e) => e.stopPropagation());
    this.list = h('div', { class: 'mat-list' });
    this.el = h('div', { class: 'materials' }, h('div', { class: 'as-bar' }, search, h('span', { class: 'as-hint' }, 'Drag a material onto a surface in the view to assign it to that slot; or pick one per slot in the Inspector.')), this.list);
    ed.on('status', () => this.render());
    this.render();
  }

  private render() {
    clear(this.list);
    for (const m of this.ed.materials) {
      if (m.decal) continue;
      if (this.query && !`${m.name} ${m.inherits ?? ''} ${m.shader ?? ''} ${m.semantic ?? ''}`.toLowerCase().includes(this.query)) continue;
      const f = Array.isArray(m.baseColorFactor) ? (m.baseColorFactor as number[]) : typeof m.baseColorFactor === 'string' ? null : [0.6, 0.6, 0.6];
      const sw = f ? `rgb(${f.slice(0, 3).map((c) => Math.round(Math.pow(Math.min(1, c), 1 / 2.2) * 255)).join(',')})` : String(m.baseColorFactor);
      const row = h('div', { class: 'mat-row', draggable: true, title: m.notes ?? m.name },
        h('span', { class: 'mat-sw', style: `background:${sw}` }), h('span', { class: 'mat-name' }, m.name),
        h('span', { class: 'mat-meta' }, [m.shader && m.shader !== 'standard' ? m.shader : '', m.alphaMode && m.alphaMode !== 'opaque' ? m.alphaMode : '', m.inherits ? `← ${m.inherits}` : ''].filter(Boolean).join(' · ')));
      row.addEventListener('dragstart', (e) => { e.dataTransfer!.setData('application/x-rill-material', m.name); e.dataTransfer!.effectAllowed = 'copy'; });
      this.list.append(row);
    }
  }
}

/** The renderer playground (environment, rendering, debug views) mounted in a tab; environment edits become set_environment operations. */
export class EnvironmentPanel {
  readonly el: HTMLElement;
  constructor(readonly ed: Editor, vp: Viewport) {
    this.el = h('div', { class: 'envpanel' });
    const rt = ed.rt;
    const bookmarks: Record<string, () => void> = {};
    for (const v of rt.world.viewpoints()) {
      bookmarks[v.name ?? v.id] = () => {
        const p = v.transform.position;
        rt.camera.position[0] = p[0]; rt.camera.position[1] = p[1] + 1.65; rt.camera.position[2] = p[2];
        rt.camera.yaw = ((v.yaw ?? 0) * Math.PI) / 180;
        rt.camera.pitch = ((v.pitch ?? 0) * Math.PI) / 180;
      };
    }
    const gui = createPlayground(rt.renderer, rt.env, rt.player, {
      setPreset: async (name) => { ed.tryExec('set_environment', { preset: name, overrides: null }); },
      stress: rt.api.stress,
      clearStress: rt.api.clearStress,
      capture: () => void ed.rt.renderer.capture().then((b) => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `rill-${ed.mapName}-${Date.now()}.png`; a.click(); }),
      bookmarks,
    }, { container: this.el, title: 'Environment & rendering' });
    gui.domElement.classList.add('embedded');
    // Slider edits preview live; when one finishes, the map's overrides are recomputed and recorded.
    let pending = 0;
    gui.onFinishChange(() => {
      clearTimeout(pending);
      pending = window.setTimeout(async () => {
        const doc = ed.scene.doc.environment;
        const base = Environment.normalize(await loadPreset(doc.preset));
        const ov = deepDiff(base, rt.env.state) ?? null;
        if (JSON.stringify(ov ?? undefined) !== JSON.stringify(doc.overrides)) ed.tryExec('set_environment', { preset: doc.preset, overrides: ov }, { label: 'Environment settings' });
      }, 30);
    });
    ed.on('environment', () => gui.controllersRecursive().forEach((c) => c.updateDisplay()));
    void vp;
  }
}

export class DebugPanel {
  readonly el: HTMLElement;
  private info: HTMLElement;
  private hist: HTMLElement;
  constructor(readonly ed: Editor) {
    const P = ed.pick, S = ed.show;
    this.info = h('pre', { class: 'dbg-info' });
    this.hist = h('div', { class: 'dbg-hist' });
    this.el = h('div', { class: 'debug' },
      h('div', { class: 'dbg-col' },
        h('div', { class: 'insp-sec-title' }, 'Viewport picking'),
        ...(['meshes', 'lights', 'markers', 'signs', 'decals', 'probes'] as const).map((k) => checkbox(P[k], (v) => { P[k] = v; }, k)),
        h('div', { class: 'insp-sec-title' }, 'Helpers'),
        ...(['lights', 'markers', 'decals', 'probes'] as const).map((k) => checkbox(S[k], (v) => { S[k] = v; }, k)),
        checkbox(ed.rt.stats.visible, () => ed.rt.stats.toggle(), 'stats overlay'),
      ),
      h('div', { class: 'dbg-col wide' }, h('div', { class: 'insp-sec-title' }, 'World'), this.info),
      h('div', { class: 'dbg-col wide' }, h('div', { class: 'insp-sec-title' }, 'Undo history (newest first)'), this.hist),
    );
    ed.on('history', () => this.renderHistory());
    setInterval(() => this.renderInfo(), 500);
    this.renderHistory();
  }

  private renderInfo() {
    if (!this.el.isConnected || this.el.offsetParent === null) return;
    const w = this.ed.rt.world, r = this.ed.rt.renderer;
    this.info.textContent = [
      `map         ${this.ed.mapName}  (${this.ed.scene.entities.length} entities, rev ${this.ed.scene.revision})`,
      `renderables ${w.renderables.length}   triangles ${w.triangleCount.toLocaleString()}`,
      `collision   ${w.collision.triangleCount.toLocaleString()} tris${w.collisionDirty ? '  (stale: rebuilt on Play)' : ''}`,
      `lightmaps   ${w.lightmaps ? `${Object.keys(w.lightmaps.doc.objects).length} objects` : 'none'}${w.lightingStale ? '  (scene changed since bake)' : ''}`,
      `lights      ${w.lights.length}   decals ${w.decals?.count ?? 0}   loads ${w.pendingLoads}`,
      `frame       ${this.ed.rt.lastFrameMs.toFixed(1)} ms   gpu ${r.timer.total.toFixed(2)} ms   draws ${r.stats.drawCalls}`,
    ].join('\n');
  }

  private renderHistory() {
    const H = this.ed.history;
    clear(this.hist);
    for (const e of [...H.redoStack].reverse()) this.hist.append(h('div', { class: 'dbg-h redo' }, `↷ ${e.label}`));
    for (const e of [...H.undoStack].reverse().slice(0, 200)) this.hist.append(h('div', { class: 'dbg-h' }, `${e.label}  `, h('small', {}, `${e.patches.length} change${e.patches.length === 1 ? '' : 's'}`)));
    if (H.transaction) this.hist.prepend(h('div', { class: 'dbg-h tx' }, `● transaction: ${H.transaction.label} (${H.transaction.patches.length})`));
  }
}

/** Log of operations, warnings and job output, plus a command line for operations / tools. */
export class ConsolePanel {
  readonly el: HTMLElement;
  private out: HTMLElement;
  private shown = 0;
  private past: string[] = [];
  private pi = 0;
  constructor(readonly ed: Editor, tools: EditorTools) {
    this.out = h('div', { class: 'con-out' });
    const input = h('input', { type: 'text', class: 'con-in', placeholder: 'operation or tool + JSON params, e.g.  move_entity {"ids": ["bench_0"], "delta": [1, 0, 0]}   ·   help' });
    input.addEventListener('keydown', async (e) => {
      e.stopPropagation();
      if (e.key === 'ArrowUp') { this.pi = Math.max(0, this.pi - 1); input.value = this.past[this.pi] ?? ''; e.preventDefault(); return; }
      if (e.key === 'ArrowDown') { this.pi = Math.min(this.past.length, this.pi + 1); input.value = this.past[this.pi] ?? ''; e.preventDefault(); return; }
      if (e.key !== 'Enter') return;
      const line = input.value.trim();
      if (!line) return;
      this.past.push(line);
      this.pi = this.past.length;
      input.value = '';
      ed.log('info', `> ${line}`);
      const m = line.match(/^(\w+)\s*([\s\S]*)$/);
      if (!m) return;
      try {
        if (m[1] === 'help') {
          ed.log('info', tools.list().map((t) => `${t.name}: ${t.description}`).join('\n'));
          return;
        }
        const params = m[2] ? JSON.parse(m[2]) : {};
        const r = await tools.call(m[1], params);
        if (r !== undefined) ed.log('info', typeof r === 'string' ? r : JSON.stringify(r, null, 1).slice(0, 4000));
      } catch (err) {
        ed.log('error', (err as Error).message);
      }
    });
    this.el = h('div', { class: 'console' }, this.out, input);
    ed.on('log', () => this.render());
    this.render();
  }

  private render() {
    const lines = this.ed.logLines;
    if (this.shown > lines.length) { clear(this.out); this.shown = 0; }
    const atBottom = this.out.scrollTop + this.out.clientHeight >= this.out.scrollHeight - 4;
    for (; this.shown < lines.length; this.shown++) {
      const l = lines[this.shown];
      const t = new Date(l.time);
      this.out.append(h('div', { class: `con-l ${l.kind}` }, h('span', { class: 'con-t' }, `${t.toTimeString().slice(0, 8)} `), l.text));
    }
    while (this.out.childElementCount > 1500) this.out.firstElementChild?.remove();
    if (atBottom) this.out.scrollTop = this.out.scrollHeight;
  }
}
