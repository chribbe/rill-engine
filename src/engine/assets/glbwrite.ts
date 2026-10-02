import type { MeshData } from '../render/geometry';

/**
 * Minimal GLB writer for generated static geometry (splines): one mesh, one
 * primitive per material (named, so the bake maps them to its materials),
 * POSITION / NORMAL / TEXCOORD_0 / TEXCOORD_1, uint32 indices. Coordinates are
 * engine space (Y up), as the glTF convention expects.
 */
export function writeGlb(mesh: MeshData): ArrayBuffer {
  const views: { offset: number; length: number; target?: number }[] = [];
  const accessors: Record<string, unknown>[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const push = (data: ArrayBufferView, target: number) => {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const pad = (4 - (bytes.length % 4)) % 4;
    chunks.push(bytes, new Uint8Array(pad));
    views.push({ offset, length: bytes.length, target });
    offset += bytes.length + pad;
    return views.length - 1;
  };
  const accessor = (data: Float32Array | Uint32Array, type: 'VEC2' | 'VEC3' | 'SCALAR', target: number, bounds = false) => {
    const view = push(data, target);
    const comps = type === 'VEC3' ? 3 : type === 'VEC2' ? 2 : 1;
    const acc: Record<string, unknown> = { bufferView: view, componentType: data instanceof Float32Array ? 5126 : 5125, count: data.length / comps, type };
    if (bounds) {
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < data.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], data[i + k]); max[k] = Math.max(max[k], data[i + k]); }
      acc.min = min;
      acc.max = max;
    }
    accessors.push(acc);
    return accessors.length - 1;
  };
  const materials: { name: string }[] = [];
  const primitives = mesh.primitives.map((p) => {
    const attributes: Record<string, number> = {
      POSITION: accessor(p.positions, 'VEC3', 34962, true),
      NORMAL: accessor(p.normals, 'VEC3', 34962),
    };
    if (p.uv0) attributes.TEXCOORD_0 = accessor(p.uv0, 'VEC2', 34962);
    if (p.uv1) attributes.TEXCOORD_1 = accessor(p.uv1, 'VEC2', 34962);
    materials.push({ name: p.material });
    return { attributes, indices: accessor(p.indices, 'SCALAR', 34963), material: materials.length - 1 };
  });
  const json = {
    asset: { version: '2.0', generator: 'rill glbwrite' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: mesh.name, mesh: 0 }],
    meshes: [{ name: mesh.name, primitives }],
    materials,
    accessors,
    bufferViews: views.map((v) => ({ buffer: 0, byteOffset: v.offset, byteLength: v.length, target: v.target })),
    buffers: [{ byteLength: offset }],
  };
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jpad = (4 - (jsonBytes.length % 4)) % 4;
  if (jpad) {
    const j = new Uint8Array(jsonBytes.length + jpad);
    j.set(jsonBytes);
    j.fill(0x20, jsonBytes.length);
    jsonBytes = j;
  }
  const total = 12 + 8 + jsonBytes.length + 8 + offset;
  const out = new ArrayBuffer(total);
  const dv = new DataView(out);
  const u8 = new Uint8Array(out);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  u8.set(jsonBytes, 20);
  let o = 20 + jsonBytes.length;
  dv.setUint32(o, offset, true);
  dv.setUint32(o + 4, 0x004e4942, true);
  o += 8;
  for (const c of chunks) { u8.set(c, o); o += c.length; }
  return out;
}
