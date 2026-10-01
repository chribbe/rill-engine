import { mat4, type Mat4 } from 'wgpu-matrix';
import type { MeshData, PrimitiveData } from '../render/geometry';

/**
 * Minimal glTF 2.0 binary (GLB) loader for static meshes:
 * positions, normals, tangents, TEXCOORD_0 (world-metre UVs), TEXCOORD_1
 * (lightmap UVs), material assignments and node transforms.
 * The node hierarchy is flattened into asset space and primitives sharing a
 * material are merged, so one asset = one draw per material.
 */

interface GltfJson {
  asset: { version: string };
  scene?: number;
  scenes?: { nodes: number[] }[];
  nodes?: GltfNode[];
  meshes?: { name?: string; primitives: GltfPrimitive[] }[];
  accessors: GltfAccessor[];
  bufferViews: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  materials?: { name?: string; extras?: Record<string, unknown> }[];
  extras?: Record<string, unknown>;
}
interface GltfNode {
  name?: string;
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  extras?: Record<string, unknown>;
}
interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
}
interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT4';
}

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 } as const;

export interface GltfAsset {
  mesh: MeshData;
  /** Node-level extras (e.g. authored light markers), in asset space. */
  markers: { name: string; matrix: Mat4; extras: Record<string, unknown> }[];
  extras: Record<string, unknown>;
}

