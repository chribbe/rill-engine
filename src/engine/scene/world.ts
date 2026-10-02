import { mat4, quat, vec3, type Mat4 } from 'wgpu-matrix';
import type { Renderer, Renderable, LightData, LodLevel } from '../render/renderer';
import type { GpuMesh } from '../render/geometry';
import type { Material, MaterialDef } from '../render/materials';
import { transformAabb } from '../render/culling';
import { loadGlb } from '../assets/gltf';
import { builtinMesh } from '../assets/primitives';
import { loadLightmapSet, type LoadedLightmaps } from '../render/lightmaps';
import { buildDecals, type DecalSet } from '../render/decals';
import { ClutterSystem, type ClutterSource } from '../render/clutter';
import { CollisionWorld, Surface } from './collision';
import type { DecalObject, Entity, LightObject, MapDocument, MarkerObject, MeshObject, ReflectionProbeObject, ScatterObject, SignObject, Transform } from './mapformat';
import { evaluateScatter, type ScatterInstance, type ScatterPreset } from './scatter';
import { buildSpline, type SplineBuild, type SplinePreset } from './splines';
import type { SplineObject } from './mapformat';
import { SceneStore, type SceneChange } from './scene';
import { buildSigns } from '../render/signs';

/** Decal materials always present in the atlas for gameplay-spawned decals. */
const RUNTIME_DECALS = ['decal_bullet', 'decal_bullet_metal'];

/**
 * Runtime world derived from the authoritative scene (SceneStore). The
 * document stays the source of truth; everything here is rebuilt from it.
 * Scene changes (editor commands, undo/redo) are queued and applied in place
 * by `flush()` once per frame: transforms and flags update the instance table
 * directly, asset or material changes re-create the entity's renderables, and
 * lights / decals / signs / reflection probes are rebuilt as sets. Collision is
 * rebuilt lazily (`ensureCollision`, before play).
 */

type Lods = { mesh: GpuMesh; distance: number; materials: Material[] }[];

