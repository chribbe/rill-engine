import type { MeshData, PrimitiveData } from '../render/geometry';

/**
 * Built-in meshes addressable as `builtin:<name>` assets. UV0 follows the
 * engine convention: world metres, V pointing down the image (so image-up is
 * world-up on walls). UV1 is a simple non-overlapping chart layout.
 */

interface Builder {
  pos: number[];
  nrm: number[];
  uv0: number[];
  uv1: number[];
  idx: number[];
}

function quad(b: Builder, o: number[], u: number[], v: number[], n: number[], uvScale: [number, number], uvOffset: [number, number], lm: [number, number, number, number]) {
  // Corners: o, o+u, o+u+v, o+v. UV0 in metres along u/v; V is negated (image-down).
  const lu = Math.hypot(u[0], u[1], u[2]);
  const lv = Math.hypot(v[0], v[1], v[2]);
  const base = b.pos.length / 3;
  const corners = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  for (const [a, c] of corners) {
    b.pos.push(o[0] + u[0] * a + v[0] * c, o[1] + u[1] * a + v[1] * c, o[2] + u[2] * a + v[2] * c);
    b.nrm.push(n[0], n[1], n[2]);
    b.uv0.push(uvOffset[0] + a * lu * uvScale[0], -(uvOffset[1] + c * lv * uvScale[1]));
    b.uv1.push(lm[0] + a * lm[2], lm[1] + (1 - c) * lm[3]);
  }
  b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function finish(b: Builder, material: string): PrimitiveData {
  return {
    material,
    positions: new Float32Array(b.pos),
    normals: new Float32Array(b.nrm),
    uv0: new Float32Array(b.uv0),
    uv1: new Float32Array(b.uv1),
    indices: new Uint32Array(b.idx),
  };
}

const newB = (): Builder => ({ pos: [], nrm: [], uv0: [], uv1: [], idx: [] });

/** Axis-aligned box centred on x/z with its base at y=0. */
export function boxMesh(sx: number, sy: number, sz: number, material = 'default'): MeshData {
  const b = newB();
  const hx = sx / 2, hz = sz / 2;
  // 6 faces, lightmap charts in a 3x2 grid.
  const g = (i: number): [number, number, number, number] => [(i % 3) / 3 + 0.01, Math.floor(i / 3) / 2 + 0.01, 1 / 3 - 0.02, 1 / 2 - 0.02];
  quad(b, [-hx, 0, hz], [sx, 0, 0], [0, sy, 0], [0, 0, 1], [1, 1], [-hx, 0], g(0)); // +Z
  quad(b, [hx, 0, -hz], [-sx, 0, 0], [0, sy, 0], [0, 0, -1], [1, 1], [-hx, 0], g(1)); // -Z
  quad(b, [hx, 0, hz], [0, 0, -sz], [0, sy, 0], [1, 0, 0], [1, 1], [-hz, 0], g(2)); // +X
  quad(b, [-hx, 0, -hz], [0, 0, sz], [0, sy, 0], [-1, 0, 0], [1, 1], [-hz, 0], g(3)); // -X
  quad(b, [-hx, sy, hz], [sx, 0, 0], [0, 0, -sz], [0, 1, 0], [1, 1], [-hx, -hz], g(4)); // top
  quad(b, [-hx, 0, -hz], [sx, 0, 0], [0, 0, sz], [0, -1, 0], [1, 1], [-hx, -hz], g(5)); // bottom
  return { name: `box ${sx}x${sy}x${sz}`, primitives: [finish(b, material)] };
}

/** Ground plane on XZ, centred, with UVs in world metres. */
export function planeMesh(sx: number, sz: number, material = 'default', segments = 1): MeshData {
  const b = newB();
  const n = segments;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x0 = -sx / 2 + (sx * i) / n;
      const z0 = sz / 2 - (sz * j) / n;
      quad(b, [x0, 0, z0], [sx / n, 0, 0], [0, 0, -sz / n], [0, 1, 0], [1, 1], [x0, -z0], [i / n, j / n, 1 / n, 1 / n]);
    }
  }
  return { name: `plane ${sx}x${sz}`, primitives: [finish(b, material)] };
}

/** UV sphere (for material test spheres). UV0 = metres along the surface. */
export function sphereMesh(radius: number, material = 'default', seg = 48, rings = 32): MeshData {
  const b = newB();
  for (let r = 0; r <= rings; r++) {
    const v = r / rings;
    const th = v * Math.PI;
    for (let s = 0; s <= seg; s++) {
      const u = s / seg;
      const ph = u * Math.PI * 2;
      const x = Math.sin(th) * Math.cos(ph), y = Math.cos(th), z = Math.sin(th) * Math.sin(ph);
      b.pos.push(x * radius, y * radius + radius, z * radius);
      b.nrm.push(x, y, z);
      b.uv0.push(u * Math.PI * 2 * radius, v * Math.PI * radius);
      b.uv1.push(u, v);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < seg; s++) {
      const a = r * (seg + 1) + s, c = a + seg + 1;
      b.idx.push(a, a + 1, c, a + 1, c + 1, c);
    }
  }
  return { name: `sphere ${radius}`, primitives: [finish(b, material)] };
}

/** Vertical cylinder (poles, trunks) with its base at y=0. */
export function cylinderMesh(radius: number, height: number, material = 'default', seg = 16): MeshData {
  const b = newB();
  const circ = Math.PI * 2 * radius;
  for (let j = 0; j <= 1; j++) {
    for (let s = 0; s <= seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      const x = Math.cos(a), z = -Math.sin(a);
      b.pos.push(x * radius, j * height, z * radius);
      b.nrm.push(x, 0, z);
      b.uv0.push((s / seg) * circ, -j * height);
      b.uv1.push(s / seg, 1 - j);
    }
  }
  for (let s = 0; s < seg; s++) {
    const a = s, c = s + seg + 1;
    b.idx.push(a, a + 1, c + 1, a, c + 1, c);
  }
  return { name: `cylinder ${radius}x${height}`, primitives: [finish(b, material)] };
}

/** Parses `builtin:box?x=2&y=3&z=1&material=concrete` style asset references. */
export function builtinMesh(ref: string): MeshData {
  const [name, query] = ref.replace(/^builtin:/, '').split('?');
  const p = new URLSearchParams(query ?? '');
  const num = (k: string, d: number) => (p.has(k) ? parseFloat(p.get(k)!) : d);
  const mat = p.get('material') ?? 'default';
  switch (name) {
    case 'box': return boxMesh(num('x', 1), num('y', 1), num('z', 1), mat);
    case 'plane': return planeMesh(num('x', 10), num('z', 10), mat, num('seg', 1));
    case 'sphere': return sphereMesh(num('r', 0.5), mat);
    case 'cylinder': return cylinderMesh(num('r', 0.1), num('h', 1), mat);
    default: throw new Error(`Unknown builtin mesh: ${ref}`);
  }
}
