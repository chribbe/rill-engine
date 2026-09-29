import { mat4 } from 'wgpu-matrix';
import { transientUsage, type GpuContext } from '../gpu/context';
import { shaderModule } from './shaderlib';
import { FrameUniforms, FRAME_BYTES, FO, RF } from './frame';
import { GeometryArena, VERTEX_LAYOUT_FULL, VERTEX_LAYOUT_POS, VERTEX_LAYOUT_POS_UV, type GpuMesh, type GpuPrimitive } from './geometry';
import { TextureManager } from './textures';
import { MaterialLibrary, type Material } from './materials';
import { SkySystem, ENV_SPEC_MIPS, PLANET_RADIUS_KM, ATMOSPHERE_TOP_KM } from './sky';
import { ShadowSystem, CASCADES, type ShadowSettings } from './shadows';
import { InstanceStore } from './instances';
import { GpuTimer } from './timing';
import { aabbVisible, extractPlanes, type Plane } from './culling';
import type { Camera } from '../scene/camera';
import { Environment, SUN_TOA_LUX } from '../scene/environment';
import { parseColor } from './materials';

export interface Renderable {
  slot: number;
  mesh: GpuMesh;
  materials: Material[];
  worldMin: Float32Array;
  worldMax: Float32Array;
  castShadow: boolean;
  visible: boolean;
  id: string;
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
}

class Bucket {
  slots = new Uint32Array(64);
  count = 0;
  constructor(public prim: GpuPrimitive, public material: Material) {}
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

  add(prim: GpuPrimitive, mat: Material, slot: number) {
    const key = prim.id * 65536 + mat.id;
    let b = this.buckets.get(key);
    if (!b) {
      b = new Bucket(prim, mat);
      this.buckets.set(key, b);
    }
    if (b.count === 0) this.active.push(b);
    b.push(slot);
  }

  /** Sorts and appends instance slots to `out` starting at `offset`; returns the new offset. */
  finalize(out: { data: Uint32Array; grow: (n: number) => void }, offset: number): number {
    this.active.sort((a, b) => {
      const ma = a.material.masked ? 1 : 0, mb = b.material.masked ? 1 : 0;
      if (ma !== mb) return ma - mb;
      const da = a.material.doubleSided ? 1 : 0, db = b.material.doubleSided ? 1 : 0;
      if (da !== db) return da - db;
      if (a.material.id !== b.material.id) return a.material.id - b.material.id;
      return a.prim.id - b.prim.id;
    });
    let o = offset;
    for (const b of this.active) {
      out.grow(o + b.count);
      out.data.set(b.slots.subarray(0, b.count), o);
      this.draws.push({ prim: b.prim, material: b.material, first: o, count: b.count, masked: b.material.masked, doubleSided: b.material.doubleSided });
      this.triangles += (b.prim.indexCount / 3) * b.count;
      this.instances += b.count;
      o += b.count;
    }
    return o;
  }
}

const TU = GPUTextureUsage;
const BU = GPUBufferUsage;
const SS = GPUShaderStage;

export class Renderer {
  readonly device: GPUDevice;
  readonly frame = new FrameUniforms();
  readonly frameBuffer: GPUBuffer;
  readonly instances: InstanceStore;
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
  private postParams: GPUBuffer;
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
  private captureRequest: ((b: Blob) => void) | null = null;
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
    this.postParams = d.createBuffer({ label: 'post', size: 48, usage: BU.UNIFORM | BU.COPY_DST });
    this.linesBuffer = d.createBuffer({ label: 'lines', size: 16, usage: BU.VERTEX | BU.COPY_DST });

    const blackArr = d.createTexture({ size: [1, 1, 2], format: 'rgba16float', usage: TU.TEXTURE_BINDING | TU.COPY_DST });
    this.lightmapView = blackArr.createView({ dimension: '2d-array' });
    const decalDummy = d.createTexture({ size: [1, 1, 1], format: 'rgba8unorm', usage: TU.TEXTURE_BINDING });
    this.decalAtlasView = decalDummy.createView({ dimension: '2d-array' });
    this.debugGridView = this.textures.white.view;
    this.cloudNoiseView = this.textures.gray.view;

