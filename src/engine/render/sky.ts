import { shaderModule } from './shaderlib';

/**
 * Atmosphere LUTs + environment lighting (sky cubemap, GGX-prefiltered specular
 * cube, L2 SH irradiance, split-sum BRDF LUT). Regenerated only when the
 * environment changes (sun direction, clouds, intensities).
 */

export const ENV_SIZE = 128;
export const ENV_SPEC_MIPS = 6;
const ENV_SRC_MIPS = Math.log2(ENV_SIZE) + 1;

export const PLANET_RADIUS_KM = 6360;

/**
 * Aerosol baseline. The Bruneton/Hillaire default Mie coefficient integrates to an
 * aerosol optical depth of only ~0.005 (an almost aerosol-free atmosphere), which
 * produced a dark, over-saturated sky and ~9:1 sun:sky contrast. Real clear days
 * have AOD ~0.08-0.15 (Nordic summer ~0.1). `turbidity` 1.0 now means AOD ~0.1:
 * measured sky ~11-12 klx horizontal vs ~48 klx sun at 38 deg (ratio ~4:1),
 * skylight R/B ~0.6 - in line with measured clear-sky data.
 */
export const AEROSOL_BASE = 20;
export const ATMOSPHERE_TOP_KM = 6460;

export interface AtmosphereSettings {
  /** Mie density multiplier relative to the model default (turbidity * AEROSOL_BASE). */
  mieScale: number;
  cameraAltitudeKm: number;
  groundAlbedo: [number, number, number];
}

const U = GPUBufferUsage;
const T = GPUTextureUsage;

export class SkySystem {
  readonly transmittance: GPUTexture;
  readonly multiScat: GPUTexture;
  readonly skyView: GPUTexture;
  readonly envSource: GPUTexture;
  readonly envSpecular: GPUTexture;
  readonly envSpecularView: GPUTextureView;
  readonly brdfLut: GPUTexture;
  readonly shBuffer: GPUBuffer;
  private atmoUniform: GPUBuffer;
  private dummy: GPUTexture;

  private lutLayout0: GPUBindGroupLayout;
  private lutLayout1: GPUBindGroupLayout;
  private pTrans: GPUComputePipeline;
  private pMs: GPUComputePipeline;
  private pSkyView: GPUComputePipeline;
  private lutBG0: GPUBindGroup[] = [];
  private lutBG1: GPUBindGroup[] = [];

  private envLayout0: GPUBindGroupLayout;
  private pSkyCube: GPUComputePipeline;
  private pDown: GPUComputePipeline;
  private pPrefilter: GPUComputePipeline;
  private pSh: GPUComputePipeline;
  private envBG0!: GPUBindGroup;
  private skyCubeBG: GPUBindGroup;
  private downBGs: GPUBindGroup[] = [];
  private prefilterBGs: GPUBindGroup[] = [];
  private shBG: GPUBindGroup;
  private prefilterParams: GPUBuffer[] = [];

  dirty = true;
  /** Frames between env refreshes when clouds are animating. */
  lastEnvUpdate = -1;