export async function loadGlb(url: string): Promise<GltfAsset> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GLB fetch failed: ${url} (${res.status})`);
  return parseGlb(await res.arrayBuffer(), url);
}

export function parseGlb(buf: ArrayBuffer, name = 'glb'): GltfAsset {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error(`${name}: not a GLB file`);
  let off = 12;
  let json: GltfJson | null = null;
  let bin: ArrayBuffer | null = null;
  while (off < buf.byteLength) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(data));
    else if (type === 0x004e4942) bin = data;
    off += 8 + len;
  }
  if (!json || !bin) throw new Error(`${name}: missing JSON or BIN chunk`);
  const g = json;
  const binBuf = bin;

  const read = (ai: number): Float32Array | Uint32Array => {
    const a = g.accessors[ai];
    const n = COMPONENTS[a.type];
    const bv = g.bufferViews[a.bufferView ?? 0];
    const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const csize = a.componentType === 5126 || a.componentType === 5125 ? 4 : a.componentType === 5123 || a.componentType === 5122 ? 2 : 1;
    const stride = bv.byteStride ?? csize * n;
    const d = new DataView(binBuf);
    const isIndex = a.componentType === 5125 || ((a.componentType === 5123 || a.componentType === 5121) && !a.normalized && n === 1);
    const out = isIndex ? new Uint32Array(a.count * n) : new Float32Array(a.count * n);
    for (let i = 0; i < a.count; i++) {
      for (let c = 0; c < n; c++) {
        const p = base + i * stride + c * csize;
        let v: number;
        switch (a.componentType) {
          case 5126: v = d.getFloat32(p, true); break;
          case 5125: v = d.getUint32(p, true); break;
          case 5123: v = d.getUint16(p, true); if (a.normalized) v /= 65535; break;
          case 5122: v = d.getInt16(p, true); if (a.normalized) v = Math.max(v / 32767, -1); break;
          case 5121: v = d.getUint8(p); if (a.normalized) v /= 255; break;
          case 5120: v = d.getInt8(p); if (a.normalized) v = Math.max(v / 127, -1); break;
          default: throw new Error(`${name}: unsupported componentType ${a.componentType}`);
        }
        out[i * n + c] = v;
      }
    }
    return out;
  };

  const localMatrix = (n: GltfNode): Mat4 => {
    if (n.matrix) return mat4.clone(n.matrix);
    const t = n.translation ?? [0, 0, 0];
    const r = n.rotation ?? [0, 0, 0, 1];
    const s = n.scale ?? [1, 1, 1];
    const m = mat4.fromQuat(r);
    mat4.scale(m, s, m);
    m[12] = t[0]; m[13] = t[1]; m[14] = t[2];
    return m;
  };

  // Gather primitives per material in asset space.
  const groups = new Map<string, { pos: number[]; nrm: number[]; tan: number[]; uv0: number[]; uv1: number[]; col: number[]; idx: number[]; hasTan: boolean; hasUv1: boolean; hasCol: boolean }>();
  const markers: GltfAsset['markers'] = [];
  const visit = (ni: number, parent: Mat4) => {
    const node = g.nodes![ni];
    const world = mat4.multiply(parent, localMatrix(node));
    if (node.extras && Object.keys(node.extras).length > 0) {
      markers.push({ name: node.name ?? `node${ni}`, matrix: world, extras: node.extras });
    }
    if (node.mesh !== undefined) {
      const nm = mat4.transpose(mat4.inverse(world));
      for (const prim of g.meshes![node.mesh].primitives) {
        if (prim.mode !== undefined && prim.mode !== 4) continue;
        const matName = prim.material !== undefined ? g.materials?.[prim.material]?.name ?? `material${prim.material}` : 'default';
        let grp = groups.get(matName);
        if (!grp) {
          grp = { pos: [], nrm: [], tan: [], uv0: [], uv1: [], col: [], idx: [], hasTan: true, hasUv1: true, hasCol: false };
          groups.set(matName, grp);
        }
        const P = read(prim.attributes.POSITION) as Float32Array;
        const N = prim.attributes.NORMAL !== undefined ? (read(prim.attributes.NORMAL) as Float32Array) : null;
        const Tn = prim.attributes.TANGENT !== undefined ? (read(prim.attributes.TANGENT) as Float32Array) : null;
        const U0 = prim.attributes.TEXCOORD_0 !== undefined ? (read(prim.attributes.TEXCOORD_0) as Float32Array) : null;
        const U1 = prim.attributes.TEXCOORD_1 !== undefined ? (read(prim.attributes.TEXCOORD_1) as Float32Array) : null;
        const C0 = prim.attributes.COLOR_0 !== undefined ? read(prim.attributes.COLOR_0) : null;
        const cN = C0 ? COMPONENTS[g.accessors[prim.attributes.COLOR_0].type] : 4;
        if (C0) grp.hasCol = true;
        const vc = P.length / 3;
        const base = grp.pos.length / 3;
        if (!Tn) grp.hasTan = false;
        if (!U1) grp.hasUv1 = false;
        for (let v = 0; v < vc; v++) {
          const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
          grp.pos.push(world[0] * x + world[4] * y + world[8] * z + world[12], world[1] * x + world[5] * y + world[9] * z + world[13], world[2] * x + world[6] * y + world[10] * z + world[14]);
          if (N) {
            const a = N[v * 3], b = N[v * 3 + 1], c = N[v * 3 + 2];
            const nx = nm[0] * a + nm[4] * b + nm[8] * c, ny = nm[1] * a + nm[5] * b + nm[9] * c, nz = nm[2] * a + nm[6] * b + nm[10] * c;
            const l = Math.hypot(nx, ny, nz) || 1;
            grp.nrm.push(nx / l, ny / l, nz / l);
          } else grp.nrm.push(0, 1, 0);
          if (Tn) {
            const a = Tn[v * 4], b = Tn[v * 4 + 1], c = Tn[v * 4 + 2];
            const tx = world[0] * a + world[4] * b + world[8] * c, ty = world[1] * a + world[5] * b + world[9] * c, tz = world[2] * a + world[6] * b + world[10] * c;
            const l = Math.hypot(tx, ty, tz) || 1;
            grp.tan.push(tx / l, ty / l, tz / l, Tn[v * 4 + 3]);
          } else grp.tan.push(1, 0, 0, 1);
          grp.uv0.push(U0 ? U0[v * 2] : 0, U0 ? U0[v * 2 + 1] : 0);
          grp.uv1.push(U1 ? U1[v * 2] : 0, U1 ? U1[v * 2 + 1] : 0);
          if (C0) grp.col.push(C0[v * cN], C0[v * cN + 1], C0[v * cN + 2], cN > 3 ? C0[v * cN + 3] : 1);
          else grp.col.push(0, 1, 0, 1);
        }
        if (prim.indices !== undefined) {
          const I = read(prim.indices);
          for (let i = 0; i < I.length; i++) grp.idx.push(I[i] + base);
        } else {
          for (let i = 0; i < vc; i++) grp.idx.push(base + i);
        }
      }
    }
    for (const c of node.children ?? []) visit(c, world);
  };
  const sceneNodes = g.scenes?.[g.scene ?? 0]?.nodes ?? (g.nodes ?? []).map((_, i) => i);
  for (const ni of sceneNodes) visit(ni, mat4.identity());

  const primitives: PrimitiveData[] = [];
  for (const [material, grp] of groups) {
    primitives.push({
      material,
      positions: new Float32Array(grp.pos),
      normals: new Float32Array(grp.nrm),
      tangents: grp.hasTan ? new Float32Array(grp.tan) : undefined,
      uv0: new Float32Array(grp.uv0),
      uv1: grp.hasUv1 ? new Float32Array(grp.uv1) : undefined,
      colors: grp.hasCol ? new Float32Array(grp.col) : undefined,
      indices: new Uint32Array(grp.idx),
    });
  }
  return { mesh: { name, primitives }, markers, extras: g.extras ?? {} };
}
