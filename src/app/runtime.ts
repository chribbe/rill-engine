import { createGpuContext } from '../engine/gpu/context';
import { Renderer, DEBUG_VIEWS, type Renderable } from '../engine/render/renderer';
import { Camera } from '../engine/scene/camera';
import { Environment, type EnvironmentState } from '../engine/scene/environment';
import { World } from '../engine/scene/world';
import { FirstPersonController } from '../engine/player/controller';
import { Input } from '../engine/input/input';
import { StatsOverlay } from '../engine/ui/stats';
import { tonemapperFromName } from '../engine/ui/playground';
import { runStress, clearStress } from '../stress';
import { Sandbox } from '../sandbox';

/**
 * The game runtime shared by the standalone viewer (play.html) and the editor
 * (index.html): GPU context, renderer, world (from the authoritative map
 * document), environment, first-person player, sandbox, frame loop and the
 * automation API (`window.rill`). The editor drives the same instance: edit
 * mode replaces the player with an editor camera, play mode hands it back.
 */

export const PRESETS = ['clear', 'overcast', 'foggy', 'dusk', 'winter', 'bluehour', 'november', 'november_evening'];

const presetCache = new Map<string, Promise<EnvironmentState>>();
export function loadPreset(name: string): Promise<EnvironmentState> {
  let p = presetCache.get(name);
  if (!p) {
    p = fetch(`/environments/${name}.json`).then((r) => {
      if (!r.ok) throw new Error(`Environment preset not found: ${name}`);
      return r.json();
    });
    p.catch(() => presetCache.delete(name));
    presetCache.set(name, p);
  }
  return p.then((s) => structuredClone(s));
}

export function deepMerge<T>(base: T, over: Record<string, unknown> | undefined): T {
  if (!over) return base;
  const out = structuredClone(base) as Record<string, unknown>;
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>);
    else out[k] = v;
  }
  return out as T;
}

