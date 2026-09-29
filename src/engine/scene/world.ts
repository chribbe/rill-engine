import { mat4, type Mat4 } from 'wgpu-matrix';
import type { Renderer, Renderable, LightData } from '../render/renderer';
import type { GpuMesh } from '../render/geometry';
import type { Material, MaterialDef } from '../render/materials';
import { transformAabb } from '../render/culling';
import { loadGlb } from '../assets/gltf';
import { builtinMesh } from '../assets/primitives';
import { loadLightmapSet, type LoadedLightmaps } from '../render/lightmaps';
import { buildDecals } from '../render/decals';
import { CollisionWorld } from './collision';
import type { DecalObject, MapDocument, MapObject, Transform } from './mapformat';

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

export class World {
  readonly objects = new Map<string, RuntimeObject>();
  readonly renderables: Renderable[] = [];
  readonly lights: LightData[] = [];
  readonly collision = new CollisionWorld();
  private meshes = new Map<string, Promise<GpuMesh>>();
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
        const mesh = await this.mesh(o.asset);
        const mats = await this.materialsFor(mesh, o.id, o.materialOverrides);
        const model = transformMatrix(o.transform);
        const flags = o.receiveDecals === false ? 2 : 0;
        rt.renderables.push(this.makeRenderable(o.id, mesh, mats, model, o.castShadow ?? true, flags, fnv1a(o.id)));
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
        const mesh = await this.mesh(o.asset);
        const mats = await this.materialsFor(mesh, o.id, o.materialOverrides);
        o.instances.forEach((it, i) => {
          const model = yawMatrix(it[0], it[1], it[2], it[3], it[4]);
          rt.renderables.push(this.makeRenderable(`${o.id}#${i}`, mesh, mats, model, o.castShadow ?? true, 2, fnv1a(`${o.id}#${i}`)));
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
      case 'decal':
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
    this.renderer.setLightmaps(lm.view, lm.layers);
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
