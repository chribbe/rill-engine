import './editor.css';
import { createRuntime } from '../app/runtime';
import { AssetRegistry } from './assets';
import { Editor } from './editor';
import { Viewport } from './viewport';
import { BlenderBridge } from './bridge';
import { EditorTools } from './api';
import { buildLayout, buildStatusBar, buildToolbar } from './ui/layout';
import { Outliner } from './ui/outliner';
import { Inspector } from './ui/inspector';
import { AssetsPanel, ConsolePanel, DebugPanel, EnvironmentPanel, MaterialsPanel } from './ui/panels';
import { h } from './ui/dom';

/**
 * Editor entry (index.html): the game runtime with the editor on top. The
 * viewport renders through the same renderer and world as play mode; editing
 * goes through editor operations only. Automation: window.rill.editor.
 */
async function main() {
  const root = document.getElementById('ed')!;
  const loading = document.getElementById('loading')!;
  const canvas = h('canvas', { id: 'view' });
  const slots = buildLayout(root, canvas);
  const rt = await createRuntime(canvas, { onProgress: (m) => (loading.textContent = m) });
  rt.player.enabled = false;
  if (rt.stats.visible) rt.stats.toggle();
  const assets = await AssetRegistry.load();
  const ed = new Editor(rt, assets);
  const vp = new Viewport(ed, slots.view, canvas);
  const bridge = new BlenderBridge(ed);
  const tools = new EditorTools(ed, bridge);

  buildToolbar(document.getElementById('ed-toolbar')!, ed, vp, bridge, tools);
  const outliner = new Outliner(ed);
  outliner.onFocus = () => vp.focus();
  slots.left.append(outliner.el);
  slots.right.append(new Inspector(ed).el);
  slots.addTab('Assets', new AssetsPanel(ed).el);
  slots.addTab('Materials', new MaterialsPanel(ed).el);
  slots.addTab('Environment', new EnvironmentPanel(ed, vp).el);
  slots.addTab('Debug', new DebugPanel(ed).el);
  slots.addTab('Console', new ConsolePanel(ed, tools).el);
  buildStatusBar(document.getElementById('ed-status')!, ed);

  // Datalists for inspector fields.
  const matList = h('datalist', { id: 'rill-materials' });
  const semList = h('datalist', { id: 'rill-semantics' });
  document.body.append(matList, semList);
  const fillLists = () => {
    matList.replaceChildren(...ed.materials.filter((m) => !m.decal).map((m) => h('option', { value: m.name })));
    const sems = new Set(['building', 'streetlight', 'tree', 'vegetation', 'road', 'path', 'retaining_wall', 'station', 'prop', 'terrain', 'decal', 'bench', 'fence', 'vehicle', 'sign', 'light', ...ed.scene.entities.map((e) => e.semantic).filter((s): s is string => !!s)]);
    semList.replaceChildren(...[...sems].sort().map((s) => h('option', { value: s })));
  };
  ed.on('status', fillLists);
  fillLists();

  // Editor camera: last view of this map, else the player start.
  const camKey = `rill.editor.camera.${ed.mapName}`;
  try {
    const c = JSON.parse(localStorage.getItem(camKey) ?? 'null');
    if (c) {
      rt.camera.position[0] = c.p[0]; rt.camera.position[1] = c.p[1]; rt.camera.position[2] = c.p[2];
      rt.camera.yaw = c.yaw; rt.camera.pitch = c.pitch;
    }
  } catch { /* ignore */ }
  setInterval(() => {
    if (ed.mode !== 'edit') return;
    const c = rt.camera;
    try { localStorage.setItem(camKey, JSON.stringify({ p: Array.from(c.position), yaw: c.yaw, pitch: c.pitch })); } catch { /* ignore */ }
  }, 1500);

  rt.hooks.update = (dt) => {
    if (ed.mode === 'play') {
      rt.player.update(dt);
      rt.world.update(dt, rt.player.feet);
      rt.sandbox.update(dt);
    } else {
      vp.updateCamera(dt);
      rt.renderer.particles.update(dt);
    }
  };
  // Renderables appear asynchronously (asset loads, undo of a delete): refresh the outline a few times a second.
  let n = 0;
  rt.hooks.afterRender = () => {
    if (++n % 8 === 0) ed.updateHighlight();
    vp.draw();
  };

  window.addEventListener('beforeunload', (e) => {
    if (ed.history.dirty) e.preventDefault();
  });
  // Console mirror of runtime warnings.
  const warn = console.warn.bind(console);
  console.warn = (...a: unknown[]) => { warn(...a); ed.log('warn', a.map(String).join(' ')); };

  (window as unknown as { rill: unknown }).rill = {
    ...rt.api,
    editor: { ed, vp, tools, bridge, call: tools.call.bind(tools), exec: ed.exec.bind(ed), list: tools.list.bind(tools) },
  };
  await rt.prewarm();
  loading.remove();
  ed.log('info', `Editor ready: ${ed.mapName} (${ed.scene.entities.length} entities, ${assets.all.length} assets). Type 'help' for tools.`);
  rt.start();
}

main().catch((e) => {
  console.error(e);
  const el = document.getElementById('fatal')!;
  el.textContent = `Failed to start:\n${e?.stack ?? e}`;
  el.style.display = 'block';
  document.getElementById('loading')?.remove();
});
