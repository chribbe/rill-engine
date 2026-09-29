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
  total = 0;

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
  pass(name: string): GPURenderPassTimestampWrites | undefined {
    if (!this.enabled || this.names.length >= this.maxPasses) return undefined;
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
      for (let i = 0; i < names.length; i++) {
        const ms = Number(t[i * 2 + 1] - t[i * 2]) / 1e6;
        if (ms >= 0 && ms < 1000) {
          const prev = this.results.get(names[i]) ?? ms;
          this.results.set(names[i], prev * 0.9 + ms * 0.1);
          total += ms;
        }
      }
      this.total = this.total * 0.9 + total * 0.1;
      buf.unmap();
      this.busy[slot] = false;
    }).catch(() => { this.busy[slot] = false; });
  }
}