export interface RuntimeObject {
  doc: Entity;
  renderables: Renderable[];
  /** Mesh entities: resolved LOD chain (LOD0 = renderables[0].mesh). */
  lods?: Lods;
  /** Scatter entities: preset, species models and the evaluated instances (renderables[i] = instances[i]). */
  scatter?: { preset: ScatterPreset; species: Lods[]; instances: ScatterInstance[]; ms: number; groundRev: number };
  /** Spline entities: preset, repeated-part models, the last build and its uploaded mesh. */
  spline?: { preset: SplinePreset; assets: Map<string, Lods>; build: SplineBuild | null; mesh: GpuMesh | null; version: number; ms: number };
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

/** Instance flags: 2 = no decals, 8 = wind (vegetation sways). */
function meshFlags(o: MeshObject) {
  return (o.receiveDecals === false ? 2 : 0) | (o.semantic === 'vegetation' ? 8 : 0);
}

/** Fields whose change needs the renderables re-created (new mesh / materials). */
function meshIdentity(o: MeshObject) {
  return JSON.stringify([o.asset, o.materialOverrides ?? null]);
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

interface Turnstile {
  r: Renderable;
  base: Mat4;
  pivot: number[];
  axis: number[];
  lane: number[];
  dir: number[];
  angle: number;
  target: number;
  side: number;
}

export class World {
  readonly objects = new Map<string, RuntimeObject>();
  private turnstiles = new Map<string, Turnstile>();
  readonly renderables: Renderable[] = [];
  lights: LightData[] = [];
  reflectionProbes: ReflectionProbeObject[] = [];
  readonly collision = new CollisionWorld();
  /** Collision no longer matches the scene (rebuilt by `ensureCollision`). */
  private _collisionDirty = true;
  get collisionDirty() { return this._collisionDirty; }
  set collisionDirty(v: boolean) {
    this._collisionDirty = v;
    // Scatters stand on the collision surfaces: re-drop them once edits pause.
    if (v) this.regroundAt = performance.now() + 500;
  }
  private regroundAt = 0;
  /** Bumped on every collision rebuild (scatters remember the ground they were dropped on). */
  collisionRev = 0;
  /** Static geometry changed since the lightmaps were baked (re-bake to update). */
  lightingStale = false;
  private meshes = new Map<string, Promise<GpuMesh>>();
  private models = new Map<string, Promise<ModelLods>>();
  lightmaps: LoadedLightmaps | null = null;
  decals: DecalSet | null = null;
  decalBytes = 0;
  loadMs = 0;
  private signsRt: RuntimeObject | null = null;
  private dirty = new Set<string>();
  private dirtyKinds = new Set<string>();
  private removed = new Set<Renderable>();
  private signBuild: Promise<void> | null = null;
  private decalBuild: Promise<void> | null = null;
  /** Mesh loads in flight (editor status). */
  pendingLoads = 0;

  constructor(readonly renderer: Renderer, readonly scene: SceneStore, readonly baseUrl: string) {
    scene.subscribe((c) => this.onSceneChange(c));
  }

  get doc(): MapDocument {
    return this.scene.doc;
  }

  private uploadDecals() {
    const b = this.decals!.build();
    this.renderer.setDecals(b.packed, b.count, b.cells, b.grid, this.decals!.atlas);
  }

  /** Runtime decal (bullet hole...) on the surface hit at `point` with outward `normal`. */
  addDecal(material: string, point: ArrayLike<number>, normal: ArrayLike<number>, size: number) {
    if (!this.decals?.has(material)) return;
    this.decals.addDynamic(material, point, normal, size);
    this.uploadDecals();
  }

  /** Removes runtime decals (bullet holes) - leaving play mode. */
  clearRuntimeDecals() {
    if (!this.decals) return;
    this.decals.clearDynamic();
    this.uploadDecals();
  }

  static async fetchDocument(url: string): Promise<MapDocument> {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Map fetch failed: ${url}`);
    const doc = (await res.json()) as MapDocument;
    if (doc.version !== 2 || !Array.isArray(doc.entities)) {
      throw new Error(`${url}: map format version ${doc.version} (expected 2) - run: node tools/scene/migrate.ts <map>`);
    }
    return doc;
  }

  static async load(renderer: Renderer, url: string, onProgress?: (msg: string) => void): Promise<World> {
    const t0 = performance.now();
    const doc = await World.fetchDocument(url);
    const w = new World(renderer, new SceneStore(doc), url.slice(0, url.lastIndexOf('/') + 1));
    await w.build(onProgress);
    w.loadMs = performance.now() - t0;
    return w;
  }

  /** Builds every runtime object from the current document (initial load / reload). */
  /** True while the initial build runs: scatters wait for the complete ground. */
  private building = false;

  private async build(onProgress?: (msg: string) => void) {
    const doc = this.doc;
    onProgress?.(`Loading ${doc.entities.length} entities`);
    this.building = true;
    try {
      await Promise.all(doc.entities.map((o) => this.addObject(o)));
    } finally {
      this.building = false;
    }
    if (doc.lightmaps) {
      onProgress?.('Loading lightmaps');
      try {
        await this.applyLightmaps(this.baseUrl + doc.lightmaps);
      } catch (e) {
        console.warn('[world] lightmaps unavailable:', e);
      }
    }
    await this.rebuildSigns();
    await this.rebuildDecals();
    this.rebuildLights();
    this.rebuildReflectionProbes();
    this.ensureCollision();
    // Splines drape on the loaded ground; then the collision includes them for scatters.
    const splines = [...this.objects.values()].filter((r) => r.spline);
    if (splines.length) {
      for (const r of splines) await this.populateSpline(r);
      this.ensureCollision();
    }
    // Scatters that evaluated while the ground was still loading: drop them again.
    for (const r of this.objects.values()) if (r.scatter && r.scatter.groundRev !== this.collisionRev) this.populateScatter(r);
    this.compactRenderables();
    // Everything above was built from the final document: nothing left for flush().
    this.dirtyKinds.clear();
    if (this.renderer.settings.clutter) {
      onProgress?.('Scattering ground clutter');
      await this.buildClutter();
    }
  }

  /** Replaces the document and rebuilds the world in place (editor load / revert). */
  async reload(doc: MapDocument) {
    for (const id of [...this.objects.keys()]) this.removeRuntime(id);
    this.compactRenderables();
    this.dirty.clear();
    this.dirtyKinds.clear();
    this.lightingStale = false;
    this.scene.load(doc);
    await this.build();
  }

  // ------------------------------------------------------------------ scene sync

  private onSceneChange(c: SceneChange) {
    if (c.source === 'load') return;
    for (const p of c.patches) {
      if (p.kind !== 'entity') continue;
      this.dirty.add(p.id);
      const b = p.before, a = p.after;
      // Hiding / re-parenting a subtree changes every descendant's effective visibility.
      if (b?.visible !== a?.visible || b?.parent !== a?.parent || b?.locked !== a?.locked) {
        for (const d of this.scene.descendants(p.id)) this.dirty.add(d);
      }
      if (b) this.dirtyKinds.add(b.type);
      if (a) this.dirtyKinds.add(a.type);
    }
  }

  /** True while queued scene changes are not yet applied to the runtime. */
  get dirtyCount() {
    return this.dirty.size;
  }

  /** Ground under scatters changed and edits paused: rebuild collision, re-drop every scatter. */
  private maybeReground() {
    if (!this.regroundAt || performance.now() < this.regroundAt) return;
    this.regroundAt = 0;
    const scatters = [...this.objects.values()].filter((r) => r.scatter);
    if (!scatters.length) return;
    // Full rebuild (splines included), so scatters keep off newly drawn paths.
    this.ensureCollision();
    for (const r of scatters) if (r.scatter!.groundRev !== this.collisionRev) this.populateScatter(r);
    this.compactRenderables();
  }

  /** Applies queued scene changes to the runtime (call once per frame, before rendering). */
  flush() {
    if (this.regroundAt && this.dirty.size === 0) this.maybeReground();
    if (this.dirty.size === 0 && this.dirtyKinds.size === 0) return;
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const id of ids) {
      const e = this.scene.get(id);
      const rt = this.objects.get(id);
      if (e) this.dirtyKinds.add(e.type);
      if (!e) {
        if (rt) this.removeRuntime(id);
      } else if (!rt) {
        void this.addObject(e);
      } else {
        this.syncEntity(rt, e);
      }
    }
    this.compactRenderables();
    this.maybeReground();
    const k = this.dirtyKinds;
    if (k.has('light')) this.rebuildLights();
    if (k.has('reflectionProbe')) this.rebuildReflectionProbes();
    if (k.has('decal')) void this.rebuildDecals();
    if (k.has('sign')) void this.rebuildSigns();
    k.clear();
  }

  private syncEntity(rt: RuntimeObject, e: Entity) {
    const prev = rt.doc;
    if (e.type === 'scatter' && prev.type === 'scatter' && prev.scatter.preset === e.scatter.preset) {
      // Same species: re-evaluate in place (painting, moving, density...).
      rt.doc = e;
      if (rt.scatter) this.populateScatter(rt);
      return;
    }
    if (e.type === 'spline' && prev.type === 'spline' && prev.spline.preset === e.spline.preset) {
      rt.doc = e;
      if (rt.spline) void this.populateSpline(rt);
      return;
    }
    if (prev.type !== e.type || (e.type === 'mesh' && meshIdentity(prev as MeshObject) !== meshIdentity(e)) || e.type === 'instances' || e.type === 'scatter' || e.type === 'spline') {
      // New mesh, materials or instance list: re-create.
      this.removeRuntime(e.id);
      void this.addObject(e);
      return;
    }
    rt.doc = e;
    if (e.type === 'mesh') this.updateMesh(rt, e, prev as MeshObject);
  }

  /** Transform / flags / visibility of an existing mesh entity, in place. */
  private updateMesh(rt: RuntimeObject, o: MeshObject, prev: MeshObject) {
    const r = rt.renderables[0];
    if (!r) return; // still loading: the load applies the latest document
    const inst = this.renderer.instances;
    const model = transformMatrix(o.transform);
    inst.setModel(r.slot, model);
    inst.setFlags(r.slot, meshFlags(o));
    transformAabb(model, r.mesh.aabb.min, r.mesh.aabb.max, r.worldMin, r.worldMax);
    r.castShadow = o.castShadow ?? true;
    r.visible = this.scene.effectiveVisible(o.id);
    const sc = o.transform.scale ?? [1, 1, 1];
    if (rt.lods) r.lods = World.lodChain(rt.lods, Math.max(sc[0], sc[1], sc[2]));
    this.setupTurnstile(o, r, model);
    inst.setProbes(r.slot, this.renderer.probeBits(r.worldMin, r.worldMax));
    const moved = JSON.stringify(prev.transform) !== JSON.stringify(o.transform);
    if (moved || prev.visible !== o.visible || prev.collision !== o.collision) this.collisionDirty = true;
    if (moved && (o.static ?? true)) this.lightingStale = true;
  }

  private removeRuntime(id: string) {
    const rt = this.objects.get(id);
    if (!rt) return;
    for (const r of rt.renderables) {
      this.removed.add(r);
      this.renderer.instances.free(r.slot);
    }
    if (rt.spline?.mesh) {
      this.renderer.arena.free(rt.spline.mesh);
      rt.spline.mesh = null;
      rt.spline.version++;
      this.splineCollisionStale = true;
      this.regroundAt = performance.now() + 500;
    }
    if (rt.doc.type === 'mesh' || rt.doc.type === 'instances') {
      this.collisionDirty = true;
      if (rt.doc.type === 'mesh' && rt.doc.lightmap) this.lightingStale = true;
    }
    this.objects.delete(id);
    this.turnstiles.delete(id);
  }

  /** Drops removed renderables from the draw list (in place: callers keep the array). */
  private compactRenderables() {
    if (this.removed.size === 0) return;
    let w = 0;
    for (const r of this.renderables) if (!this.removed.has(r)) this.renderables[w++] = r;
    this.renderables.length = w;
    this.removed.clear();
  }

  // ------------------------------------------------------------------ behaviour

  /** Per-frame world behaviour (turnstiles turning as the player walks through). */
  update(dt: number, feet: ArrayLike<number>) {
    for (const t of this.turnstiles.values()) {
      const rel = [feet[0] - t.lane[0], feet[1] - t.lane[1], feet[2] - t.lane[2]];
      const along = rel[0] * t.dir[0] + rel[2] * t.dir[2];
      const lat = Math.hypot(rel[0] - t.dir[0] * along, rel[2] - t.dir[2] * along);
      const inLane = lat < 0.45 && Math.abs(along) < 1.0 && Math.abs(rel[1] - 0.9) < 1.2;
      const side = inLane ? Math.sign(along) || 1 : 0;
      // Crossing the rotor plane turns it one third, in the passing direction.
      if (side && t.side && side !== t.side) t.target += (side > 0 ? 1 : -1) * (2 * Math.PI) / 3;
      if (side) t.side = side;
      else if (Math.abs(along) > 1.5 || lat > 1.0) t.side = 0;
      if (t.angle === t.target) continue;
      const step = dt * 6.0;
      const d = t.target - t.angle;
      t.angle = Math.abs(d) <= step ? t.target : t.angle + Math.sign(d) * step;
      this.renderer.instances.setModel(t.r.slot, this.turnstileModel(t));
    }
  }

  private turnstileModel(t: Turnstile) {
    const m = mat4.translation(t.pivot);
    mat4.rotate(m, t.axis, t.angle, m);
    mat4.translate(m, [-t.pivot[0], -t.pivot[1], -t.pivot[2]], m);
    mat4.multiply(m, t.base, m);
    return m;
  }

  /** Resets play-mode behaviour state (turnstiles back to their authored pose). */
  resetBehaviour() {
    for (const t of this.turnstiles.values()) {
      t.angle = t.target = 0;
      t.side = 0;
      this.renderer.instances.setModel(t.r.slot, t.base);
    }
  }

  /** Turnstile data is entity-local: world pivot / axis / lane from the current transform. */
  private setupTurnstile(o: MeshObject, r: Renderable, model: Mat4) {
    if (!o.turnstile) {
      this.turnstiles.delete(o.id);
      return;
    }
    const t = o.turnstile;
    const q = o.transform.rotation ?? [0, 0, 0, 1];
    const rot = (v: number[]) => Array.from(vec3.normalize(vec3.transformQuat(v, quat.fromValues(q[0], q[1], q[2], q[3]))));
    const pt = (v: number[]) => Array.from(vec3.transformMat4(v, model));
    const pivot = pt(t.pivot);
    // Arms sweep a small sphere: grow the bounds so culling never clips them.
    for (let i = 0; i < 3; i++) { r.worldMin[i] = Math.min(r.worldMin[i], pivot[i] - 0.7); r.worldMax[i] = Math.max(r.worldMax[i], pivot[i] + 0.7); }
    this.turnstiles.set(o.id, { r, base: model, pivot, axis: rot(t.axis), lane: pt(t.lane), dir: rot(t.dir), angle: 0, target: 0, side: 0 });
  }

  // ------------------------------------------------------------------ derived sets

  private visibleOfType<T extends Entity['type']>(type: T): Extract<Entity, { type: T }>[] {
    return this.doc.entities.filter((e): e is Extract<Entity, { type: T }> => e.type === type && this.scene.effectiveVisible(e.id));
  }

  /** Map lamps from the light entities. */
  rebuildLights() {
    this.lights = this.visibleOfType('light').map((o) => lightData(o));
    this.renderer.setLights(this.lights);
  }

  rebuildReflectionProbes() {
    this.reflectionProbes = this.visibleOfType('reflectionProbe');
    this.renderer.setReflectionProbes(this.reflectionProbes);
    this.renderer.assignReflectionProbes(this.renderables);
  }

  /** Static decals from the decal entities; the atlas is rebuilt only when a new material appears. */
  async rebuildDecals() {
    if (this.decalBuild) {
      // Coalesce: one rebuild after the running one, with the latest document.
      await this.decalBuild;
      this.dirtyKinds.add('decal');
      return;
    }
    const decals = this.visibleOfType('decal');
    if (this.decals && this.decals.covers(decals)) {
      this.decals.setStatic(decals);
      this.uploadDecals();
      return;
    }
    this.decalBuild = (async () => {
      const set = await buildDecals(this.renderer.device, this.renderer.textures, decals, RUNTIME_DECALS);
      this.decals = set;
      if (set) {
        set.setStatic(this.visibleOfType('decal'));
        this.uploadDecals();
        this.decalBytes = set.bytes;
      }
    })();
    try { await this.decalBuild; } finally { this.decalBuild = null; }
  }

  /** All text signs as one mesh: atlas faces (backlit / painted) and lightbox bodies. */
  async rebuildSigns() {
    if (this.signBuild) {
      await this.signBuild;
      this.dirtyKinds.add('sign');
      return;
    }
    this.signBuild = (async () => {
      const signs = this.visibleOfType('sign');
      const b = signs.length ? await buildSigns(this.renderer.textures, signs, '/textures/runtime/signs.png', (o) => transformMatrix(o.transform) as Float32Array) : null;
      if (this.signsRt) {
        for (const r of this.signsRt.renderables) {
          this.removed.add(r);
          this.renderer.instances.free(r.slot);
          this.renderer.arena.free(r.mesh);
        }
        this.compactRenderables();
        this.signsRt = null;
      }
      if (!b) return;
      const prims = [b.lit, b.painted, b.body].filter((p): p is NonNullable<typeof p> => !!p);
      const mesh = this.renderer.arena.upload({ name: 'signs', primitives: prims });
      const mats = await Promise.all(mesh.primitives.map((p) => this.renderer.materials.get(p.material)));
      const r = this.makeRenderable('__signs', mesh, mats, mat4.identity(), false, 2, fnv1a('signs'));
      this.renderer.instances.setProbes(r.slot, this.renderer.probeBits(r.worldMin, r.worldMax));
      this.signsRt = { doc: signs[0], renderables: [r] };
    })();
    try { await this.signBuild; } finally { this.signBuild = null; }
  }

  /** Spline geometry changed since the collision was built (ignored by ground queries during editing). */
  private splineCollisionStale = false;

  /**
   * Rebuilds the collision soup from visible, collidable mesh entities if anything changed.
   * `forGround`: a ground query while editing (splines being dragged don't force a rebuild).
   */
  ensureCollision(forGround = false) {
    if (!this.collisionDirty && (forGround || !this.splineCollisionStale)) return;
    this.splineCollisionStale = false;
    const t0 = performance.now();
    this.collision.clear();
    for (const rt of this.objects.values()) {
      const o = rt.doc;
      if (o.type === 'spline' && rt.spline?.build && (o.collision ?? rt.spline.preset.collision ?? true) && this.scene.effectiveVisible(o.id)) {
        for (const p of rt.spline.build.primitives) this.collision.addMesh(p.positions, p.indices, mat4.identity(), Surface.Default, o.id);
        for (const r of rt.renderables.slice(rt.spline.mesh ? 1 : 0)) {
          for (const p of r.mesh.primitives) this.collision.addMesh(p.positions, p.indices, this.renderer.instances.model(r.slot), Surface.Default, o.id);
        }
        continue;
      }
      if (o.type !== 'mesh' || !(o.collision ?? o.static ?? true) || !this.scene.effectiveVisible(o.id)) continue;
      const r = rt.renderables[0];
      if (!r) continue;
      const model = transformMatrix(o.transform);
      r.mesh.primitives.forEach((p, k) => {
        const m = r.materials[k];
        if (m.def.shader === 'foliage') return;
        this.collision.addMesh(p.positions, p.indices, model, (m.def.metallic ?? 0) > 0.5 ? Surface.Metal : Surface.Default, o.id);
      });
    }
    this.collisionDirty = false;
    this.collisionRev++;
    console.info(`[world] collision: ${this.collision.triangleCount} triangles in ${(performance.now() - t0).toFixed(0)} ms`);
  }

  // ------------------------------------------------------------------ scatter

  private scatterPresets = new Map<string, Promise<ScatterPreset>>();
  scatterPreset(name: string): Promise<ScatterPreset> {
    let p = this.scatterPresets.get(name);
    if (!p) {
      p = fetch(`/scatter/${encodeURIComponent(name)}.json`).then((r) => {
        if (!r.ok) throw new Error(`scatter preset '${name}' not found`);
        return r.json() as Promise<ScatterPreset>;
      });
      p.catch(() => this.scatterPresets.delete(name));
      this.scatterPresets.set(name, p);
    }
    return p;
  }

  /** Re-evaluates a scatter against the current ground and rebuilds its instances. */
  populateScatter(rt: RuntimeObject) {
    const e = rt.doc as ScatterObject;
    const sc = rt.scatter!;
    const t0 = performance.now();
    for (const r of rt.renderables) {
      this.removed.add(r);
      this.renderer.instances.free(r.slot);
    }
    rt.renderables = [];
    this.ensureCollision(true);
    const m = transformMatrix({ position: e.transform.position, rotation: e.transform.rotation });
    const toWorld = (x: number, z: number): [number, number] => [m[0] * x + m[8] * z + m[12], m[2] * x + m[10] * z + m[14]];
    const inst = evaluateScatter(e, sc.preset, toWorld, (x, z) => this.collision.groundHit(x, 1e4, z, 2e4), (id) => this.scene.get(id)?.semantic);
    const vis = this.scene.effectiveVisible(e.id);
    const semantic = e.semantic ?? sc.preset.semantic ?? 'vegetation';
    const flags = 2 | (semantic === 'vegetation' ? 8 : 0);
    const shadow = sc.preset.castShadow ?? true;
    for (const it of inst) {
      const lods = sc.species[it.species];
      const model = yawMatrix(it.position[0], it.position[1], it.position[2], it.yawDeg, it.scale);
      const id = `${e.id}#${it.key}`;
      const r = this.makeRenderable(id, lods[0].mesh, lods[0].materials, model, shadow, flags, fnv1a(id));
      r.lods = World.lodChain(lods, it.scale);
      r.visible = vis;
      this.renderer.instances.setProbes(r.slot, this.renderer.probeBits(r.worldMin, r.worldMax));
      rt.renderables.push(r);
    }
    sc.instances = inst;
    sc.groundRev = this.collisionRev;
    sc.ms = performance.now() - t0;
  }

  /** Evaluated instances of a scatter entity (world transforms, cell keys, species assets). */
  scatterInstances(id: string): { key: string; asset: string; position: [number, number, number]; yawDeg: number; scale: number }[] {
    const rt = this.objects.get(id);
    if (!rt?.scatter) return [];
    return rt.scatter.instances.map((i) => ({ key: i.key, asset: rt.scatter!.preset.species[i.species].asset, position: i.position, yawDeg: i.yawDeg, scale: i.scale }));
  }

  // ------------------------------------------------------------------ splines

  private splinePresets = new Map<string, Promise<SplinePreset>>();
  splinePreset(name: string): Promise<SplinePreset> {
    let p = this.splinePresets.get(name);
    if (!p) {
      p = fetch(`/splines/${encodeURIComponent(name)}.json`).then((r) => {
        if (!r.ok) throw new Error(`spline preset '${name}' not found`);
        return r.json() as Promise<SplinePreset>;
      });
      p.catch(() => this.splinePresets.delete(name));
      this.splinePresets.set(name, p);
    }
    return p;
  }

  /** Rebuilds a spline's geometry (draped on the current ground, itself excluded). */
  async populateSpline(rt: RuntimeObject) {
    const sp = rt.spline!;
    const v = ++sp.version;
    const e = rt.doc as SplineObject;
    const t0 = performance.now();
    this.ensureCollision(true);
    const m = transformMatrix(e.transform);
    const toWorld = (p: [number, number, number]): [number, number, number] => {
      const w = vec3.transformMat4(p, m);
      return [w[0], w[1], w[2]];
    };
    // Ground within a window below the curve (2 m above, 12 m below); else the topmost surface.
    const C = this.collision;
    const build = buildSpline(e, sp.preset, toWorld, (x, z, y) => (C.groundHit(x, y + 2, z, 14, e.id) ?? C.groundHit(x, 1e4, z, 2e4, e.id))?.height ?? null);
    const mats = await Promise.all(build.primitives.map((p) => this.renderer.materials.get(p.material)));
    if (sp.version !== v || this.objects.get(e.id) !== rt) return;
    for (const r of rt.renderables) {
      this.removed.add(r);
      this.renderer.instances.free(r.slot);
    }
    if (sp.mesh) this.renderer.arena.free(sp.mesh);
    rt.renderables = [];
    sp.mesh = null;
    const vis = this.scene.effectiveVisible(e.id);
    const shadow = e.castShadow ?? sp.preset.castShadow ?? true;
    if (build.primitives.length) {
      const mesh = this.renderer.arena.upload({ name: e.id, primitives: build.primitives });
      const r = this.makeRenderable(e.id, mesh, mats, mat4.identity(), shadow, 0, fnv1a(e.id));
      r.visible = vis;
      this.applyLightmapTo(e.id, r);
      this.renderer.instances.setProbes(r.slot, this.renderer.probeBits(r.worldMin, r.worldMax));
      rt.renderables.push(r);
      sp.mesh = mesh;
    }
    build.instances.forEach((it, k) => {
      const lods = sp.assets.get(it.asset);
      if (!lods) return;
      const id = `${e.id}#${k}`;
      const r = this.makeRenderable(id, lods[0].mesh, lods[0].materials, it.matrix, shadow, 0, fnv1a(id));
      r.lods = World.lodChain(lods, 1);
      r.visible = vis;
      this.renderer.instances.setProbes(r.slot, this.renderer.probeBits(r.worldMin, r.worldMax));
      rt.renderables.push(r);
    });
    // A lightmapped spline whose chart changed shows its old bake until re-baked.
    const prevRes = sp.build?.lightmapResolution;
    if (prevRes && JSON.stringify(prevRes) !== JSON.stringify(build.lightmapResolution) && this.lightmaps?.doc.objects[e.id]) this.lightingStale = true;
    sp.build = build;
    sp.ms = performance.now() - t0;
    this.compactRenderables();
    this.splineCollisionStale = true;
    this.regroundAt = performance.now() + 500;
  }

  // ------------------------------------------------------------------ queries

  /** Player start: the 'spawn' marker, else the first viewpoint, else the origin. */
  spawn(): { position: [number, number, number]; yaw: number; pitch: number } {
    const markers = this.doc.entities.filter((e): e is MarkerObject => e.type === 'marker');
    const m = markers.find((e) => e.semantic === 'spawn') ?? markers.find((e) => e.semantic === 'viewpoint');
    if (!m) return { position: [0, 2, 0], yaw: 0, pitch: 0 };
    const p = m.transform.position;
    return { position: [p[0], p[1], p[2]], yaw: m.yaw ?? 0, pitch: m.pitch ?? 0 };
  }

  viewpoints(): MarkerObject[] {
    return this.doc.entities.filter((e): e is MarkerObject => e.type === 'marker' && e.semantic === 'viewpoint');
  }

  // ------------------------------------------------------------------ loading

  private mesh(ref: string): Promise<GpuMesh> {
    let p = this.meshes.get(ref);
    if (!p) {
      p = (async () => {
        const data = ref.startsWith('builtin:') ? builtinMesh(ref) : (await loadGlb('/' + ref.replace(/^\//, ''))).mesh;
        for (const prim of data.primitives) prim.material = slotName(prim.material);
        return this.renderer.arena.upload(data);
      })();
      p.catch(() => this.meshes.delete(ref));
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
      p.catch(() => this.models.delete(ref));
      this.models.set(ref, p);
    }
    return p;
  }

  clutter: ClutterSystem | null = null;
  private clutterPending: Promise<void> | null = null;

  /** Builds the ground clutter the first time it is enabled (parked by default). */
  ensureClutter() {
    if (!this.clutter && !this.clutterPending) this.clutterPending = this.buildClutter();
  }

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
    this.ensureCollision();
    const sys = new ClutterSystem();
    // One neutral instance slot per lightmap page (clutter reads the ground's lightmap).
    const inst = this.renderer.instances;
    const pages = this.lightmaps ? this.lightmaps.doc.pages.length : 0;
    const nComp = this.lightmaps ? this.lightmaps.doc.components.length : 1;
    const pageSlot0 = pages > 0 ? inst.allocContiguous(pages) : this.renderer.clutterSlot;
    for (let pg = 0; pg < pages; pg++) {
      inst.set(pageSlot0 + pg, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], [1, 1, 0, 0], pg * nComp, 2, 0, 0);
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

  /** Applies the baked lightmap entry (if any) to a fresh renderable. */
  private applyLightmapTo(id: string, r: Renderable) {
    const lm = this.lightmaps;
    const entry = lm?.doc.objects[id];
    if (lm && entry) this.renderer.instances.setLightmap(r.slot, entry.scaleOffset, entry.page * lm.doc.components.length);
  }

  async addObject(o: Entity) {
    const rt: RuntimeObject = { doc: o, renderables: [] };
    this.objects.set(o.id, rt);
    switch (o.type) {
      case 'mesh':
      case 'instances': {
        this.pendingLoads++;
        let lods: RuntimeObject['lods'] | null = null;
        try {
          lods = await this.lodMaterials(await this.model(o.asset), o.id, o.materialOverrides);
        } catch (e) {
          console.warn(`[world] ${o.id}: ${(e as Error).message}`);
        } finally {
          this.pendingLoads--;
        }
        // Removed or re-created while loading: drop this load.
        if (!lods || this.objects.get(o.id) !== rt) return;
        rt.lods = lods;
        const d = rt.doc; // latest document (transforms may have changed during the load)
        const vis = this.scene.effectiveVisible(d.id);
        if (d.type === 'mesh') {
          const model = transformMatrix(d.transform);
          const r = this.makeRenderable(d.id, lods[0].mesh, lods[0].materials, model, d.castShadow ?? true, meshFlags(d), fnv1a(d.id));
          const sc = d.transform.scale ?? [1, 1, 1];
          r.lods = World.lodChain(lods, Math.max(sc[0], sc[1], sc[2]));
          r.visible = vis;
          rt.renderables.push(r);
          this.setupTurnstile(d, r, model);
          this.applyLightmapTo(d.id, r);
          this.renderer.instances.setProbes(r.slot, this.renderer.probeBits(r.worldMin, r.worldMax));
          if (d.collision ?? d.static ?? true) this.collisionDirty = true;
        } else if (d.type === 'instances') {
          d.instances.forEach((it, i) => {
            const model = yawMatrix(it[0], it[1], it[2], it[3], it[4]);
            const r = this.makeRenderable(`${d.id}#${i}`, lods![0].mesh, lods![0].materials, model, d.castShadow ?? true, 2 | (d.semantic === 'vegetation' ? 8 : 0), fnv1a(`${d.id}#${i}`));
            r.lods = World.lodChain(lods!, it[4]);
            r.visible = vis;
            rt.renderables.push(r);
            this.renderer.instances.setProbes(r.slot, this.renderer.probeBits(r.worldMin, r.worldMax));
          });
        }
        break;
      }
      case 'scatter': {
        this.pendingLoads++;
        try {
          const preset = await this.scatterPreset(o.scatter.preset);
          const species = await Promise.all(preset.species.map(async (sp) => this.lodMaterials(await this.model(sp.asset), sp.asset)));
          if (this.objects.get(o.id) !== rt) return;
          rt.scatter = { preset, species, instances: [], ms: 0, groundRev: -1 };
          if (!this.building) this.populateScatter(rt);
        } catch (e) {
          console.warn(`[world] ${o.id}: ${(e as Error).message}`);
        } finally {
          this.pendingLoads--;
        }
        break;
      }
      case 'spline': {
        this.pendingLoads++;
        try {
          const preset = await this.splinePreset(o.spline.preset);
          const assets = new Map<string, Lods>();
          for (const part of preset.parts) if (part.kind === 'repeat' && part.asset && !assets.has(part.asset)) assets.set(part.asset, await this.lodMaterials(await this.model(part.asset), part.asset));
          if (this.objects.get(o.id) !== rt) return;
          rt.spline = { preset, assets, build: null, mesh: null, version: 0, ms: 0 };
          if (!this.building) await this.populateSpline(rt);
        } catch (e) {
          console.warn(`[world] ${o.id}: ${(e as Error).message}`);
        } finally {
          this.pendingLoads--;
        }
        break;
      }
      default:
        // Lights, decals, signs, reflection probes: derived sets rebuilt by flush().
        this.dirtyKinds.add(o.type);
        break;
    }
  }

  async applyLightmaps(url: string, bust?: string) {
    const lm = await loadLightmapSet(this.renderer.device, url, bust);
    this.lightmaps = lm;
    let applied = 0;
    for (const id of Object.keys(lm.doc.objects)) {
      const rt = this.objects.get(id);
      if (!rt) continue;
      for (const r of rt.renderables) {
        this.applyLightmapTo(id, r);
        applied++;
      }
    }
    this.renderer.setLightmaps(lm.view, lm.layers, lm.directional);
    if (lm.probeVolume) this.renderer.setProbeVolume(lm.probeVolume);
    console.info(`[world] lightmaps: ${applied} objects, ${lm.layers} layers, ${(lm.bytes / 1048576).toFixed(1)} MB`);
  }

  /** Re-reads the lightmap set from disk (after a bake). */
  async reloadLightmaps() {
    if (!this.doc.lightmaps) return;
    await this.applyLightmaps(this.baseUrl + this.doc.lightmaps, String(Date.now()));
    this.lightingStale = false;
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

function lightData(o: LightObject): LightData {
  const l = o.light;
  const q = o.transform.rotation ?? [0, 0, 0, 1];
  const m = mat4.fromQuat(q);
  // Local -Y is the emission axis for spots (lamp heads point down by default).
  const dir: [number, number, number] = [-m[4], -m[5], -m[6]];
  return {
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
    always: l.always,
  };
}

export type { DecalObject, SignObject };
