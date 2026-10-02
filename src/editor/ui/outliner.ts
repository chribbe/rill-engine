import type { Editor } from '../editor';
import { h, ICONS } from './dom';

/**
 * Scene hierarchy: a virtualised tree over the document's outliner hierarchy
 * (thousands of entities stay cheap). Click selects (Shift range, Cmd/Ctrl
 * toggle), double-click frames, drag rows onto another row to re-parent
 * (or onto the empty area for top level), eye / lock toggles per row.
 */

const ROW = 20;

export class Outliner {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private spacer: HTMLElement;
  private rowsEl: HTMLElement;
  private search: HTMLInputElement;
  private expanded: Set<string>;
  private rows: { id: string; depth: number; kids: boolean }[] = [];
  private anchor: string | null = null;
  private dirty = true;
  private filter = '';
  private countEl: HTMLElement;

  constructor(readonly ed: Editor) {
    const saved = localStorage.getItem(`rill.outliner.${ed.mapName}`);
    this.expanded = new Set(saved ? (JSON.parse(saved) as string[]) : []);
    this.search = h('input', { type: 'search', placeholder: 'Filter (name, id, semantic, type)…', class: 'ol-search' });
    this.search.addEventListener('input', () => { this.filter = this.search.value.trim().toLowerCase(); this.dirty = true; this.schedule(); });
    this.search.addEventListener('keydown', (e) => e.stopPropagation());
    this.spacer = h('div', { class: 'ol-spacer' });
    this.rowsEl = h('div', { class: 'ol-rows' });
    this.list = h('div', { class: 'ol-list' }, this.spacer, this.rowsEl);
    this.list.addEventListener('scroll', () => this.render());
    this.list.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('application/x-rill-entities')) e.preventDefault(); });
    this.list.addEventListener('drop', (e) => {
      const ids = e.dataTransfer?.getData('application/x-rill-entities');
      if (!ids || (e.target as HTMLElement).closest('.ol-row')) return;
      e.preventDefault();
      ed.tryExec('reparent_entity', { ids: JSON.parse(ids), parent: null });
    });
    this.countEl = h('span', { class: 'ol-count' });
    this.el = h('div', { class: 'outliner' },
      h('div', { class: 'panel-head' }, h('span', {}, 'Scene'), this.countEl,
        h('button', { class: 'mini', title: 'Collapse all', onclick: () => { this.expanded.clear(); this.persist(); this.dirty = true; this.schedule(); } }, '⊟')),
      this.search, this.list);
    ed.on('scene', () => { this.dirty = true; this.schedule(); });
    ed.on('selection', () => { this.reveal(); this.schedule(); });
    new ResizeObserver(() => this.render()).observe(this.list);
    this.schedule();
  }

  private raf = 0;
  private schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (this.dirty) this.flatten();
      this.render();
    });
  }

  private persist() {
    try { localStorage.setItem(`rill.outliner.${this.ed.mapName}`, JSON.stringify([...this.expanded])); } catch { /* private mode */ }
  }

  private matches(id: string) {
    const e = this.ed.scene.get(id)!;
    const f = this.filter;
    return e.id.toLowerCase().includes(f) || (e.name ?? '').toLowerCase().includes(f) || (e.semantic ?? '').toLowerCase().includes(f) || e.type.toLowerCase() === f || (e.tags ?? []).some((t) => t.toLowerCase().includes(f));
  }

  private flatten() {
    this.dirty = false;
    const sc = this.ed.scene;
    const out: typeof this.rows = [];
    if (this.filter) {
      // Matches plus their ancestors, everything expanded.
      const keep = new Set<string>();
      for (const e of sc.entities) if (this.matches(e.id)) { keep.add(e.id); for (const a of sc.ancestors(e.id)) keep.add(a); }
      const walk = (id: string, depth: number) => {
        for (const c of sc.children(id)) {
          if (!keep.has(c)) continue;
          const kids = sc.children(c).some((k) => keep.has(k));
          out.push({ id: c, depth, kids });
          walk(c, depth + 1);
        }
      };
      walk('', 0);
    } else {
      const walk = (id: string, depth: number) => {
        for (const c of sc.children(id)) {
          const kids = sc.children(c).length > 0;
          out.push({ id: c, depth, kids });
          if (kids && this.expanded.has(c)) walk(c, depth + 1);
        }
      };
      walk('', 0);
    }
    this.rows = out;
    this.spacer.style.height = `${out.length * ROW}px`;
    this.countEl.textContent = `${sc.entities.length}`;
  }

  /** Expands ancestors of the selection and scrolls the primary into view. */
  private reveal() {
    const id = this.ed.selection[this.ed.selection.length - 1];
    if (!id) return;
    let changed = false;
    for (const a of this.ed.scene.ancestors(id)) if (!this.expanded.has(a)) { this.expanded.add(a); changed = true; }
    if (changed) { this.persist(); this.flatten(); }
    else if (this.dirty) this.flatten();
    const i = this.rows.findIndex((r) => r.id === id);
    if (i < 0) return;
    const top = i * ROW, vh = this.list.clientHeight;
    if (top < this.list.scrollTop || top + ROW > this.list.scrollTop + vh) this.list.scrollTop = Math.max(0, top - vh / 2);
  }

  private render() {
    const sc = this.ed.scene;
    const st = this.list.scrollTop, vh = this.list.clientHeight || 400;
    const i0 = Math.max(0, Math.floor(st / ROW) - 4), i1 = Math.min(this.rows.length, Math.ceil((st + vh) / ROW) + 4);
    const sel = new Set(this.ed.selection);
    const frag = document.createDocumentFragment();
    for (let i = i0; i < i1; i++) {
      const r = this.rows[i];
      const e = sc.get(r.id);
      if (!e) continue;
      const hidden = e.visible === false, locked = e.locked === true;
      const effHidden = !hidden && !sc.effectiveVisible(r.id);
      const row = h('div', {
        class: `ol-row${sel.has(r.id) ? ' sel' : ''}${hidden || effHidden ? ' hidden' : ''}${sc.effectiveLocked(r.id) ? ' locked' : ''}`,
        style: `top:${i * ROW}px;padding-left:${4 + r.depth * 14}px`,
        draggable: true,
        title: `${e.id}${e.semantic ? ` · ${e.semantic}` : ''}`,
      },
        h('span', { class: 'ol-twisty', onclick: (ev: MouseEvent) => { ev.stopPropagation(); this.toggle(r.id); } }, r.kids ? (this.expanded.has(r.id) || this.filter ? '▾' : '▸') : ''),
        h('span', { class: `ol-icon t-${e.type}` }, ICONS[e.type] ?? '•'),
        h('span', { class: 'ol-name' }, e.name ?? e.id),
        h('span', { class: `ol-tog${hidden ? ' on' : ''}`, title: hidden ? 'Show' : 'Hide', onclick: (ev: MouseEvent) => { ev.stopPropagation(); this.ed.tryExec('set_visibility', { ids: this.idsFor(r.id), visible: hidden }); } }, hidden ? '◌' : '◉'),
        h('span', { class: `ol-tog${locked ? ' on' : ''}`, title: locked ? 'Unlock' : 'Lock (not pickable, transforms protected)', onclick: (ev: MouseEvent) => { ev.stopPropagation(); this.ed.tryExec('set_locked', { ids: this.idsFor(r.id), locked: !locked }); } }, locked ? '🔒' : '·'),
      );
      row.addEventListener('click', (ev) => this.click(r.id, ev));
      row.addEventListener('dblclick', () => { this.ed.select(r.id); this.onFocus?.(); });
      row.addEventListener('dragstart', (ev) => {
        const ids = sel.has(r.id) ? this.ed.selectionRoots : [r.id];
        ev.dataTransfer!.setData('application/x-rill-entities', JSON.stringify(ids));
        ev.dataTransfer!.effectAllowed = 'move';
      });
      row.addEventListener('dragover', (ev) => {
        if (!ev.dataTransfer?.types.includes('application/x-rill-entities')) return;
        ev.preventDefault();
        row.classList.add('drop');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop'));
      row.addEventListener('drop', (ev) => {
        ev.preventDefault();
        row.classList.remove('drop');
        const ids = JSON.parse(ev.dataTransfer!.getData('application/x-rill-entities')) as string[];
        if (ids.includes(r.id)) return;
        this.ed.tryExec('reparent_entity', { ids, parent: r.id });
        this.expanded.add(r.id);
        this.persist();
      });
      frag.append(row);
    }
    this.rowsEl.replaceChildren(frag);
  }

  /** Row toggles act on the whole selection when the row is part of it. */
  private idsFor(id: string) {
    return this.ed.selection.includes(id) ? this.ed.selection : [id];
  }

  onFocus: (() => void) | null = null;

  private toggle(id: string) {
    if (this.expanded.has(id)) this.expanded.delete(id);
    else this.expanded.add(id);
    this.persist();
    this.dirty = true;
    this.schedule();
  }

  private click(id: string, ev: MouseEvent) {
    const ed = this.ed;
    if (ev.shiftKey && this.anchor) {
      const a = this.rows.findIndex((r) => r.id === this.anchor), b = this.rows.findIndex((r) => r.id === id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        ed.setSelection([...this.rows.slice(lo, hi + 1).map((r) => r.id).filter((x) => x !== id), id]);
        return;
      }
    }
    if (ev.metaKey || ev.ctrlKey) ed.select(id, 'toggle');
    else ed.select(id);
    this.anchor = id;
  }
}
