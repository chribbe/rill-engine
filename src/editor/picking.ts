import { mat4, vec3 } from 'wgpu-matrix';
import { isSpatial, type Entity } from '../engine/scene/mapformat';
import { transformMatrix } from '../engine/scene/world';
import type { Camera } from '../engine/scene/camera';
import type { Editor } from './editor';
import type { V3 } from './xform';

/**
 * CPU ray picking against what the viewport shows: mesh triangles (LOD0, in
 * each entity's local space) and helper shapes for entities without geometry
 * (lights, markers, probes: screen-sized spheres; decals and signs: boxes).
 */

export interface PickHit {
  id: string;
  t: number;
  point: V3;
  /** World normal of the hit triangle (meshes) or facing the ray (helpers). */
  normal: V3;
  /** Material slot (asset material name) of the hit primitive. */
  slot?: string;
}

export interface Ray { o: V3; d: V3 }

/** Ray through a viewport point (CSS pixels relative to the viewport, size in CSS pixels). */
export function viewRay(camera: Camera, x: number, y: number, w: number, h: number): Ray {
  const nx = (x / w) * 2 - 1, ny = 1 - (y / h) * 2;
  // Reverse-Z: z = 1 is the near plane.
  const a = vec3.transformMat4([nx, ny, 1], camera.invViewProj);
  const b = vec3.transformMat4([nx, ny, 0.5], camera.invViewProj);
  const d = vec3.normalize(vec3.sub(b, a));
  return { o: [camera.position[0], camera.position[1], camera.position[2]], d: [d[0], d[1], d[2]] };
}

function rayAabb(o: ArrayLike<number>, d: ArrayLike<number>, min: ArrayLike<number>, max: ArrayLike<number>, maxT: number): number {
  let t0 = 0, t1 = maxT;
  for (let k = 0; k < 3; k++) {
    const inv = 1 / d[k];
    let a = (min[k] - o[k]) * inv, b = (max[k] - o[k]) * inv;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return -1;
  }
  return t0;
}

/** Ray vs unit box [-0.5, 0.5]^3 in local space; t in the ray's parameter. */
function rayUnitBox(o: ArrayLike<number>, d: ArrayLike<number>) {
  return rayAabb(o, d, [-0.5, -0.5, -0.5], [0.5, 0.5, 0.5], 1e9);
}

export class Picker {
  constructor(private editor: Editor) {}

  /** Nearest pickable hit along the ray (honours the editor's pick filter and locks). */
  pick(ray: Ray, opts: { meshesOnly?: boolean; ignore?: Set<string>; includeLocked?: boolean } = {}): PickHit | null {
    const ed = this.editor;
    const scene = ed.scene;
    let best: PickHit | null = null;
    const ok = (id: string) => !opts.ignore?.has(id) && scene.effectiveVisible(id) && (opts.includeLocked || !scene.effectiveLocked(id));
    // Meshes.
    if (ed.pick.meshes || opts.meshesOnly) {
      for (const [id, rt] of ed.rt.world.objects) {
        const e = rt.doc;
        if ((e.type !== 'mesh' && e.type !== 'instances') || !ok(id)) continue;
        for (const r of rt.renderables) {
          const tb = rayAabb(ray.o, ray.d, r.worldMin, r.worldMax, best ? best.t : 1e9);
          if (tb < 0) continue;
          const model = e.type === 'mesh' ? transformMatrix(e.transform) : ed.rt.renderer.instances.model(r.slot);
          const hit = this.meshHit(ray, model, r.mesh.primitives, best ? best.t : 1e9);
          if (hit) best = { id, t: hit.t, point: hit.point, normal: hit.normal, slot: r.mesh.primitives[hit.prim].material };
        }
      }
    }
    if (opts.meshesOnly) return best;
    // Helpers.
    for (const e of scene.entities) {
      if (!isSpatial(e) || !ok(e.id) || !this.helperPickable(e)) continue;
      const t = this.helperHit(ray, e);
      if (t >= 0 && (!best || t < best.t - 0.05)) {
        const p: V3 = [ray.o[0] + ray.d[0] * t, ray.o[1] + ray.d[1] * t, ray.o[2] + ray.d[2] * t];
        best = { id: e.id, t, point: p, normal: [-ray.d[0], -ray.d[1], -ray.d[2]] };
      }
    }
    return best;
  }

