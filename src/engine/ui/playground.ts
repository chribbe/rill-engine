import GUI from 'lil-gui';
import type { Renderer } from '../render/renderer';
import { DEBUG_VIEWS } from '../render/renderer';
import type { Environment, EnvironmentState } from '../scene/environment';
import type { FirstPersonController } from '../player/controller';

/**
 * Renderer-tuning playground (not the editor). Every control writes straight
 * into RenderSettings or the EnvironmentState document.
 */
export interface PlaygroundHooks {
  setPreset: (name: string) => Promise<void>;
  stress: (kind: string, count: number) => void;
  clearStress: () => void;
  capture: () => void;
  bookmarks: Record<string, () => void>;
}

export const TONEMAPPERS: Record<string, number> = { AgX: 0, 'AgX Punchy': 5, 'PBR Neutral': 1, 'ACES (Hill)': 2, 'Reinhard (luma)': 3, Clamp: 4 };

export function createPlayground(r: Renderer, env: Environment, player: FirstPersonController, hooks: PlaygroundHooks): GUI {
  const gui = new GUI({ title: 'Rill renderer playground', width: 320 });
  const S = r.settings;
  const E = () => env.state;
  const touch = () => env.touch();
  const proxy = { preset: E().name, view: 'lit' };

  const envF = gui.addFolder('Environment');
  envF.add(proxy, 'preset', ['clear', 'overcast', 'foggy', 'dusk']).name('Weather preset').onChange(async (v: string) => {
    await hooks.setPreset(v);
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
  });
  const envBind = (folder: GUI, obj: () => object, key: string, min?: number, max?: number, step?: number, name?: string) => {
    // lil-gui binds objects directly; environment state objects are replaced on preset change,
    // so we route through a getter/setter shim.
    const shim = {} as Record<string, unknown>;
    Object.defineProperty(shim, key, {
      get: () => (obj() as Record<string, unknown>)[key],
      set: (v) => {
        (obj() as Record<string, unknown>)[key] = v;
        touch();
      },
    });
    const c = min !== undefined ? folder.add(shim, key, min, max, step) : folder.add(shim, key);
    if (name) c.name(name);
    return c;
  };
  const sun = envF.addFolder('Sun');
  envBind(sun, () => E().sun, 'azimuth', 0, 360, 0.5, 'Azimuth (°)');
  envBind(sun, () => E().sun, 'elevation', -8, 90, 0.1, 'Elevation (°)');
  envBind(sun, () => E().sun, 'intensity', 0, 2, 0.01, 'Intensity ×');
  const sky = envF.addFolder('Sky');
  envBind(sky, () => E().sky, 'intensity', 0, 3, 0.01, 'Sky intensity ×');
  envBind(sky, () => E().sky, 'turbidity', 0.1, 4, 0.01, 'Aerosols (1 = AOD 0.1)');
  envBind(sky, () => E().sky, 'cloudCover', 0, 1, 0.01, 'Cloud cover');
  envBind(sky, () => E().sky, 'cloudSharpness', 0.03, 1, 0.01, 'Cloud softness');
  envBind(sky, () => E().sky, 'overcastLuminance', 10, 12000, 10, 'Overcast nits');
  const fog = envF.addFolder('Fog / atmosphere');
  envBind(fog, () => E().fog, 'enabled', undefined, undefined, undefined, 'Fog enabled');
  envBind(fog, () => E().fog, 'density', 0, 0.08, 0.0001, 'Density (1/m)');
  envBind(fog, () => E().fog, 'height', -20, 60, 0.5, 'Reference height (m)');
  envBind(fog, () => E().fog, 'falloff', 0.001, 0.5, 0.001, 'Height falloff');
  envBind(fog, () => E().fog, 'hazeVisibilityKm', 0, 80, 0.5, 'Haze visibility (km)');
  envBind(fog, () => E().fog, 'anisotropy', 0, 0.95, 0.01, 'Phase g');
  envBind(fog, () => E().fog, 'sunScatter', 0, 3, 0.01, 'Sun inscatter');
  envBind(fog, () => E().fog, 'startDistance', 0, 100, 0.5, 'Start distance (m)');
  const exp = envF.addFolder('Exposure / ambient');
  envBind(exp, () => E().exposure, 'ev100', 2, 17, 0.05, 'EV100 (manual / start)');
  exp.add(S, 'autoExposure').name('Auto exposure');
  envBind(exp, () => E().exposure, 'min', 0, 17, 0.05, 'Auto EV min');
  envBind(exp, () => E().exposure, 'max', 0, 17, 0.05, 'Auto EV max');
  exp.add(r.exposure, 'key', 0.04, 0.4, 0.005).name('Auto key (mid-grey target)');
  exp.add(S, 'bloom', 0, 0.2, 0.005).name('Bloom (veiling glare)');
  envBind(exp, () => E().exposure, 'compensation', -4, 4, 0.05, 'Compensation (stops)');
  envBind(exp, () => E().ambient, 'lightmapSky', 0, 3, 0.01, 'Lightmap sky ×');
  envBind(exp, () => E().ambient, 'lightmapSun', 0, 3, 0.01, 'Lightmap sun bounce ×');
  envBind(exp, () => E().ambient, 'indirect', 0, 3, 0.01, 'Indirect ×');
  envBind(exp, () => E().ambient, 'envSpecular', 0, 3, 0.01, 'Env specular ×');
  envBind(exp, () => E().lights, 'intensity', 0, 3, 0.01, 'Local lights ×');
  const wet = envF.addFolder('Wetness');
  envBind(wet, () => E().weather, 'wetness', 0, 1, 0.01, 'Wetness');
  envBind(wet, () => E().weather, 'puddles', 0, 1, 0.01, 'Puddles');
  const post = envF.addFolder('Grading (restrained)');
  envBind(post, () => E().post, 'contrast', 0.7, 1.4, 0.01, 'Contrast');
  envBind(post, () => E().post, 'saturation', 0, 1.5, 0.01, 'Saturation');
  envBind(post, () => E().post, 'temperature', -1, 1, 0.01, 'White balance');
  sun.open();

  const view = gui.addFolder('Debug views');
  view.add(proxy, 'view', Object.keys(DEBUG_VIEWS)).name('View (V / Shift+V)').onChange((v: string) => (S.debugView = DEBUG_VIEWS[v]));
  view.add(S, 'wireframe').name('Wireframe overlay');
  view.add(S, 'bounds').name('Bounding boxes');
  view.add(S, 'freezeCulling').name('Freeze culling');

  const rend = gui.addFolder('Rendering');
  rend.add(S, 'msaa').name('MSAA 4x');
  rend.add(S, 'lodBias', 0.25, 4, 0.05).name('LOD distance bias');
  rend.add(S, 'lodFade', 0, 0.3, 0.01).name('LOD crossfade band');
  rend.add(S, 'alphaToCoverage').name('Alpha to coverage');
  rend.add(S, 'tonemapper', TONEMAPPERS).name('Tone mapper');
  rend.add(S, 'dither').name('Output dither');
  rend.add(S, 'renderScale', 0.25, 1, 0.05).name('Render scale');
  rend.add(S, 'fog').name('Fog (global toggle)');
  rend.add(S, 'sun').name('Sun direct');
  rend.add(S, 'skyAmbient').name('Sky ambient (SH)');
  rend.add(S, 'envSpecular').name('Env reflections');
  rend.add(S, 'localLights').name('Local lights');
  rend.add(S, 'decals').name('Decals');

  const light = gui.addFolder('Static lighting');
  light.add(S, 'lightmaps').name('Lightmaps');
  light.add(S, 'lightmapBicubic').name('Bicubic lightmap filter');
  light.add(S, 'shRatio').name('Normal detail in lightmaps');
  light.add(S, 'specOcclusion').name('Reflection normalisation');
  light.add(S, 'directionalLightmaps').name('Directional lightmaps (RNM)');
  light.add(S, 'probeVolume').name('Probe volume (dynamic objects)');
  light.add(S, 'reflectionProbes').name('Reflection probes').onChange(() => env.touch());
  light.add(S, 'showProbes').name('Show reflection probe boxes');
  light.add({ recapture: () => env.touch() }, 'recapture').name('Recapture reflection probes');

  const tex = gui.addFolder('Materials / textures');
  const aniso = { a: S.anisotropy };
  tex.add(aniso, 'a', [1, 2, 4, 8, 16]).name('Anisotropy').onChange((v: number) => r.setAnisotropy(Number(v)));
  tex.add(S, 'mipBias', -2, 2, 0.05).name('Mip bias');
  tex.add(S, 'detailStrength', 0, 2, 0.01).name('Detail strength');
  tex.add(S, 'macroStrength', 0, 2, 0.01).name('Macro variation');
  tex.add(S, 'normalStrength', 0, 2, 0.01).name('Normal strength');
  tex.add(S, 'specularAA', 0, 4, 0.01).name('Specular AA');

  const sh = gui.addFolder('Shadows');
  sh.add(S.shadows, 'enabled').name('Enabled');
  sh.add(S.shadows, 'resolution', [1024, 2048, 3072, 4096]).name('Resolution');
  sh.add(S.shadows, 'distance', 20, 400, 1).name('Distance (m)');
  sh.add(S.shadows, 'splitLambda', 0, 1, 0.01).name('Split λ');
  sh.add(S.shadows, 'softness', 0, 0.5, 0.005).name('Softness (m)');
  sh.add(S.shadows, 'normalOffset', 0, 4, 0.05).name('Normal offset (texels)');
  sh.add(S.shadows, 'constBias', 0, 0.005, 0.00005).name('Depth bias');
  sh.add(S.shadows, 'slopeBias', 0, 6, 0.1).name('Slope bias');
  sh.add(S.shadows, 'pcf7').name('7x7 PCF');
  sh.add(S.shadows, 'cascadeBlend').name('Cascade blending');

  const ctl = gui.addFolder('Controller');
  ctl.add(player, 'fly').name('Fly (F)');
  ctl.add(player, 'walkSpeed', 0.5, 10, 0.1).name('Walk speed (m/s)');
  ctl.add(player, 'flySpeed', 1, 60, 0.5).name('Fly speed (m/s)');
  const fovP = { fov: 62 };
  ctl.add(fovP, 'fov', 40, 100, 1).name('Vertical FOV (°)').onChange((v: number) => ((player as unknown as { camera: { fovY: number } }).camera.fovY = (v * Math.PI) / 180));

  const stress = gui.addFolder('Stress tests');
  const st = { kind: 'trees', count: 5000 };
  stress.add(st, 'kind', ['trees', 'props', 'buildings', 'spheres']).name('Kind');
  stress.add(st, 'count', 100, 100000, 100).name('Count');
  stress.add({ go: () => hooks.stress(st.kind, st.count) }, 'go').name('Spawn');
  stress.add({ clear: () => hooks.clearStress() }, 'clear').name('Clear stress objects');

  const bm = gui.addFolder('Viewpoints');
  for (const [k, fn] of Object.entries(hooks.bookmarks)) bm.add({ [k]: fn }, k);
  gui.add({ cap: () => hooks.capture() }, 'cap').name('Save screenshot (P)');

  for (const f of [view, rend, light, tex, sh, ctl, stress, bm, fog, exp, wet, post, sky]) f.close();
  return gui;
}

export function tonemapperFromName(n: string): number {
  return ({ agx: 0, neutral: 1, aces: 2, reinhard: 3, clamp: 4, agxPunchy: 5 } as Record<string, number>)[n] ?? 0;
}

export type { EnvironmentState };