    // ---- layouts
    const FV = SS.VERTEX | SS.FRAGMENT;
    this.frameLayout = d.createBindGroupLayout({
      label: 'frame',
      entries: [
        { binding: 0, visibility: FV, buffer: { type: 'uniform' } },
        { binding: 1, visibility: FV, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: FV, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: SS.FRAGMENT, sampler: {} },
        { binding: 4, visibility: SS.FRAGMENT, sampler: {} },
        { binding: 5, visibility: SS.FRAGMENT, sampler: { type: 'comparison' } },
        { binding: 6, visibility: SS.FRAGMENT, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
        { binding: 7, visibility: SS.FRAGMENT, texture: { viewDimension: 'cube' } },
        { binding: 8, visibility: SS.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 9, visibility: SS.FRAGMENT, texture: {} },
        { binding: 10, visibility: SS.FRAGMENT, texture: { viewDimension: '2d-array' } },
        { binding: 11, visibility: SS.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 12, visibility: SS.FRAGMENT, texture: {} },
        { binding: 13, visibility: SS.FRAGMENT, texture: {} },
        { binding: 14, visibility: SS.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 15, visibility: SS.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 16, visibility: SS.FRAGMENT, texture: { viewDimension: '2d-array' } },
        { binding: 17, visibility: SS.FRAGMENT, texture: {} },
        { binding: 18, visibility: SS.FRAGMENT, texture: {} },
      ],
    });
    this.materialLayout = d.createBindGroupLayout({
      label: 'material',
      entries: [
        { binding: 0, visibility: FV, buffer: { type: 'uniform' } },
        ...[1, 2, 3, 4, 5, 6].map((b) => ({ binding: b, visibility: SS.FRAGMENT, texture: {} })),
      ],
    });
    this.shadowLayout = d.createBindGroupLayout({
      label: 'shadowView',
      entries: [
        { binding: 0, visibility: SS.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: SS.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: SS.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: SS.FRAGMENT, sampler: {} },
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
      ],
    });
    this.stdPipelineLayout = d.createPipelineLayout({ bindGroupLayouts: [this.frameLayout, this.materialLayout] });
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

  setLightmaps(view: GPUTextureView, layers: number) {
    this.lightmapView = view;
    this.lightmapLayers = layers;
    this.bindingsDirty = true;
  }
  setDebugGrid(view: GPUTextureView) {
    this.debugGridView = view;
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

  private stdPipeline(masked: boolean, doubleSided: boolean): GPURenderPipeline {
    const msaa = this.settings.msaa;
    const key = `std:${masked}:${doubleSided}:${msaa}`;
    let p = this.pipelines.get(key);
    if (!p) {
      const mod = shaderModule(this.device, 'standard');
      p = this.device.createRenderPipeline({
        label: key,
        layout: this.stdPipelineLayout,
        vertex: { module: mod, entryPoint: 'vsMain', buffers: VERTEX_LAYOUT_FULL },
        fragment: { module: mod, entryPoint: masked ? 'fsMasked' : 'fsOpaque', targets: [{ format: 'rgba16float' }] },
        primitive: { topology: 'triangle-list', cullMode: doubleSided ? 'none' : 'back', frontFace: 'ccw' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
        multisample: { count: msaa ? 4 : 1 },
      });
      this.pipelines.set(key, p);
    }
    return p;
  }

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
          targets: [{ format: 'rgba16float', blend: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } } }],
        },
        primitive: { topology: 'triangle-list', cullMode: doubleSided ? 'none' : 'back' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'always' },
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

