import { mat4, quat, vec3, type Mat4 } from 'wgpu-matrix';
import type { Entity, PrefabDocument, PrefabObject, Transform } from './mapformat';

/**
 * Prefabs: reusable groups of entities stored in public/prefabs/<name>.json in
 * the prefab's own space (origin = the instance's pivot). A `prefab` entity in
 * a map places one; the runtime expands it into virtual entities with IDs
 * '<instance>/<child>' (nested prefabs nest further). The same transforms are
 * used to unpack an instance into ordinary entities and to save edits back.
 */

function matrixOf(t: Transform): Mat4 {
  const m = mat4.translation(t.position);
  if (t.rotation) mat4.multiply(m, mat4.fromQuat(t.rotation), m);
  if (t.scale) mat4.scale(m, t.scale, m);
  return m;
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
/** Positions to 0.1 mm: float32 round trips through a rotated frame stay put. */
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** Yaw (degrees about +Y) of a rotation. */
function yawOf(q: ArrayLike<number> | undefined): number {
  if (!q) return 0;
  return (Math.atan2(2 * (q[3] * q[1] + q[0] * q[2]), 1 - 2 * (q[1] * q[1] + q[2] * q[2])) * 180) / Math.PI;
}

/** Applies `frame` (or its inverse) to one entity's spatial data, in place. */
function reframe(e: Entity, frame: Transform, inverse: boolean) {
  const M = inverse ? mat4.inverse(matrixOf(frame)) : matrixOf(frame);
  const fq = quat.fromValues(...((frame.rotation ?? [0, 0, 0, 1]) as [number, number, number, number]));
  const q = inverse ? quat.inverse(fq) : fq;
  const fs = frame.scale;
  if ('transform' in e && e.transform) {
    const t = e.transform;
    const p = vec3.transformMat4(t.position, M);
    t.position = [r4(p[0]), r4(p[1]), r4(p[2])];
    const r = quat.multiply(q, quat.fromValues(...((t.rotation ?? [0, 0, 0, 1]) as [number, number, number, number])));
    if (r[3] < 0) quat.scale(r, -1, r);
    if (Math.abs(r[3]) < 1 - 1e-9) t.rotation = [r6(r[0]), r6(r[1]), r6(r[2]), r6(r[3])];
    else delete t.rotation;
    if (fs) {
      const s = (t.scale ?? [1, 1, 1]).map((v, k) => r6(inverse ? v / fs[k] : v * fs[k])) as [number, number, number];
      if (s.every((v) => Math.abs(v - 1) < 1e-9)) delete t.scale;
      else t.scale = s;
    }
  }
  // World-space data inside entity types.
  if (e.type === 'reflectionProbe') {
    const lo = e.probe.boxMin, hi = e.probe.boxMax;
    const pts = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => vec3.transformMat4([i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]], M));
    e.probe = {
      ...e.probe,
      boxMin: [0, 1, 2].map((k) => r4(Math.min(...pts.map((p) => p[k])))) as [number, number, number],
      boxMax: [0, 1, 2].map((k) => r4(Math.max(...pts.map((p) => p[k])))) as [number, number, number],
    };
  }
  if (e.type === 'marker') {
    const dy = yawOf(fq);
    const y = (e.yaw ?? 0) + (inverse ? -dy : dy);
    if (Math.abs(y) > 1e-6) e.yaw = r6(((y % 360) + 540) % 360 - 180);
    else delete e.yaw;
  }
}

/** The virtual entities an instance expands into (world space, IDs '<instance>/<child>'). */
export function expandPrefab(inst: PrefabObject, pd: PrefabDocument): Entity[] {
  return pd.entities.map((c) => {
    const e = structuredClone(c) as Entity;
    e.id = `${inst.id}/${c.id}`;
    e.parent = c.parent ? `${inst.id}/${c.parent}` : inst.id;
    reframe(e, inst.transform, false);
    return e;
  });
}

/** Entities in world space -> prefab space of a frame (the inverse of expandPrefab's transform). */
export function toPrefabSpace(entities: Entity[], frame: Transform): Entity[] {
  return entities.map((c) => {
    const e = structuredClone(c);
    reframe(e, frame, true);
    return e;
  });
}

/** Prefab entities placed into the world at a frame (unpacking): copies with the given IDs. */
export function fromPrefabSpace(entities: Entity[], frame: Transform): Entity[] {
  return entities.map((c) => {
    const e = structuredClone(c);
    reframe(e, frame, false);
    return e;
  });
}

/** Entity counts by type (prefab lists). */
export function prefabSummary(pd: PrefabDocument) {
  const counts: Record<string, number> = {};
  for (const e of pd.entities) counts[e.type] = (counts[e.type] ?? 0) + 1;
  return counts;
}
