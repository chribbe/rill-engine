import { mat4, type Mat4 } from 'wgpu-matrix';
import type { Renderer, Renderable, LightData, LodLevel } from '../render/renderer';
import type { GpuMesh } from '../render/geometry';
import type { Material, MaterialDef } from '../render/materials';
import { transformAabb } from '../render/culling';
import { loadGlb } from '../assets/gltf';
import { builtinMesh } from '../assets/primitives';
import { loadLightmapSet, type LoadedLightmaps } from '../render/lightmaps';
import { buildDecals } from '../render/decals';
import { ClutterSystem, type ClutterSource } from '../render/clutter';
import { CollisionWorld } from './collision';
import type { DecalObject, MapDocument, MapObject, ReflectionProbeObject, Transform } from './mapformat';

/**
 * Runtime world built from a MapDocument. The document stays the source of
 * truth (inspectable, serialisable); everything here is derived and can be
 * rebuilt from it.
 */

export interface RuntimeObject {
  doc: MapObject;
  renderables: Renderable[];
}

export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function transformMatrix(t: Transform): Mat4 {
  const m = mat4.translation(t.position);
  if (t.rotation) mat4.multiply(m, mat4.fromQuat(t.rotation), m);
  if (t.scale) mat4.scale(m, t.scale, m);
  return m;
}

function yawMatrix(x: number, y: number, z: number, yawDeg: number, s: number): Mat4 {
  const m = mat4.translation([x, y, z]);
  mat4.rotateY(m, (-yawDeg * Math.PI) / 180, m);
  mat4.scale(m, [s, s, s], m);
  return m;
}

/** Blender appends .001 etc. to duplicated material names. */
function slotName(n: string) {
  return n.replace(/\.\d{3}$/, '');
}

/** Model descriptor (assets/*.model.json): LOD meshes relative to the descriptor. */
interface ModelDocument {
  format: 'rill.model';
  version: number;
  lods: { mesh: string; distance: number }[];
}
type ModelLods = { mesh: GpuMesh; distance: number }[];

export class World {
  readonly objects = new Map<string, RuntimeObject>();
  readonly renderables: Renderable[] = [];
  readonly lights: LightData[] = [];
  readonly reflectionProbes: ReflectionProbeObject[] = [];
  readonly collision = new CollisionWorld();
  private meshes = new Map<string, Promise<GpuMesh>>();
  private models = new Map<string, Promise<ModelLods>>();
  lightmaps: LoadedLightmaps | null = null;
  decalBytes = 0;
  loadMs = 0;

  constructor(readonly renderer: Renderer, readonly doc: MapDocument, readonly baseUrl: string) {}

