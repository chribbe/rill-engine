import { createGpuContext } from './engine/gpu/context';
import { Renderer, DEBUG_VIEWS, type Renderable } from './engine/render/renderer';
import { Camera } from './engine/scene/camera';
import { Environment, type EnvironmentState } from './engine/scene/environment';
import { World } from './engine/scene/world';
import { FirstPersonController } from './engine/player/controller';
import { StatsOverlay } from './engine/ui/stats';
import { createPlayground, tonemapperFromName } from './engine/ui/playground';
import { runStress, clearStress } from './stress';

async function loadPreset(name: string): Promise<EnvironmentState> {
  const r = await fetch(`/environments/${name}.json`);
  if (!r.ok) throw new Error(`Environment preset not found: ${name}`);
  return r.json();
}

function deepMerge<T>(base: T, over: Record<string, unknown> | undefined): T {
  if (!over) return base;
  const out = structuredClone(base) as Record<string, unknown>;
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>);
    else out[k] = v;
  }
  return out as T;
}

async function main() {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const loading = document.getElementById('loading')!;
  const hint = document.getElementById('hint')!;
  const params = new URLSearchParams(location.search);
  const mapName = params.get('map') ?? 'testmap';

  const gpu = await createGpuContext(canvas);
  const renderer = new Renderer(gpu);
  const camera = new Camera();

  // Exact device-pixel sizing: no CSS scaling blur.
  let cssW = window.innerWidth, cssH = window.innerHeight, dpr = window.devicePixelRatio || 1;
  let devW = Math.round(cssW * dpr), devH = Math.round(cssH * dpr);
  let sizeOverride: [number, number] | null = null;
  const applySize = () => {
    const s = renderer.settings.renderScale;
    const w = sizeOverride ? sizeOverride[0] : Math.max(1, Math.round(devW * s));
    const h = sizeOverride ? sizeOverride[1] : Math.max(1, Math.round(devH * s));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    canvas.style.imageRendering = s < 1 ? 'pixelated' : 'auto';
  };
  new ResizeObserver((entries) => {
    const e = entries[0];
    const box = e.devicePixelContentBoxSize?.[0];
    cssW = e.contentRect.width;
    cssH = e.contentRect.height;
    dpr = window.devicePixelRatio || 1;
    devW = box ? box.inlineSize : Math.round(cssW * dpr);
    devH = box ? box.blockSize : Math.round(cssH * dpr);
    applySize();
  }).observe(canvas);
  applySize();

  // Global engine textures.
  renderer.textures.load('/textures/cloud_noise.png', 'linear').then((t) => renderer.setCloudNoise(t.view)).catch(() => {});
  renderer.textures.load('/textures/debug_grid_albedo.png', 'color').then((t) => renderer.setDebugGrid(t.view)).catch(() => {});

  loading.textContent = `Loading map '${mapName}'…`;
  const world = await World.load(renderer, `/maps/${mapName}/map.json`, (m) => (loading.textContent = m));
  const env = new Environment(deepMerge(await loadPreset(world.doc.environment.preset), world.doc.environment.overrides));
  renderer.settings.tonemapper = tonemapperFromName(env.state.post.tonemapper);

  const player = new FirstPersonController(camera, canvas, world.collision);
  const sp = world.doc.spawn;
  player.teleport(sp.position, sp.yaw, sp.pitch);

  const stats = new StatsOverlay(document.body);
  const renderables: Renderable[] = world.renderables;
  const stressList: Renderable[] = [];

  const presets = ['clear', 'overcast', 'foggy', 'dusk'];
  const setPreset = async (name: string) => {
    env.set(deepMerge(await loadPreset(name), name === world.doc.environment.preset ? world.doc.environment.overrides : undefined));
  };
  const capture = async () => {
    const blob = await renderer.capture();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `rill-${env.state.name}-${Date.now()}.png`;
    a.click();
  };
  const bookmarks: Record<string, () => void> = { Spawn: () => player.teleport(sp.position, sp.yaw, sp.pitch) };
  for (const o of world.doc.objects) {
    if (o.type === 'marker' && o.semantic === 'viewpoint') {
      const q = o.transform;
      bookmarks[o.name ?? o.id] = () => {
        player.fly = true;
        player.teleport([q.position[0], q.position[1], q.position[2]], o.yaw ?? 0, o.pitch ?? 0);
      };
    }
  }
  const gui = createPlayground(renderer, env, player, {
    setPreset,
    stress: (kind, count) => runStress(renderer, world, stressList, kind, count),
    clearStress: () => clearStress(renderer, stressList),
    capture,
    bookmarks,
  });

  const viewNames = Object.keys(DEBUG_VIEWS);
  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    if (e.code.startsWith('Digit')) {
      const i = parseInt(e.code.slice(5), 10) - 1;
      if (i >= 0 && i < presets.length) setPreset(presets[i]).then(() => gui.controllersRecursive().forEach((c) => c.updateDisplay()));
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
    if (e.code === 'KeyH') gui.show(gui._hidden);
    if (e.code === 'KeyP') capture();
    if (e.code === 'KeyB') renderer.settings.bounds = !renderer.settings.bounds;
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

  // Automation / tooling API: the same operations a future editor or AI agent
  // will use (structured, no screen clicking).
  const api = {
    renderer, world, env, camera, player,
    setPreset,
    setView: (name: string) => (renderer.settings.debugView = DEBUG_VIEWS[name] ?? 0),
    setCamera: (pos: [number, number, number], yawDeg: number, pitchDeg = 0, fly = true) => {
      player.fly = fly;
      player.teleport(pos, yawDeg, pitchDeg);
    },
    getCamera: () => ({
      position: Array.from(camera.position),
      yaw: (camera.yaw * 180) / Math.PI,
      pitch: (camera.pitch * 180) / Math.PI,
    }),
    stats: () => ({ ...renderer.stats, gpu: Object.fromEntries(renderer.timer.results), gpuTotal: renderer.timer.total, frameMs: lastFrameMs }),
    capture: async () => {
      const b = await renderer.capture();
      return new Promise<string>((res) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result as string);
        fr.readAsDataURL(b);
      });
    },
    getScene: () => world.toJSON(),
    /** Renders one frame now (independent of rAF) and saves it to ./screenshots/<name>.png (dev server). */
    shot: async (name: string, width?: number, height?: number) => {
      if (width && height) sizeOverride = [width, height];
      // Warm-up frame at the capture size (targets, shadows), then the captured one.
      frame(performance.now(), true);
      const p = renderer.capture();
      frame(performance.now(), true);
      const blob = await p;
      sizeOverride = null;
      const r = await fetch(`/__capture?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
      return (await r.json()).file as string;
    },
    /** Renders `frames` frames back-to-back (MessageChannel, unthrottled) and reports timings. */
    setSize: (w: number, h: number) => { sizeOverride = w > 0 ? [w, h] : null; },
    bench: async (frames = 120) => {
      const ch = new MessageChannel();
      const tick = () => new Promise<void>((res) => { ch.port1.onmessage = () => res(); ch.port2.postMessage(0); });
      const cpu: number[] = [];
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) {
        const c0 = performance.now();
        frame(c0, true);
        cpu.push(performance.now() - c0);
        await renderer.device.queue.onSubmittedWorkDone();
        await tick();
      }
      const wall = (performance.now() - t0) / frames;
      cpu.sort((a, b) => a - b);
      return {
        frames, wallMsPerFrame: +wall.toFixed(3), cpuMedianMs: +cpu[frames >> 1].toFixed(3), cpuP95Ms: +cpu[Math.floor(frames * 0.95)].toFixed(3),
        gpuMs: +renderer.timer.total.toFixed(3), gpuPasses: Object.fromEntries([...renderer.timer.results].map(([k, v]) => [k, +v.toFixed(3)])),
        stats: { ...renderer.stats },
      };
    },
    stress: (kind: string, count: number) => runStress(renderer, world, stressList, kind, count),
    clearStress: () => clearStress(renderer, stressList),
  };
  (window as unknown as { rill: typeof api }).rill = api;

  loading.remove();
  let last = performance.now();
  let lastFrameMs = 16;
  function frame(now: number, manual = false) {
    const dt = manual ? 1 / 60 : Math.min(0.1, (now - last) / 1000);
    lastFrameMs = now - last;
    last = now;
    const c0 = performance.now();
    applySize();
    player.update(dt);
    env.advance(dt);
    const all = stressList.length ? renderables.concat(stressList) : renderables;
    renderer.render(camera, env, all, dt);
    const cpu = performance.now() - c0;
    const p = camera.position;
    stats.update(now, lastFrameMs, cpu, renderer, world,
      `Pos    ${p[0].toFixed(1)} ${p[1].toFixed(1)} ${p[2].toFixed(1)}  yaw ${((camera.yaw * 180) / Math.PI % 360).toFixed(0)}°  ${player.fly ? 'FLY' : player.onGround ? 'walk' : 'air'}  env ${env.state.name}`);
  }
  const loop = (now: number) => {
    frame(now);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

main().catch((e) => {
  console.error(e);
  const el = document.getElementById('fatal')!;
  el.textContent = `Failed to start:\n${e?.stack ?? e}`;
  el.style.display = 'block';
  document.getElementById('loading')?.remove();
});
