import { mat4 } from 'wgpu-matrix';
import type { Renderer, Renderable } from './engine/render/renderer';
import { World } from './engine/scene/world';
import type { GpuMesh } from './engine/render/geometry';
import type { Material } from './engine/render/materials';
import { transformAabb } from './engine/render/culling';
import { loadGlb } from './engine/assets/gltf';
import { builtinMesh } from './engine/assets/primitives';

/**
 * Stress-test spawner: adds transient renderables (not part of the map
 * document) to measure culling, batching, shadow and fill costs.
 */

let baseInstanceCount = -1;
const meshCache = new Map<string, Promise<{ mesh: GpuMesh; mats: Material[] }>>();

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function getMesh(r: Renderer, ref: string, fallback: string) {
  let p = meshCache.get(ref);
  if (!p) {
    p = (async () => {
      let data;
      try {
        data = ref.startsWith('builtin:') ? builtinMesh(ref) : (await loadGlb('/' + ref)).mesh;
      } catch {
        data = builtinMesh(fallback);
      }
      for (const pr of data.primitives) pr.material = pr.material.replace(/\.\d{3}$/, '');
      const mesh = r.arena.upload(data);
      const mats = await Promise.all(mesh.primitives.map((pr) => r.materials.get(pr.material)));
      return { mesh, mats };
    })();
    meshCache.set(ref, p);
  }
  return p;
}

export async function runStress(r: Renderer, world: World, list: Renderable[], kind: string, count: number) {
  if (baseInstanceCount < 0) baseInstanceCount = r.instances.count;
  const rand = rng(1234 + list.length);
  const specs: Record<string, { ref: string; fallback: string; area: number; scale: [number, number]; ground: boolean }> = {
    trees: { ref: 'assets/testmap/tree_pine_a.model.json', fallback: 'builtin:cylinder?r=0.25&h=14&material=bark_pine', area: 600, scale: [0.8, 1.2], ground: true },
    props: { ref: 'assets/testmap/streetlight.glb', fallback: 'builtin:cylinder?r=0.08&h=6&material=metal_galvanized', area: 400, scale: [1, 1], ground: true },
    buildings: { ref: 'builtin:box?x=12&y=15&z=30&material=concrete_cast', fallback: 'builtin:box?x=12&y=15&z=30', area: 1500, scale: [0.6, 1.4], ground: true },
    spheres: { ref: 'builtin:sphere?r=0.5&material=debug_checker', fallback: 'builtin:sphere?r=0.5', area: 300, scale: [0.5, 3], ground: true },
  };
  const s = specs[kind] ?? specs.spheres;
  let lods: Awaited<ReturnType<World['loadModel']>> | null = null;
  if (s.ref.endsWith('.model.json')) lods = await world.loadModel(s.ref).catch(() => null);
  const { mesh, mats } = lods ? { mesh: lods[0].mesh, mats: lods[0].materials } : await getMesh(r, s.ref, s.fallback);
  const half = s.area / 2;
  for (let i = 0; i < count; i++) {
    const x = (rand() * 2 - 1) * half;
    const z = (rand() * 2 - 1) * half;
    let y = 0;
    if (s.ground) {
      const g = world.collision.groundHeight(x, 200, z, 400);
      if (g > -Infinity) y = g;
    }
    const sc = s.scale[0] + rand() * (s.scale[1] - s.scale[0]);
    const m = mat4.translation([x, y, z]);
    mat4.rotateY(m, rand() * Math.PI * 2, m);
    mat4.scale(m, [sc, sc, sc], m);
    const slot = r.instances.alloc();
    r.instances.set(slot, m, null, -1, 2, i, 0);
    const worldMin = new Float32Array(3), worldMax = new Float32Array(3);
    transformAabb(m, mesh.aabb.min, mesh.aabb.max, worldMin, worldMax);
    list.push({ slot, mesh, materials: mats, lods: lods ? World.lodsFor(lods, sc) : undefined, worldMin, worldMax, castShadow: true, visible: true, id: `stress:${kind}:${i}` });
  }
  console.info(`[stress] +${count} ${kind} (total ${list.length}, ${(list.reduce((a, b) => a + b.mesh.triangles, 0) / 1e6).toFixed(2)}M tris)`);
}

export function clearStress(r: Renderer, list: Renderable[]) {
  list.length = 0;
  if (baseInstanceCount >= 0) r.instances.count = baseInstanceCount;
}