  private helperPickable(e: Entity) {
    const P = this.editor.pick;
    switch (e.type) {
      case 'light': return P.lights;
      case 'marker': return P.markers;
      case 'decal': return P.decals;
      case 'sign': return P.signs;
      case 'reflectionProbe': case 'probeVolume': return P.probes;
      default: return false;
    }
  }

  private helperHit(ray: Ray, e: Exclude<Entity, { type: 'group' }>): number {
    const p = e.transform.position;
    if (e.type === 'decal' || e.type === 'sign') {
      const size: V3 = e.type === 'decal' ? e.decal.size : [e.sign.size[0], e.sign.size[1], Math.max(0.05, e.sign.depth ?? 0.05)];
      const m = transformMatrix({ position: p, rotation: e.transform.rotation });
      mat4.scale(m, size, m);
      const inv = mat4.inverse(m);
      const o = vec3.transformMat4(ray.o, inv);
      const d = vec3.sub(vec3.transformMat4(vec3.add(ray.o, ray.d), inv), o);
      return rayUnitBox(o, d);
    }
    // Screen-sized sphere around the helper icon.
    const c = this.editor.rt.camera.position;
    const dist = Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]);
    const r = Math.max(0.15, dist * 0.018);
    const oc = [ray.o[0] - p[0], ray.o[1] - p[1], ray.o[2] - p[2]];
    const b = oc[0] * ray.d[0] + oc[1] * ray.d[1] + oc[2] * ray.d[2];
    const cc = oc[0] * oc[0] + oc[1] * oc[1] + oc[2] * oc[2] - r * r;
    const disc = b * b - cc;
    if (disc < 0) return -1;
    const t = -b - Math.sqrt(disc);
    return t >= 0 ? t : -1;
  }

  /** Möller-Trumbore over every primitive, with the ray taken into local space. */
  private meshHit(ray: Ray, model: ArrayLike<number>, prims: { positions: Float32Array; indices: Uint32Array }[], maxT: number) {
    const inv = mat4.inverse(model as Float32Array);
    const o = vec3.transformMat4(ray.o, inv);
    // Unnormalised local direction: t stays the world ray parameter.
    const d = vec3.sub(vec3.transformMat4(vec3.add(ray.o, ray.d), inv), o);
    let bestT = maxT, bestPrim = -1, bn: number[] = [0, 1, 0];
    for (let pi = 0; pi < prims.length; pi++) {
      const P = prims[pi].positions, I = prims[pi].indices;
      for (let i = 0; i < I.length; i += 3) {
        const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3;
        const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
        const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
        const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;
        const id = 1 / det;
        const tx = o[0] - P[a], ty = o[1] - P[a + 1], tz = o[2] - P[a + 2];
        const u = (tx * px + ty * py + tz * pz) * id;
        if (u < 0 || u > 1) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const v = (d[0] * qx + d[1] * qy + d[2] * qz) * id;
        if (v < 0 || u + v > 1) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * id;
        if (t > 1e-4 && t < bestT) {
          bestT = t;
          bestPrim = pi;
          bn = [e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x];
        }
      }
    }
    if (bestPrim < 0) return null;
    // Normal to world (inverse transpose), facing the ray.
    const nx = inv[0] * bn[0] + inv[1] * bn[1] + inv[2] * bn[2];
    const ny = inv[4] * bn[0] + inv[5] * bn[1] + inv[6] * bn[2];
    const nz = inv[8] * bn[0] + inv[9] * bn[1] + inv[10] * bn[2];
    let n = vec3.normalize([nx, ny, nz]);
    if (n[0] * ray.d[0] + n[1] * ray.d[1] + n[2] * ray.d[2] > 0) n = vec3.negate(n);
    const point: V3 = [ray.o[0] + ray.d[0] * bestT, ray.o[1] + ray.d[1] * bestT, ray.o[2] + ray.d[2] * bestT];
    return { t: bestT, prim: bestPrim, point, normal: [n[0], n[1], n[2]] as V3 };
  }
}
