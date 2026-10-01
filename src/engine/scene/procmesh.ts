import { mat4, vec3, type Mat4 } from 'wgpu-matrix';
import type { PrimitiveData } from '../render/geometry';

/**
 * Tiny procedural mesh builder (boxes, cylinders) for placeholder props built
 * in code, e.g. the sandbox viewmodel. UV0 is in metres like authored assets.
 */
export class MeshBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private uv: number[] = [];
  private idx: number[] = [];

  private vert(m: Mat4, p: number[], n: number[], u: number, v: number) {
    const wp = vec3.transformMat4(p, m);
    const wn = vec3.normalize(vec3.transformMat4Upper3x3(n, m));
    this.pos.push(wp[0], wp[1], wp[2]);
    this.nrm.push(wn[0], wn[1], wn[2]);
    this.uv.push(u, v);
    return this.pos.length / 3 - 1;
  }

  /** Axis-aligned box of `size` around the origin of `m`. */
  box(m: Mat4, size: [number, number, number]) {
    const h = size.map((s) => s / 2);
    // Each face: normal axis, two tangent axes.
    const faces: [number, number, number][] = [[0, 1, 2], [1, 2, 0], [2, 0, 1]];
    for (const [a, b, c] of faces) {
      for (const sgn of [1, -1]) {
        const base: number[] = [];
        for (const [sb, sc] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          const p = [0, 0, 0], n = [0, 0, 0];
          p[a] = h[a] * sgn; p[b] = h[b] * sb * sgn; p[c] = h[c] * sc;
          n[a] = sgn;
          base.push(this.vert(m, p, n, p[b], p[c]));
        }
        this.idx.push(base[0], base[1], base[2], base[0], base[2], base[3]);
      }
    }
    return this;
  }

  /** Cylinder along the local Z axis, centred on the origin of `m`. */
  cylinder(m: Mat4, radius: number, length: number, segments = 16, caps = true) {
    const ring: number[][] = [];
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const x = Math.cos(a), y = Math.sin(a);
      const u = (i / segments) * Math.PI * 2 * radius;
      ring.push([
        this.vert(m, [x * radius, y * radius, -length / 2], [x, y, 0], u, 0),
        this.vert(m, [x * radius, y * radius, length / 2], [x, y, 0], u, length),
      ]);
    }
    for (let i = 0; i < segments; i++) {
      const [a0, a1] = ring[i], [b0, b1] = ring[i + 1];
      this.idx.push(a0, b0, b1, a0, b1, a1);
    }
    if (caps) {
      for (const s of [-1, 1]) {
        const c = this.vert(m, [0, 0, (s * length) / 2], [0, 0, s], 0, 0);
        const rim: number[] = [];
        for (let i = 0; i <= segments; i++) {
          const a = (i / segments) * Math.PI * 2;
          rim.push(this.vert(m, [Math.cos(a) * radius, Math.sin(a) * radius, (s * length) / 2], [0, 0, s], Math.cos(a) * radius, Math.sin(a) * radius));
        }
        for (let i = 0; i < segments; i++) {
          if (s > 0) this.idx.push(c, rim[i], rim[i + 1]);
          else this.idx.push(c, rim[i + 1], rim[i]);
        }
      }
    }
    return this;
  }

  build(material: string): PrimitiveData {
    return {
      positions: new Float32Array(this.pos),
      normals: new Float32Array(this.nrm),
      uv0: new Float32Array(this.uv),
      indices: new Uint32Array(this.idx),
      material,
    };
  }
}

/** Translation * rotation (XYZ euler, radians) helper for part placement. */
export function place(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): Mat4 {
  const m = mat4.translation([x, y, z]);
  if (rx) mat4.rotateX(m, rx, m);
  if (ry) mat4.rotateY(m, ry, m);
  if (rz) mat4.rotateZ(m, rz, m);
  return m;
}
