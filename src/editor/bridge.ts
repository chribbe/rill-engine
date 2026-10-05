import { mat4, vec3 } from 'wgpu-matrix';
import type { Editor } from './editor';
import { writeGlb } from '../engine/assets/glbwrite';
import type { PrimitiveData } from '../engine/render/geometry';
import { blockExtent } from '../engine/scene/blocks';
import { transformMatrix } from '../engine/scene/world';
import type { Entity } from '../engine/scene/mapformat';

/**
 * Client of the Blender bridge (tools/dev/editor_server.ts): starts offline
 * tasks, streams their logs into the editor console and applies the result
 * (bake_lightmaps: reload the lightmap set in place).
 */

export interface JobState {
  id: string;
  task: string;
  status: 'running' | 'done' | 'failed';
  startedAt: number;
  endedAt?: number;
  result?: Record<string, unknown>;
  log: string[];
  logLength: number;
}

export class BlenderBridge {
  job: JobState | null = null;
  /** Bake passes done / total (parsed from the bake log). */
  progress: { done: number; total: number } | null = null;
  private seen = 0;

  constructor(readonly ed: Editor) {}

  async tasks(): Promise<{ name: string; description: string; implemented: boolean }[]> {
    const r = await fetch('/__blender/tasks');
    return r.ok ? r.json() : [];
  }

