import type { Editor } from './editor';

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
      for (const line of j.log) if (line.trim()) this.ed.log('job', line);
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

  /** Bake lighting: saves the map first (the bake reads the saved document), then runs Cycles. */
  async bakeLighting(opts: { samples?: number; size?: number; denoise?: boolean } = {}) {
    if (this.job?.status === 'running') throw new Error('a job is already running');
    if (this.ed.history.dirty) {
      this.ed.log('info', 'Saving the map before baking…');
      if (!(await this.ed.save())) throw new Error('save failed');
    }
    return this.run('bake_lightmaps', { map: this.ed.mapName, ...opts });
  }
}