  private skyPipeline(): GPURenderPipeline {
    const msaa = this.settings.msaa;
    const key = `sky:${msaa}`;
    let p = this.pipelines.get(key);
    if (!p) {
      const mod = shaderModule(this.device, 'sky');
      p = this.device.createRenderPipeline({
        label: key,
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.frameLayout] }),
        vertex: { module: mod, entryPoint: 'vsMain' },
        fragment: { module: mod, entryPoint: 'fsMain', targets: [{ format: 'rgba16float' }] },
        primitive: { topology: 'triangle-list' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'greater-equal' },
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
        fragment: { module: mod, entryPoint: 'fsMain', targets: [{ format: 'rgba16float' }] },
        primitive: { topology: 'line-list' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'greater-equal' },
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
    const transient = transientUsage(this.gpu.caps);
    const samples = this.settings.msaa ? 4 : 1;
    if (this.settings.msaa) {
      this.msaaColor = d.createTexture({ label: 'msaaColor', size: [width, height], format: 'rgba16float', sampleCount: 4, usage: TU.RENDER_ATTACHMENT | transient });
    } else {
      this.msaaColor = undefined;
    }
    this.depth = d.createTexture({ label: 'depth', size: [width, height], format: 'depth32float', sampleCount: samples, usage: TU.RENDER_ATTACHMENT | transient });
    this.resolved = d.createTexture({ label: 'hdr', size: [width, height], format: 'rgba16float', usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING });
    this.postBG = d.createBindGroup({
      layout: this.postLayout,
      entries: [
        { binding: 0, resource: { buffer: this.postParams } },
        { binding: 1, resource: this.resolved.createView() },
      ],
    });
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
    this.frameBG = d.createBindGroup({
      label: 'frame',
      layout: this.frameLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuffer } },
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
      ],
    });
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
    return new Promise((res) => (this.captureRequest = res));
  }

  // ------------------------------------------------------------------ frame

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

    // ---- environment + frame uniforms
    const envState = env.state;
    const de = env.derive();
    const F = this.frame;
    F.mat(FO.viewProj, camera.viewProj);
    F.mat(FO.view, camera.view);
    F.mat(FO.proj, camera.proj);
    F.mat(FO.invViewProj, camera.invViewProj);
    const shadowsOn = S.shadows.enabled && de.sunDir[1] > -0.02;
    this.shadows.update(camera.position as Float32Array, camera.forward as Float32Array, camera.fovY, camera.aspect, camera.near, de.sunDir, S.shadows);
    for (let i = 0; i < CASCADES; i++) F.mat(FO.cascadeViewProj + i * 16, this.shadows.cascades[i].viewProj);
    F.vec4(FO.cameraPos, camera.position[0], camera.position[1], camera.position[2], this.time);
    F.vec4(FO.viewport, this.width, this.height, 1 / this.width, 1 / this.height);
    const sunCosR = Math.cos(((envState.sun.angularDiameter / 2) * Math.PI) / 180);
    F.vec4(FO.sunDir, de.sunDir[0], de.sunDir[1], de.sunDir[2], sunCosR);
    F.vec4(FO.sunColor, de.sunIlluminance[0], de.sunIlluminance[1], de.sunIlluminance[2], 1);
    const A = envState.ambient;
    F.vec4(FO.exposure, de.preExposure, envState.exposure.ev100, envState.sky.intensity, A.indirect);
    const fog = envState.fog;
    const hazeDensity = fog.hazeVisibilityKm > 0 ? 3.912 / (fog.hazeVisibilityKm * 1000) : 0;
    const fogOn = S.fog && fog.enabled;
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
    if (S.alphaToCoverage && S.msaa) flags |= RF.A2C;
    if (S.shadows.pcf7) flags |= RF.PCF7;
    F.uvec4(FO.debug, S.debugView, flags, this.lightCount, this.decalCount);
    const g = this.decalGrid;
    F.vec4(FO.decalGrid, g.originX, g.originZ, g.cell, 1 / g.cell);
    F.uvec4(FO.decalGrid2, g.nx, g.nz, g.maxPer, 0);
    F.vec4(FO.atmo, PLANET_RADIUS_KM, ATMOSPHERE_TOP_KM, 0.1 + Math.max(0, camera.position[1]) / 1000, sk.turbidity);
    F.vec4(FO.sky, SUN_TOA_LUX * envState.sun.intensity, 0, ENV_SPEC_MIPS, sk.cloudSharpness);
    d.queue.writeBuffer(this.frameBuffer, 0, F.data);

    // Post params
    const post = new ArrayBuffer(48);
    const pu = new Uint32Array(post);
    const pf = new Float32Array(post);
    pu[0] = S.tonemapper;
    pu[2] = S.dither ? 1 : 0;
    const pp = envState.post;
    pf.set([envState.exposure.compensation * 0, pp.contrast, pp.saturation, pp.temperature], 4);
    const wb = whiteBalance(pp.temperature);
    pf.set([wb[0], wb[1], wb[2], 1], 8);
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
    const main = this.mainList;
    main.reset();
    let visibleObjects = 0;
    for (const r of renderables) {
      if (!r.visible) continue;
      if (!aabbVisible(planes, r.worldMin, r.worldMax)) continue;
      visibleObjects++;
      const prims = r.mesh.primitives;
      for (let k = 0; k < prims.length; k++) main.add(prims[k], r.materials[k], r.slot);
    }
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
          const prims = r.mesh.primitives;
          for (let k = 0; k < prims.length; k++) list.add(prims[k], r.materials[k], r.slot);
        }
        offset = list.finalize(this.visible, offset);
        shadowDraws += list.draws.length;
        shadowTris += list.triangles;
      }
    }
    // Upload visible list (grow GPU buffer if needed).
    if (offset * 4 > this.visibleBuffer.size) {
      this.visibleBuffer.destroy();
      this.visibleBuffer = d.createBuffer({ label: 'visible', size: this.visible.data.byteLength, usage: BU.STORAGE | BU.COPY_DST });
      this.bindingsDirty = true;
    }
    if (offset > 0) d.queue.writeBuffer(this.visibleBuffer, 0, this.visible.data, 0, offset);
    this.instances.upload();
    if (this.instances.generation !== this.instanceGen) this.bindingsDirty = true;
    if (this.bindingsDirty) this.rebuildBindings();
    const tcEnd = performance.now();

    // ---- encode
    const enc = d.createCommandEncoder({ label: 'frame' });
    this.timer.beginFrame();
    if (env.version !== this.lastEnvVersion || this.sky.dirty) {
      this.sky.encodeUpdate(enc, this.frameBuffer, { mieScale: sk.turbidity, cameraAltitudeKm: 0.1, groundAlbedo: [ga[0], ga[1], ga[2]] }, de.sunDir);
      this.lastEnvVersion = env.version;
    }
    const arena = this.arena;

    // Shadows
    if (shadowsOn) {
      for (let ci = 0; ci < CASCADES; ci++) {
        const pass = enc.beginRenderPass({
          label: `shadow${ci}`,
          colorAttachments: [],
          depthStencilAttachment: { view: this.shadows.layerViews[ci], depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
          timestampWrites: ci === 0 ? this.timer.pass('shadow0') : ci === 3 ? this.timer.pass('shadow3') : undefined,
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

    // Main forward pass
    const overdraw = S.debugView === DEBUG_VIEWS.overdraw;
    const colorView = S.msaa ? this.msaaColor!.createView() : this.resolved!.createView();
    const pass = enc.beginRenderPass({
      label: 'main',
      colorAttachments: [{
        view: colorView,
        resolveTarget: S.msaa ? this.resolved!.createView() : undefined,
        clearValue: overdraw ? { r: 0, g: 0, b: 0, a: -1 } : { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: S.msaa ? 'discard' : 'store',
      }],
      depthStencilAttachment: { view: this.depth!.createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'discard' },
      timestampWrites: this.timer.pass('main'),
    });
    pass.setBindGroup(0, this.frameBG!);
    pass.setVertexBuffer(0, arena.pos.buffer);
    pass.setVertexBuffer(1, arena.attr.buffer);
    pass.setIndexBuffer(arena.index.buffer, 'uint32');
    let cur: GPURenderPipeline | null = null;
    let curMat: Material | null = null;
    for (const dr of main.draws) {
      const p = overdraw ? this.overdrawPipeline(dr.doubleSided) : this.stdPipeline(dr.masked, dr.doubleSided);
      if (p !== cur) { pass.setPipeline(p); cur = p; curMat = null; }
      if (dr.material !== curMat) { pass.setBindGroup(1, dr.material.bindGroup); curMat = dr.material; }
      pass.drawIndexed(dr.prim.indexCount, dr.count, dr.prim.firstIndex, dr.prim.baseVertex, dr.first);
    }
    if (!overdraw) {
      pass.setPipeline(this.skyPipeline());
      pass.draw(3);
    }
    // Debug overlays
    if (S.wireframe) {
      pass.setPipeline(this.linePipeline(true));
      pass.setBindGroup(0, this.linesBG!);
      pass.setVertexBuffer(0, arena.pos.buffer);
      for (const dr of main.draws) arena.ensureWire(dr.prim);
      pass.setIndexBuffer(arena.wire.buffer, 'uint32');
      for (const dr of main.draws) {
        pass.drawIndexed(dr.prim.wireCount, dr.count, dr.prim.wireFirst, dr.prim.baseVertex, dr.first);
      }
    }
    this.lineVerts.length = 0;
    if (S.bounds) this.addBoundsLines(renderables, planes);
    if (this.frozenViewProj) this.addFrustumLines(this.frozenViewProj);
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
    if (captureBuf && this.captureRequest) {
      const resolve = this.captureRequest;
      this.captureRequest = null;
      this.readCapture(captureBuf, bytesPerRow, this.width, this.height, swap.format).then(resolve);
    }

    const st = this.stats;
    st.drawCalls = main.draws.length;
    st.shadowDrawCalls = shadowDraws;
    st.triangles = main.triangles;
    st.shadowTriangles = shadowTris;
    st.instances = main.instances;
    st.visibleObjects = visibleObjects;
    st.totalObjects = renderables.length;
    st.culledObjects = renderables.length - visibleObjects;
    st.cpuCullMs = tcEnd - tc;
    st.cpuEncodeMs = performance.now() - t0 - (tcEnd - tc);
  }

  private async readCapture(buf: GPUBuffer, bpr: number, w: number, h: number, format: GPUTextureFormat): Promise<Blob> {
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
    const c = new OffscreenCanvas(w, h);
    c.getContext('2d')!.putImageData(img, 0, 0);
    return c.convertToBlob({ type: 'image/png' });
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
