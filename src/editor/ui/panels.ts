import { createPlayground } from '../../engine/ui/playground';
import { Environment } from '../../engine/scene/environment';
import { deepDiff, loadPreset } from '../../app/runtime';
import type { Editor } from '../editor';
import { ENTITY_TEMPLATES, type Viewport } from '../viewport';
import type { EditorTools } from '../api';
import { checkbox, clear, h } from './dom';
import type { ThumbSource } from '../thumbs';

/** Bottom tab panels: assets, materials, environment & rendering, debug, console. */

const CAT_ICON: Record<string, string> = {
  blockout: '■', prefabs: '❖', entities: '✦', scatter: '❦', splines: '〰', decals: '▧', buildings: '▥', structural: '▤', props: '◇', vegetation: '♣', roads: '═', lighting: '✸', vehicles: '▬', terrain: '◢', environment: '◠', reference: '⚲',
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
    ed.on('status', () => this.render());
    this.render();
  }

  private render() {
    const ed = this.ed;
    const cats = ['all', 'blockout', 'prefabs', 'entities', 'scatter', 'splines', 'decals', ...ed.assets.doc.categories.filter((c) => ed.assets.all.some((a) => a.category === c && (this.unique || !a.unique)))];
    clear(this.cats);
    for (const c of cats) {
      this.cats.append(h('div', { class: `as-cat${c === this.cat ? ' on' : ''}`, onclick: () => { this.cat = c; this.render(); } }, `${CAT_ICON[c] ?? '•'} ${c}`));
    }
    clear(this.grid);
    /** Glyph, replaced by the thumbnail once it is drawn. */
    const pic = (cat: string, src?: ThumbSource) => {
      const el = h('div', { class: 'as-glyph' }, CAT_ICON[cat] ?? '•');
      if (!src) return el;
      const show = (url: string | null | undefined) => {
        if (!url) return;
        el.textContent = '';
        el.classList.add('as-thumb');
        el.append(h('img', { src: url, alt: '', draggable: false }));
      };
      const now = ed.thumbs.peek(src);
      if (now) show(now);
      else {
        // Drawn when the tile scrolls into view.
        const io = new IntersectionObserver((es) => {
          if (!es.some((x) => x.isIntersecting)) return;
          io.disconnect();
          void ed.thumbs.get(src).then((u) => { if (el.isConnected) show(u); });
        });
        io.observe(el);
      }
      return el;
    };
    const tile = (id: string, name: string, sub: string, cat: string, src?: ThumbSource) => {
      const t = h('div', { class: `as-tile${ed.placing === id ? ' on' : ''}`, draggable: true, title: `${id}\n${sub}` },
        pic(cat, src), h('div', { class: 'as-name' }, name), h('div', { class: 'as-sub' }, sub));
      t.addEventListener('click', () => { ed.placing = ed.placing === id ? null : id; ed.emit('tool'); });
      t.addEventListener('dragstart', (e) => { e.dataTransfer!.setData('application/x-rill-asset', id); e.dataTransfer!.effectAllowed = 'copy'; });
      this.grid.append(t);
    };
    const q = this.query.toLowerCase();
    if (this.cat === 'all' || this.cat === 'blockout') {
      const bt = ed.blockTool;
      const shapes: [string, string, string][] = [['box', 'Box', 'block'], ['wedge', 'Ramp', 'wedge'], ['stairs', 'Stairs', '17 cm steps'], ['cylinder', 'Pillar', 'cylinder'], ['room', 'Room', 'floor + walls']];
      for (const [k, l, sub] of shapes) {
        if (q && !`${k} ${l} blockout`.toLowerCase().includes(q)) continue;
        const t = h('div', { class: `as-tile${ed.tool === 'block' && bt.mode === 'draw' && bt.shape === k ? ' on' : ''}`, title: `${l}: drag a footprint on any surface, then set the height (Block tool, B)` },
          pic('blockout', { kind: 'block', shape: k as typeof bt.shape }), h('div', { class: 'as-name' }, l), h('div', { class: 'as-sub' }, `blockout · ${sub}`));
        t.addEventListener('click', () => { bt.shape = k as typeof bt.shape; bt.mode = 'draw'; ed.tool = 'block'; ed.emit('tool'); });
        this.grid.append(t);
      }
      for (const [k, l] of [['door', 'Door'], ['window', 'Window'], ['double_door', 'Double door'], ['wide_window', 'Wide window'], ['passage', 'Passage'], ['custom', 'Custom opening']]) {
        if (q && !`${k} ${l} opening`.toLowerCase().includes(q)) continue;
        const t = h('div', { class: `as-tile${ed.tool === 'block' && bt.mode === 'opening' && bt.opening === k ? ' on' : ''}`, title: `${l}: click a wall (box block) to cut it` },
          h('div', { class: 'as-glyph' }, '▯'), h('div', { class: 'as-name' }, l), h('div', { class: 'as-sub' }, 'opening · click a wall'));
        t.addEventListener('click', () => { bt.opening = k as typeof bt.opening; bt.mode = 'opening'; ed.tool = 'block'; ed.emit('tool'); });
        this.grid.append(t);
      }
    }
    if (this.cat === 'all' || this.cat === 'prefabs') {
      for (const p of ed.prefabs.list) {
        if (q && !`${p.name} ${p.title ?? ''} ${p.category ?? ''} ${(p.tags ?? []).join(' ')} ${p.description ?? ''}`.toLowerCase().includes(q)) continue;
        tile(`prefab:${p.name}`, p.title ?? p.name, `prefab · ${p.entities} entities${p.category ? ` · ${p.category}` : ''}`, 'prefabs', { kind: 'prefab', name: p.name, version: p.modified });
      }
      if (this.cat === 'prefabs' && !ed.prefabs.list.length) this.grid.append(h('div', { class: 'insp-empty' }, 'No prefabs yet: select entities and use “Save as prefab…” in the Inspector.'));
    }
    if (this.cat === 'all' || this.cat === 'entities') {
      for (const id of Object.keys(ENTITY_TEMPLATES)) if (!q || TEMPLATE_NAMES[id].toLowerCase().includes(q)) tile(id, TEMPLATE_NAMES[id], 'entity', 'entities');
    }
    if (this.cat === 'all' || this.cat === 'scatter') {
      for (const p of ed.scatterPresets) {
        if (q && !`${p.name} ${p.title} ${p.description ?? ''}`.toLowerCase().includes(q)) continue;
        const t = h('div', { class: `as-tile${ed.tool === 'paint' && ed.brush.preset === p.name ? ' on' : ''}`, title: `${p.title}\n${p.description ?? ''}\nClick, then paint on the ground (Shift erases, [ ] brush size)` },
          h('div', { class: 'as-glyph' }, CAT_ICON.scatter), h('div', { class: 'as-name' }, p.title), h('div', { class: 'as-sub' }, `scatter · ${p.density}/100 m² · ${p.species} species`));
        t.addEventListener('click', () => {
          ed.brush.preset = p.name;
          ed.tool = 'paint';
          // A different preset starts a new scatter instead of painting into the selected one.
          const sel = ed.primary;
          if (sel?.type === 'scatter' && sel.scatter.preset !== p.name) ed.setSelection([]);
          ed.emit('tool');
        });
        this.grid.append(t);
      }
    }
    if (this.cat === 'all' || this.cat === 'splines') {
      for (const p of ed.splinePresets) {
        if (q && !`${p.name} ${p.title} ${p.description ?? ''}`.toLowerCase().includes(q)) continue;
        const t = h('div', { class: `as-tile${ed.tool === 'spline' && ed.splineTool.preset === p.name ? ' on' : ''}`, title: `${p.title}\n${p.description ?? ''}\nClick, then click points on the ground (Enter / Esc finishes)` },
          h('div', { class: 'as-glyph' }, CAT_ICON.splines), h('div', { class: 'as-name' }, p.title), h('div', { class: 'as-sub' }, `spline · ${p.name}`));
        t.addEventListener('click', () => {
          ed.splineTool.preset = p.name;
          ed.splineTool.drawing = null;
          ed.splineTool.pending = null;
          ed.tool = 'spline';
          if (ed.primary?.type === 'spline') ed.setSelection([]);
          ed.emit('tool');
        });
        this.grid.append(t);
      }
    }
    if (this.cat === 'all' || this.cat === 'decals') {
      for (const m of ed.materials.filter((x) => x.decal)) {
        if (q && !m.name.toLowerCase().includes(q)) continue;
        const t = h('div', { class: `as-tile${ed.tool === 'decal' && ed.decalTool.material === m.name ? ' on' : ''}`, title: `${m.name}\n${m.notes ?? ''}\nClick, then click / drag on surfaces` },
          h('div', { class: 'as-glyph' }, CAT_ICON.decals), h('div', { class: 'as-name' }, m.name.replace(/^decal_/, '').replace(/_/g, ' ')), h('div', { class: 'as-sub' }, `decal · ${m.name}`));
        t.addEventListener('click', () => {
          ed.decalTool.material = m.name;
          ed.pick.decals = true;
          ed.tool = 'decal';
          ed.emit('tool');
        });
        this.grid.append(t);
      }
    }
    if (!['entities', 'scatter', 'splines', 'decals', 'blockout', 'prefabs'].includes(this.cat)) {
      const list = ed.assets.search(this.query, { category: this.cat === 'all' ? undefined : this.cat, includeUnique: this.unique });
      for (const a of list.slice(0, 400)) {
        const b = a.bounds;
        const size = b ? `${(b.max[0] - b.min[0]).toFixed(1)}×${(b.max[1] - b.min[1]).toFixed(1)}×${(b.max[2] - b.min[2]).toFixed(1)} m` : '';
        tile(a.id, a.name, `${a.id.split('/')[0]} · ${size}`, a.category, a.path ? { kind: 'asset', path: a.path } : undefined);
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
