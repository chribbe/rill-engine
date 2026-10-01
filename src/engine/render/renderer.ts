import { mat4 } from 'wgpu-matrix';
import { transientUsage, type GpuContext } from '../gpu/context';
import { shaderModule } from './shaderlib';
import { FrameUniforms, FRAME_BYTES, FO, RF } from './frame';
import { GeometryArena, VERTEX_LAYOUT_FULL, VERTEX_LAYOUT_POS, VERTEX_LAYOUT_POS_UV, type GpuMesh, type GpuPrimitive } from './geometry';
import { TextureManager } from './textures';
import { MaterialLibrary, type Material } from './materials';
import { SkySystem, ENV_SPEC_MIPS, PLANET_RADIUS_KM, ATMOSPHERE_TOP_KM, AEROSOL_BASE } from './sky';
import { ShadowSystem, CASCADES, type ShadowSettings } from './shadows';
import { InstanceStore } from './instances';
import { ClutterSystem, type ClutterDraw } from './clutter';
import { GpuTimer } from './timing';
import { ExposureController } from './exposure';
import { ReflectionProbes, faceView, CAPTURE_PRE_EXPOSURE, PROBE_SIZE } from './reflections';
import type { LoadedProbeVolume } from './lightmaps';
import type { ReflectionProbeObject } from '../scene/mapformat';
import type { EnvironmentState, DerivedEnvironment } from '../scene/environment';
import { aabbVisible, extractPlanes, type Plane } from './culling';
import type { Camera } from '../scene/camera';
import { Environment, SUN_TOA_LUX } from '../scene/environment';
import { parseColor } from './materials';

/** One level of detail of a model; `dist2` = squared start distance (instance scale applied). */
export interface LodLevel {
  mesh: GpuMesh;
  materials: Material[];
  dist2: number;
}

export interface Renderable {
  slot: number;
  /** LOD0 (and the culling bounds). */
  mesh: GpuMesh;
  materials: Material[];
  /** Optional LOD chain, ascending distance; lods[0] is mesh/materials. */
  lods?: LodLevel[];
  worldMin: Float32Array;
  worldMax: Float32Array;
  castShadow: boolean;
  visible: boolean;
  id: string;
}

/** Anything that can be rendered from: the player camera or a probe face. */
export interface ViewParams {
  position: ArrayLike<number>;
  forward: ArrayLike<number>;
  view: ArrayLike<number>;
  proj: ArrayLike<number>;
  viewProj: Float32Array;
  invViewProj: ArrayLike<number>;
  fovY: number;
  aspect: number;
  near: number;
}

export interface LightData {
  position: [number, number, number];
  color: [number, number, number];
  /** Luminous intensity (candela). */
  intensity: number;
  range: number;
  type: 'point' | 'spot';
  direction?: [number, number, number];
  innerAngle?: number;
  outerAngle?: number;
  sourceRadius?: number;
  fogScatter?: number;
}

export const DEBUG_VIEWS: Record<string, number> = {
  lit: 0,
  albedo: 1,
  normals: 2,
  geometricNormals: 3,
  uv0: 4,
  lightmapUv: 5,
  lightmapOnly: 6,
  lightmapDensity: 7,
  roughness: 8,
  metallic: 9,
  ao: 10,
  shadowCascades: 11,
  lightingOnly: 12,
  directOnly: 13,
  indirectOnly: 14,
  specularOnly: 15,
  mipLevel: 16,
  scaleGrid: 17,
  shadowTerm: 18,
  fogTransmittance: 19,
  overdraw: 20,
  texelDensity: 22,
};

export interface RenderSettings {
  msaa: boolean;
  debugView: number;
  wireframe: boolean;
  bounds: boolean;
  freezeCulling: boolean;
  shadows: ShadowSettings;
  anisotropy: number;
  mipBias: number;
  detailStrength: number;
  macroStrength: number;
  normalStrength: number;
  specularAA: number;
  lightmaps: boolean;
  lightmapBicubic: boolean;
  shRatio: boolean;
  specOcclusion: boolean;
  envSpecular: boolean;
  skyAmbient: boolean;
  sun: boolean;
  localLights: boolean;
  decals: boolean;
  alphaToCoverage: boolean;
  fog: boolean;
  tonemapper: number;
  dither: boolean;
  renderScale: number;
  /** Veiling-glare bloom strength (0 = off). Energy-conserving mix. */
  bloom: number;
  /** Auto exposure (eye adaptation) enabled; limits come from the environment. */
  autoExposure: boolean;
  directionalLightmaps: boolean;
  probeVolume: boolean;
  reflectionProbes: boolean;
  showProbes: boolean;
  /** LOD distance multiplier (>1 keeps detail further away). */
  lodBias: number;
  /** LOD crossfade band, ± fraction of each switch distance (0 = hard switches). */
  lodFade: number;
  /** Ground clutter (detail props) on/off and distance multiplier. */
  clutter: boolean;
  clutterDistance: number;
}

export function defaultRenderSettings(): RenderSettings {
  return {
    msaa: true,
    debugView: 0,
    wireframe: false,
    bounds: false,
    freezeCulling: false,
    shadows: {
      enabled: true,
      resolution: 2048,
      distance: 160,
      splitLambda: 0.82,
      normalOffset: 1.4,
      constBias: 0.0004,
      slopeBias: 1.5,
      softness: 0.02,
      pcf7: false,
      cascadeBlend: true,
      casterExtension: 60,
    },
    anisotropy: 16,
    mipBias: 0,
    detailStrength: 1,
    macroStrength: 1,
    normalStrength: 1,
    specularAA: 1,
    lightmaps: true,
    lightmapBicubic: true,
    shRatio: true,
    specOcclusion: true,
    envSpecular: true,
    skyAmbient: true,
    sun: true,
    localLights: true,
    decals: true,
    alphaToCoverage: true,
    fog: true,
    tonemapper: 0,
    dither: true,
    renderScale: 1,
    bloom: 0.04,
    autoExposure: true,
    directionalLightmaps: true,
    probeVolume: true,
    reflectionProbes: true,
    showProbes: false,
    lodBias: 1,
    lodFade: 0.1,
    clutter: true,
    clutterDistance: 1,
  };
}

export interface FrameStats {
  drawCalls: number;
  shadowDrawCalls: number;
  triangles: number;
  shadowTriangles: number;
  instances: number;
  visibleObjects: number;
  culledObjects: number;
  totalObjects: number;
  cpuCullMs: number;
  cpuEncodeMs: number;
}

interface Draw {
  prim: GpuPrimitive;
  material: Material;
  first: number;
  count: number;
  masked: boolean;
  doubleSided: boolean;
  /** Instances inside a LOD transition band (dithered crossfade pipeline variant). */
  fade: boolean;
}

class Bucket {
  slots = new Uint32Array(64);
  count = 0;
  constructor(public prim: GpuPrimitive, public material: Material, public fade = false) {}
  push(s: number) {
    if (this.count >= this.slots.length) {
      const n = new Uint32Array(this.slots.length * 2);
      n.set(this.slots);
      this.slots = n;
    }
    this.slots[this.count++] = s;
  }
}

/** Groups visible instances by (primitive, material) -> one instanced draw each. */
class DrawList {
  private buckets = new Map<number, Bucket>();
  private active: Bucket[] = [];
  draws: Draw[] = [];
  triangles = 0;
  instances = 0;

  reset() {
    for (const b of this.active) b.count = 0;
    this.active.length = 0;
    this.draws.length = 0;
    this.triangles = 0;
    this.instances = 0;
  }

  /** `entry` = instance slot, optionally with LOD-fade bits (see `fadeEntry`). */
  add(prim: GpuPrimitive, mat: Material, entry: number, fade = false) {
    const key = (prim.id * 65536 + mat.id) * 2 + (fade ? 1 : 0);
    let b = this.buckets.get(key);
    if (!b) {
      b = new Bucket(prim, mat, fade);
      this.buckets.set(key, b);
    }
    if (b.count === 0) this.active.push(b);
    b.push(entry);
  }

  /** Sorts and appends instance slots to `out` starting at `offset`; returns the new offset. */
  finalize(out: { data: Uint32Array; grow: (n: number) => void }, offset: number): number {
    this.active.sort((a, b) => {
      const ma = a.material.masked ? 1 : 0, mb = b.material.masked ? 1 : 0;
      if (ma !== mb) return ma - mb;
      const da = a.material.doubleSided ? 1 : 0, db = b.material.doubleSided ? 1 : 0;
      if (da !== db) return da - db;
      if (a.fade !== b.fade) return a.fade ? 1 : -1;
      if (a.material.id !== b.material.id) return a.material.id - b.material.id;
      return a.prim.id - b.prim.id;
    });
    let o = offset;
    for (const b of this.active) {
      out.grow(o + b.count);
      out.data.set(b.slots.subarray(0, b.count), o);
      this.draws.push({ prim: b.prim, material: b.material, first: o, count: b.count, masked: b.material.masked, doubleSided: b.material.doubleSided, fade: b.fade });
      this.triangles += (b.prim.indexCount / 3) * b.count;
      this.instances += b.count;
      o += b.count;
    }
    return o;
  }
}

/** Minimum LOD level of shadow casters per cascade. */
const SHADOW_MIN_LOD = [0, 1, 2, 2];

const TU = GPUTextureUsage;
const BU = GPUBufferUsage;
const SS = GPUShaderStage;

