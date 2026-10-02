import type { Editor } from '../editor';
import { checkbox, clear, h, numberField, select } from './dom';

/**
 * Floating settings for the active world-building tool (top right of the
 * viewport): scatter brush, sculpt brush, decal stamp, spline preset.
 */
export class ToolOptions {
  readonly el: HTMLElement;

  constructor(readonly ed: Editor) {
    this.el = h('div', { class: 'toolopts' });
    // Keep viewport shortcuts out of the panel's inputs.
    this.el.addEventListener('keydown', (e) => e.stopPropagation());
    ed.on('tool', () => this.render());
    ed.on('status', () => this.render());
    this.render();
  }

  private render() {
    const ed = this.ed;
    clear(this.el);
    const row = (label: string, ...f: (HTMLElement | string)[]) => h('div', { class: 'to-row' }, h('span', { class: 'to-label' }, label), ...f);
    const num = (label: string, value: number, step: number, prec: number, set: (v: number) => void) =>
      numberField({ label, value, step, precision: prec, onCommit: set, onScrub: (v, done) => { set(v); if (done) this.render(); } });
    let body: HTMLElement[] = [];
    let title = '';
    switch (ed.tool) {
      case 'paint': {
        title = 'Scatter brush';
        const names = ed.scatterPresets.map((p) => p.name);
        body = [
          row('Preset', select(names.length ? names : [ed.brush.preset], ed.brush.preset, (v) => {
            ed.brush.preset = v;
            if (ed.primary?.type === 'scatter' && ed.primary.scatter.preset !== v) ed.setSelection([]);
            ed.emit('tool');
          }, Object.fromEntries(ed.scatterPresets.map((p) => [p.name, p.title])))),
          row('Radius', num('m', ed.brush.radius, 0.1, 1, (v) => (ed.brush.radius = Math.max(0.5, Math.min(80, v))))),
          row('', checkbox(ed.brush.erase, (v) => { ed.brush.erase = v; ed.emit('tool'); }, 'Erase (or hold Shift)')),
          h('div', { class: 'to-note' }, ed.primary?.type === 'scatter' ? `Painting into ${ed.primary.name ?? ed.primary.id}` : 'The first stroke starts a new scatter'),
        ];
        break;
      }
      case 'sculpt': {
        title = 'Terrain sculpt';
        const modes: [string, string][] = [['raise', 'Raise'], ['lower', 'Lower'], ['smooth', 'Smooth'], ['flatten', 'Flatten'], ['paint', 'Paint ground'], ['unpaint', 'Unpaint']];
        body = [
          h('div', { class: 'to-modes' }, ...modes.map(([m, l]) => h('button', { class: `mini${ed.sculpt.mode === m ? ' on' : ''}`, onclick: () => { ed.sculpt.mode = m as typeof ed.sculpt.mode; ed.emit('tool'); } }, l))),
          row('Radius', num('m', ed.sculpt.radius, 0.1, 1, (v) => (ed.sculpt.radius = Math.max(0.5, Math.min(60, v))))),
          row('Strength', num('', ed.sculpt.strength, 0.01, 2, (v) => (ed.sculpt.strength = Math.max(0.01, Math.min(2, v))))),
          h('div', { class: 'to-note' }, ed.sculpt.mode === 'flatten' ? 'Flattens towards the height where the drag starts' : ed.sculpt.mode.includes('paint') ? 'Paints the ground blend layer (forest floor / worn earth)' : 'Shift inverts raise / lower'),
        ];
        break;
      }
      case 'decal': {
        title = 'Decal stamp';
        const names = ed.materials.filter((m) => m.decal && !m.name.startsWith('decal_bullet')).map((m) => m.name);
        const dt = ed.decalTool;
        body = [
          row('Material', select(names.length ? names : [dt.material], dt.material, (v) => { dt.material = v; ed.emit('tool'); })),
          row('Size', num('m', dt.size, 0.01, 2, (v) => (dt.size = Math.max(0.1, Math.min(20, v))))),
          row('Jitter', num('±', dt.jitter, 0.01, 2, (v) => (dt.jitter = Math.max(0, Math.min(0.9, v))))),
          row('Spacing', num('m', dt.spacing, 0.05, 2, (v) => (dt.spacing = Math.max(0.1, v)))),
          row('', checkbox(dt.randomRoll, (v) => { dt.randomRoll = v; }, 'Random rotation')),
        ];
        break;
      }
      case 'spline': {
        title = 'Spline';
        const names = ed.splinePresets.map((p) => p.name);
        const st = ed.splineTool;
        body = [
          row('Preset', select(names.length ? names : [st.preset], st.preset, (v) => { st.preset = v; ed.emit('tool'); }, Object.fromEntries(ed.splinePresets.map((p) => [p.name, p.title])))),
          h('div', { class: 'to-note' }, 'Click points on the ground; Enter / Esc finishes; Backspace removes the last point'),
        ];
        break;
      }
    }
    this.el.style.display = body.length ? '' : 'none';
    if (body.length) this.el.append(h('div', { class: 'to-title' }, title), ...body);
  }
}
