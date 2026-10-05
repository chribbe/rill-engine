import type { Editor } from '../editor';
import { clear, h } from './dom';

/** Banner over the viewport while a prefab is open for editing in place: Save / Save & close / Close. */
export class PrefabBar {
  readonly el: HTMLElement;
  private timer = 0;

  constructor(readonly ed: Editor) {
    this.el = h('div', { class: 'prefabbar' });
    this.el.addEventListener('keydown', (e) => e.stopPropagation());
    ed.on('status', () => this.render());
    ed.on('history', () => this.schedule());
    this.render();
  }

  /** History events come per drag step: re-check the "changed" state at most a few times a second. */
  private schedule() {
    if (this.timer) return;
    this.timer = window.setTimeout(() => { this.timer = 0; this.render(); }, 250);
  }

  private render() {
    const ed = this.ed, s = ed.prefabs.session;
    clear(this.el);
    this.el.style.display = s ? '' : 'none';
    if (!s) return;
    const others = ed.scene.entities.filter((e) => e.type === 'prefab' && e.prefab === s.prefab).length;
    const changed = ed.prefabs.changed;
    this.el.append(
      h('span', { class: 'pb-title' }, '✎ Editing prefab ', h('b', {}, s.prefab)),
      h('span', { class: 'pb-sub' }, `${changed ? 'unsaved changes · ' : s.savedAt ? 'saved · ' : ''}${others ? `${others} other instance${others === 1 ? '' : 's'} update on save` : 'no other instances in this map'}`),
      h('button', { class: `mini${changed ? ' accept' : ''}`, disabled: !changed, title: 'Write the prefab file; every instance updates (Cmd/Ctrl+S also saves it)', onclick: () => void ed.prefabs.save() }, 'Save prefab'),
      h('button', { class: 'mini', title: 'Save, then put the instance back', onclick: () => void ed.prefabs.close({ save: true }) }, 'Save & close'),
      h('button', { class: 'mini', title: changed ? 'Put the instance back (asks about the unsaved changes)' : 'Put the instance back', onclick: () => void ed.prefabs.close() }, 'Close'),
    );
  }
}