export class Renderer {
  readonly device: GPUDevice;
  readonly frame = new FrameUniforms();
  readonly frameBuffer: GPUBuffer;
  readonly instances: InstanceStore;
  /** Objects drawn per LOD level in the last main view. */
  readonly lodCounts = new Uint32Array(4);
  readonly arena: GeometryArena;
  readonly textures: TextureManager;
  readonly materials: MaterialLibrary;
  readonly sky: SkySystem;
  readonly shadows: ShadowSystem;
  readonly timer: GpuTimer;
  settings = defaultRenderSettings();
  stats: FrameStats = {
    drawCalls: 0, shadowDrawCalls: 0, triangles: 0, shadowTriangles: 0, instances: 0,
    visibleObjects: 0, culledObjects: 0, totalObjects: 0, cpuCullMs: 0, cpuEncodeMs: 0,
  };

  private sampAniso!: GPUSampler;
  private sampClamp: GPUSampler;
  private sampShadow: GPUSampler;
  private frameLayout: GPUBindGroupLayout;
  readonly materialLayout: GPUBindGroupLayout;
  private shadowLayout: GPUBindGroupLayout;
  private linesLayout: GPUBindGroupLayout;
  private postLayout: GPUBindGroupLayout;
  private stdPipelineLayout: GPUPipelineLayout;
  /** Ground clutter: group 2 = compact instances + params. */
  readonly clutterLayout: GPUBindGroupLayout;
  private clutterPipelineLayout: GPUPipelineLayout;
  clutter: ClutterSystem | null = null;
  private clutterDraws: ClutterDraw[] = [];
  /** Instance slot with neutral per-object data used by clutter shading. */
  readonly clutterSlot: number;
  private shadowPipelineLayout: GPUPipelineLayout;
  private pipelines = new Map<string, GPURenderPipeline>();

  private visible = { data: new Uint32Array(1 << 16), grow: (n: number) => this.growVisible(n) };
  private visibleBuffer: GPUBuffer;
  private lightBuffer: GPUBuffer;
  private lightCount = 0;
  private decalBuffer: GPUBuffer;
  private decalCellBuffer: GPUBuffer;
  private decalCount = 0;
  private decalAtlasView: GPUTextureView;
  private lightmapView: GPUTextureView;
  private debugGridView: GPUTextureView;
  private cloudNoiseView: GPUTextureView;
  /** Snow layer albedo / normal / ORM (defaults until loaded). */
  private snowViews: GPUTextureView[];
  private postParams: GPUBuffer;
  readonly exposure: ExposureController;
  private captureFrame = new FrameUniforms();
  private captureFrameBuffer: GPUBuffer;
  private captureFrameBG?: GPUBindGroup;
  probes: ReflectionProbes | null = null;
  probeVolume: LoadedProbeVolume | null = null;
  lightmapDirectional = false;
  private dummyVolume: GPUTextureView;
  private dummyCubeArray: GPUTextureView;
  private dummyProbeData: GPUBuffer;
  private bloomLevels: GPUTexture[] = [];
  private bloomViews: GPUTextureView[] = [];
  private bloomDownBGs: GPUBindGroup[] = [];
  private bloomUpBGs: GPUBindGroup[] = [];
  private bloomParamBufs: GPUBuffer[] = [];
  private bloomLayout!: GPUBindGroupLayout;
  /** Exposure actually used this frame (EV100, pre-exposure). */
  currentEV = 0;
  currentPreExposure = 1;
  private linesBuffer: GPUBuffer;
  private linesCapacity = 0;

  private frameBG?: GPUBindGroup;
  private shadowBGs: GPUBindGroup[] = [];
  private linesBG?: GPUBindGroup;
  private postBG?: GPUBindGroup;
  private bindingsDirty = true;
  private instanceGen = -1;

  private width = 0;
  private height = 0;
  private msaaColor?: GPUTexture;
  private depth?: GPUTexture;
  private resolved?: GPUTexture;
  private targetsMsaa = false;

  private mainList = new DrawList();
  private shadowLists: DrawList[] = [];
  private frozenPlanes: Plane[] | null = null;
  private frozenViewProj: Float32Array | null = null;
  private lastEnvVersion = -1;
  private time = 0;
  private captureRequest: ((b: ImageData) => void) | null = null;
  lineVerts: number[] = [];
  lightmapLayers = 0;

