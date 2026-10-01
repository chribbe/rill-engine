/**
 * Geometry storage. All meshes live in a few large GPU buffers ("arena") and are
 * addressed by (baseVertex, firstIndex, indexCount). This keeps buffer binding
 * constant across draws and maps directly onto indirect / multi-draw later.
 *
 * Vertex streams:
 *   0: position   float32x3                      (12 B) - also used alone by depth/shadow passes
 *   1: attributes normal snorm16x4 | tangent snorm16x4 | uv0 float32x2 | uv1 unorm16x2 | colour unorm8x4 (32 B)
 *      colour.r = material blend weight (layer B), g/b/a reserved for future layers / masks
 * UV0 is in world metres by convention (materials declare their physical size).
 * UV1 is the lightmap chart layout in [0,1] (scaled/offset per instance into an atlas).
 */

export const POS_STRIDE = 12;
export const ATTR_STRIDE = 32;

export const VERTEX_LAYOUT_FULL: GPUVertexBufferLayout[] = [
  { arrayStride: POS_STRIDE, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
  {
    arrayStride: ATTR_STRIDE,
    attributes: [
      { shaderLocation: 1, offset: 0, format: 'snorm16x4' },
      { shaderLocation: 2, offset: 8, format: 'snorm16x4' },
      { shaderLocation: 3, offset: 16, format: 'float32x2' },
      { shaderLocation: 4, offset: 24, format: 'unorm16x2' },
      { shaderLocation: 5, offset: 28, format: 'unorm8x4' },
    ],
  },
];

export const VERTEX_LAYOUT_POS: GPUVertexBufferLayout[] = [
  { arrayStride: POS_STRIDE, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
];

export const VERTEX_LAYOUT_POS_UV: GPUVertexBufferLayout[] = [
  { arrayStride: POS_STRIDE, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
  { arrayStride: ATTR_STRIDE, attributes: [{ shaderLocation: 3, offset: 16, format: 'float32x2' }] },
];

export interface PrimitiveData {
  positions: Float32Array;
  normals: Float32Array;
  tangents?: Float32Array;
  uv0?: Float32Array;
  uv1?: Float32Array;
  /** Per-vertex RGBA in 0..1 (r = blend weight). */
  colors?: Float32Array;
  indices: Uint32Array;
  /** Material slot name (glTF material name); resolved through the material library. */
  material: string;
}

export interface MeshData {
  name: string;
  primitives: PrimitiveData[];
}

export interface Aabb {
  min: [number, number, number];
  max: [number, number, number];
}

export interface GpuPrimitive {
  id: number;
  baseVertex: number;
  firstIndex: number;
  indexCount: number;
  vertexCount: number;
  material: string;
  aabb: Aabb;
  /** CPU copies kept for collision, picking, clutter scattering and on-demand wireframe generation. */
  positions: Float32Array;
  indices: Uint32Array;
  normals?: Float32Array;
  colors?: Float32Array;
  uv1?: Float32Array;
  wireFirst: number;
  wireCount: number;
}

export interface GpuMesh {
  name: string;
  primitives: GpuPrimitive[];
  aabb: Aabb;
  triangles: number;
  hasUv1: boolean;
}

class GrowBuffer {
  buffer: GPUBuffer;
  used = 0;
  constructor(private device: GPUDevice, private label: string, private usage: number, public capacity: number) {
    this.buffer = device.createBuffer({ label, size: capacity, usage: usage | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  }
  /** Reserves bytes, growing (with a GPU copy) if needed. Returns the byte offset. */
  alloc(bytes: number): number {
    if (this.used + bytes > this.capacity) {
      let cap = this.capacity;
      while (this.used + bytes > cap) cap *= 2;
      const nb = this.device.createBuffer({ label: this.label, size: cap, usage: this.usage | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
      const enc = this.device.createCommandEncoder();
      enc.copyBufferToBuffer(this.buffer, 0, nb, 0, this.used);
      this.device.queue.submit([enc.finish()]);
      this.buffer.destroy();
      this.buffer = nb;
      this.capacity = cap;
      this.onGrow?.();
    }
    const off = this.used;
    this.used += bytes;
    return off;
  }
  onGrow?: () => void;
}

export class GeometryArena {
  readonly pos: GrowBuffer;
  readonly attr: GrowBuffer;
  readonly index: GrowBuffer;
  readonly wire: GrowBuffer;
  private nextId = 0;
  readonly primitives: GpuPrimitive[] = [];
  vertexCount = 0;

  constructor(private device: GPUDevice) {
    const V = 1 << 20;
    this.pos = new GrowBuffer(device, 'arena:pos', GPUBufferUsage.VERTEX, V * POS_STRIDE);
    this.attr = new GrowBuffer(device, 'arena:attr', GPUBufferUsage.VERTEX, V * ATTR_STRIDE);
    this.index = new GrowBuffer(device, 'arena:index', GPUBufferUsage.INDEX, V * 3 * 4);
    this.wire = new GrowBuffer(device, 'arena:wire', GPUBufferUsage.INDEX, 1 << 20);
  }

  get bytes() {
    return this.pos.used + this.attr.used + this.index.used + this.wire.used;
  }

  upload(mesh: MeshData): GpuMesh {
    const prims: GpuPrimitive[] = [];
    let tris = 0;
    const aabb: Aabb = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    let hasUv1 = true;
    for (const p of mesh.primitives) {
      const vc = p.positions.length / 3;
      if (!p.uv1) hasUv1 = false;
      const tangents = p.tangents ?? computeTangents(p.positions, p.normals, p.uv0, p.indices);
      const attr = new ArrayBuffer(vc * ATTR_STRIDE);
      const i16 = new Int16Array(attr);
      const u16 = new Uint16Array(attr);
      const f32 = new Float32Array(attr);
      const u8 = new Uint8Array(attr);
      for (let v = 0; v < vc; v++) {
        const o16 = v * 16;
        i16[o16 + 0] = snorm16(p.normals[v * 3]);
        i16[o16 + 1] = snorm16(p.normals[v * 3 + 1]);
        i16[o16 + 2] = snorm16(p.normals[v * 3 + 2]);
        i16[o16 + 3] = 0;
        i16[o16 + 4] = snorm16(tangents[v * 4]);
        i16[o16 + 5] = snorm16(tangents[v * 4 + 1]);
        i16[o16 + 6] = snorm16(tangents[v * 4 + 2]);
        i16[o16 + 7] = tangents[v * 4 + 3] < 0 ? -32767 : 32767;
        const o32 = v * 8;
        f32[o32 + 4] = p.uv0 ? p.uv0[v * 2] : 0;
        f32[o32 + 5] = p.uv0 ? p.uv0[v * 2 + 1] : 0;
        u16[o16 + 12] = p.uv1 ? unorm16(p.uv1[v * 2]) : 0;
        u16[o16 + 13] = p.uv1 ? unorm16(p.uv1[v * 2 + 1]) : 0;
        // Vertex colour: R = blend-layer weight, G = baked vertex AO, A = spare.
        // Meshes without COLOR_0 get (0, 1, 0, 1): layer A, unoccluded.
        const o8 = v * 32 + 28;
        if (p.colors) {
          for (let c = 0; c < 4; c++) u8[o8 + c] = Math.max(0, Math.min(255, Math.round(p.colors[v * 4 + c] * 255)));
        } else {
          u8[o8] = 0; u8[o8 + 1] = 255; u8[o8 + 2] = 0; u8[o8 + 3] = 255;
        }
      }
      const posOff = this.pos.alloc(vc * POS_STRIDE);
      const attrOff = this.attr.alloc(vc * ATTR_STRIDE);
      const idxOff = this.index.alloc(p.indices.byteLength);
      this.device.queue.writeBuffer(this.pos.buffer, posOff, p.positions as Float32Array<ArrayBuffer>);
      this.device.queue.writeBuffer(this.attr.buffer, attrOff, attr);
      this.device.queue.writeBuffer(this.index.buffer, idxOff, p.indices as Uint32Array<ArrayBuffer>);
      const pa = boundsOf(p.positions);
      for (let k = 0; k < 3; k++) {
        aabb.min[k] = Math.min(aabb.min[k], pa.min[k]);
        aabb.max[k] = Math.max(aabb.max[k], pa.max[k]);
      }
      const prim: GpuPrimitive = {
        id: this.nextId++,
        baseVertex: posOff / POS_STRIDE,
        firstIndex: idxOff / 4,
        indexCount: p.indices.length,
        vertexCount: vc,
        material: p.material,
        aabb: pa,
        positions: p.positions,
        indices: p.indices,
        normals: p.normals,
        colors: p.colors,
        uv1: p.uv1,
        wireFirst: 0,
        wireCount: 0,
      };
      this.vertexCount += vc;
      tris += p.indices.length / 3;
      prims.push(prim);
      this.primitives.push(prim);
    }
    return { name: mesh.name, primitives: prims, aabb, triangles: tris, hasUv1 };
  }

  /** Builds a unique-edge line list for a primitive (lazily, for the wireframe view). */
  ensureWire(p: GpuPrimitive) {
    if (p.wireCount > 0) return;
    const seen = new Set<number>();
    const out: number[] = [];
    const idx = p.indices;
    const n = p.vertexCount;
    for (let t = 0; t < idx.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = idx[t + e];
        const b = idx[t + ((e + 1) % 3)];
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const key = lo * n + hi;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(lo, hi);
      }
    }
    const arr = new Uint32Array(out);
    const off = this.wire.alloc(arr.byteLength);
    this.device.queue.writeBuffer(this.wire.buffer, off, arr);
    p.wireFirst = off / 4;
    p.wireCount = arr.length;
  }
}

function snorm16(v: number) {
  return Math.max(-32767, Math.min(32767, Math.round(v * 32767)));
}
function unorm16(v: number) {
  return Math.max(0, Math.min(65535, Math.round(v * 65535)));
}

export function boundsOf(pos: Float32Array): Aabb {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = pos[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

/**
 * Per-vertex tangents from UV0 (accumulated triangle tangents, Gram-Schmidt).
 * Handedness follows the glTF convention: bitangent = cross(N, T) * w points
 * toward decreasing V (image "up" in OpenGL-style normal maps).
 */
export function computeTangents(pos: Float32Array, nrm: Float32Array, uv: Float32Array | undefined, idx: Uint32Array): Float32Array {
  const vc = pos.length / 3;
  const out = new Float32Array(vc * 4);
  if (!uv) {
    for (let v = 0; v < vc; v++) {
      const nx = nrm[v * 3], ny = nrm[v * 3 + 1], nz = nrm[v * 3 + 2];
      // Any perpendicular vector: cross(up, n), or +X for near-vertical normals.
      let tx = nz, ty = 0, tz = -nx;
      if (Math.abs(ny) > 0.99) { tx = 1; ty = 0; tz = 0; }
      const l = Math.hypot(tx, ty, tz) || 1;
      out.set([tx / l, ty / l, tz / l, 1], v * 4);
    }
    return out;
  }
  const tan = new Float64Array(vc * 3);
  const bit = new Float64Array(vc * 3);
  for (let t = 0; t < idx.length; t += 3) {
    const i0 = idx[t], i1 = idx[t + 1], i2 = idx[t + 2];
    const x1 = pos[i1 * 3] - pos[i0 * 3], y1 = pos[i1 * 3 + 1] - pos[i0 * 3 + 1], z1 = pos[i1 * 3 + 2] - pos[i0 * 3 + 2];
    const x2 = pos[i2 * 3] - pos[i0 * 3], y2 = pos[i2 * 3 + 1] - pos[i0 * 3 + 1], z2 = pos[i2 * 3 + 2] - pos[i0 * 3 + 2];
    const s1 = uv[i1 * 2] - uv[i0 * 2], t1 = uv[i1 * 2 + 1] - uv[i0 * 2 + 1];
    const s2 = uv[i2 * 2] - uv[i0 * 2], t2 = uv[i2 * 2 + 1] - uv[i0 * 2 + 1];
    const d = s1 * t2 - s2 * t1;
    if (Math.abs(d) < 1e-12) continue;
    const r = 1 / d;
    const sx = (t2 * x1 - t1 * x2) * r, sy = (t2 * y1 - t1 * y2) * r, sz = (t2 * z1 - t1 * z2) * r;
    const bx = (s1 * x2 - s2 * x1) * r, by = (s1 * y2 - s2 * y1) * r, bz = (s1 * z2 - s2 * z1) * r;
    for (const i of [i0, i1, i2]) {
      tan[i * 3] += sx; tan[i * 3 + 1] += sy; tan[i * 3 + 2] += sz;
      bit[i * 3] += bx; bit[i * 3 + 1] += by; bit[i * 3 + 2] += bz;
    }
  }
  for (let v = 0; v < vc; v++) {
    const nx = nrm[v * 3], ny = nrm[v * 3 + 1], nz = nrm[v * 3 + 2];
    let tx = tan[v * 3], ty = tan[v * 3 + 1], tz = tan[v * 3 + 2];
    const dn = nx * tx + ny * ty + nz * tz;
    tx -= nx * dn; ty -= ny * dn; tz -= nz * dn;
    let l = Math.hypot(tx, ty, tz);
    if (l < 1e-8) {
      tx = -nz; ty = 0; tz = nx;
      l = Math.hypot(tx, ty, tz);
      if (l < 1e-8) { tx = 1; ty = 0; tz = 0; l = 1; }
    }
    tx /= l; ty /= l; tz /= l;
    // dP/dv in glTF UV space points "down" the image; OpenGL normal maps want
    // +Y = up, so the bitangent is -dP/dv.
    const cx = ny * tz - nz * ty, cy = nz * tx - nx * tz, cz = nx * ty - ny * tx;
    const w = cx * -bit[v * 3] + cy * -bit[v * 3 + 1] + cz * -bit[v * 3 + 2] < 0 ? -1 : 1;
    out[v * 4] = tx; out[v * 4 + 1] = ty; out[v * 4 + 2] = tz; out[v * 4 + 3] = w;
  }
  return out;
}