/** Leaves of `cur` that differ from `base` (the overrides a map stores over its preset). */
export function deepDiff(base: unknown, cur: unknown): Record<string, unknown> | undefined {
  if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cur as Record<string, unknown>)) {
    const b = (base as Record<string, unknown> | undefined)?.[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const d = deepDiff(b, v);
      if (d) out[k] = d;
    } else if (JSON.stringify(v) !== JSON.stringify(b)) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

export interface RuntimeHooks {
  /** Per-frame simulation before rendering (default: player + world behaviour + sandbox). */
  update?: (dt: number) => void;
  /** After the frame was submitted (editor overlays). */
  afterRender?: (dt: number) => void;
}

export type Runtime = Awaited<ReturnType<typeof createRuntime>>;

export async function createRuntime(canvas: HTMLCanvasElement, opts: { onProgress?: (m: string) => void; stats?: boolean } = {}) {
  const params = new URLSearchParams(location.search);
  const mapName = params.get('map') ?? 'testmap';
  const progress = opts.onProgress ?? (() => {});

  const gpu = await createGpuContext(canvas);
  const renderer = new Renderer(gpu);
  const camera = new Camera();

  // Retina/HiDPI: render at one pixel per CSS pixel by default (exact 2x nearest upscale),
  // ~4x cheaper than native; ?scale=1 (or the Render scale slider) restores full density.
  const scaleParam = params.get('scale');
  if (params.has('clutter')) renderer.settings.clutter = params.get('clutter') !== '0';
  renderer.settings.renderScale = scaleParam ? Math.min(1, Math.max(0.25, +scaleParam || 1)) : (window.devicePixelRatio || 1) >= 2 ? 0.5 : 1;

  // Exact device-pixel sizing: no CSS scaling blur.
  let cssW = canvas.clientWidth || window.innerWidth, cssH = canvas.clientHeight || window.innerHeight, dpr = window.devicePixelRatio || 1;
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

  // Offline BC7 textures when supported (?bc=0 compares against the PNG + GPU-mip path).
  if (params.get('bc') !== '0') {
    const n = await renderer.textures.enableCompression();
    if (n) console.log(`[textures] BC7 index: ${n} textures`);
  }
  // Global engine textures.
  renderer.textures.load('/textures/cloud_noise.png', 'linear').then((t) => renderer.setCloudNoise(t.view)).catch(() => {});
  renderer.textures.load('/textures/debug_grid_albedo.png', 'color').then((t) => renderer.setDebugGrid(t.view)).catch(() => {});
  renderer.textures.load('/textures/fx/effects.png', 'color', { wrap: false }).then((t) => renderer.setParticleAtlas(t.view)).catch(() => {});
  // Weather snow layer (same maps as the 'snow' material).
  Promise.all([
    renderer.textures.load('/textures/snow_albedo.png', 'color'),
    renderer.textures.load('/textures/snow_normal.png', 'normal'),
    renderer.textures.load('/textures/snow_orm.png', 'linear'),
  ]).then(([a, n, o]) => renderer.setSnowTextures(a.view, n.view, o.view)).catch((e) => console.warn('[snow] textures unavailable', e));

  progress(`Loading map '${mapName}'…`);
  const world = await World.load(renderer, `/maps/${mapName}/map.json`, progress);
  const envDoc = () => world.doc.environment;
  const env = new Environment(deepMerge(await loadPreset(envDoc().preset), envDoc().overrides));
  renderer.settings.tonemapper = tonemapperFromName(env.state.post.tonemapper);

  /** Re-derives the environment from the map document (after set_environment / undo). */
  let envSeq = 0;
  const applyEnvironment = async () => {
    const seq = ++envSeq;
    const d = envDoc();
    const s = deepMerge(await loadPreset(d.preset), d.overrides);
    if (seq !== envSeq) return;
    // Already showing this state (the editor previewed it live): no re-capture of probes.
    if (JSON.stringify(Environment.normalize(structuredClone(s))) === JSON.stringify(env.state)) return;
    // Wind/cloud clocks continue; only the state document changes.
    env.set(s);
    renderer.settings.tonemapper = tonemapperFromName(env.state.post.tonemapper);
    rt.onEnvironment?.();
  };
  world.scene.subscribe((c) => {
    if (c.source === 'load' || c.patches.some((p) => p.kind === 'doc' && p.key === 'environment')) void applyEnvironment();
  });

  const input = new Input(canvas);
  const player = new FirstPersonController(camera, input, world.collision);
  const sandbox = new Sandbox(renderer, camera, world);
  const sp = world.spawn();
  player.teleport(sp.position, sp.yaw, sp.pitch);

  const stats = new StatsOverlay(opts.stats === false ? document.createElement('div') : canvas.parentElement ?? document.body);
  const renderables: Renderable[] = world.renderables;
  const stressList: Renderable[] = [];

  /** Previews a preset without touching the map document (play page keys 1-8). */
  const setPreset = async (name: string) => {
    env.set(deepMerge(await loadPreset(name), name === envDoc().preset ? envDoc().overrides : undefined));
    renderer.settings.tonemapper = tonemapperFromName(env.state.post.tonemapper);
  };

  const hooks: RuntimeHooks = {};
  let last = performance.now();
  let lastFrameMs = 16;
  let running = false;
  /** Debug frame-rate cap (frames per second, 0 = display rate): tests frame-rate independence. */
  let fpsCap = params.has('fps') ? Math.max(0, +params.get('fps')! || 0) : 0;

  function defaultUpdate(dt: number) {
    player.update(dt);
    world.update(dt, player.feet);
    sandbox.update(dt);
  }

  function frame(now: number, manual = false) {
    const dt = manual ? 1 / 60 : Math.min(0.1, (now - last) / 1000);
    lastFrameMs = now - last;
    last = now;
    const c0 = performance.now();
    applySize();
    if (renderer.settings.clutter) world.ensureClutter();
    world.flush();
    (hooks.update ?? defaultUpdate)(dt);
    env.advance(dt);
    const all = stressList.length ? renderables.concat(stressList) : renderables;
    renderer.render(camera, env, all, dt);
    hooks.afterRender?.(dt);
    const cpu = performance.now() - c0;
    const p = camera.position;
    stats.update(now, lastFrameMs, cpu, renderer, world,
      `Pos    ${p[0].toFixed(1)} ${p[1].toFixed(1)} ${p[2].toFixed(1)}  yaw ${((camera.yaw * 180) / Math.PI % 360).toFixed(0)}°  ${player.fly ? 'FLY' : player.onGround ? 'walk' : 'air'}  env ${env.state.name}`);
  }

  /** Renders one frame now at an exact size and returns the raw image (auto exposure settled first). */
  async function renderImage(width?: number, height?: number): Promise<ImageData> {
    if (width && height) sizeOverride = [width, height];
    try {
      // Warm-up frames at the capture size (targets, shadows) and let auto
      // exposure meter this view and snap to it, then the captured frame.
      for (let i = 0; i < 6; i++) {
        if (i >= 2) renderer.exposure.snapFrames = 1;
        frame(performance.now(), true);
        await renderer.device.queue.onSubmittedWorkDone();
        await new Promise((r) => setTimeout(r, 0));
        // Variants compile asynchronously: let them land before the captured frames.
        if (i === 1) await renderer.pipelinesSettled();
      }
      const p = renderer.captureRaw();
      frame(performance.now(), true);
      return await p;
    } finally {
      sizeOverride = null;
    }
  }

  async function saveImage(name: string, img: ImageData): Promise<string> {
    const r = await fetch(`/__capture?name=${encodeURIComponent(name)}&w=${img.width}&h=${img.height}`, { method: 'POST', body: img.data });
    return (await r.json()).file as string;
  }

  // Automation / tooling API: structured operations, no screen clicking.
  const api = {
    renderer, world, env, camera, player, sandbox, input,
    setPreset,
    /** Advances `n` manual frames (1/60 s each), e.g. to simulate held fire before a shot. */
    step: async (n = 1) => {
      for (let i = 0; i < n; i++) {
        frame(performance.now(), true);
        await renderer.device.queue.onSubmittedWorkDone();
      }
    },
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
    shot: async (name: string, width?: number, height?: number) => saveImage(name, await renderImage(width, height)),
    setSize: (w: number, h: number) => { sizeOverride = w > 0 ? [w, h] : null; },
    /** Captures every viewpoint marker (optionally a subset by index) to screenshots/<prefix>_<i>.png. */
    shotViews: async (prefix: string, w = 1280, h = 720, only?: number[]) => {
      const views = world.viewpoints();
      const files: string[] = [];
      for (let i = 0; i < views.length; i++) {
        if (only && !only.includes(i)) continue;
        const v = views[i];
        player.fly = true;
        player.teleport([v.transform.position[0], v.transform.position[1], v.transform.position[2]], v.yaw ?? 0, v.pitch ?? 0);
        files.push(await api.shot(`${prefix}_${i}`, w, h));
      }
      return files;
    },
    /** Renders `frames` frames back-to-back (MessageChannel, unthrottled) and reports timings. */
    bench: async (frames = 120) => {
      const ch = new MessageChannel();
      const tick = () => new Promise<void>((res) => { ch.port1.onmessage = () => res(); ch.port2.postMessage(0); });
      const cpu: number[] = [];
      // Warm up, then measure from a clean timer history.
      for (let i = 0; i < 8; i++) { frame(performance.now(), true); await renderer.device.queue.onSubmittedWorkDone(); if (i === 1) await renderer.pipelinesSettled(); }
      renderer.timer.reset();
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
        gpuMs: +renderer.timer.total.toFixed(3), gpuSpanMs: +renderer.timer.span.toFixed(3), gpuPasses: Object.fromEntries([...renderer.timer.results].map(([k, v]) => [k, +v.toFixed(3)])),
        stats: { ...renderer.stats },
      };
    },
    stress: (kind: string, count: number) => runStress(renderer, world, stressList, kind, count),
    clearStress: () => clearStress(renderer, stressList),
  };

  const rt = {
    mapName, params, gpu, renderer, camera, world, env, player, sandbox, input, stats, renderables, stressList, api, hooks,
    setPreset, applyEnvironment, renderImage, saveImage, frame,
    onEnvironment: null as null | (() => void),
    get lastFrameMs() { return lastFrameMs; },
    get fpsCap() { return fpsCap; },
    set fpsCap(v: number) { fpsCap = Math.max(0, v); },
    /** Compiles what the first view needs, then every other variant in the background. */
    async prewarm() {
      progress('Compiling shaders…');
      applySize();
      player.update(0);
      renderer.render(camera, env, renderables, 1 / 60);
      renderer.render(camera, env, renderables, 1 / 60);
      await renderer.prewarm(renderables);
      renderer.syncPipelines = false;
    },
    start() {
      if (running) return;
      running = true;
      last = performance.now();
      const loop = (now: number) => {
        requestAnimationFrame(loop);
        // Skip display frames to emulate a slower machine (within ~1 ms of the target interval).
        if (fpsCap > 0 && now - last < 1000 / fpsCap - 1) return;
        frame(now);
      };
      requestAnimationFrame(loop);
    },
  };
  return rt;
}
