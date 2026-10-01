/**
 * GPU pass timing via timestamp queries (when the adapter supports them).
 * Uses a small ring of readback buffers so we never stall on mapAsync.
 */
export class GpuTimer {
  readonly enabled: boolean;
  private querySet?: GPUQuerySet;
  private resolveBuf?: GPUBuffer;
  private readBufs: GPUBuffer[] = [];
  private busy: boolean[] = [];
  private names: string[] = [];
  private ring = 0;
  readonly maxPasses = 8;
  /** Smoothed milliseconds per pass name. */
  readonly results = new Map<string, number>();
  /** Sum of pass durations (passes may overlap on tile-based GPUs). */
  total = 0;
  /** First pass begin -> last pass end: the frame's GPU span, robust to overlap. */
  span = 0;
  private samples = 0;

  /** Forget smoothed history (benchmarks between views). */
  reset() {
    this.results.clear();
    this.total = 0;
    this.span = 0;
    this.samples = 0;
  }

  constructor(device: GPUDevice, enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) return;
    this.querySet = device.createQuerySet({ type: 'timestamp', count: this.maxPasses * 2 });
    this.resolveBuf = device.createBuffer({ size: this.maxPasses * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    for (let i = 0; i < 3; i++) {
      this.readBufs.push(device.createBuffer({ size: this.maxPasses * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }));
      this.busy.push(false);
    }
  }

  beginFrame() {
    this.names = [];
  }

  /** Returns timestampWrites for a pass descriptor (or undefined when disabled/full). */
  /** Timestamp writes can perturb tile-based GPUs; allow turning them off at runtime. */
  paused = false;

  pass(name: string): GPURenderPassTimestampWrites | undefined {
    if (!this.enabled || this.paused || this.names.length >= this.maxPasses) return undefined;
    const i = this.names.length;
    this.names.push(name);
    return { querySet: this.querySet!, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 };
  }

  endFrame(enc: GPUCommandEncoder) {
    if (!this.enabled || this.names.length === 0) return;
    const slot = this.ring;
    if (this.busy[slot]) return; // skip this frame's readback
    const n = this.names.length;
    enc.resolveQuerySet(this.querySet!, 0, n * 2, this.resolveBuf!, 0);
    enc.copyBufferToBuffer(this.resolveBuf!, 0, this.readBufs[slot], 0, n * 16);
    this.pendingSlot = slot;
    this.pendingNames = this.names.slice();
  }

  private pendingSlot = -1;
  private pendingNames: string[] = [];

  /** Call after queue.submit. */
  afterSubmit() {
    if (this.pendingSlot < 0) return;
    const slot = this.pendingSlot;
    const names = this.pendingNames;
    this.pendingSlot = -1;
    this.busy[slot] = true;
    this.ring = (this.ring + 1) % this.readBufs.length;
    const buf = this.readBufs[slot];
    buf.mapAsync(GPUMapMode.READ).then(() => {
      const t = new BigInt64Array(buf.getMappedRange());
      let total = 0;
      let t0 = t[0], t1 = t[1];
      // Converges quickly after reset(), then smooths.
      const a = Math.max(0.1, 1 / (this.samples + 1));
      for (let i = 0; i < names.length; i++) {
        const ms = Number(t[i * 2 + 1] - t[i * 2]) / 1e6;
        if (ms >= 0 && ms < 1000) {
          const prev = this.results.get(names[i]) ?? ms;
          this.results.set(names[i], prev * (1 - a) + ms * a);
          total += ms;
          if (t[i * 2] < t0) t0 = t[i * 2];
          if (t[i * 2 + 1] > t1) t1 = t[i * 2 + 1];
        }
      }
      const span = Number(t1 - t0) / 1e6;
      this.total = this.total * (1 - a) + total * a;
      if (span >= 0 && span < 1000) this.span = this.span * (1 - a) + span * a;
      this.samples++;
      buf.unmap();
      this.busy[slot] = false;
    }).catch(() => { this.busy[slot] = false; });
  }
}