  async run(task: string, params: Record<string, unknown>): Promise<string> {
    const r = await fetch('/__blender/jobs', { method: 'POST', body: JSON.stringify({ task, params }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? r.statusText);
    this.seen = 0;
    this.progress = null;
    this.job = { id: j.id, task, status: 'running', startedAt: Date.now(), log: [], logLength: 0 };
    this.ed.log('job', `[${task}] started (${j.id})`);
    this.ed.emit('status');
    void this.poll(j.id);
    return j.id;
  }

  private async poll(id: string) {
    while (this.job?.id === id) {
      await new Promise((r) => setTimeout(r, 1000));
      let j: JobState;
      try {
        const r = await fetch(`/__blender/jobs/${id}?from=${this.seen}`);
        if (r.status === 404) {
          this.ed.log('warn', `[${this.job.task}] the dev server lost track of job ${id} (restarted?); the process may still be running`);
          this.job = { ...this.job, status: 'failed' };
          this.ed.emit('status');
          return;
        }
        if (!r.ok) continue;
        j = await r.json();
      } catch {
        continue;
      }
      for (const line of j.log) {
        if (!line.trim()) continue;
        this.ed.log('job', line);
        // Progress: 7 bake passes per atlas page ("[bake] atlas: 2 page(s)", "[bake] page 0 sky: 28.6s").
        const pages = line.match(/\[bake\] atlas: (\d+) page/);
        if (pages) this.progress = { done: 0, total: +pages[1] * 7 };
        if (/\[bake\] page \d+ \w+: [\d.]+s/.test(line) && this.progress) this.progress.done++;
      }
      this.seen = j.logLength;
      this.job = { ...j, log: [] };
      this.ed.emit('status');
      if (j.status !== 'running') {
        await this.finish(j);
        return;
      }
    }
  }

  private async finish(j: JobState) {
    if (j.status === 'failed') {
      this.ed.log('error', `[${j.task}] failed - see the log above`);
      return;
    }
    if (j.result?.reload === 'lightmaps') {
      // A map saved from another one used that map's lightmaps; its own bake lives in lightmaps/.
      const own = 'lightmaps/lightmapset.json';
      if (this.ed.scene.doc.lightmaps !== own) {
        this.ed.exec('set_map_settings', { lightmaps: own });
        await this.ed.save();
      }
      await this.ed.rt.world.reloadLightmaps();
      this.ed.log('info', `[${j.task}] lightmaps reloaded`);
    }
    this.ed.emit('status');
  }

  async cancel() {
    if (this.job?.status === 'running') await fetch(`/__blender/jobs/${this.job.id}`, { method: 'DELETE' });
  }

  /**
   * Generated geometry the bake needs besides map.json: spline and block meshes (world
   * space, with their lightmap charts), the instances of scatters and spline repeats
   * (occluders) and the entities prefab instances expand into (baked like map entities,
   * keyed '<instance>/<child>').
   */
  async exportBakeExtras(): Promise<string | null> {
    const w = this.ed.rt.world;
    await w.settle();
    const meshes: { id: string; glb: string; resolution: [number, number] | null }[] = [];
    const instances: { asset: string; matrix: number[] }[] = [];
    const entities: Entity[] = [];
    for (const [id, rt] of w.objects) {
      if (!w.isVisible(id)) continue;
      const bl = rt.block?.build;
      if (bl && rt.doc.type === 'block') {
        const M = transformMatrix(blockExtent(rt.doc).transform);
        const N = mat4.transpose(mat4.inverse(M));
        const prims: PrimitiveData[] = bl.primitives.map((p) => {
          const pos = new Float32Array(p.positions.length), nrm = new Float32Array(p.normals!.length);
          for (let i = 0; i < pos.length; i += 3) {
            const q = vec3.transformMat4([p.positions[i], p.positions[i + 1], p.positions[i + 2]], M);
            const n = vec3.normalize(vec3.transformMat4Upper3x3([p.normals![i], p.normals![i + 1], p.normals![i + 2]], N));
            pos.set(q, i);
            nrm.set(n, i);
          }
          return { ...p, positions: pos, normals: nrm };
        });
        // Dynamic (non-static) blocks still shadow the bake, without a chart of their own.
        meshes.push({ id, glb: toBase64(writeGlb({ name: id, primitives: prims })), resolution: (rt.doc.static ?? true) ? bl.lightmapResolution : null });
      }
      if (rt.owner && (rt.doc.type === 'mesh' || rt.doc.type === 'instances')) entities.push(rt.doc);
      const b = rt.spline?.build;
      if (b) {
        if (b.primitives.length) meshes.push({ id, glb: toBase64(writeGlb({ name: id, primitives: b.primitives })), resolution: b.lightmapResolution });
        for (const it of b.instances) instances.push({ asset: it.asset, matrix: Array.from(it.matrix) });
      }
      if (rt.scatter) {
        rt.scatter.instances.forEach((it, i) => {
          const r = rt.renderables[i];
          if (r) instances.push({ asset: rt.scatter!.preset.species[it.species].asset, matrix: Array.from(this.ed.rt.renderer.instances.model(r.slot)) });
        });
      }
    }
    // Sculpted terrain chunks replace their original assets in the bake.
    for (const t of w.deformedTerrain()) {
      if (!this.ed.scene.effectiveVisible(t.id)) continue;
      meshes.push({ id: t.id, glb: toBase64(writeGlb({ name: t.id, primitives: t.primitives })), resolution: t.resolution });
    }
    if (!meshes.length && !instances.length && !entities.length) return null;
    const r = await fetch(`/__editor/bake-extra?map=${encodeURIComponent(this.ed.mapName)}`, { method: 'POST', body: JSON.stringify({ meshes, instances, entities }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? r.statusText);
    this.ed.log('info', `Bake scene: ${j.meshes} generated meshes, ${j.instances} instances, ${j.entities ?? 0} prefab entities exported`);
    return j.extra as string;
  }

  /** Bake lighting: saves the map first (the bake reads the saved document), exports generated geometry, then runs Cycles. */
  async bakeLighting(opts: { samples?: number; size?: number; denoise?: boolean } = {}) {
    if (this.job?.status === 'running') throw new Error('a job is already running');
    if (this.ed.history.dirty) {
      this.ed.log('info', 'Saving the map before baking…');
      if (!(await this.ed.save())) throw new Error('save failed');
    }
    const extra = await this.exportBakeExtras();
    return this.run('bake_lightmaps', { map: this.ed.mapName, ...opts, ...(extra ? { extra } : {}) });
  }
}

function toBase64(buf: ArrayBuffer): string {
  const u8 = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