  constructor(private gpu: GpuContext) {
    const d = (this.device = gpu.device);
    this.frameBuffer = d.createBuffer({ label: 'frame', size: FRAME_BYTES, usage: BU.UNIFORM | BU.COPY_DST });
    this.instances = new InstanceStore(d);
    this.arena = new GeometryArena(d);
    this.textures = new TextureManager(d);
    this.timer = new GpuTimer(d, gpu.caps.timestamps);
    this.shadows = new ShadowSystem(d);
    this.shadows.ensure(this.settings.shadows.resolution);
    for (let i = 0; i < CASCADES; i++) this.shadowLists.push(new DrawList());

    this.createAnisoSampler(this.settings.anisotropy);
    this.sampClamp = d.createSampler({ label: 'clamp', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge' });
    this.sampShadow = d.createSampler({ label: 'shadow', compare: 'less-equal', magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });

    this.visibleBuffer = d.createBuffer({ label: 'visible', size: this.visible.data.byteLength, usage: BU.STORAGE | BU.COPY_DST });
    this.lightBuffer = d.createBuffer({ label: 'lights', size: 64 * 256, usage: BU.STORAGE | BU.COPY_DST });
    this.decalBuffer = d.createBuffer({ label: 'decals', size: 96 * 16, usage: BU.STORAGE | BU.COPY_DST });
    this.decalCellBuffer = d.createBuffer({ label: 'decalCells', size: 64, usage: BU.STORAGE | BU.COPY_DST });
    this.postParams = d.createBuffer({ label: 'post', size: 144, usage: BU.UNIFORM | BU.COPY_DST });
    this.exposure = new ExposureController(d);
    this.captureFrameBuffer = d.createBuffer({ label: 'captureFrame', size: FRAME_BYTES, usage: BU.UNIFORM | BU.COPY_DST });
    this.dummyVolume = d.createTexture({ size: [1, 1, 1], dimension: '3d', format: 'rgba16float', usage: TU.TEXTURE_BINDING }).createView({ dimension: '3d' });
    this.dummyCubeArray = d.createTexture({ size: [1, 1, 6], format: 'rgba16float', usage: TU.TEXTURE_BINDING }).createView({ dimension: 'cube-array', arrayLayerCount: 6 });
    this.dummyProbeData = d.createBuffer({ size: 256, usage: BU.STORAGE });
    this.linesBuffer = d.createBuffer({ label: 'lines', size: 16, usage: BU.VERTEX | BU.COPY_DST });

    const blackArr = d.createTexture({ size: [1, 1, 2], format: 'rgba16float', usage: TU.TEXTURE_BINDING | TU.COPY_DST });
    this.lightmapView = blackArr.createView({ dimension: '2d-array' });
    const decalDummy = d.createTexture({ size: [1, 1, 1], format: 'rgba8unorm', usage: TU.TEXTURE_BINDING });
    this.decalAtlasView = decalDummy.createView({ dimension: '2d-array' });
    this.debugGridView = this.textures.white.view;
    this.cloudNoiseView = this.textures.gray.view;
    this.snowViews = [this.textures.white.view, this.textures.flatNormal.view, this.textures.defaultOrm.view];

    // ---- layouts
    const FV = SS.VERTEX | SS.FRAGMENT;
    this.frameLayout = d.createBindGroupLayout({
      label: 'frame',
      entries: [
        { binding: 0, visibility: FV, buffer: { type: 'uniform' } },
        { binding: 1, visibility: FV, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: FV, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: FV, sampler: {} },
        { binding: 4, visibility: FV, sampler: {} },
        { binding: 5, visibility: SS.FRAGMENT, sampler: { type: 'comparison' } },
        { binding: 6, visibility: SS.FRAGMENT, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
        { binding: 7, visibility: SS.FRAGMENT, texture: { viewDimension: 'cube' } },
        { binding: 8, visibility: SS.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 9, visibility: SS.FRAGMENT, texture: {} },
        { binding: 10, visibility: FV, texture: { viewDimension: '2d-array' } },
        { binding: 11, visibility: SS.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 12, visibility: SS.FRAGMENT, texture: {} },
        { binding: 13, visibility: SS.FRAGMENT, texture: {} },
        { binding: 14, visibility: SS.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 15, visibility: SS.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 16, visibility: SS.FRAGMENT, texture: { viewDimension: '2d-array' } },
        { binding: 17, visibility: SS.FRAGMENT, texture: {} },
        { binding: 18, visibility: FV, texture: {} },
        { binding: 19, visibility: SS.FRAGMENT, texture: { viewDimension: '3d' } },
        { binding: 20, visibility: SS.FRAGMENT, texture: { viewDimension: 'cube-array' } },
        { binding: 21, visibility: SS.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 22, visibility: SS.FRAGMENT, texture: {} },
        { binding: 23, visibility: SS.FRAGMENT, texture: {} },
        { binding: 24, visibility: SS.FRAGMENT, texture: {} },
      ],
    });
    this.materialLayout = d.createBindGroupLayout({
      label: 'material',
      entries: [
        { binding: 0, visibility: FV, buffer: { type: 'uniform' } },
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((b) => ({ binding: b, visibility: SS.FRAGMENT, texture: {} })),
      ],
    });
    this.shadowLayout = d.createBindGroupLayout({
      label: 'shadowView',
      entries: [
        { binding: 0, visibility: SS.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: SS.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: SS.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: FV, sampler: {} },
      ],
    });
    this.linesLayout = d.createBindGroupLayout({
      label: 'lines',
      entries: [
        { binding: 0, visibility: FV, buffer: { type: 'uniform' } },
        { binding: 1, visibility: SS.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: SS.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.postLayout = d.createBindGroupLayout({
      label: 'post',
      entries: [
        { binding: 0, visibility: SS.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: SS.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: SS.FRAGMENT, texture: {} },
        { binding: 3, visibility: FV, sampler: {} },
      ],
    });
    this.bloomLayout = d.createBindGroupLayout({
      label: 'bloom',
      entries: [
        { binding: 0, visibility: SS.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: SS.FRAGMENT, texture: {} },
        { binding: 2, visibility: SS.FRAGMENT, sampler: {} },
      ],
    });
    this.stdPipelineLayout = d.createPipelineLayout({ bindGroupLayouts: [this.frameLayout, this.materialLayout] });
    this.clutterLayout = d.createBindGroupLayout({
      label: 'clutter',
      entries: [
        { binding: 0, visibility: SS.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: SS.VERTEX, buffer: { type: 'uniform' } },
      ],
    });
    this.clutterPipelineLayout = d.createPipelineLayout({ bindGroupLayouts: [this.frameLayout, this.materialLayout, this.clutterLayout] });
    this.clutterSlot = this.instances.alloc();
    this.instances.set(this.clutterSlot, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], null, -1, 2, 0, 0);
    this.shadowPipelineLayout = d.createPipelineLayout({ bindGroupLayouts: [this.shadowLayout, this.materialLayout] });

    this.materials = new MaterialLibrary(d, this.textures, this.materialLayout);
    this.sky = new SkySystem(d, this.sampClamp, this.sampAniso, this.cloudNoiseView);
  }

  private createAnisoSampler(aniso: number) {
    this.sampAniso = this.device.createSampler({
      label: `aniso${aniso}`,
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      maxAnisotropy: Math.max(1, Math.min(16, aniso)),
    });
    this.bindingsDirty = true;
  }

  setAnisotropy(a: number) {
    this.settings.anisotropy = a;
    this.createAnisoSampler(a);
  }

  setLightmaps(view: GPUTextureView, layers: number, directional = false) {
    this.lightmapView = view;
    this.lightmapLayers = layers;
    this.lightmapDirectional = directional;
    this.bindingsDirty = true;
  }

  setProbeVolume(pv: LoadedProbeVolume) {
    this.probeVolume = pv;
    this.bindingsDirty = true;
  }

  /** Creates the reflection probe set (captured on the next frame / env change). */
  setReflectionProbes(objects: ReflectionProbeObject[]) {
    this.probes = objects.length ? new ReflectionProbes(this.device, this.sky, objects) : null;
    this.lastEnvVersion = -1;
    this.bindingsDirty = true;
  }
  setDebugGrid(view: GPUTextureView) {
    this.debugGridView = view;
    this.bindingsDirty = true;
  }
  setSnowTextures(albedo: GPUTextureView, normal: GPUTextureView, orm: GPUTextureView) {
    this.snowViews = [albedo, normal, orm];
    this.bindingsDirty = true;
  }
  setCloudNoise(view: GPUTextureView) {
    this.cloudNoiseView = view;
    this.sky.setCloudNoise(view);
    this.bindingsDirty = true;
  }

  setLights(lights: LightData[]) {
    const n = Math.min(lights.length, 256);
    const f = new Float32Array(Math.max(1, n) * 16);
    for (let i = 0; i < n; i++) {
      const l = lights[i];
      const o = i * 16;
      f.set([...l.position, l.range], o);
      f.set([l.color[0] * l.intensity, l.color[1] * l.intensity, l.color[2] * l.intensity, l.fogScatter ?? 1], o + 4);
      const dir = l.direction ?? [0, -1, 0];
      const outer = ((l.outerAngle ?? 60) * Math.PI) / 180;
      const inner = ((l.innerAngle ?? 45) * Math.PI) / 180;
      f.set([dir[0], dir[1], dir[2], Math.cos(outer)], o + 8);
      f.set([Math.cos(inner), l.type === 'spot' ? 1 : 0, l.sourceRadius ?? 0.1, 0], o + 12);
    }
    this.device.queue.writeBuffer(this.lightBuffer, 0, f);
    this.lightCount = n;
  }

  /** Decals: packed decal structs + a world-space XZ grid of per-cell index lists. */
  setDecals(packed: Float32Array, count: number, cells: Uint32Array, grid: { originX: number; originZ: number; cell: number; nx: number; nz: number; maxPer: number }, atlas: GPUTextureView) {
    if (packed.byteLength > this.decalBuffer.size) {
      this.decalBuffer.destroy();
      this.decalBuffer = this.device.createBuffer({ label: 'decals', size: packed.byteLength, usage: BU.STORAGE | BU.COPY_DST });
    }
    if (cells.byteLength > this.decalCellBuffer.size) {
      this.decalCellBuffer.destroy();
      this.decalCellBuffer = this.device.createBuffer({ label: 'decalCells', size: cells.byteLength, usage: BU.STORAGE | BU.COPY_DST });
    }
    this.device.queue.writeBuffer(this.decalBuffer, 0, packed as Float32Array<ArrayBuffer>);
    this.device.queue.writeBuffer(this.decalCellBuffer, 0, cells as Uint32Array<ArrayBuffer>);
    this.decalCount = count;
    this.decalGrid = grid;
    this.decalAtlasView = atlas;
    this.bindingsDirty = true;
  }
  private decalGrid = { originX: 0, originZ: 0, cell: 8, nx: 0, nz: 0, maxPer: 0 };

  private growVisible(n: number) {
    if (n <= this.visible.data.length) return;
    let cap = this.visible.data.length;
    while (cap < n) cap *= 2;
    const a = new Uint32Array(cap);
    a.set(this.visible.data);
    this.visible.data = a;
  }

  // ------------------------------------------------------------------ pipelines

  /** Global shader features active this frame (feed the `override` constants). */
  private features = {
    debug: false, decals: true, wetness: false, shadows: true, lightmap: true, localLights: false, fog: true, specAA: true, detail: true, macro: true,
    dirLightmap: false, probeVolume: false, reflProbes: false, season: false,
  };
  /** Set false to compile the full runtime uber-shader (for comparisons). */
  specialize = true;

  private variant(m: Material): { key: string; constants: Record<string, number> } {
    const g = this.features;
    const d = m.def;
    const foliage = d.shader === 'foliage';
    const on = (b: boolean) => (this.specialize ? (b ? 1 : 0) : 1);
    const constants: Record<string, number> = {
      DEBUG_VIEWS: on(g.debug),
      USE_TRIPLANAR: on(d.mapping === 'triplanar'),
      USE_DETAIL: on(g.detail && !!(d.detail?.albedo || d.detail?.normal)),
      USE_MACRO: on(g.macro && !!d.macro),
      USE_DECALS: on(g.decals && !foliage),
      USE_WETNESS: on(g.wetness && !foliage),
      USE_SHADOWS: on(g.shadows),
      USE_LIGHTMAP: on(g.lightmap && !foliage),
      USE_LOCAL_LIGHTS: on(g.localLights),
      USE_FOG: on(g.fog),
      USE_FOLIAGE: on(foliage),
      USE_SPEC_AA: on(g.specAA),
      USE_DIR_LIGHTMAP: on(g.dirLightmap && g.lightmap && !foliage),
      USE_PROBE_VOLUME: on(g.probeVolume),
      USE_REFL_PROBES: on(g.reflProbes),
      USE_BLEND: on(!!m.blendDef),
      USE_SNOW: on(g.season && d.shader !== 'unlit'),
    };
    let bits = 0;
    Object.values(constants).forEach((v, i) => (bits |= v << i));
    return { key: bits.toString(16), constants };
  }

  /** Diagnostic: replaces the opaque fragment entry point (e.g. 'fsDiagTrivial'). */
  diagFragment: string | null = null;

  private stdPipeline(masked: boolean, doubleSided: boolean, mat: Material, msaa = this.settings.msaa, fade = false): GPURenderPipeline {
    const v = this.variant(mat);
    const key = `std:${masked}:${doubleSided}:${msaa}:${this.diagFragment}:${v.key}:${fade}`;
    let p = this.pipelines.get(key);
    if (!p) {
      const mod = shaderModule(this.device, this.diagFragment ? 'standard_diag' : 'standard');
      p = this.device.createRenderPipeline({
        label: key,
        layout: this.stdPipelineLayout,
        vertex: { module: mod, entryPoint: 'vsMain', buffers: VERTEX_LAYOUT_FULL },
        fragment: { module: mod, entryPoint: this.diagFragment ?? (masked ? 'fsMasked' : 'fsOpaque'), targets: [{ format: this.hdrFormat }], constants: { ...v.constants, USE_LOD_FADE: fade ? 1 : 0 } },
        primitive: { topology: 'triangle-list', cullMode: doubleSided ? 'none' : 'back', frontFace: 'ccw' },
        depthStencil: { format: this.depthFormat, depthWriteEnabled: true, depthCompare: 'greater' },
        multisample: { count: msaa ? 4 : 1 },
      });
      this.pipelines.set(key, p);
    }
    return p;
  }

  /** Masked geometry: depth/coverage prepass (colour writes off) or the equal-depth lit pass. */
  private maskedPipeline(prepass: boolean, doubleSided: boolean, mat: Material, msaa = this.settings.msaa, fade = false, clutter = false): GPURenderPipeline {
    // Hardware A2C when multisampled (fast path); discard-based test otherwise.
    const hwA2C = prepass && msaa && this.settings.alphaToCoverage && this.hwA2C;
    const v = this.variant(mat);
    // Only the prepass needs the fade variant: the equal-depth colour pass inherits its coverage.
    // Clutter always fades with distance.
    const fadeV = prepass && (fade || clutter);
    const key = `masked:${prepass}:${doubleSided}:${msaa}:${hwA2C}:${prepass ? '' : v.key}:${fadeV}:${clutter}`;
    let p = this.pipelines.get(key);
    if (!p) {
      const mod = shaderModule(this.device, 'standard');
      p = this.device.createRenderPipeline({
        label: key,
        layout: clutter ? this.clutterPipelineLayout : this.stdPipelineLayout,
        vertex: { module: mod, entryPoint: clutter ? 'vsClutter' : 'vsMain', buffers: VERTEX_LAYOUT_FULL },
        fragment: {
          module: mod,
          entryPoint: prepass ? (hwA2C ? 'fsDepthA2C' : 'fsDepthMasked') : 'fsMaskedColor',
          targets: [{ format: this.hdrFormat, writeMask: prepass ? 0 : GPUColorWrite.ALL }],
          constants: { ...v.constants, USE_LOD_FADE: fadeV ? 1 : 0 },
        },
        primitive: { topology: 'triangle-list', cullMode: doubleSided ? 'none' : 'back', frontFace: 'ccw' },
        depthStencil: prepass
          ? { format: this.depthFormat, depthWriteEnabled: true, depthCompare: 'greater' }
          : { format: this.depthFormat, depthWriteEnabled: false, depthCompare: 'equal' },
        multisample: { count: msaa ? 4 : 1, alphaToCoverageEnabled: hwA2C },
      });
      this.pipelines.set(key, p);
    }
    return p;
  }
  hwA2C = true;
  hdrFormat: GPUTextureFormat = 'rgba16float';
  depthFormat: GPUTextureFormat = 'depth32float';
  /** Diagnostic: switch render-target formats (clears pipeline cache + targets). */
  setTargetFormats(hdr: GPUTextureFormat, depth: GPUTextureFormat) {
    this.hdrFormat = hdr;
    this.depthFormat = depth;
    for (const k of [...this.pipelines.keys()]) if (!k.startsWith('shadow') && k !== 'post') this.pipelines.delete(k);
    this.width = 0;
  }
  useTransient = true;
  /** Forces target re-creation (after toggling target options). */
  invalidateTargets() {
    this.width = 0;
  }

  /** Experiment/diagnostic switch: 'prepass' (default), 'direct' (single pass with discard). */
  maskedMode: 'prepass' | 'direct' | 'prepassOnly' = 'prepass';

  private overdrawPipeline(doubleSided: boolean): GPURenderPipeline {
    const msaa = this.settings.msaa;
    const key = `overdraw:${doubleSided}:${msaa}`;
    let p = this.pipelines.get(key);
    if (!p) {
      const vs = shaderModule(this.device, 'standard');
      const fs = shaderModule(this.device, 'lines');
      p = this.device.createRenderPipeline({
        label: key,
        layout: this.stdPipelineLayout,
        vertex: { module: vs, entryPoint: 'vsMain', buffers: VERTEX_LAYOUT_FULL },
        fragment: {
          module: fs, entryPoint: 'fsOverdraw',
          targets: [{ format: this.hdrFormat, blend: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } } }],
        },
        primitive: { topology: 'triangle-list', cullMode: doubleSided ? 'none' : 'back' },
        depthStencil: { format: this.depthFormat, depthWriteEnabled: false, depthCompare: 'always' },
        multisample: { count: msaa ? 4 : 1 },
      });
      this.pipelines.set(key, p);
    }
    return p;
  }

  private shadowPipeline(masked: boolean, doubleSided: boolean): GPURenderPipeline {
    const s = this.settings.shadows;
    const key = `shadow:${masked}:${doubleSided}:${s.slopeBias}`;
    let p = this.pipelines.get(key);
    if (!p) {
      const mod = shaderModule(this.device, 'shadow_depth');
      p = this.device.createRenderPipeline({
        label: key,
        layout: this.shadowPipelineLayout,
        vertex: masked
          ? { module: mod, entryPoint: 'vsMasked', buffers: VERTEX_LAYOUT_POS_UV }
          : { module: mod, entryPoint: 'vsMain', buffers: VERTEX_LAYOUT_POS },
        fragment: masked ? { module: mod, entryPoint: 'fsMasked', targets: [] } : undefined,
        primitive: {
          topology: 'triangle-list',
          cullMode: doubleSided ? 'none' : 'back',
          unclippedDepth: this.gpu.caps.depthClipControl,
        },
        depthStencil: {
          format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less',
          depthBias: 0, depthBiasSlopeScale: s.slopeBias, depthBiasClamp: 0.01,
        },
      });
      this.pipelines.set(key, p);
    }
    return p;
  }

  private skyPipeline(msaa = this.settings.msaa): GPURenderPipeline {
    const key = `sky:${msaa}`;
    let p = this.pipelines.get(key);
    if (!p) {
      const mod = shaderModule(this.device, 'sky');
      p = this.device.createRenderPipeline({
        label: key,
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.frameLayout] }),
        vertex: { module: mod, entryPoint: 'vsMain' },
        fragment: { module: mod, entryPoint: 'fsMain', targets: [{ format: this.hdrFormat }] },
        primitive: { topology: 'triangle-list' },
        depthStencil: { format: this.depthFormat, depthWriteEnabled: false, depthCompare: 'greater-equal' },
        multisample: { count: msaa ? 4 : 1 },
      });
      this.pipelines.set(key, p);
    }
    return p;
  }

  private linePipeline(wire: boolean): GPURenderPipeline {
    const msaa = this.settings.msaa;
    const key = `lines:${wire}:${msaa}`;
    let p = this.pipelines.get(key);
    if (!p) {
      const mod = shaderModule(this.device, 'lines');
      p = this.device.createRenderPipeline({
        label: key,
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.linesLayout] }),
        vertex: wire
          ? { module: mod, entryPoint: 'vsWire', buffers: VERTEX_LAYOUT_POS }
          : {
              module: mod, entryPoint: 'vsLines',
              buffers: [{ arrayStride: 28, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x4' }] }],
            },
        fragment: { module: mod, entryPoint: 'fsMain', targets: [{ format: this.hdrFormat }] },
        primitive: { topology: 'line-list' },
        depthStencil: { format: this.depthFormat, depthWriteEnabled: false, depthCompare: 'greater-equal' },
        multisample: { count: msaa ? 4 : 1 },
      });
      this.pipelines.set(key, p);
    }
    return p;
  }

