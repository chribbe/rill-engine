import type { Editor, Tool } from '../editor';
import type { Viewport } from '../viewport';
import type { BlenderBridge } from '../bridge';
import type { EditorTools } from '../api';
import { checkbox, h, select } from './dom';

/**
 * Editor chrome: toolbar, resizable panel layout (sizes remembered), bottom
 * tabs and status bar. Panels are mounted into the slots it returns.
 */

export interface Slots {
  left: HTMLElement;
  right: HTMLElement;
  view: HTMLElement;
  addTab(name: string, el: HTMLElement): void;
}

export function buildLayout(root: HTMLElement, canvas: HTMLCanvasElement): Slots {
  const left = h('div', { class: 'ed-left panel' });
  const right = h('div', { class: 'ed-right panel' });
  const view = h('div', { class: 'ed-view' }, canvas);
  const tabsBar = h('div', { class: 'tabs' });
  const tabBody = h('div', { class: 'tab-body' });
  const bottom = h('div', { class: 'ed-bottom panel' }, tabsBar, tabBody);
  const sv1 = h('div', { class: 'split v' }), sv2 = h('div', { class: 'split v' }), sh = h('div', { class: 'split h' });
  const top = h('div', { class: 'ed-top' }, left, sv1, view, sv2, right);
  root.append(top, sh, bottom);

  const key = 'rill.editor.layout';
  const sizes = { left: 290, right: 330, bottom: 250, ...(() => { try { return JSON.parse(localStorage.getItem(key) ?? '{}'); } catch { return {}; } })() };
  const apply = () => {
    root.style.setProperty('--left', `${sizes.left}px`);
    root.style.setProperty('--right', `${sizes.right}px`);
    root.style.setProperty('--bottom', `${sizes.bottom}px`);
  };
  apply();
  const drag = (el: HTMLElement, fn: (dx: number, dy: number) => void) => {
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      let x = e.clientX, y = e.clientY;
      const move = (ev: PointerEvent) => { fn(ev.clientX - x, ev.clientY - y); x = ev.clientX; y = ev.clientY; apply(); };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        try { localStorage.setItem(key, JSON.stringify(sizes)); } catch { /* ignore */ }
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
  };
  drag(sv1, (dx) => (sizes.left = Math.max(160, Math.min(700, sizes.left + dx))));
  drag(sv2, (dx) => (sizes.right = Math.max(220, Math.min(800, sizes.right - dx))));
  drag(sh, (_dx, dy) => (sizes.bottom = Math.max(90, Math.min(window.innerHeight - 200, sizes.bottom - dy))));

  const tabs = new Map<string, { btn: HTMLElement; el: HTMLElement }>();
  const show = (name: string) => {
    for (const [n, t] of tabs) {
      t.btn.classList.toggle('on', n === name);
      t.el.style.display = n === name ? '' : 'none';
    }
    try { localStorage.setItem('rill.editor.tab', name); } catch { /* ignore */ }
  };
  return {
    left, right, view,
    addTab(name, el) {
      const btn = h('div', { class: 'tab', onclick: () => show(name) }, name);
      tabsBar.append(btn);
      tabBody.append(el);
      tabs.set(name, { btn, el });
      const want = localStorage.getItem('rill.editor.tab') ?? 'Assets';
      show(tabs.has(want) ? want : [...tabs.keys()][0]);
    },
  };
}

