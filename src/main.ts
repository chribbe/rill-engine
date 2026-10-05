import { DEBUG_VIEWS } from './engine/render/renderer';
import { createPlayground } from './engine/ui/playground';
import { createRuntime, PRESETS } from './app/runtime';
import { Game } from './game/game';

/**
 * Standalone game view (play.html): the runtime with the renderer playground,
 * no editor. The editor (index.html) runs the same runtime with its own UI.
 */
async function main() {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const loading = document.getElementById('loading')!;
  const hint = document.getElementById('hint')!;
  const rt = await createRuntime(canvas, { onProgress: (m) => (loading.textContent = m) });
  const { renderer, world, player, sandbox, stats, api } = rt;

  const capture = async () => {
    const blob = await renderer.capture();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `rill-${rt.env.state.name}-${Date.now()}.png`;
    a.click();
  };
  const sp = world.spawn();
  const bookmarks: Record<string, () => void> = { Spawn: () => player.teleport(sp.position, sp.yaw, sp.pitch) };
  for (const o of world.viewpoints()) {
    const q = o.transform;
    bookmarks[o.name ?? o.id] = () => {
      player.fly = true;
      player.teleport([q.position[0], q.position[1], q.position[2]], o.yaw ?? 0, o.pitch ?? 0);
    };
  }
  // Right-hand panel column: gameplay tuning on top, the renderer playground (collapsed) below.
  const column = document.createElement('div');
  column.id = 'panels';
  document.body.append(column);
  const gui = createPlayground(renderer, rt.env, player, {
    setPreset: rt.setPreset,
    stress: api.stress,
    clearStress: api.clearStress,
    capture,
    bookmarks,
  }, { container: column });
  // The game layer (?game=0: the plain viewer with the sandbox weapon).
  let game: Game | null = null;
  if (rt.params.get('game') !== '0') {
    game = new Game(rt);
    await game.init({ panel: column });
    column.prepend(game.panel!.gui.domElement);
    gui.close();
    rt.hooks.update = game.update;
  }

  // Fire (sandbox weapon) while the mouse is captured.
  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 0 && document.pointerLockElement === canvas) sandbox.trigger = true;
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) sandbox.trigger = false;
  });
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement !== canvas) sandbox.trigger = false;
  });
  const viewNames = Object.keys(DEBUG_VIEWS);
  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    if (e.code.startsWith('Digit')) {
      const i = parseInt(e.code.slice(5), 10) - 1;
      if (i >= 0 && i < PRESETS.length) rt.setPreset(PRESETS[i]).then(() => gui.controllersRecursive().forEach((c) => c.updateDisplay()));
    }
    if (e.code === 'KeyV') {
      const cur = viewNames.findIndex((n) => DEBUG_VIEWS[n] === renderer.settings.debugView);
      const next = (cur + (e.shiftKey ? viewNames.length - 1 : 1)) % viewNames.length;
      renderer.settings.debugView = DEBUG_VIEWS[viewNames[next]];
      showHint(`View: ${viewNames[next]}`);
    }
    if (e.code === 'Tab') {
      e.preventDefault();
      stats.toggle();
    }
    if (e.code === 'KeyH') {
      gui.show(gui._hidden);
      game?.panel?.gui.show(gui._hidden === false);
    }
    if (e.code === 'KeyP') capture();
    if (e.code === 'KeyB') renderer.settings.bounds = !renderer.settings.bounds;
    if (e.code === 'KeyL') sandbox.toggleFlashlight();
    if (e.code === 'KeyX' && !game) sandbox.toggleWeapon();
    if (e.code === 'KeyG') renderer.settings.wireframe = !renderer.settings.wireframe;
    if (e.code === 'KeyM') {
      renderer.settings.msaa = !renderer.settings.msaa;
      showHint(`MSAA ${renderer.settings.msaa ? 'on' : 'off'}`);
    }
  });
  let hintTimer = 0;
  const showHint = (t: string) => {
    hint.textContent = t;
    hint.style.opacity = '1';
    clearTimeout(hintTimer);
    hintTimer = window.setTimeout(() => (hint.style.opacity = '0'), 2500);
  };
  setTimeout(() => (hint.style.opacity = '0'), 8000);

  (window as unknown as { rill: typeof api & { game: Game | null } }).rill = Object.assign(api, { game });
  await rt.prewarm();
  loading.remove();
  rt.start();
}

main().catch((e) => {
  console.error(e);
  const el = document.getElementById('fatal')!;
  el.textContent = `Failed to start:\n${e?.stack ?? e}`;
  el.style.display = 'block';
  document.getElementById('loading')?.remove();
});
