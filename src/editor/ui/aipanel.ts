import type { AiLayer } from '../ai';
import type { HistoryEntry } from '../commands';
import { checkbox, clear, h } from './dom';

/**
 * AI tab: whether an agent is connected, the scope it may work in, its
 * changesets (pending review: Show / Accept / Revert; open: Stop) and a log of
 * its tool calls.
 */
export class AiPanel {
  readonly el: HTMLElement;
  private status: HTMLElement;
  private scopeEl: HTMLElement;
  private sets: HTMLElement;
  private log: HTMLElement;

  constructor(readonly ai: AiLayer) {
    this.status = h('div', { class: 'ai-status' });
    this.scopeEl = h('div', { class: 'ai-scope' });
    this.sets = h('div', { class: 'ai-sets' });
    this.log = h('div', { class: 'ai-log' });
    this.el = h('div', { class: 'aipanel' },
      h('div', { class: 'ai-col' }, h('div', { class: 'insp-sec-title' }, 'Agent'), this.status, h('div', { class: 'insp-sec-title' }, 'Scope for Claude'), this.scopeEl),
      h('div', { class: 'ai-col wide' }, h('div', { class: 'insp-sec-title' }, 'Changesets'), this.sets),
      h('div', { class: 'ai-col wide' }, h('div', { class: 'insp-sec-title' }, 'Tool calls'), this.log));
    ai.onChange(() => this.render());
    ai.ed.on('history', () => this.render());
    ai.ed.on('selection', () => this.renderScope());
    setInterval(() => this.renderStatus(), 1000);
    this.render();
  }

  private render() {
    this.renderStatus();
    this.renderScope();
    this.renderSets();
    this.renderLog();
  }

  private renderStatus() {
    const ai = this.ai;
    const idle = ai.lastCallAt ? Math.round((Date.now() - ai.lastCallAt) / 1000) : -1;
    const last = ai.calls[ai.calls.length - 1];
    clear(this.status);
    this.status.append(
      h('div', {}, ai.registered ? h('span', { class: 'ok' }, '● editor reachable for agents') : h('span', { class: 'warn' }, '○ no dev server (agents need npm run dev)')),
      h('div', {}, ai.calling ? h('span', { class: 'busy' }, `Claude is calling ${last?.name ?? ''}…`) : idle >= 0 ? `Last call ${idle < 60 ? `${idle} s` : `${Math.round(idle / 60)} min`} ago: ${last?.name}` : 'No agent calls yet'),
      h('div', { class: 'insp-note' }, 'Connect: start Claude Code in this repository (the rill-editor MCP server is registered in .mcp.json) and ask it to work in the open editor.'),
    );
  }

  private renderScope() {
    const ai = this.ai, s = ai.scope, ed = ai.ed;
    clear(this.scopeEl);
    const P = s.protect;
    const set = (k: keyof typeof P) => (v: boolean) => { P[k] = v; ai.changed(); };
    this.scopeEl.append(
      h('div', { class: 'ai-row' },
        h('button', { class: `mini${s.mode === 'map' ? ' on' : ''}`, onclick: () => ai.scopeToMap() }, 'Whole map'),
        h('button', { class: `mini${s.mode === 'selection' ? ' on' : ''}`, disabled: !ed.selection.length, title: 'Only the selected entities (and their children) may change; new things only around them', onclick: () => ai.scopeToSelection() }, `Selection (${ed.selectionRoots.length})`)),
      s.mode === 'selection' ? h('div', { class: 'insp-note' }, `${s.ids.length} entities${s.area ? `, area ${Math.round(s.area.max[0] - s.area.min[0])} × ${Math.round(s.area.max[1] - s.area.min[1])} m` : ''} · `, h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); ed.setSelection(s.ids); } }, 'select')) : '',
      h('div', { class: 'insp-sec-title sub' }, 'Protect'),
      checkbox(P.buildings, set('buildings'), 'Building transforms', 'No moving / rotating / scaling / deleting buildings (materials may change)'),
      checkbox(P.streets, set('streets'), 'Street layout', 'Roads, paths, kerbs, parking, squares: no moving, deleting or reshaping'),
      checkbox(P.terrain, set('terrain'), 'Terrain', 'No sculpting or ground paint'),
      checkbox(P.environment, set('environment'), 'Weather / time of day'),
    );
  }

  private renderSets() {
    const ai = this.ai;
    clear(this.sets);
    const open = ai.open;
    if (open) {
      const d = ai.describe(open);
      this.sets.append(h('div', { class: 'ai-set open' },
        h('div', { class: 'ai-set-title' }, `● ${open.changeset!.title}`, h('small', {}, ` in progress · ${d.operations} operations`)),
        open.changeset!.prompt ? h('div', { class: 'ai-prompt' }, `“${open.changeset!.prompt}”`) : null,
        h('div', { class: 'ai-lines' }, d.lines.join('   ') || 'no changes yet'),
        h('div', { class: 'ai-row' },
          h('button', { class: 'mini', title: 'End it now and review what is there', onclick: () => { ai.commit('Stopped by the user'); } }, 'Stop & review'),
          h('button', { class: 'mini', onclick: () => { if (confirm('Discard everything Claude did in this changeset?')) ai.discard(); } }, 'Discard'))));
    }
    const all = [...new Set([...ai.ed.history.undoStack.filter((e) => e.changeset), ...ai.archive])];
    const recent = all.sort((a, b) => b.time - a.time).slice(0, 20);
    if (!open && !recent.length) this.sets.append(h('div', { class: 'insp-empty' }, 'No changesets yet.'));
    for (const e of recent) this.sets.append(this.setRow(e));
  }

  private setRow(e: HistoryEntry) {
    const ai = this.ai, c = e.changeset!;
    const d = ai.describe(e);
    const pending = c.status === 'pending';
    const ids = [...d.ids.created, ...d.ids.changed].filter((id) => ai.ed.scene.has(id));
    return h('div', { class: `ai-set ${c.status}` },
      h('div', { class: 'ai-set-title' }, c.title, h('small', {}, ` · ${c.status === 'pending' ? 'waiting for review' : c.status} · ${new Date(e.time).toLocaleTimeString()}`)),
      c.prompt ? h('div', { class: 'ai-prompt' }, `“${c.prompt}”`) : null,
      c.summary ? h('div', { class: 'ai-summary' }, c.summary) : null,
      h('div', { class: 'ai-lines' }, d.lines.join('   ') || 'no changes'),
      h('div', { class: 'ai-row' },
        h('button', { class: 'mini', disabled: !ids.length, title: 'Select what it added or changed', onclick: () => { ai.ed.setSelection(ids); } }, `Show (${ids.length})`),
        pending ? h('button', { class: 'mini accept', onclick: () => ai.accept(e) }, 'Accept') : null,
        pending ? h('button', { class: 'mini revert', onclick: () => ai.revert(e) }, 'Revert') : null,
        c.status === 'accepted' ? h('button', { class: 'mini', title: 'Undo it after all', onclick: () => ai.revert(e) }, 'Revert') : null));
  }

  private renderLog() {
    clear(this.log);
    for (const c of [...this.ai.calls].reverse().slice(0, 80)) {
      this.log.append(h('div', { class: `ai-call${c.ok ? '' : ' err'}` },
        h('span', { class: 'con-t' }, `${new Date(c.time).toTimeString().slice(0, 8)} `),
        h('b', {}, c.name), ` ${c.params} `, h('small', {}, `${c.ms.toFixed(0)} ms`),
        c.error ? h('div', { class: 'ai-err' }, c.error) : null));
    }
  }
}