export function buildToolbar(root: HTMLElement, ed: Editor, vp: Viewport, bridge: BlenderBridge, tools: EditorTools) {
  const btn = (label: string, title: string, fn: () => void, cls = '') => h('button', { class: `tb ${cls}`, title, onclick: fn }, label);
  const maps = select([ed.mapName], ed.mapName, (v) => {
    if (ed.history.dirty && !confirm('Discard unsaved changes?')) { maps.value = ed.mapName; return; }
    location.search = `?map=${encodeURIComponent(v)}`;
  });
  fetch('/__editor/maps').then((r) => r.json()).then((list: { name: string }[]) => {
    maps.replaceChildren(...list.map((m) => h('option', { value: m.name }, m.name)));
    maps.value = ed.mapName;
  }).catch(() => {});
  const save = btn('Save', 'Save the map (Cmd/Ctrl+S)', () => void ed.save());
  const reload = btn('Reload', 'Reload the map from disk (discards unsaved edits)', () => {
    if (!ed.history.dirty || confirm('Discard unsaved changes and reload from disk?')) void ed.reload();
  });
  const saveAs = btn('Save as…', 'Save a copy as a new map (the original stays untouched)', async () => {
    const name = prompt('New map name (letters, digits, _ and -):', `${ed.mapName}_copy`);
    if (!name) return;
    if (!/^[\w-]+$/.test(name)) { ed.log('error', `Bad map name '${name}'`); return; }
    try {
      const m = await ed.saveAs(name);
      ed.history.markSaved();
      if (confirm(`Saved as '${m}'. Open it now?`)) location.search = `?map=${encodeURIComponent(m)}`;
    } catch (e) {
      ed.log('error', `Save as: ${(e as Error).message}`);
    }
  });
  const backups = btn('Backups…', 'Earlier saved versions of this map (every save keeps the previous one)', async () => {
    const list = await ed.backups();
    showMenu(backups, list.length ? list.map((b) => ({
      label: `${b.file.replace(/\.json$/, '')}   ${new Date(b.time).toLocaleString()}   ${(b.bytes / 1024).toFixed(0)} KB`,
      run: () => {
        if (ed.history.dirty && !confirm('Discard unsaved changes and load this backup?')) return;
        ed.restoreBackup(b.file).catch((e) => ed.log('error', (e as Error).message));
      },
    })) : [{ label: 'No backups yet (made on every save)', run: () => {} }]);
  });
  const undo = btn('↶', 'Undo (Cmd/Ctrl+Z)', () => ed.undo());
  const redo = btn('↷', 'Redo (Cmd/Ctrl+Shift+Z)', () => ed.redo());
  const toolBtns: Record<Tool, HTMLElement> = {
    select: btn('Select', 'Select (Q)', () => setTool('select')),
    translate: btn('Move', 'Move (W)', () => setTool('translate')),
    rotate: btn('Rotate', 'Rotate (E)', () => setTool('rotate')),
    scale: btn('Scale', 'Scale (R)', () => setTool('scale')),
    decal: btn('Decal', 'Place decals (T): click a surface, drag to paint a trail; [ ] size. Pick a decal material in Assets > decals', () => { ed.pick.decals = true; setTool('decal'); }),
    spline: btn('Spline', 'Draw paths, roads, kerbs, fences, rail track (N): click points on the ground, Enter / Esc to finish, Backspace removes the last point; drag the points of a selected spline', () => setTool('spline')),
    sculpt: btn('Sculpt', 'Sculpt / paint the terrain (G): raise, lower, smooth, flatten, ground paint; Shift inverts; [ ] brush size', () => setTool('sculpt')),
    paint: btn('Paint', 'Paint vegetation / rocks (B): drag to paint the selected scatter (or start a new one), Shift erases, [ ] brush size', () => setTool('paint')),
  };
  const setTool = (t: Tool) => { ed.tool = t; ed.emit('tool'); };
  const space = btn('World', 'Gizmo axes: world / local (X)', () => { ed.space = ed.space === 'world' ? 'local' : 'world'; ed.emit('tool'); });
  const snapChk = checkbox(ed.snap.enabled, (v) => { ed.snap.enabled = v; ed.emit('tool'); }, 'Snap', 'Snapping (hold Cmd/Ctrl while dragging to invert)');
  const grids = ['0.015625', '0.03125', '0.0625', '0.125', '0.25', '0.5', '1', '2', '4', '8', '16'];
  const grid = select(grids, String(ed.snap.grid), (v) => { ed.snap.grid = +v; ed.emit('tool'); }, Object.fromEntries(grids.map((g) => [g, `${+g >= 1 ? g : (+g * 100).toFixed(+g < 0.1 ? 2 : 1).replace(/\.?0+$/, '')}${+g >= 1 ? ' m' : ' cm'}`])));
  grid.title = 'Grid step ([ / ])';
  const angle = select(['1', '5', '15', '45', '90'], String(ed.snap.angle), (v) => { ed.snap.angle = +v; }, { 1: '1°', 5: '5°', 15: '15°', 45: '45°', 90: '90°' });
  angle.title = 'Rotation snap';
  const playFrom = select(['camera', 'spawn'], 'camera', () => {}, { camera: 'from camera', spawn: 'from player start' });
  const play = btn('▶ Play', 'Play (F5) - walk the edited world; F5 / Esc to stop', () => (ed.mode === 'play' ? ed.stop() : ed.play(playFrom.value as 'camera' | 'spawn')), 'play');
  const bake = btn('Bake lighting', 'Save + bake lightmaps and probes with Blender/Cycles (background job)', () => {
    if (bridge.job?.status === 'running') {
      if (confirm('Cancel the running bake?')) void bridge.cancel();
      return;
    }
    bridge.bakeLighting().catch((e) => ed.log('error', `Bake: ${(e as Error).message}`));
  });
  const capture = btn('Capture', 'Save a 1600×900 render of the view to screenshots/ (capture_view)', async () => {
    const r = await tools.captureView({ width: 1600, height: 900, save: `capture_${ed.mapName}_${Date.now()}`, image: false });
    ed.log('info', `Captured ${r.file}`);
  });
  const status = h('span', { class: 'tb-status' });
  root.append(h('div', { class: 'toolbar' },
    h('span', { class: 'tb-brand' }, 'Rill'), maps, save, saveAs, backups, reload, h('span', { class: 'tb-sep' }), undo, redo, h('span', { class: 'tb-sep' }),
    ...Object.values(toolBtns), space, snapChk, grid, angle, h('span', { class: 'tb-sep' }), play, playFrom, h('span', { class: 'tb-sep' }), bake, capture, status));

  const refresh = () => {
    for (const [t, b] of Object.entries(toolBtns)) b.classList.toggle('on', ed.tool === t);
    space.textContent = ed.space === 'world' ? 'World' : 'Local';
    grid.value = String(ed.snap.grid);
    (snapChk.querySelector('input') as HTMLInputElement).checked = ed.snap.enabled;
    save.classList.toggle('dirty', ed.history.dirty);
    save.textContent = ed.history.dirty ? 'Save •' : 'Save';
    undo.toggleAttribute('disabled', !ed.history.canUndo);
    redo.toggleAttribute('disabled', !ed.history.canRedo);
    undo.title = ed.history.canUndo ? `Undo ${ed.history.undoStack[ed.history.undoStack.length - 1].label} (Cmd/Ctrl+Z)` : 'Undo';
    redo.title = ed.history.canRedo ? `Redo ${ed.history.redoStack[ed.history.redoStack.length - 1].label}` : 'Redo';
    play.textContent = ed.mode === 'play' ? '■ Stop' : '▶ Play';
    play.classList.toggle('on', ed.mode === 'play');
    const j = bridge.job;
    if (j?.status === 'running') {
      const s = Math.round((Date.now() - j.startedAt) / 1000);
      const pr = bridge.progress;
      bake.textContent = `Baking${pr ? ` ${Math.min(pr.done, pr.total)}/${pr.total}` : '…'} ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      bake.classList.add('busy');
    } else {
      bake.textContent = 'Bake lighting';
      bake.classList.remove('busy');
    }
    const w = ed.rt.world;
    status.textContent = [w.lightingStale ? 'lighting stale - re-bake' : '', w.pendingLoads ? `loading ${w.pendingLoads}…` : ''].filter(Boolean).join(' · ');
  };
  for (const ev of ['tool', 'history', 'mode', 'status', 'scene'] as const) ed.on(ev, refresh);
  setInterval(refresh, 1000);
  refresh();
  void vp;
}

/** Small dropdown menu under an element; closes on any outside click. */
export function showMenu(anchor: HTMLElement, items: { label: string; run: () => void }[]) {
  document.querySelector('.menu')?.remove();
  const r = anchor.getBoundingClientRect();
  const m = h('div', { class: 'menu', style: `left:${r.left}px;top:${r.bottom + 2}px` },
    ...items.map((it) => h('div', { class: 'menu-item', onclick: () => { m.remove(); it.run(); } }, it.label)));
  document.body.append(m);
  setTimeout(() => document.addEventListener('pointerdown', function close(e) {
    if (!m.contains(e.target as Node)) { m.remove(); document.removeEventListener('pointerdown', close); }
  }), 0);
}

export function buildStatusBar(root: HTMLElement, ed: Editor) {
  const el = h('div', { class: 'statusbar' });
  root.append(el);
  const refresh = () => {
    const p = ed.primary;
    const sel = ed.selection.length ? `${ed.selection.length} selected · ${p?.name ?? p?.id} (${p?.type}${p?.semantic ? `, ${p.semantic}` : ''})` : 'Nothing selected';
    el.textContent = `${sel}   ·   ${ed.scene.entities.length} entities   ·   ${ed.mapName}${ed.history.dirty ? ' (unsaved)' : ''}   ·   RMB look + WASD fly · MMB pan · Alt+LMB orbit · wheel dolly · F frame · W/E/R tools · Cmd+D duplicate · Del delete · F5 play`;
  };
  for (const ev of ['selection', 'history', 'scene'] as const) ed.on(ev, refresh);
  refresh();
}
