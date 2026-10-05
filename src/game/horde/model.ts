import { mat4 } from 'wgpu-matrix';
import type { Renderer } from '../../engine/render/renderer';
import type { RigPartSource } from '../../engine/scene/rig';
import type { DebrisMesh } from '../../engine/physics/debris';
import type { GpuMesh } from '../../engine/render/geometry';
import type { LodLevel } from '../../engine/render/renderer';
import { loadGlbParts } from '../../engine/assets/gltf';

export const LEG_KEYS = ['fl', 'ml', 'rl', 'fr', 'mr', 'rr'] as const;
/** Alternating tripods: front-left, mid-right, rear-left step together, then the other three. */
export const LEG_GROUP = [0, 1, 0, 1, 0, 1];

type V3 = [number, number, number];

/** Distances (m, at the reference field of view) where the rig parts switch to LOD1 and LOD2. */
const LOD_DIST = [9, 22];

export interface LegInfo {
  key: string;
  upper: string;
  lower: string;
  /** Hip in the body frame, thigh and shin rest vectors (hip→knee, knee→foot), their lengths. */
  hip: V3;
  thigh: V3;
  shin: V3;
  l1: number;
  l2: number;
  /** Rest foot in the body frame (on the ground at -rideHeight). */
  foot: V3;
  /** Horizontal outward direction of the leg. */
  out: V3;
}

/** The tomato bug as loaded once: rig part sources (under a mesh-less `frame` root), leg data, gib meshes. */
export interface TomatoModel {
  parts: RigPartSource[];
  legs: LegInfo[];
  shells: DebrisMesh[];
  chunks: DebrisMesh[];
  pulp: DebrisMesh[];
  lid: DebrisMesh;
  crown: DebrisMesh;
  legUpper: DebrisMesh;
  legLower: DebrisMesh;
  any: GpuMesh;
}

const len = (v: ArrayLike<number>) => Math.hypot(v[0], v[1], v[2]);

export async function loadTomatoModel(R: Renderer, url: string): Promise<TomatoModel> {
  const raw = await loadGlbParts(url);
  const parts: RigPartSource[] = [{ name: 'frame', rest: mat4.identity(), mesh: null, materials: [] }];
  const debris = new Map<string, DebrisMesh>();
  let any: GpuMesh | null = null;
  const rests = new Map<string, Float32Array>();
  const extras = new Map<string, Record<string, unknown>>();
  const lodMeshes = new Map<string, LodLevel[]>();
  for (const p of raw) {
    if (!p.mesh.primitives.length) continue;
    const mesh = R.arena.upload(p.mesh);
    const materials = await Promise.all(mesh.primitives.map((q) => R.materials.get(q.material)));
    const lod = /^(.*)__lod(\d)$/.exec(p.name);
    if (lod) {
      // Distance LODs of a rig part (same pivot): <part>__lod1, __lod2.
      const list = lodMeshes.get(lod[1]) ?? [];
      list[+lod[2]] = { mesh, materials, dist2: LOD_DIST[+lod[2] - 1] ** 2 };
      lodMeshes.set(lod[1], list);
      continue;
    }
    any ??= mesh;
    extras.set(p.name, p.extras);
    if (p.name.startsWith('gib_')) {
      const a = mesh.aabb, h = [(a.max[0] - a.min[0]) / 2, (a.max[1] - a.min[1]) / 2, (a.max[2] - a.min[2]) / 2];
      const r = Math.max(h[0], h[1], h[2]);
      // Skin shells and the lid lie flat (their thin axis is local y); tubes and lumps roll.
      const flat = p.extras.gib === 'shell' || p.name === 'gib_lid' || p.name === 'gib_crown';
      debris.set(p.name, { mesh, materials, radius: Math.min(r, Math.max(h[0], h[2]) * 0.7 + 0.02), flatAxis: flat ? [0, 1, 0] : undefined, rest: flat ? h[1] : undefined });
      continue;
    }
    // The body becomes the frame's child at identity; everything that hung on the body hangs on the
    // frame instead (so the body's squash does not stretch the legs).
    const rest = p.name === 'body' ? mat4.identity() : p.rest;
    rests.set(p.name, rest as Float32Array);
    const parent = p.name === 'body' ? 'frame' : p.parent === 'body' && p.name !== 'lid' ? 'frame' : p.parent;
    parts.push({ name: p.name, parent, rest, mesh, materials });
  }
  for (const part of parts) {
    const l = lodMeshes.get(part.name);
    if (!part.mesh || !l || !l[1]) continue;
    l[0] = { mesh: part.mesh, materials: part.materials, dist2: 0 };
    part.lods = l.filter(Boolean);
  }
  const legs: LegInfo[] = LEG_KEYS.map((key) => {
    const upper = `leg_${key}_upper`, lower = `leg_${key}_lower`;
    const r = rests.get(upper)!;
    const hip: V3 = [r[12], r[13], r[14]];
    const thigh = (extras.get(upper)?.tip ?? [0, 0, 0]) as V3;
    const shin = (extras.get(lower)?.tip ?? [0, 0, 0]) as V3;
    const foot: V3 = [hip[0] + thigh[0] + shin[0], hip[1] + thigh[1] + shin[1], hip[2] + thigh[2] + shin[2]];
    const ol = Math.hypot(foot[0], foot[2]) || 1;
    return { key, upper, lower, hip, thigh, shin, l1: len(thigh), l2: len(shin), foot, out: [foot[0] / ol, 0, foot[2] / ol] };
  });
  const pick = (prefix: string) => [...debris.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
  // The leg gibs are copies of the front-right leg: their long axes are its segments.
  const fr = legs[3], nrm = (v: V3): V3 => { const l = len(v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const lu = debris.get('gib_leg_upper'), ll = debris.get('gib_leg_lower');
  if (lu) { lu.longAxis = nrm(fr.thigh); lu.rest = 0.035; lu.radius = 0.06; }
  if (ll) { ll.longAxis = nrm(fr.shin); ll.rest = 0.03; ll.radius = 0.05; }
  return {
    parts, legs, any: any!,
    shells: pick('gib_shell_'), chunks: pick('gib_chunk'), pulp: pick('gib_pulp_'),
    lid: debris.get('gib_lid')!, crown: debris.get('gib_crown')!, legUpper: debris.get('gib_leg_upper')!, legLower: debris.get('gib_leg_lower')!,
  };
}
