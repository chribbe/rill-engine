import { mat4, vec3 } from 'wgpu-matrix';
import { shaderModule } from './shaderlib';
import type { SkySystem } from './sky';
import { ENV_SIZE, ENV_SPEC_MIPS } from './sky';
import type { ReflectionProbeObject } from '../scene/mapformat';

/**
 * Box-projected reflection probes (Source `env_cubemap` / Source 2 style),
 * captured in-engine from the lit scene (lightmaps, sun, sky, fog), GGX
 * prefiltered into a cube array and SH-projected for reflection
 * normalisation. Re-captured whenever the environment changes.
 */

export const PROBE_SIZE = ENV_SIZE; // 128 - shares the env prefilter setup
const PROBE_RECORD = 256; // bytes per probe in the storage buffer (SH[12] + pos/bmin/bmax/pad)
/** Fixed exposure for captures (values stored in absolute nits after decode). */
export const CAPTURE_PRE_EXPOSURE = 1 / 1024;

export interface CaptureView {
  position: Float32Array;
  forward: Float32Array;
  view: Float32Array;
  proj: Float32Array;
  viewProj: Float32Array;
  invViewProj: Float32Array;
  fovY: number;
  aspect: number;
  near: number;
}

// Face directions/up vectors in cube-map order (+X -X +Y -Y +Z -Z).
const FACES: [number[], number[]][] = [
  [[1, 0, 0], [0, 1, 0]],
  [[-1, 0, 0], [0, 1, 0]],
  [[0, 1, 0], [0, 0, -1]],
  [[0, -1, 0], [0, 0, 1]],
  [[0, 0, 1], [0, 1, 0]],
  [[0, 0, -1], [0, 1, 0]],
];

export function faceView(pos: ArrayLike<number>, face: number): CaptureView {
  const [f, up] = FACES[face];
  const p = vec3.fromValues(pos[0], pos[1], pos[2]);
  const view = mat4.lookAt(p, vec3.add(p, f), up);
  const proj = mat4.perspectiveReverseZ(Math.PI / 2, 1, 0.05, Infinity);
  const viewProj = mat4.multiply(proj, view);
  return {
    position: p as Float32Array,
    forward: vec3.fromValues(f[0], f[1], f[2]) as Float32Array,
    view: view as Float32Array,
    proj: proj as Float32Array,
    viewProj: viewProj as Float32Array,
    invViewProj: mat4.inverse(viewProj) as Float32Array,
    fovY: Math.PI / 2,
    aspect: 1,
    near: 0.05,
  };
}

export class ReflectionProbes {
  readonly count: number;
  readonly cubeArray: GPUTexture;
  readonly cubeArrayView: GPUTextureView;
  readonly dataBuffer: GPUBuffer;
  readonly captureColor: GPUTexture;
  readonly captureDepth: GPUTexture;
  private srcCube: GPUTexture;
  private decodePipeline: GPUComputePipeline;
  private decodeParams: GPUBuffer[] = [];
  private decodeBGs: GPUBindGroup[] = [];
  private downBGs: GPUBindGroup[] = [];
  private prefilterBGs: GPUBindGroup[][] = [];
  private shBGs: GPUBindGroup[] = [];
  readonly probes: ReflectionProbeObject[];
  /** Environment version the probes were last captured for. */
  capturedVersion = -1;
  lastCaptureMs = 0;