  constructor(private device: GPUDevice, private sampClamp: GPUSampler, private sampAniso: GPUSampler, cloudNoise: GPUTextureView) {
    const d = device;
    const storageTex = (label: string, w: number, h: number) =>
      d.createTexture({ label, size: [w, h], format: 'rgba16float', usage: T.STORAGE_BINDING | T.TEXTURE_BINDING });
    this.transmittance = storageTex('atmo:transmittance', 256, 64);
    this.multiScat = storageTex('atmo:multiscat', 32, 32);
    this.skyView = storageTex('atmo:skyview', 192, 108);
    this.brdfLut = storageTex('brdfLut', 64, 64);
    this.dummy = storageTex('dummy', 1, 1);
    this.envSource = d.createTexture({
      label: 'env:source', size: [ENV_SIZE, ENV_SIZE, 6], format: 'rgba16float', mipLevelCount: ENV_SRC_MIPS,
      usage: T.STORAGE_BINDING | T.TEXTURE_BINDING,
    });
    this.envSpecular = d.createTexture({
      label: 'env:specular', size: [ENV_SIZE, ENV_SIZE, 6], format: 'rgba16float', mipLevelCount: ENV_SPEC_MIPS,
      usage: T.STORAGE_BINDING | T.TEXTURE_BINDING,
    });
    this.envSpecularView = this.envSpecular.createView({ dimension: 'cube' });
    this.shBuffer = d.createBuffer({ label: 'env:sh', size: 12 * 16, usage: U.STORAGE | U.COPY_DST | U.COPY_SRC });
    // Neutral grey sky until the first env update runs.
    const init = new Float32Array(48);
    init[0] = 1000; init[1] = 1000; init[2] = 1000;
    d.queue.writeBuffer(this.shBuffer, 0, init);
    this.atmoUniform = d.createBuffer({ label: 'atmo:uniform', size: 48, usage: U.UNIFORM | U.COPY_DST });

    // ---- atmosphere LUT pipelines
    const lutMod = shaderModule(d, 'atmosphere_luts');
    this.lutLayout0 = d.createBindGroupLayout({
      label: 'atmo:g0',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: {} },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: {} },
      ],
    });
    this.lutLayout1 = d.createBindGroupLayout({
      label: 'atmo:g1',
      entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { format: 'rgba16float', access: 'write-only' } }],
    });
    const lutPL = d.createPipelineLayout({ bindGroupLayouts: [this.lutLayout0, this.lutLayout1] });
    const mk = (entryPoint: string, layout: GPUPipelineLayout, module: GPUShaderModule) =>
      d.createComputePipeline({ label: entryPoint, layout, compute: { module, entryPoint } });
    this.pTrans = mk('transmittanceMain', lutPL, lutMod);
    this.pMs = mk('multiScatMain', lutPL, lutMod);
    this.pSkyView = mk('skyViewMain', lutPL, lutMod);
    const g0 = (a: GPUTexture, b: GPUTexture) =>
      d.createBindGroup({
        layout: this.lutLayout0,
        entries: [
          { binding: 0, resource: { buffer: this.atmoUniform } },
          { binding: 1, resource: sampClamp },
          { binding: 2, resource: a.createView() },
          { binding: 3, resource: b.createView() },
        ],
      });
    const g1 = (t: GPUTexture) => d.createBindGroup({ layout: this.lutLayout1, entries: [{ binding: 0, resource: t.createView() }] });
    this.lutBG0 = [g0(this.dummy, this.dummy), g0(this.transmittance, this.dummy), g0(this.transmittance, this.multiScat)];
    this.lutBG1 = [g1(this.transmittance), g1(this.multiScat), g1(this.skyView)];

    // ---- environment pipelines
    const envMod = shaderModule(d, 'env');
    const C = GPUShaderStage.COMPUTE;
    this.envLayout0 = d.createBindGroupLayout({
      label: 'env:g0',
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, sampler: {} },
        { binding: 2, visibility: C, sampler: {} },
        { binding: 3, visibility: C, texture: {} },
        { binding: 4, visibility: C, texture: {} },
        { binding: 5, visibility: C, texture: {} },
      ],
    });
    const stor2dArr = (binding: number): GPUBindGroupLayoutEntry => ({
      binding, visibility: C, storageTexture: { format: 'rgba16float', access: 'write-only', viewDimension: '2d-array' },
    });
    const skyCubeL = d.createBindGroupLayout({ entries: [stor2dArr(0)] });
    const downL = d.createBindGroupLayout({
      entries: [{ binding: 1, visibility: C, texture: { viewDimension: '2d-array', sampleType: 'unfilterable-float' } }, stor2dArr(2)],
    });
    const prefL = d.createBindGroupLayout({
      entries: [
        { binding: 3, visibility: C, buffer: { type: 'uniform' } },
        { binding: 4, visibility: C, texture: { viewDimension: 'cube' } },
        stor2dArr(5),
      ],
    });
    const shL = d.createBindGroupLayout({
      entries: [
        { binding: 6, visibility: C, texture: { viewDimension: '2d-array', sampleType: 'unfilterable-float' } },
        { binding: 7, visibility: C, buffer: { type: 'storage' } },
      ],
    });
    const brdfL = d.createBindGroupLayout({
      entries: [{ binding: 8, visibility: C, storageTexture: { format: 'rgba16float', access: 'write-only' } }],
    });
    const pl = (l: GPUBindGroupLayout) => d.createPipelineLayout({ bindGroupLayouts: [this.envLayout0, l] });
    this.pSkyCube = mk('skyCubeMain', pl(skyCubeL), envMod);
    this.pDown = mk('downsampleMain', pl(downL), envMod);
    this.pPrefilter = mk('prefilterMain', pl(prefL), envMod);
    this.pSh = mk('shMain', pl(shL), envMod);
    const pBrdf = mk('brdfLutMain', pl(brdfL), envMod);

    this.skyCubeBG = d.createBindGroup({
      layout: skyCubeL,
      entries: [{ binding: 0, resource: this.envSource.createView({ dimension: '2d-array', baseMipLevel: 0, mipLevelCount: 1 }) }],
    });
    for (let i = 1; i < ENV_SRC_MIPS; i++) {
      this.downBGs.push(
        d.createBindGroup({
          layout: downL,
          entries: [
            { binding: 1, resource: this.envSource.createView({ dimension: '2d-array', baseMipLevel: i - 1, mipLevelCount: 1 }) },
            { binding: 2, resource: this.envSource.createView({ dimension: '2d-array', baseMipLevel: i, mipLevelCount: 1 }) },
          ],
        }),
      );
    }
    const srcCube = this.envSource.createView({ dimension: 'cube' });
    for (let i = 0; i < ENV_SPEC_MIPS; i++) {
      const b = d.createBuffer({ size: 16, usage: U.UNIFORM | U.COPY_DST });
      const buf = new ArrayBuffer(16);
      new Float32Array(buf, 0, 2).set([i / (ENV_SPEC_MIPS - 1), ENV_SIZE]);
      new Uint32Array(buf, 8, 2).set([i === 0 ? 1 : 192, 0]);
      d.queue.writeBuffer(b, 0, buf);
      this.prefilterParams.push(b);
      this.prefilterBGs.push(
        d.createBindGroup({
          layout: prefL,
          entries: [
            { binding: 3, resource: { buffer: b } },
            { binding: 4, resource: srcCube },
            { binding: 5, resource: this.envSpecular.createView({ dimension: '2d-array', baseMipLevel: i, mipLevelCount: 1 }) },
          ],
        }),
      );
    }
    this.shBG = d.createBindGroup({
      layout: shL,
      entries: [
        { binding: 6, resource: this.envSource.createView({ dimension: '2d-array', baseMipLevel: 3, mipLevelCount: 1 }) },
        { binding: 7, resource: { buffer: this.shBuffer } },
      ],
    });

    // BRDF LUT once.
    this.cloudNoise = cloudNoise;
    const brdfBG = d.createBindGroup({ layout: brdfL, entries: [{ binding: 8, resource: this.brdfLut.createView() }] });
    const enc = d.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pBrdf);
    pass.setBindGroup(0, this.makeEnvBG0Dummy());
    pass.setBindGroup(1, brdfBG);
    pass.dispatchWorkgroups(8, 8);
    pass.end();
    d.queue.submit([enc.finish()]);
  }

  private cloudNoise: GPUTextureView;
  private frameBuffer?: GPUBuffer;

  private makeEnvBG0Dummy() {
    const tmp = this.device.createBuffer({ size: 1024, usage: U.UNIFORM });
    return this.device.createBindGroup({
      layout: this.envLayout0,
      entries: [
        { binding: 0, resource: { buffer: tmp } },
        { binding: 1, resource: this.sampClamp },
        { binding: 2, resource: this.sampAniso },
        { binding: 3, resource: this.dummy.createView() },
        { binding: 4, resource: this.dummy.createView() },
        { binding: 5, resource: this.dummy.createView() },
      ],
    });
  }

  setCloudNoise(view: GPUTextureView) {
    this.cloudNoise = view;
    this.frameBuffer = undefined;
    this.dirty = true;
  }

  /** Records LUT + environment regeneration into `enc`. Frame uniforms must already be written. */
  encodeUpdate(enc: GPUCommandEncoder, frameBuffer: GPUBuffer, settings: AtmosphereSettings, sunDir: [number, number, number]) {
    if (this.frameBuffer !== frameBuffer) {
      this.frameBuffer = frameBuffer;
      this.envBG0 = this.device.createBindGroup({
        layout: this.envLayout0,
        entries: [
          { binding: 0, resource: { buffer: frameBuffer } },
          { binding: 1, resource: this.sampClamp },
          { binding: 2, resource: this.sampAniso },
          { binding: 3, resource: this.skyView.createView() },
          { binding: 4, resource: this.transmittance.createView() },
          { binding: 5, resource: this.cloudNoise },
        ],
      });
    }
    const a = new Float32Array(12);
    a.set([PLANET_RADIUS_KM, ATMOSPHERE_TOP_KM, settings.mieScale, settings.cameraAltitudeKm]);
    a.set([sunDir[0], sunDir[1], sunDir[2], 0], 4);
    a.set([...settings.groundAlbedo, 0], 8);
    this.device.queue.writeBuffer(this.atmoUniform, 0, a);

    const pass = enc.beginComputePass({ label: 'sky+env' });
    // Atmosphere LUTs
    pass.setPipeline(this.pTrans);
    pass.setBindGroup(0, this.lutBG0[0]);
    pass.setBindGroup(1, this.lutBG1[0]);
    pass.dispatchWorkgroups(32, 8);
    pass.setPipeline(this.pMs);
    pass.setBindGroup(0, this.lutBG0[1]);
    pass.setBindGroup(1, this.lutBG1[1]);
    pass.dispatchWorkgroups(4, 4);
    pass.setPipeline(this.pSkyView);
    pass.setBindGroup(0, this.lutBG0[2]);
    pass.setBindGroup(1, this.lutBG1[2]);
    pass.dispatchWorkgroups(24, 14);
    // Sky -> cube
    pass.setPipeline(this.pSkyCube);
    pass.setBindGroup(0, this.envBG0);
    pass.setBindGroup(1, this.skyCubeBG);
    pass.dispatchWorkgroups(ENV_SIZE / 8, ENV_SIZE / 8, 6);
    pass.setPipeline(this.pDown);
    for (let i = 1; i < ENV_SRC_MIPS; i++) {
      const s = Math.max(1, ENV_SIZE >> i);
      pass.setBindGroup(1, this.downBGs[i - 1]);
      pass.dispatchWorkgroups(Math.ceil(s / 8), Math.ceil(s / 8), 6);
    }
    pass.setPipeline(this.pPrefilter);
    for (let i = 0; i < ENV_SPEC_MIPS; i++) {
      const s = Math.max(1, ENV_SIZE >> i);
      pass.setBindGroup(1, this.prefilterBGs[i]);
      pass.dispatchWorkgroups(Math.ceil(s / 8), Math.ceil(s / 8), 6);
    }
    pass.setPipeline(this.pSh);
    pass.setBindGroup(1, this.shBG);
    pass.dispatchWorkgroups(1);
    pass.end();
    this.dirty = false;
  }
}

