/**
 * GPU instance table. Every drawable instance (static object, prop, tree) has a
 * slot holding its transform and static-lighting binding. Draws never bind
 * per-object data: the vertex shader indexes this table through the per-frame
 * visible list.
 */
export const INSTANCE_FLOATS = 24; // mat4 + lmST + info(u32 x4)
const INSTANCE_BYTES = INSTANCE_FLOATS * 4;

export class InstanceStore {
  buffer: GPUBuffer;
  private cpu: Float32Array<ArrayBuffer>;
  private u32: Uint32Array<ArrayBuffer>;
  capacity: number;
  count = 0;
  private dirtyMin = Infinity;
  private dirtyMax = -1;
  /** Bumped when the GPU buffer is reallocated (bind groups must be rebuilt). */
  generation = 0;

  constructor(private device: GPUDevice, initial = 4096) {
    this.capacity = initial;
    this.cpu = new Float32Array(initial * INSTANCE_FLOATS);
    this.u32 = new Uint32Array(this.cpu.buffer);
    this.buffer = this.createBuffer(initial);
  }

  private createBuffer(n: number) {
    return this.device.createBuffer({ label: 'instances', size: n * INSTANCE_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }

  private freeSlots: number[] = [];

  /** A slot for one instance; reuses slots released by `free` (editor deletes). */
  alloc(): number {
    const f = this.freeSlots.pop();
    if (f !== undefined) return f;
    return this.allocNew();
  }

  /** `n` consecutive new slots (never recycled ones): returns the first. */
  allocContiguous(n: number): number {
    const first = this.allocNew();
    for (let i = 1; i < n; i++) this.allocNew();
    return first;
  }

  /** Releases a slot. The caller must have stopped drawing it; its record is zeroed. */
  free(slot: number) {
    const o = slot * INSTANCE_FLOATS;
    this.cpu.fill(0, o, o + INSTANCE_FLOATS);
    this.dirtyMin = Math.min(this.dirtyMin, slot);
    this.dirtyMax = Math.max(this.dirtyMax, slot);
    this.freeSlots.push(slot);
  }

  private allocNew(): number {
    if (this.count >= this.capacity) {
      const cap = this.capacity * 2;
      const cpu = new Float32Array(cap * INSTANCE_FLOATS);
      cpu.set(this.cpu);
      this.cpu = cpu;
      this.u32 = new Uint32Array(cpu.buffer);
      this.buffer.destroy();
      this.buffer = this.createBuffer(cap);
      this.capacity = cap;
      this.generation++;
      this.dirtyMin = 0;
      this.dirtyMax = this.count - 1;
    }
    return this.count++;
  }

  set(slot: number, model: ArrayLike<number>, lmST: ArrayLike<number> | null, lmLayer: number, flags: number, seed: number, idHash: number) {
    const o = slot * INSTANCE_FLOATS;
    this.cpu.set(model as Float32Array, o);
    if (lmST) this.cpu.set(lmST as Float32Array, o + 16);
    else this.cpu.set([1, 1, 0, 0], o + 16);
    this.u32[o + 20] = lmLayer >= 0 ? lmLayer + 1 : 0;
    this.u32[o + 21] = flags >>> 0;
    this.u32[o + 22] = seed >>> 0;
    this.u32[o + 23] = idHash >>> 0;
    this.dirtyMin = Math.min(this.dirtyMin, slot);
    this.dirtyMax = Math.max(this.dirtyMax, slot);
  }

  /** Moves an instance (animated props); the rest of its record is kept. */
  setModel(slot: number, model: ArrayLike<number>) {
    this.cpu.set(model as Float32Array, slot * INSTANCE_FLOATS);
    this.dirtyMin = Math.min(this.dirtyMin, slot);
    this.dirtyMax = Math.max(this.dirtyMax, slot);
  }

  /** Behaviour flags (low 8 bits: no-decals, wind...); the reflection probe bits are kept. */
  setFlags(slot: number, flags: number) {
    const o = slot * INSTANCE_FLOATS;
    this.u32[o + 21] = ((this.u32[o + 21] & 0xffffff00) | (flags & 0xff)) >>> 0;
    this.dirtyMin = Math.min(this.dirtyMin, slot);
    this.dirtyMax = Math.max(this.dirtyMax, slot);
  }

  /** Per-object reflection probes: up to three probe indices packed in flag bits 8..31 (index + 1, 0 = none). */
  setProbes(slot: number, packed: number) {
    const o = slot * INSTANCE_FLOATS;
    this.u32[o + 21] = ((this.u32[o + 21] & 0xff) | (packed & 0xffffff00)) >>> 0;
    this.dirtyMin = Math.min(this.dirtyMin, slot);
    this.dirtyMax = Math.max(this.dirtyMax, slot);
  }

  model(slot: number): Float32Array {
    return this.cpu.subarray(slot * INSTANCE_FLOATS, slot * INSTANCE_FLOATS + 16);
  }

  setLightmap(slot: number, lmST: ArrayLike<number>, layer: number) {
    const o = slot * INSTANCE_FLOATS;
    this.cpu.set(lmST as Float32Array, o + 16);
    this.u32[o + 20] = layer >= 0 ? layer + 1 : 0;
    this.dirtyMin = Math.min(this.dirtyMin, slot);
    this.dirtyMax = Math.max(this.dirtyMax, slot);
  }

  upload() {
    if (this.dirtyMax < this.dirtyMin) return;
    const a = this.dirtyMin * INSTANCE_FLOATS;
    const b = (this.dirtyMax + 1) * INSTANCE_FLOATS;
    this.device.queue.writeBuffer(this.buffer, a * 4, this.cpu, a, b - a);
    this.dirtyMin = Infinity;
    this.dirtyMax = -1;
  }
}