  constructor(device: GPUDevice, private sky: SkySystem, probes: ReflectionProbeObject[]) {
    const d = device;
    this.probes = probes;
    this.count = probes.length;
    const layers = Math.max(1, this.count) * 6;
    const T = GPUTextureUsage;
    this.cubeArray = d.createTexture({
      label: 'reflProbes', size: [PROBE_SIZE, PROBE_SIZE, layers], format: 'rgba16float', mipLevelCount: ENV_SPEC_MIPS,
      usage: T.TEXTURE_BINDING | T.STORAGE_BINDING,
    });
    this.cubeArrayView = this.cubeArray.createView({ dimension: 'cube-array', arrayLayerCount: layers });
    this.dataBuffer = d.createBuffer({ label: 'reflProbeData', size: Math.max(1, this.count) * PROBE_RECORD, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.captureColor = d.createTexture({ label: 'probeCapture', size: [PROBE_SIZE, PROBE_SIZE], format: 'rgba16float', usage: T.RENDER_ATTACHMENT | T.TEXTURE_BINDING });
    this.captureDepth = d.createTexture({ label: 'probeCaptureDepth', size: [PROBE_SIZE, PROBE_SIZE], format: 'depth32float', usage: T.RENDER_ATTACHMENT });
    const srcMips = Math.log2(PROBE_SIZE) + 1;
    this.srcCube = d.createTexture({
      label: 'probeSource', size: [PROBE_SIZE, PROBE_SIZE, 6], format: 'rgba16float', mipLevelCount: srcMips,
      usage: T.STORAGE_BINDING | T.TEXTURE_BINDING,
    });
    this.decodePipeline = d.createComputePipeline({ label: 'probeDecode', layout: 'auto', compute: { module: shaderModule(d, 'probe_decode'), entryPoint: 'main' } });
    for (let f = 0; f < 6; f++) {
      const b = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const a = new ArrayBuffer(16);
      new Float32Array(a, 0, 1)[0] = 1 / CAPTURE_PRE_EXPOSURE;
      new Uint32Array(a, 4, 1)[0] = f;
      d.queue.writeBuffer(b, 0, a);
      this.decodeParams.push(b);
      this.decodeBGs.push(d.createBindGroup({
        layout: this.decodePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: b } },
          { binding: 1, resource: this.captureColor.createView() },
          { binding: 2, resource: this.srcCube.createView({ dimension: '2d-array', baseMipLevel: 0, mipLevelCount: 1 }) },
        ],
      }));
    }
    const L = sky.layouts;
    for (let i = 1; i < srcMips; i++) {
      this.downBGs.push(d.createBindGroup({
        layout: L.down,
        entries: [
          { binding: 1, resource: this.srcCube.createView({ dimension: '2d-array', baseMipLevel: i - 1, mipLevelCount: 1 }) },
          { binding: 2, resource: this.srcCube.createView({ dimension: '2d-array', baseMipLevel: i, mipLevelCount: 1 }) },
        ],
      }));
    }
    const srcCubeView = this.srcCube.createView({ dimension: 'cube' });
    for (let p = 0; p < this.count; p++) {
      const bgs: GPUBindGroup[] = [];
      for (let m = 0; m < ENV_SPEC_MIPS; m++) {
        bgs.push(d.createBindGroup({
          layout: L.prefilter,
          entries: [
            { binding: 3, resource: { buffer: sky.prefilterParams[m] } },
            { binding: 4, resource: srcCubeView },
            { binding: 5, resource: this.cubeArray.createView({ dimension: '2d-array', baseArrayLayer: p * 6, arrayLayerCount: 6, baseMipLevel: m, mipLevelCount: 1 }) },
          ],
        }));
      }
      this.prefilterBGs.push(bgs);
      this.shBGs.push(d.createBindGroup({
        layout: L.sh,
        entries: [
          { binding: 6, resource: this.srcCube.createView({ dimension: '2d-array', baseMipLevel: 3, mipLevelCount: 1 }) },
          { binding: 7, resource: { buffer: this.dataBuffer, offset: p * PROBE_RECORD, size: 192 } },
        ],
      }));
    }
    // Static per-probe data (position / box / layer); SH is written by the GPU.
    for (let p = 0; p < this.count; p++) {
      const o = probes[p];
      const f = new Float32Array(16);
      f.set([...o.transform.position, p], 0);
      f.set([...o.probe.boxMin, o.probe.blend ?? 1.5], 4);
      f.set([...o.probe.boxMax, o.probe.priority ?? 0], 8);
      d.queue.writeBuffer(this.dataBuffer, p * PROBE_RECORD + 192, f, 0, 12);
    }
  }

  /** After the 6 faces of probe `p` have been rendered+decoded: mips, prefilter, SH. */
  encodeDecodeFace(enc: GPUCommandEncoder, face: number) {
    const pass = enc.beginComputePass({ label: 'probeDecode' });
    pass.setPipeline(this.decodePipeline);
    pass.setBindGroup(0, this.decodeBGs[face]);
    pass.dispatchWorkgroups(PROBE_SIZE / 8, PROBE_SIZE / 8);
    pass.end();
  }

  encodeFilter(enc: GPUCommandEncoder, p: number) {
    const s = this.sky;
    const pass = enc.beginComputePass({ label: `probeFilter${p}` });
    pass.setBindGroup(0, s.envBindGroup0!);
    pass.setPipeline(s.pipelines.down);
    for (let i = 1; i <= this.downBGs.length; i++) {
      const sz = Math.max(1, PROBE_SIZE >> i);
      pass.setBindGroup(1, this.downBGs[i - 1]);
      pass.dispatchWorkgroups(Math.ceil(sz / 8), Math.ceil(sz / 8), 6);
    }
    pass.setPipeline(s.pipelines.prefilter);
    for (let m = 0; m < ENV_SPEC_MIPS; m++) {
      const sz = Math.max(1, PROBE_SIZE >> m);
      pass.setBindGroup(1, this.prefilterBGs[p][m]);
      pass.dispatchWorkgroups(Math.ceil(sz / 8), Math.ceil(sz / 8), 6);
    }
    pass.setPipeline(s.pipelines.sh);
    pass.setBindGroup(1, this.shBGs[p]);
    pass.dispatchWorkgroups(1);
    pass.end();
  }

  get bytes() {
    let b = 0;
    for (let m = 0; m < ENV_SPEC_MIPS; m++) b += (PROBE_SIZE >> m) ** 2 * 8 * 6 * Math.max(1, this.count);
    return b;
  }
}