// ---------------------------------------------------------------- CPU atmosphere

/** Transmittance from a point at `altKm` toward a direction with zenith cosine `cosZ`. */
export function atmosphereTransmittance(cosZ: number, altKm: number, mieScale: number): [number, number, number] {
  const R = PLANET_RADIUS_KM, top = ATMOSPHERE_TOP_KM;
  const h0 = R + altKm;
  // Ray/sphere with ray origin (0, h0), dir (sinZ, cosZ).
  const sinZ = Math.sqrt(Math.max(0, 1 - cosZ * cosZ));
  const b = h0 * cosZ;
  const c = h0 * h0 - top * top;
  const tTop = -b + Math.sqrt(Math.max(0, b * b - c));
  // Below the horizon the ground blocks the sun entirely.
  const cg = h0 * h0 - R * R;
  const dg = b * b - cg;
  if (dg > 0 && -b - Math.sqrt(dg) > 0) return [0, 0, 0];
  const steps = 64;
  const dt = tTop / steps;
  let odR = 0, odM = 0, odO = 0;
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    const x = sinZ * t, y = h0 + cosZ * t;
    const h = Math.hypot(x, y) - R;
    odR += Math.exp(-h / 8) * dt;
    odM += Math.exp(-h / 1.2) * mieScale * dt;
    odO += Math.max(0, 1 - Math.abs(h - 25) / 15) * dt;
  }
  const rs = [5.802e-3, 13.558e-3, 33.1e-3];
  const oz = [0.65e-3, 1.881e-3, 0.085e-3];
  return [0, 1, 2].map((k) => Math.exp(-(rs[k] * odR + 4.44e-3 * odM + oz[k] * odO))) as [number, number, number];
}
