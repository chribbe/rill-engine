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

  alloc(): number {
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