  private postPipeline(): GPURenderPipeline {
    const key = 'post';
    let p = this.pipelines.get(key);
    if (!p) {
      const mod = shaderModule(this.device, 'post');
      p = this.device.createRenderPipeline({
        label: key,
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.postLayout] }),
        vertex: { module: mod, entryPoint: 'vsMain' },
        fragment: { module: mod, entryPoint: 'fsMain', targets: [{ format: this.gpu.presentFormat }] },
        primitive: { topology: 'triangle-list' },
      });
      this.pipelines.set(key, p);
    }
    return p;
  }

  // ------------------------------------------------------------------ targets

  resize(width: number, height: number) {
    if (width === this.width && height === this.height && this.targetsMsaa === this.settings.msaa && this.resolved) return;
    this.width = width;
    this.height = height;
    this.targetsMsaa = this.settings.msaa;
    this.msaaColor?.destroy();
    this.depth?.destroy();
    this.resolved?.destroy();
    const d = this.device;
    const transient = this.useTransient ? transientUsage(this.gpu.caps) : 0;
    const samples = this.settings.msaa ? 4 : 1;
    if (this.settings.msaa) {
      this.msaaColor = d.createTexture({ label: 'msaaColor', size: [width, height], format: this.hdrFormat, sampleCount: 4, usage: TU.RENDER_ATTACHMENT | transient });
    } else {
      this.msaaColor = undefined;
    }
    this.depth = d.createTexture({ label: 'depth', size: [width, height], format: this.depthFormat, sampleCount: samples, usage: TU.RENDER_ATTACHMENT | transient });
    this.resolved = d.createTexture({ label: 'hdr', size: [width, height], format: this.hdrFormat, usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING });
    this.createBloomChain(width, height);
    this.postBG = d.createBindGroup({
      layout: this.postLayout,
      entries: [
        { binding: 0, resource: { buffer: this.postParams } },
        { binding: 1, resource: this.resolved.createView() },
        { binding: 2, resource: this.bloomViews[0] },
        { binding: 3, resource: this.sampClamp },
      ],
    });
  }

  private createBloomChain(width: number, height: number) {
    const d = this.device;
    for (const t of this.bloomLevels) t.destroy();
    this.bloomLevels = [];
    this.bloomViews = [];
    this.bloomDownBGs = [];
    this.bloomUpBGs = [];
    let w = Math.max(1, width >> 1), h = Math.max(1, height >> 1);
    for (let i = 0; i < 7 && Math.min(w, h) >= 4; i++) {
      const t = d.createTexture({ label: `bloom${i}`, size: [w, h], format: 'rgba16float', usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING });
      this.bloomLevels.push(t);
      this.bloomViews.push(t.createView());
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
    }
    const n = this.bloomLevels.length;
    while (this.bloomParamBufs.length < n * 2) {
      this.bloomParamBufs.push(d.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST }));
    }
    const params = (i: number, texelW: number, texelH: number, mode: number) => {
      const buf = this.bloomParamBufs[i];
      const a = new ArrayBuffer(16);
      new Float32Array(a, 0, 2).set([1 / texelW, 1 / texelH]);
      new Uint32Array(a, 8, 2).set([mode, 0]);
      d.queue.writeBuffer(buf, 0, a);
      return buf;
    };
    for (let i = 0; i < n; i++) {
      const src = i === 0 ? this.resolved!.createView() : this.bloomViews[i - 1];
      const sw = i === 0 ? width : this.bloomLevels[i - 1].width;
      const sh = i === 0 ? height : this.bloomLevels[i - 1].height;
      this.bloomDownBGs.push(d.createBindGroup({
        layout: this.bloomLayout,
        entries: [
          { binding: 0, resource: { buffer: params(i, sw, sh, i === 0 ? 0 : 1) } },
          { binding: 1, resource: src },
          { binding: 2, resource: this.sampClamp },
        ],
      }));
    }
    for (let i = 0; i < n - 1; i++) {
      // Upsample level i+1 into level i.
      const s = this.bloomLevels[i + 1];
      this.bloomUpBGs.push(d.createBindGroup({
        layout: this.bloomLayout,
        entries: [
          { binding: 0, resource: { buffer: params(n + i, s.width, s.height, 2) } },
          { binding: 1, resource: this.bloomViews[i + 1] },
          { binding: 2, resource: this.sampClamp },
        ],
      }));
    }
  }

  private bloomPipeline(up: boolean): GPURenderPipeline {
    const key = `bloom:${up}`;
    let p = this.pipelines.get(key);
    if (!p) {
      const mod = shaderModule(this.device, 'bloom');
      p = this.device.createRenderPipeline({
        label: key,
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bloomLayout] }),
        vertex: { module: mod, entryPoint: 'vsMain' },
        fragment: {
          module: mod, entryPoint: up ? 'fsUp' : 'fsDown',
          targets: [{ format: 'rgba16float', blend: up ? { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } } : undefined }],
        },
        primitive: { topology: 'triangle-list' },
      });
      this.pipelines.set(key, p);
    }
    return p;
  }

  private encodeBloom(enc: GPUCommandEncoder) {
    const n = this.bloomLevels.length;
    for (let i = 0; i < n; i++) {
      const pass = enc.beginRenderPass({ label: `bloomDown${i}`, colorAttachments: [{ view: this.bloomViews[i], loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
      pass.setPipeline(this.bloomPipeline(false));
      pass.setBindGroup(0, this.bloomDownBGs[i]);
      pass.draw(3);
      pass.end();
    }
    for (let i = n - 2; i >= 0; i--) {
      const pass = enc.beginRenderPass({ label: `bloomUp${i}`, colorAttachments: [{ view: this.bloomViews[i], loadOp: 'load', storeOp: 'store' }] });
      pass.setPipeline(this.bloomPipeline(true));
      pass.setBindGroup(0, this.bloomUpBGs[i]);
      pass.draw(3);
      pass.end();
    }
  }

  get renderWidth() {
    return this.width;
  }
  get renderHeight() {
    return this.height;
  }

  get targetBytes() {
    const px = this.width * this.height;
    return px * (this.settings.msaa ? 8 * 4 + 4 * 4 : 4) + px * 8;
  }

  private rebuildBindings() {
    const d = this.device;
    const frameEntries = (buf: GPUBuffer): GPUBindGroupEntry[] => [
        { binding: 0, resource: { buffer: buf } },
        { binding: 1, resource: { buffer: this.instances.buffer } },
        { binding: 2, resource: { buffer: this.visibleBuffer } },
        { binding: 3, resource: this.sampAniso },
        { binding: 4, resource: this.sampClamp },
        { binding: 5, resource: this.sampShadow },
        { binding: 6, resource: this.shadows.arrayView },
        { binding: 7, resource: this.sky.envSpecularView },
        { binding: 8, resource: { buffer: this.sky.shBuffer } },
        { binding: 9, resource: this.sky.brdfLut.createView() },
        { binding: 10, resource: this.lightmapView },
        { binding: 11, resource: { buffer: this.lightBuffer } },
        { binding: 12, resource: this.sky.skyView.createView() },
        { binding: 13, resource: this.sky.transmittance.createView() },
        { binding: 14, resource: { buffer: this.decalBuffer } },
        { binding: 15, resource: { buffer: this.decalCellBuffer } },
        { binding: 16, resource: this.decalAtlasView },
        { binding: 17, resource: this.debugGridView },
        { binding: 18, resource: this.cloudNoiseView },
        { binding: 19, resource: this.probeVolume?.view ?? this.dummyVolume },
        { binding: 20, resource: this.probes?.cubeArrayView ?? this.dummyCubeArray },
        { binding: 21, resource: { buffer: this.probes?.dataBuffer ?? this.dummyProbeData } },
        { binding: 22, resource: this.snowViews[0] },
        { binding: 23, resource: this.snowViews[1] },
        { binding: 24, resource: this.snowViews[2] },
      ];
    this.frameBG = d.createBindGroup({ label: 'frame', layout: this.frameLayout, entries: frameEntries(this.frameBuffer) });
    this.captureFrameBG = d.createBindGroup({ label: 'captureFrame', layout: this.frameLayout, entries: frameEntries(this.captureFrameBuffer) });
    this.shadowBGs = [];
    for (let i = 0; i < CASCADES; i++) {
      this.shadowBGs.push(
        d.createBindGroup({
          layout: this.shadowLayout,
          entries: [
            { binding: 0, resource: { buffer: this.shadows.uniforms, offset: i * 256, size: 64 } },
            { binding: 1, resource: { buffer: this.instances.buffer } },
            { binding: 2, resource: { buffer: this.visibleBuffer } },
            { binding: 3, resource: this.sampAniso },
          ],
        }),
      );
    }
    this.linesBG = d.createBindGroup({
      layout: this.linesLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuffer } },
        { binding: 1, resource: { buffer: this.instances.buffer } },
        { binding: 2, resource: { buffer: this.visibleBuffer } },
      ],
    });
    this.bindingsDirty = false;
    this.instanceGen = this.instances.generation;
  }

  /** Resolves on the next rendered frame with a PNG of the final image. */
  capture(): Promise<Blob> {
    return this.captureRaw().then((img) => {
      const c = new OffscreenCanvas(img.width, img.height);
      c.getContext('2d')!.putImageData(img, 0, 0);
      return c.convertToBlob({ type: 'image/png' });
    });
  }

  /** Resolves on the next rendered frame with the final image as RGBA pixels. */
  captureRaw(): Promise<ImageData> {
    return new Promise((res) => (this.captureRequest = res));
  }

  // ------------------------------------------------------------------ frame

  /** Flags + shader feature set for a view (main view or probe capture). */
  private viewFlags(envState: EnvironmentState, de: DerivedEnvironment, capture: boolean, msaa: boolean) {
    const S = this.settings;
    const shadowsOn = S.shadows.enabled && de.sunDir[1] > -0.02;
    const fogOn = S.fog && envState.fog.enabled;
    let flags = 0;
    if (shadowsOn) flags |= RF.SHADOWS;
    if (fogOn) flags |= RF.FOG;
    if (S.lightmaps && this.lightmapLayers > 0) flags |= RF.LIGHTMAPS;
    if (S.detailStrength > 0) flags |= RF.DETAIL;
    if (S.decals) flags |= RF.DECALS;
    if (S.specularAA > 0) flags |= RF.SPEC_AA;
    if (S.localLights && envState.lights.intensity > 0) flags |= RF.LOCAL_LIGHTS;
    if (S.shadows.cascadeBlend) flags |= RF.CASCADE_BLEND;
    if (S.shRatio) flags |= RF.SH_RATIO;
    if (S.specOcclusion) flags |= RF.SPEC_OCCLUSION;
    if (S.envSpecular) flags |= RF.ENV_SPEC;
    if (S.skyAmbient) flags |= RF.SKY_AMBIENT;
    if (S.sun) flags |= RF.SUN;
    if (S.alphaToCoverage && msaa) flags |= RF.A2C;
    if (S.shadows.pcf7) flags |= RF.PCF7;
    if (S.directionalLightmaps && this.lightmapDirectional) flags |= RF.DIR_LIGHTMAP;
    if (S.probeVolume && this.probeVolume) flags |= RF.PROBE_VOLUME;
    const reflOn = !capture && S.reflectionProbes && !!this.probes && this.probes.count > 0 && this.probes.capturedVersion >= 0;
    if (reflOn) flags |= RF.REFL_PROBES;
    const ft = this.features;
    ft.debug = !capture && S.debugView !== 0;
    ft.decals = S.decals && this.decalCount > 0;
    const W = envState.weather;
    ft.wetness = W.wetness > 0 || (W.melt ?? 0) > 0;
    ft.season = (W.snow ?? 0) > 0 || (W.dry ?? 0) > 0;
    ft.shadows = shadowsOn;
    ft.lightmap = S.lightmaps && this.lightmapLayers > 0;
    ft.localLights = (flags & RF.LOCAL_LIGHTS) !== 0 && this.lightCount > 0;
    ft.fog = fogOn;
    ft.specAA = S.specularAA > 0;
    ft.detail = S.detailStrength > 0;
    ft.macro = S.macroStrength > 0;
    ft.dirLightmap = (flags & RF.DIR_LIGHTMAP) !== 0;
    ft.probeVolume = (flags & RF.PROBE_VOLUME) !== 0;
    ft.reflProbes = reflOn;
    return { flags, shadowsOn, fogOn };
  }

  private writeFrameUniforms(F: FrameUniforms, buffer: GPUBuffer, v: ViewParams, width: number, height: number, env: Environment, de: DerivedEnvironment,
    preExposure: number, ev: number, flags: number, debugView: number) {
    const S = this.settings;
    const envState = env.state;
    F.mat(FO.viewProj, v.viewProj);
    F.mat(FO.view, v.view);
    F.mat(FO.proj, v.proj);
    F.mat(FO.invViewProj, v.invViewProj);
    for (let i = 0; i < CASCADES; i++) F.mat(FO.cascadeViewProj + i * 16, this.shadows.cascades[i].viewProj);
    F.vec4(FO.cameraPos, v.position[0], v.position[1], v.position[2], this.time);
    F.vec4(FO.viewport, width, height, 1 / width, 1 / height);
    const sunCosR = Math.cos(((envState.sun.angularDiameter / 2) * Math.PI) / 180);
    F.vec4(FO.sunDir, de.sunDir[0], de.sunDir[1], de.sunDir[2], sunCosR);
    F.vec4(FO.sunColor, de.sunIlluminance[0], de.sunIlluminance[1], de.sunIlluminance[2], 1);
    const A = envState.ambient;
    F.vec4(FO.exposure, preExposure, ev, envState.sky.intensity, A.indirect);
    const fog = envState.fog;
    const hazeDensity = fog.hazeVisibilityKm > 0 ? 3.912 / (fog.hazeVisibilityKm * 1000) : 0;
    F.vec4(FO.fog0, fog.density, fog.height, fog.falloff, hazeDensity);
    F.vec4(FO.fog1, fog.anisotropy, fog.startDistance, fog.maxOpacity, 0);
    const fa = parseColor(fog.albedo, [1, 1, 1, 1]);
    F.vec4(FO.fogColor, fa[0], fa[1], fa[2], fog.sunScatter);
    F.vec4(FO.shadow0, S.shadows.normalOffset, S.shadows.constBias, S.shadows.softness, S.shadows.distance);
    const c = this.shadows.cascades;
    F.vec4(FO.cascadeSplits, c[0].splitFar, c[1].splitFar, c[2].splitFar, c[3].splitFar);
    F.vec4(FO.cascadeTexel, c[0].texelWorld, c[1].texelWorld, c[2].texelWorld, c[3].texelWorld);
    F.vec4(FO.mat0, S.detailStrength, S.macroStrength, S.mipBias, S.normalStrength);
    F.vec4(FO.mat1, S.specularAA, envState.weather.wetness, envState.weather.puddles, A.envSpecular);
    const sk = envState.sky;
    F.vec4(FO.clouds, sk.cloudCover, sk.cloudAltitude, de.cloudOffset[0], de.cloudOffset[1]);
    const oc = env.overcastRadiance();
    F.vec4(FO.overcast, oc[0], oc[1], oc[2], sk.cloudDensity);
    const ga = parseColor(A.groundAlbedo, [0.12, 0.12, 0.1, 1]);
    F.vec4(FO.ground, ga[0], ga[1], ga[2], envState.lights.intensity);
    F.vec4(FO.lmParams, S.lightmaps ? 1 : 0, S.lightmapBicubic ? 1 : 0, A.lightmapSky, A.lightmapSun);
    F.uvec4(FO.debug, debugView, flags, this.lightCount, this.decalCount);
    const g = this.decalGrid;
    F.vec4(FO.decalGrid, g.originX, g.originZ, g.cell, 1 / g.cell);
    F.uvec4(FO.decalGrid2, g.nx, g.nz, g.maxPer, 0);
    F.vec4(FO.atmo, PLANET_RADIUS_KM, ATMOSPHERE_TOP_KM, 0.1 + Math.max(0, v.position[1]) / 1000, sk.turbidity * AEROSOL_BASE);
    F.vec4(FO.sky, SUN_TOA_LUX * envState.sun.intensity, 0, ENV_SPEC_MIPS, sk.cloudSharpness);
    const tint = parseColor(sk.tint, [1, 1, 1, 1]);
    F.vec4(FO.skyTint, tint[0], tint[1], tint[2], 0);
    const pv = this.probeVolume;
    if (pv) {
      F.vec4(FO.pvOrigin, pv.origin[0], pv.origin[1], pv.origin[2], 1);
      F.vec4(FO.pvInvSpacing, 1 / pv.spacing[0], 1 / pv.spacing[1], 1 / pv.spacing[2], 0);
    }
    F.uvec4(FO.pvDims, pv ? pv.dims[0] : 1, pv ? pv.dims[1] : 1, pv ? pv.dims[2] : 1, this.probes?.count ?? 0);
    const W = envState.weather;
    F.vec4(FO.season, W.snow ?? 0, W.melt ?? 0, W.dry ?? 0, 1 / 2.0);
    this.device.queue.writeBuffer(buffer, 0, F.data);
  }

  /** Culls and buckets the main list + shadow cascades; uploads the visible list. */
  /**
   * LOD by distance from the view to the bounds centre, normalised to the
   * reference 60-degree field of view so zoomed views keep detail.
   */
  private selectLod(r: Renderable, eye: ArrayLike<number>, k2: number, minLod = 0): LodLevel | Renderable {
    const lods = r.lods;
    if (!lods) return r;
    if (minLod >= lods.length - 1) return lods[lods.length - 1];
    const dx = (r.worldMin[0] + r.worldMax[0]) * 0.5 - eye[0];
    const dy = (r.worldMin[1] + r.worldMax[1]) * 0.5 - eye[1];
    const dz = (r.worldMin[2] + r.worldMax[2]) * 0.5 - eye[2];
    const d2 = (dx * dx + dy * dy + dz * dz) * k2;
    let i = Math.min(minLod, lods.length - 1);
    while (i + 1 < lods.length && lods[i + 1].dist2 <= d2) i++;
    this.lodCounts[i]++;
    return lods[i];
  }

  /**
   * Inside a band of ±lodFade × switch distance, draws both neighbouring LODs with
   * complementary dither masks (Source-style dithered transition, no popping).
   * Returns false outside every band.
   */
  private addLodCrossfade(list: DrawList, r: Renderable, eye: ArrayLike<number>, k2: number): boolean {
    const lods = r.lods!;
    const dx = (r.worldMin[0] + r.worldMax[0]) * 0.5 - eye[0];
    const dy = (r.worldMin[1] + r.worldMax[1]) * 0.5 - eye[1];
    const dz = (r.worldMin[2] + r.worldMax[2]) * 0.5 - eye[2];
    const d = Math.sqrt((dx * dx + dy * dy + dz * dz) * k2);
    const band = this.settings.lodFade;
    for (let k = 1; k < lods.length; k++) {
      const b = Math.sqrt(lods[k].dist2), w = b * band;
      if (d <= b - w || d >= b + w) continue;
      const t = (d - (b - w)) / (2 * w);
      const out = lods[k - 1], inc = lods[k];
      const qo = Math.min(63, Math.round(t * 63)), qi = Math.max(1, Math.round(t * 63));
      const eo = (r.slot | (qo << 24) | (1 << 30)) >>> 0, ei = (r.slot | (qi << 24) | (2 << 30)) >>> 0;
      for (let p = 0; p < out.mesh.primitives.length; p++) list.add(out.mesh.primitives[p], out.materials[p], eo, true);
      for (let p = 0; p < inc.mesh.primitives.length; p++) list.add(inc.mesh.primitives[p], inc.materials[p], ei, true);
      this.lodCounts[t < 0.5 ? k - 1 : k]++;
      return true;
    }
    return false;
  }

  private buildLists(planes: Plane[], renderables: Renderable[], shadowsOn: boolean, eye: ArrayLike<number>, fovY: number) {
    const main = this.mainList;
    main.reset();
    let visibleObjects = 0;
    const bias = Math.max(0.05, this.settings.lodBias);
    const k = Math.tan(fovY / 2) / Math.tan(Math.PI / 6) / bias;
    const k2 = k * k;
    this.lodCounts.fill(0);
    for (const r of renderables) {
      if (!r.visible) continue;
      if (!aabbVisible(planes, r.worldMin, r.worldMax)) continue;
      visibleObjects++;
      if (r.lods && this.settings.lodFade > 0 && this.addLodCrossfade(main, r, eye, k2)) continue;
      const l = this.selectLod(r, eye, k2);
      const prims = l.mesh.primitives;
      for (let k = 0; k < prims.length; k++) main.add(prims[k], l.materials[k], r.slot);
    }
    const mainLods = this.lodCounts.slice();
    let offset = main.finalize(this.visible, 0);
    let shadowDraws = 0, shadowTris = 0;
    if (shadowsOn) {
      for (let ci = 0; ci < CASCADES; ci++) {
        const list = this.shadowLists[ci];
        list.reset();
        const cp = this.shadows.cascades[ci].planes;
        for (const r of renderables) {
          if (!r.visible || !r.castShadow) continue;
          if (!aabbVisible(cp, r.worldMin, r.worldMax)) continue;
          // Camera LOD in the near cascades (self-shadowing matches what is seen),
          // coarser casters further out where a shadow texel covers decimetres.
          const l = this.selectLod(r, eye, k2, SHADOW_MIN_LOD[ci]);
          const prims = l.mesh.primitives;
          for (let k = 0; k < prims.length; k++) list.add(prims[k], l.materials[k], r.slot);
        }
        offset = list.finalize(this.visible, offset);
        shadowDraws += list.draws.length;
        shadowTris += list.triangles;
      }
    }
    if (offset * 4 > this.visibleBuffer.size) {
      this.visibleBuffer.destroy();
      this.visibleBuffer = this.device.createBuffer({ label: 'visible', size: this.visible.data.byteLength, usage: BU.STORAGE | BU.COPY_DST });
      this.bindingsDirty = true;
    }
    if (offset > 0) this.device.queue.writeBuffer(this.visibleBuffer, 0, this.visible.data, 0, offset);
    this.instances.upload();
    if (this.instances.generation !== this.instanceGen) this.bindingsDirty = true;
    if (this.bindingsDirty) this.rebuildBindings();
    this.lodCounts.set(mainLods);
    return { visibleObjects, shadowDraws, shadowTris };
  }

  private encodeShadows(enc: GPUCommandEncoder, timestamps: boolean) {
    const arena = this.arena;
    for (let ci = 0; ci < CASCADES; ci++) {
      const pass = enc.beginRenderPass({
        label: `shadow${ci}`,
        colorAttachments: [],
        depthStencilAttachment: { view: this.shadows.layerViews[ci], depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
        timestampWrites: !timestamps ? undefined : ci === 0 ? this.timer.pass('shadow0') : ci === 3 ? this.timer.pass('shadow3') : undefined,
      });
      pass.setBindGroup(0, this.shadowBGs[ci]);
      pass.setVertexBuffer(0, arena.pos.buffer);
      pass.setVertexBuffer(1, arena.attr.buffer);
      pass.setIndexBuffer(arena.index.buffer, 'uint32');
      let cur: GPURenderPipeline | null = null;
      let curMat: Material | null = null;
      for (const dr of this.shadowLists[ci].draws) {
        const p = this.shadowPipeline(dr.masked, dr.doubleSided);
        if (p !== cur) { pass.setPipeline(p); cur = p; curMat = null; }
        if (dr.material !== curMat) { pass.setBindGroup(1, dr.material.bindGroup); curMat = dr.material; }
        pass.drawIndexed(dr.prim.indexCount, dr.count, dr.prim.firstIndex, dr.prim.baseVertex, dr.first);
      }
      pass.end();
    }
  }

  /** Opaque, masked prepass + colour, sky. Returns the open pass for overlays. */
  private encodeMain(enc: GPUCommandEncoder, target: { color: GPUTextureView; resolve?: GPUTextureView; depth: GPUTextureView; msaa: boolean },
    frameBG: GPUBindGroup, overdraw: boolean, timestamps: boolean, clutter: ClutterDraw[] = []): GPURenderPassEncoder {
    const arena = this.arena;
    const msaa = target.msaa;
    const pass = enc.beginRenderPass({
      label: 'main',
      colorAttachments: [{
        view: target.color,
        resolveTarget: target.resolve,
        clearValue: overdraw ? { r: 0, g: 0, b: 0, a: -1 } : { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: target.resolve ? 'discard' : 'store',
      }],
      depthStencilAttachment: { view: target.depth, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'discard' },
      timestampWrites: timestamps ? this.timer.pass('main') : undefined,
    });
    pass.setBindGroup(0, frameBG);
    pass.setVertexBuffer(0, arena.pos.buffer);
    pass.setVertexBuffer(1, arena.attr.buffer);
    pass.setIndexBuffer(arena.index.buffer, 'uint32');
    let cur: GPURenderPipeline | null = null;
    let curMat: Material | null = null;
    const draws = this.mainList.draws;
    const drawList = (filter: (d: Draw) => boolean, pick: (d: Draw) => GPURenderPipeline) => {
      for (const dr of draws) {
        if (!filter(dr)) continue;
        const p = pick(dr);
        if (p !== cur) { pass.setPipeline(p); cur = p; curMat = null; }
        if (dr.material !== curMat) { pass.setBindGroup(1, dr.material.bindGroup); curMat = dr.material; }
        pass.drawIndexed(dr.prim.indexCount, dr.count, dr.prim.firstIndex, dr.prim.baseVertex, dr.first);
      }
    };
    if (overdraw) {
      drawList(() => true, (dr) => this.overdrawPipeline(dr.doubleSided));
    } else if (this.maskedMode === 'direct') {
      drawList(() => true, (dr) => this.stdPipeline(dr.masked, dr.doubleSided, dr.material, msaa, dr.fade));
    } else {
      // Opaque first (fills depth), then masked prepass, then masked colour at equal depth.
      drawList((d) => !d.masked, (dr) => this.stdPipeline(false, dr.doubleSided, dr.material, msaa, dr.fade));
      drawList((d) => d.masked, (dr) => this.maskedPipeline(true, dr.doubleSided, dr.material, msaa, dr.fade));
      const clutterPass = (prepassStage: boolean) => {
        for (const c of clutter) {
          const prims = c.type.mesh.primitives;
          for (let k = 0; k < prims.length; k++) {
            const m = c.type.materials[k];
            if (!m.masked) continue; // clutter is alpha-tested cards
            const p = this.maskedPipeline(prepassStage, true, m, msaa, false, true);
            if (p !== cur) { pass.setPipeline(p); cur = p; curMat = null; }
            if (m !== curMat) { pass.setBindGroup(1, m.bindGroup); curMat = m; }
            pass.setBindGroup(2, c.type.bindGroup);
            pass.drawIndexed(prims[k].indexCount, c.count, prims[k].firstIndex, prims[k].baseVertex, c.first);
          }
        }
      };
      if (this.maskedMode === 'prepass') {
        clutterPass(true);
        drawList((d) => d.masked, (dr) => this.maskedPipeline(false, dr.doubleSided, dr.material, msaa));
        clutterPass(false);
      }
    }
    if (!overdraw) {
      pass.setPipeline(this.skyPipeline(msaa));
      pass.draw(3);
    }
    return pass;
  }

  /**
   * Captures every reflection probe (6 faces each) from the lit scene, then
   * decodes, prefilters and SH-projects them. Runs on environment changes.
   */
  captureProbes(env: Environment, renderables: Renderable[]) {
    const P = this.probes;
    if (!P || P.count === 0) return;
    const t0 = performance.now();
    const d = this.device;
    const de = env.derive();
    const S = this.settings;
    for (let p = 0; p < P.count; p++) {
      const pos = P.probes[p].transform.position;
      for (let face = 0; face < 6; face++) {
        const v = faceView(pos, face);
        const { flags, shadowsOn } = this.viewFlags(env.state, de, true, false);
        this.shadows.update(v.position, v.forward, v.fovY, v.aspect, v.near, de.sunDir, S.shadows);
        this.writeFrameUniforms(this.captureFrame, this.captureFrameBuffer, v, PROBE_SIZE, PROBE_SIZE, env, de, CAPTURE_PRE_EXPOSURE, 10, flags, 0);
        const planes = extractPlanes(v.viewProj, { near: true, far: false, zeroToOne: true, reverseZ: true });
        this.buildLists(planes, renderables, shadowsOn, v.position, v.fovY);
        const enc = d.createCommandEncoder({ label: `probe${p}:${face}` });
        if (shadowsOn) this.encodeShadows(enc, false);
        const pass = this.encodeMain(enc, { color: P.captureColor.createView(), depth: P.captureDepth.createView(), msaa: false }, this.captureFrameBG!, false, false);
        pass.end();
        P.encodeDecodeFace(enc, face);
        if (face === 5) P.encodeFilter(enc, p);
        d.queue.submit([enc.finish()]);
      }
    }
    P.capturedVersion = env.version;
    P.lastCaptureMs = performance.now() - t0;
    console.info(`[probes] captured ${P.count} reflection probes in ${P.lastCaptureMs.toFixed(0)} ms (CPU)`);
  }

  render(camera: Camera, env: Environment, renderables: Renderable[], dt: number) {
    const t0 = performance.now();
    const S = this.settings;
    this.time += dt;
    const d = this.device;
    const canvas = this.gpu.canvas;
    this.resize(canvas.width, canvas.height);
    camera.aspect = this.width / this.height;
    camera.update();
    if (this.shadows.ensure(S.shadows.resolution)) this.bindingsDirty = true;
    if (this.bindingsDirty) this.rebuildBindings();

    const envState = env.state;
    const de = env.derive();

    // ---- environment-dependent precomputation: sky LUTs/env map, then probes
    if (env.version !== this.lastEnvVersion || this.sky.dirty) {
      // The env map generation reads the main frame uniforms (sun, sky, clouds).
      const pre = this.viewFlags(envState, de, false, S.msaa);
      this.writeFrameUniforms(this.frame, this.frameBuffer, camera, this.width, this.height, env, de, this.currentPreExposure, this.currentEV, pre.flags, 0);
      const enc0 = d.createCommandEncoder({ label: 'sky' });
      const ga = parseColor(envState.ambient.groundAlbedo, [0.12, 0.12, 0.1, 1]);
      this.sky.encodeUpdate(enc0, this.frameBuffer, { mieScale: envState.sky.turbidity * AEROSOL_BASE, cameraAltitudeKm: 0.1, groundAlbedo: [ga[0], ga[1], ga[2]] }, de.sunDir);
      d.queue.submit([enc0.finish()]);
      this.lastEnvVersion = env.version;
      if (this.probes && S.reflectionProbes) this.captureProbes(env, renderables);
    }

    // ---- exposure + main view uniforms
    const ex = envState.exposure;
    const ev = this.exposure.update({
      auto: S.autoExposure && (ex.auto ?? true),
      ev100: ex.ev100,
      compensation: ex.compensation,
      min: ex.min ?? ex.ev100 - 2,
      max: ex.max ?? ex.ev100 + 1.5,
    }, dt);
    const preExposure = 1 / (1.2 * Math.pow(2, ev));
    this.currentEV = ev;
    this.currentPreExposure = preExposure;
    const { flags, shadowsOn } = this.viewFlags(envState, de, false, S.msaa);
    this.shadows.update(camera.position as Float32Array, camera.forward as Float32Array, camera.fovY, camera.aspect, camera.near, de.sunDir, S.shadows);
    this.writeFrameUniforms(this.frame, this.frameBuffer, camera, this.width, this.height, env, de, preExposure, ev, flags, S.debugView);

    // Post params
    const post = new ArrayBuffer(144);
    const pu = new Uint32Array(post);
    const pf = new Float32Array(post);
    pu[0] = S.tonemapper;
    pu[2] = S.dither ? 1 : 0;
    const pp = envState.post;
    pf.set([0, pp.contrast, pp.saturation, pp.temperature], 4);
    const wb = whiteBalance(pp.temperature);
    pf.set([wb[0], wb[1], wb[2], 1], 8);
    const bloomOn = S.bloom > 0 && S.debugView === 0;
    pf.set([bloomOn ? S.bloom : 0, 1 / Math.max(1, this.bloomLevels.length), 0, 0], 12);
    const G = pp.grade ?? {};
    const v3 = (a: number[] | undefined, d: number) => (a && a.length >= 3 ? [a[0], a[1], a[2]] : [d, d, d]);
    pf.set([...v3(G.slope, 1), G.saturation ?? 1], 16);
    pf.set([...v3(G.offset, 0), 0], 20);
    pf.set([...v3(G.power, 1), 0], 24);
    pf.set([...v3(G.shadowTint, 0), G.shadowTint?.[3] ?? 0], 28);
    pf.set([...v3(G.highlightTint, 0), G.highlightTint?.[3] ?? 0], 32);
    d.queue.writeBuffer(this.postParams, 0, post);

    // ---- culling + draw lists
    const tc = performance.now();
    if (S.freezeCulling && !this.frozenPlanes) {
      this.frozenPlanes = extractPlanes(camera.viewProj, { near: true, far: false, zeroToOne: true, reverseZ: true });
      this.frozenViewProj = new Float32Array(camera.viewProj);
    } else if (!S.freezeCulling) {
      this.frozenPlanes = null;
      this.frozenViewProj = null;
    }
    const planes = this.frozenPlanes ?? extractPlanes(camera.viewProj, { near: true, far: false, zeroToOne: true, reverseZ: true });
    const ls = this.buildLists(planes, renderables, shadowsOn, camera.position, camera.fovY);
    if (this.clutter && S.clutter) this.clutter.collect(camera.position, planes, S.clutterDistance, this.clutterDraws);
    else this.clutterDraws.length = 0;
    const tcEnd = performance.now();

    // ---- encode
    const enc = d.createCommandEncoder({ label: 'frame' });
    this.timer.beginFrame();
    if (shadowsOn) this.encodeShadows(enc, true);
    const overdraw = S.debugView === DEBUG_VIEWS.overdraw;
    const pass = this.encodeMain(enc, {
      color: S.msaa ? this.msaaColor!.createView() : this.resolved!.createView(),
      resolve: S.msaa ? this.resolved!.createView() : undefined,
      depth: this.depth!.createView(),
      msaa: S.msaa,
    }, this.frameBG!, overdraw, true, this.clutterDraws);
    const arena = this.arena;
    // Debug overlays
    if (S.wireframe) {
      pass.setPipeline(this.linePipeline(true));
      pass.setBindGroup(0, this.linesBG!);
      pass.setVertexBuffer(0, arena.pos.buffer);
      for (const dr of this.mainList.draws) arena.ensureWire(dr.prim);
      pass.setIndexBuffer(arena.wire.buffer, 'uint32');
      for (const dr of this.mainList.draws) {
        pass.drawIndexed(dr.prim.wireCount, dr.count, dr.prim.wireFirst, dr.prim.baseVertex, dr.first);
      }
    }
    this.lineVerts.length = 0;
    if (S.bounds) this.addBoundsLines(renderables, planes);
    if (this.frozenViewProj) this.addFrustumLines(this.frozenViewProj);
    if (S.showProbes && this.probes) this.addProbeLines();
    if (this.lineVerts.length > 0) {
      const data = new Float32Array(this.lineVerts);
      if (data.byteLength > this.linesCapacity) {
        this.linesBuffer.destroy();
        this.linesCapacity = Math.max(data.byteLength, this.linesCapacity * 2);
        this.linesBuffer = d.createBuffer({ label: 'lines', size: this.linesCapacity, usage: BU.VERTEX | BU.COPY_DST });
      }
      d.queue.writeBuffer(this.linesBuffer, 0, data);
      pass.setPipeline(this.linePipeline(false));
      pass.setBindGroup(0, this.linesBG!);
      pass.setVertexBuffer(0, this.linesBuffer);
      pass.draw(data.length / 7);
    }
    pass.end();

    // Post
    this.exposure.encode(enc, this.resolved!.createView(), this.width, this.height, preExposure);
    if (bloomOn) this.encodeBloom(enc);
    const swap = this.gpu.context.getCurrentTexture();
    const post2 = enc.beginRenderPass({
      label: 'post',
      colorAttachments: [{ view: swap.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
      timestampWrites: this.timer.pass('post'),
    });
    post2.setPipeline(this.postPipeline());
    post2.setBindGroup(0, this.postBG!);
    post2.draw(3);
    post2.end();

    let captureBuf: GPUBuffer | null = null;
    let bytesPerRow = 0;
    if (this.captureRequest) {
      bytesPerRow = Math.ceil((this.width * 4) / 256) * 256;
      captureBuf = d.createBuffer({ size: bytesPerRow * this.height, usage: BU.COPY_DST | BU.MAP_READ });
      enc.copyTextureToBuffer({ texture: swap }, { buffer: captureBuf, bytesPerRow }, [this.width, this.height]);
    }

    this.timer.endFrame(enc);
    d.queue.submit([enc.finish()]);
    this.timer.afterSubmit();
    this.exposure.afterSubmit();
    if (captureBuf && this.captureRequest) {
      const resolve = this.captureRequest;
      this.captureRequest = null;
      this.readCapture(captureBuf, bytesPerRow, this.width, this.height, swap.format).then(resolve);
    }

    const st = this.stats;
    st.drawCalls = this.mainList.draws.length;
    st.shadowDrawCalls = ls.shadowDraws;
    st.triangles = this.mainList.triangles;
    st.shadowTriangles = ls.shadowTris;
    st.instances = this.mainList.instances;
    st.visibleObjects = ls.visibleObjects;
    st.totalObjects = renderables.length;
    st.culledObjects = renderables.length - ls.visibleObjects;
    st.cpuCullMs = tcEnd - tc;
    st.cpuEncodeMs = performance.now() - t0 - (tcEnd - tc);
  }

  private addProbeLines() {
    const P = this.probes!;
    for (const o of P.probes) {
      this.addBox(o.probe.boxMin, o.probe.boxMax, [0.3, 0.6, 1, 0.8]);
      const c = o.transform.position;
      this.addLine([c[0] - 0.3, c[1], c[2]], [c[0] + 0.3, c[1], c[2]], [1, 1, 0.2, 1]);
      this.addLine([c[0], c[1] - 0.3, c[2]], [c[0], c[1] + 0.3, c[2]], [1, 1, 0.2, 1]);
      this.addLine([c[0], c[1], c[2] - 0.3], [c[0], c[1], c[2] + 0.3], [1, 1, 0.2, 1]);
    }
  }

  private async readCapture(buf: GPUBuffer, bpr: number, w: number, h: number, format: GPUTextureFormat): Promise<ImageData> {
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buf.getMappedRange());
    const img = new ImageData(w, h);
    const bgra = format === 'bgra8unorm';
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = y * bpr + x * 4;
        const o = (y * w + x) * 4;
        img.data[o] = src[s + (bgra ? 2 : 0)];
        img.data[o + 1] = src[s + 1];
        img.data[o + 2] = src[s + (bgra ? 0 : 2)];
        img.data[o + 3] = 255;
      }
    }
    buf.unmap();
    buf.destroy();
    return img;
  }

  private addLine(a: ArrayLike<number>, b: ArrayLike<number>, col: [number, number, number, number]) {
    this.lineVerts.push(a[0], a[1], a[2], ...col, b[0], b[1], b[2], ...col);
  }

  private addBox(min: ArrayLike<number>, max: ArrayLike<number>, col: [number, number, number, number]) {
    const p = (i: number) => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
    const e = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
    for (const [a, b] of e) this.addLine(p(a), p(b), col);
  }

  private addBoundsLines(renderables: Renderable[], planes: Plane[]) {
    let n = 0;
    for (const r of renderables) {
      if (!r.visible) continue;
      const vis = aabbVisible(planes, r.worldMin, r.worldMax);
      if (!vis && !this.frozenPlanes) continue;
      this.addBox(r.worldMin, r.worldMax, vis ? [0.2, 1, 0.3, 0.6] : [1, 0.2, 0.2, 0.5]);
      if (++n > 20000) break;
    }
  }

  private addFrustumLines(vp: Float32Array) {
    const inv = mat4.inverse(vp);
    const corner = (x: number, y: number, z: number) => {
      const v = [x, y, z, 1];
      const o = [0, 0, 0, 0];
      for (let i = 0; i < 4; i++) o[i] = inv[i] * v[0] + inv[4 + i] * v[1] + inv[8 + i] * v[2] + inv[12 + i] * v[3];
      return [o[0] / o[3], o[1] / o[3], o[2] / o[3]];
    };
    // Reverse-Z infinite: draw near plane and a plane at z = 0.002 (~far).
    const zs = [1, 0.0005];
    const pts = zs.map((z) => [corner(-1, -1, z), corner(1, -1, z), corner(1, 1, z), corner(-1, 1, z)]);
    const col: [number, number, number, number] = [1, 0.8, 0.1, 1];
    for (let k = 0; k < 2; k++) for (let i = 0; i < 4; i++) this.addLine(pts[k][i], pts[k][(i + 1) % 4], col);
    for (let i = 0; i < 4; i++) this.addLine(pts[0][i], pts[1][i], col);
  }
}

/** Approximate white balance gains for a temperature shift (-1 cool .. +1 warm). */
function whiteBalance(t: number): [number, number, number] {
  return [1 + 0.12 * t, 1, 1 - 0.12 * t];
}