  static async load(renderer: Renderer, url: string, onProgress?: (msg: string) => void): Promise<World> {
    const t0 = performance.now();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Map fetch failed: ${url}`);
    const doc = (await res.json()) as MapDocument;
    const w = new World(renderer, doc, url.slice(0, url.lastIndexOf('/') + 1));
    onProgress?.(`Loading ${doc.objects.length} objects`);
    await Promise.all(doc.objects.map((o) => w.addObject(o)));
    if (doc.lightmaps) {
      onProgress?.('Loading lightmaps');
      try {
        await w.applyLightmaps(w.baseUrl + doc.lightmaps);
      } catch (e) {
        console.warn('[world] lightmaps unavailable:', e);
      }
    }
    const decals = doc.objects.filter((o): o is DecalObject => o.type === 'decal');
    const db = await buildDecals(renderer.device, renderer.textures, decals);
    if (db) {
      renderer.setDecals(db.packed, db.count, db.cells, db.grid, db.atlas);
      w.decalBytes = db.bytes;
    }
    renderer.setLights(w.lights);
    renderer.setReflectionProbes(w.reflectionProbes);
    onProgress?.('Scattering ground clutter');
    await w.buildClutter();
    w.loadMs = performance.now() - t0;
    return w;
  }

  private mesh(ref: string): Promise<GpuMesh> {
    let p = this.meshes.get(ref);
    if (!p) {
      p = (async () => {
        const data = ref.startsWith('builtin:') ? builtinMesh(ref) : (await loadGlb('/' + ref.replace(/^\//, ''))).mesh;
        for (const prim of data.primitives) prim.material = slotName(prim.material);
        return this.renderer.arena.upload(data);
      })();
      this.meshes.set(ref, p);
    }
    return p;
  }

  /**
   * An asset reference is either a mesh (.glb / builtin:) or a model descriptor
   * (.model.json, written by the asset tools) listing LOD meshes + distances.
   */
  private model(ref: string): Promise<ModelLods> {
    let p = this.models.get(ref);
    if (!p) {
      p = (async () => {
        if (!ref.endsWith('.model.json')) return [{ mesh: await this.mesh(ref), distance: 0 }];
        const url = '/' + ref.replace(/^\//, '');
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Model fetch failed: ${url} (${res.status})`);
        const doc = (await res.json()) as ModelDocument;
        const dir = ref.slice(0, ref.lastIndexOf('/') + 1);
        const lods = await Promise.all(doc.lods.map(async (l) => ({ mesh: await this.mesh(dir + l.mesh), distance: l.distance })));
        return lods.sort((a, b) => a.distance - b.distance);
      })();
      this.models.set(ref, p);
    }
    return p;
  }

  clutter: ClutterSystem | null = null;

  /** Scatters material-driven ground clutter over static meshes (see render/clutter.ts). */
  async buildClutter() {
    const sources: ClutterSource[] = [];
    for (const rt of this.objects.values()) {
      const o = rt.doc;
      if (o.type !== 'mesh' || rt.renderables.length === 0) continue;
      const r = rt.renderables[0];
      const model = transformMatrix(o.transform);
      r.mesh.primitives.forEach((p, k) => {
        const m = r.materials[k];
        const A = m.def.clutter ?? [], B = m.blendDef?.clutter ?? [];
        if (A.length === 0 && B.length === 0) return;
        const n = p.positions.length / 3;
        const P = new Float32Array(n * 3), N = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          const x = p.positions[i * 3], y = p.positions[i * 3 + 1], z = p.positions[i * 3 + 2];
          P[i * 3] = model[0] * x + model[4] * y + model[8] * z + model[12];
          P[i * 3 + 1] = model[1] * x + model[5] * y + model[9] * z + model[13];
          P[i * 3 + 2] = model[2] * x + model[6] * y + model[10] * z + model[14];
          if (p.normals) {
            const a = p.normals[i * 3], b = p.normals[i * 3 + 1], c = p.normals[i * 3 + 2];
            N[i * 3] = model[0] * a + model[4] * b + model[8] * c;
            N[i * 3 + 1] = model[1] * a + model[5] * b + model[9] * c;
            N[i * 3 + 2] = model[2] * a + model[6] * b + model[10] * c;
          }
        }
        let W: Float32Array | null = null;
        if (p.colors && m.blendDef) {
          W = new Float32Array(n);
          for (let i = 0; i < n; i++) W[i] = p.colors[i * 4];
        }
        const lmEntry = this.lightmaps?.doc.objects[o.id];
        sources.push({
          positions: P, normals: N, indices: p.indices, weights: W, layerA: A, layerB: B, seed: fnv1a(o.id + ':' + k),
          uv1: lmEntry ? p.uv1 ?? null : null, lmST: lmEntry?.scaleOffset ?? null, lmPage: lmEntry ? lmEntry.page : -1,
        });
      });
    }
    if (sources.length === 0) return;
    const sys = new ClutterSystem();
    // One neutral instance slot per lightmap page (clutter reads the ground's lightmap).
    const inst = this.renderer.instances;
    const pages = this.lightmaps ? this.lightmaps.doc.pages.length : 0;
    const nComp = this.lightmaps ? this.lightmaps.doc.components.length : 1;
    let pageSlot0 = this.renderer.clutterSlot;
    for (let pg = 0; pg < pages; pg++) {
      const slot = inst.alloc();
      if (pg === 0) pageSlot0 = slot;
      else if (slot !== pageSlot0 + pg) throw new Error('clutter page slots must be contiguous');
      inst.set(slot, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], [1, 1, 0, 0], pg * nComp, 2, 0, 0);
    }
    // Rejects points under roads, paths, kerbs and buildings (anything walkable above the surface).
    const covered = (x: number, y: number, z: number) => this.collision.groundHeight(x, y + 3, z, 3) > y + 0.008;
    await sys.build(this.renderer.device, this.renderer.clutterLayout, sources, this.renderer.clutterSlot, pageSlot0, covered, async (ref) => {
      const l = await this.loadModel(ref);
      return { mesh: l[0].mesh, materials: l[0].materials };
    });
    this.clutter = sys;
    this.renderer.clutter = sys;
    console.info(`[world] clutter: ${sys.instances} instances in ${sys.types.length} types, ${(sys.bytes / 1048576).toFixed(1)} MB, ${sys.buildMs.toFixed(0)} ms`);
  }

  /** Loads a mesh or model reference with materials, for tools/stress tests spawning outside the map. */
  async loadModel(ref: string) {
    return this.lodMaterials(await this.model(ref), ref);
  }

  static lodsFor(lods: { mesh: GpuMesh; distance: number; materials: Material[] }[], scale: number) {
    return World.lodChain(lods, scale);
  }

  private async lodMaterials(lods: ModelLods, objId: string, overrides?: Record<string, string | MaterialDef>) {
    return Promise.all(lods.map(async (l) => ({ mesh: l.mesh, distance: l.distance, materials: await this.materialsFor(l.mesh, objId, overrides) })));
  }

  private static lodChain(lods: { mesh: GpuMesh; distance: number; materials: Material[] }[], scale: number): LodLevel[] | undefined {
    if (lods.length < 2) return undefined;
    return lods.map((l) => ({ mesh: l.mesh, materials: l.materials, dist2: (l.distance * scale) ** 2 }));
  }

  private async materialsFor(mesh: GpuMesh, objId: string, overrides?: Record<string, string | MaterialDef>): Promise<Material[]> {
    const lib = this.renderer.materials;
    return Promise.all(
      mesh.primitives.map((p) => {
        const o = overrides?.[p.material];
        if (o === undefined) return lib.get(p.material);
        if (typeof o === 'string') return lib.get(o);
        return lib.create(`${objId}:${p.material}`, o);
      }),
    );
  }

  private makeRenderable(id: string, mesh: GpuMesh, materials: Material[], model: Mat4, castShadow: boolean, flags: number, seed: number): Renderable {
    const inst = this.renderer.instances;
    const slot = inst.alloc();
    inst.set(slot, model, null, -1, flags, seed, fnv1a(id));
    const worldMin = new Float32Array(3), worldMax = new Float32Array(3);
    transformAabb(model, mesh.aabb.min, mesh.aabb.max, worldMin, worldMax);
    const r: Renderable = { slot, mesh, materials, worldMin, worldMax, castShadow, visible: true, id };
    this.renderables.push(r);
    return r;
  }

  async addObject(o: MapObject) {
    const rt: RuntimeObject = { doc: o, renderables: [] };
    this.objects.set(o.id, rt);
    switch (o.type) {
      case 'mesh': {
        const lods = await this.lodMaterials(await this.model(o.asset), o.id, o.materialOverrides);
        const mesh = lods[0].mesh;
        const mats = lods[0].materials;
        const model = transformMatrix(o.transform);
        const flags = o.receiveDecals === false ? 2 : 0;
        const r = this.makeRenderable(o.id, mesh, mats, model, o.castShadow ?? true, flags, fnv1a(o.id));
        const sc = o.transform.scale ?? [1, 1, 1];
        r.lods = World.lodChain(lods, Math.max(sc[0], sc[1], sc[2]));
        rt.renderables.push(r);
        if (o.collision ?? o.static ?? true) {
          for (const p of mesh.primitives) {
            const m = mats[mesh.primitives.indexOf(p)];
            if (m.def.shader === 'foliage') continue;
            this.collision.addMesh(p.positions, p.indices, model);
          }
        }
        break;
      }
      case 'instances': {
        const lods = await this.lodMaterials(await this.model(o.asset), o.id, o.materialOverrides);
        const mesh = lods[0].mesh;
        const mats = lods[0].materials;
        o.instances.forEach((it, i) => {
          const model = yawMatrix(it[0], it[1], it[2], it[3], it[4]);
          const r = this.makeRenderable(`${o.id}#${i}`, mesh, mats, model, o.castShadow ?? true, 2, fnv1a(`${o.id}#${i}`));
          r.lods = World.lodChain(lods, it[4]);
          rt.renderables.push(r);
        });
        break;
      }
      case 'light': {
        const l = o.light;
        const q = o.transform.rotation ?? [0, 0, 0, 1];
        const m = mat4.fromQuat(q);
        // Local -Y is the emission axis for spots (lamp heads point down by default).
        const dir: [number, number, number] = [-m[4], -m[5], -m[6]];
        this.lights.push({
          position: o.transform.position,
          color: l.color,
          intensity: l.intensity,
          range: l.range,
          type: l.kind,
          direction: dir,
          innerAngle: l.innerAngle,
          outerAngle: l.outerAngle,
          sourceRadius: l.sourceRadius,
          fogScatter: l.fogScatter,
        });
        break;
      }
      case 'reflectionProbe':
        this.reflectionProbes.push(o);
        break;
      case 'decal':
      case 'marker':
      case 'probeVolume':
        break;
    }
  }

  async applyLightmaps(url: string) {
    const lm = await loadLightmapSet(this.renderer.device, url);
    this.lightmaps = lm;
    const nComp = lm.doc.components.length;
    let applied = 0;
    for (const [id, entry] of Object.entries(lm.doc.objects)) {
      const rt = this.objects.get(id);
      if (!rt) continue;
      for (const r of rt.renderables) {
        this.renderer.instances.setLightmap(r.slot, entry.scaleOffset, entry.page * nComp);
        applied++;
      }
    }
    this.renderer.setLightmaps(lm.view, lm.layers, lm.directional);
    if (lm.probeVolume) this.renderer.setProbeVolume(lm.probeVolume);
    console.info(`[world] lightmaps: ${applied} objects, ${lm.layers} layers, ${(lm.bytes / 1048576).toFixed(1)} MB`);
  }

  get triangleCount() {
    let t = 0;
    for (const r of this.renderables) t += r.mesh.triangles;
    return t;
  }

  /** Serialises the (current) map document. */
  toJSON(): MapDocument {
    return this.doc;
  }
}
