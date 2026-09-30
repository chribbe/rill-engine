import { shaderModule } from './shaderlib';

/**
 * Auto exposure ("eye adaptation"), in the spirit of Source's tone-map
 * controller: the resolved HDR image is metered into a centre-weighted
 * log-luminance histogram on the GPU; the CPU reads it back asynchronously
 * (no stalls), averages between percentiles (so a bright sky or deep shade
 * cannot dominate), converts to EV100 and adapts with asymmetric rates,
 * clamped to per-environment limits. Manual EV remains the fallback and the
 * starting point.
 */

const BINS = 128;
const MIN_LOG = -16; // pre-exposed log2 luminance range covered by the histogram
const MAX_LOG = 6;

export interface ExposureSettings {
  auto: boolean;
  ev100: number;
  compensation: number;
  min: number;
  max: number;
}

export class ExposureController {
  private pipeline: GPUComputePipeline;
  private params: GPUBuffer;
  readonly histogram: GPUBuffer;
  private readBufs: { buf: GPUBuffer; busy: boolean; preExposure: number }[] = [];
  private ring = 0;
  private bindGroup?: GPUBindGroup;
  private boundView?: GPUTextureView;
  private pendingSlot = -1;

  /** Current adapted EV100 (NaN until initialised). */
  ev = NaN;
  /** Last metered EV100 (scene average, before compensation/clamping). */
  metered = NaN;
  /** Fraction of the histogram between the percentiles (diagnostics). */
  lowPercentile = 0.35;
  highPercentile = 0.92;
  /** Adaptation rates (1/s): brightening (going into shade) is slower than darkening. */
  rateBrighten = 1.3;
  rateDarken = 3.0;
  /** Target pre-exposed luminance for the metered average. */
  key = 0.14;
  /** Snap to the target (used for screenshots / teleports). */
  snapFrames = 0;

  constructor(private device: GPUDevice) {
    this.pipeline = device.createComputePipeline({
      label: 'exposure:meter',
      layout: 'auto',
      compute: { module: shaderModule(device, 'exposure'), entryPoint: 'meter' },
    });
    this.params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const p = new ArrayBuffer(16);
    new Float32Array(p, 0, 2).set([MIN_LOG, 1 / (MAX_LOG - MIN_LOG)]);
    new Uint32Array(p, 8, 2).set([4, 0]);
    device.queue.writeBuffer(this.params, 0, p);
    this.histogram = device.createBuffer({ label: 'exposure:histogram', size: BINS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    for (let i = 0; i < 3; i++) {
      this.readBufs.push({ buf: device.createBuffer({ size: BINS * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }), busy: false, preExposure: 1 });
    }
  }

  /** EV100 to use this frame (adapts toward the last metered target). */
  update(s: ExposureSettings, dt: number): number {
    if (!s.auto) {
      this.ev = s.ev100 - s.compensation;
      return this.ev;
    }
    if (!Number.isFinite(this.ev)) this.ev = s.ev100;
    if (Number.isFinite(this.metered)) {
      const target = Math.min(s.max, Math.max(s.min, this.metered - s.compensation));
      if (this.snapFrames > 0) {
        this.ev = target;
        this.snapFrames--;
      } else {
        const rate = target > this.ev ? this.rateDarken : this.rateBrighten;
        this.ev += (target - this.ev) * (1 - Math.exp(-dt * rate));
      }
    }
    return this.ev;
  }

  /** Records metering of `hdrView` (after the main pass). */
  encode(enc: GPUCommandEncoder, hdrView: GPUTextureView, width: number, height: number, preExposure: number) {
    if (this.boundView !== hdrView) {
      this.boundView = hdrView;
      this.bindGroup = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.params } },
          { binding: 1, resource: hdrView },
          { binding: 2, resource: { buffer: this.histogram } },
        ],
      });
    }
    enc.clearBuffer(this.histogram);
    const pass = enc.beginComputePass({ label: 'exposure:meter' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup!);
    pass.dispatchWorkgroups(Math.ceil(width / 4 / 16), Math.ceil(height / 4 / 16));
    pass.end();
    const slot = this.readBufs[this.ring];
    if (!slot.busy) {
      enc.copyBufferToBuffer(this.histogram, 0, slot.buf, 0, BINS * 4);
      slot.preExposure = preExposure;
      this.pendingSlot = this.ring;
    }
  }

  afterSubmit() {
    if (this.pendingSlot < 0) return;
    const slot = this.readBufs[this.pendingSlot];
    this.pendingSlot = -1;
    this.ring = (this.ring + 1) % this.readBufs.length;
    slot.busy = true;
    slot.buf.mapAsync(GPUMapMode.READ).then(() => {
      const h = new Uint32Array(slot.buf.getMappedRange().slice(0));
      slot.buf.unmap();
      slot.busy = false;
      this.consume(h, slot.preExposure);
    }).catch(() => (slot.busy = false));
  }

  private consume(h: Uint32Array, preExposure: number) {
    let total = 0;
    for (let i = 0; i < BINS; i++) total += h[i];
    if (total === 0) return;
    const lo = total * this.lowPercentile, hi = total * this.highPercentile;
    let acc = 0, sum = 0, wsum = 0;
    for (let i = 0; i < BINS; i++) {
      const c = h[i];
      const a0 = acc, a1 = acc + c;
      acc = a1;
      const w = Math.max(0, Math.min(a1, hi) - Math.max(a0, lo));
      if (w <= 0) continue;
      const log2Pre = MIN_LOG + ((i + 0.5) / (BINS - 1)) * (MAX_LOG - MIN_LOG);
      sum += log2Pre * w;
      wsum += w;
    }
    if (wsum <= 0) return;
    // Scene luminance (nits) of the trimmed average, independent of the exposure used.
    const avgScene = Math.pow(2, sum / wsum) / preExposure;
    // EV100 that maps avgScene to `key` in pre-exposed units: exposure = key / L = 1 / (1.2 * 2^EV).
    this.metered = Math.log2(avgScene / (1.2 * this.key));
  }
}
