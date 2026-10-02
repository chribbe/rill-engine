// Dev-server side of the editor (vite plugin, dev only, bound to 127.0.0.1):
//
//   GET  /__editor/maps                 maps with a map.json
//   POST /__editor/save?map=<name>      writes public/maps/<name>/map.json (canonical formatting);
//                                       the previous version goes to backups/maps/<name>/ first
//   POST /__editor/save-as?map=<new>&from=<map>   new map from a document (lightmaps referenced from <map>)
//   GET  /__editor/backups?map=<name>   saved versions, newest first
//   GET  /__editor/backup?map=<name>&file=<f>     one saved version
//   GET  /__editor/materials            material library summary (public/materials/*.json)
//   GET  /__editor/asset-files          asset files on disk (for the registry / browser)
//   POST /__editor/registry             writes public/assets/registry.json
//   POST /__blender/jobs                { task, params } -> { id }   (Blender bridge)
//   GET  /__blender/jobs/<id>?from=<n>  { status, log (lines from n), result }
//   GET  /__blender/tasks               task catalogue (implemented or not)
//
// The Blender bridge runs offline tasks as child processes (tools/blender/run.ts) and
// reports logs and results; the editor reloads whatever a task produced. Only
// bake_lightmaps is implemented; the other tasks are declared so the protocol is fixed.
import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { formatMapJson } from '../../src/engine/scene/mapjson.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const PUBLIC = join(ROOT, 'public');

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rej);
  });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

const NAME = /^[\w-]+$/;
const BACKUPS = join(ROOT, 'backups', 'maps');
const KEEP_BACKUPS = 50;

function stamp() {
  const d = new Date(), p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** Copies the current map.json aside before it is overwritten; keeps the newest KEEP_BACKUPS (named snapshots are kept). */
function backupMap(map: string) {
  const src = join(PUBLIC, 'maps', map, 'map.json');
  if (!existsSync(src)) return null;
  const dir = join(BACKUPS, map);
  mkdirSync(dir, { recursive: true });
  const file = `${stamp()}.json`;
  copyFileSync(src, join(dir, file));
  const auto = readdirSync(dir).filter((f) => /^\d{8}-\d{6}(-\d{3})?\.json$/.test(f)).sort();
  for (const f of auto.slice(0, Math.max(0, auto.length - KEEP_BACKUPS))) unlinkSync(join(dir, f));
  return file;
}

/** Atomic write: a crash mid-write never leaves a truncated map. */
function writeAtomic(path: string, text: string) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// ------------------------------------------------------------------ Blender bridge

interface TaskDef {
  description: string;
  implemented: boolean;
  /** Command line for the task. */
  command?: (p: Record<string, unknown>) => { cmd: string; args: string[] };
  /** What the editor should reload when the task succeeds. */
  result?: (p: Record<string, unknown>) => Record<string, unknown>;
}

const TASKS: Record<string, TaskDef> = {
  bake_lightmaps: {
    description: 'Bake lightmaps + probe volume for a saved map with Blender/Cycles (params: map, samples?, size?, denoise?).',
    implemented: true,
    command: (p) => ({
      cmd: process.execPath,
      args: ['tools/blender/run.ts', 'bake', '--map', String(p.map), ...(p.samples ? ['--samples', String(p.samples)] : []), ...(p.size ? ['--size', String(p.size)] : []), ...(p.denoise === false ? ['--no-denoise'] : [])],
    }),
    result: (p) => ({ reload: 'lightmaps', lightmaps: `maps/${p.map}/lightmaps/lightmapset.json` }),
  },
  create_asset: { description: 'Create a new asset (mesh + materials) from a description or script.', implemented: false },
  modify_asset: { description: 'Modify an existing asset (geometry edits, re-export).', implemented: false },
  generate_uvs: { description: 'Generate UV0 (world-metre texture coordinates) for an asset.', implemented: false },
  generate_lightmap_uvs: { description: 'Generate lightmap UVs (UV1 charts) for an asset.', implemented: false },
  generate_lods: { description: 'Generate LOD meshes (+ model descriptor) for an asset.', implemented: false },
};

interface Job {
  id: string;
  task: string;
  params: Record<string, unknown>;
  status: 'running' | 'done' | 'failed';
  log: string[];
  startedAt: number;
  endedAt?: number;
  result?: Record<string, unknown>;
  proc?: ChildProcess;
}
// On globalThis: vite re-instantiates plugins when the config (or this file) changes, and
// running jobs must stay reachable across that.
const G = globalThis as unknown as { __rillJobs?: Map<string, Job>; __rillJobSeq?: number };
const jobs = (G.__rillJobs ??= new Map<string, Job>());

function startJob(task: string, params: Record<string, unknown>): Job {
  const def = TASKS[task];
  if (!def) throw Object.assign(new Error(`unknown task '${task}'`), { status: 400 });
  if (!def.implemented || !def.command) throw Object.assign(new Error(`task '${task}' is not implemented yet`), { status: 501 });
  if (params.map !== undefined && !NAME.test(String(params.map))) throw Object.assign(new Error('bad map name'), { status: 400 });
  for (const j of jobs.values()) if (j.status === 'running' && j.task === task) throw Object.assign(new Error(`a ${task} job is already running (${j.id})`), { status: 409 });
  const { cmd, args } = def.command(params);
  const job: Job = { id: `job_${(G.__rillJobSeq = (G.__rillJobSeq ?? 0) + 1)}_${Date.now().toString(36)}`, task, params, status: 'running', log: [`$ ${relative(ROOT, cmd) || cmd} ${args.join(' ')}`], startedAt: Date.now() };
  // Unbuffered Python so Blender's progress lines stream as they happen.
  const proc = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, PYTHONUNBUFFERED: '1' } });
  job.proc = proc;
  let partial = '';
  const onData = (b: Buffer) => {
    const text = partial + b.toString('utf8');
    const lines = text.split(/\r?\n/);
    partial = lines.pop() ?? '';
    job.log.push(...lines);
    if (job.log.length > 20000) job.log.splice(1, job.log.length - 20000);
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('close', (code) => {
    if (partial) job.log.push(partial);
    job.endedAt = Date.now();
    job.status = code === 0 ? 'done' : 'failed';
    job.log.push(`[bridge] ${task} ${job.status} (exit ${code}) after ${((job.endedAt - job.startedAt) / 1000).toFixed(1)} s`);
    if (code === 0) job.result = def.result?.(params);
    job.proc = undefined;
  });
  jobs.set(job.id, job);
  return job;
}

// ------------------------------------------------------------------ plugin

export function editorServer(): Plugin {
  return {
    name: 'rill-editor-server',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '', 'http://x');
        const path = url.pathname;
        if (!path.startsWith('/__editor/') && !path.startsWith('/__blender/')) return next();
        try {
          if (path === '/__editor/maps' && req.method === 'GET') {
            const dir = join(PUBLIC, 'maps');
            const maps = readdirSync(dir).filter((n) => existsSync(join(dir, n, 'map.json'))).map((n) => {
              const d = JSON.parse(readFileSync(join(dir, n, 'map.json'), 'utf8'));
              return { name: n, version: d.version, entities: (d.entities ?? d.objects ?? []).length, description: d.description };
            });
            return json(res, 200, maps);
          }
          if (path === '/__editor/save' && req.method === 'POST') {
            const map = url.searchParams.get('map') ?? '';
            if (!NAME.test(map)) return json(res, 400, { error: 'bad map name' });
            const doc = JSON.parse(await readBody(req));
            if (doc?.format !== 'rill.map' || doc.version !== 2 || !Array.isArray(doc.entities)) return json(res, 400, { error: 'not a rill.map v2 document' });
            const ids = new Set<string>();
            for (const e of doc.entities) {
              if (!e?.id || ids.has(e.id)) return json(res, 400, { error: `missing or duplicate entity id '${e?.id}'` });
              ids.add(e.id);
            }
            const file = join(PUBLIC, 'maps', map, 'map.json');
            if (!existsSync(join(PUBLIC, 'maps', map))) return json(res, 404, { error: `no map '${map}'` });
            const text = formatMapJson(doc);
            const backup = existsSync(file) && readFileSync(file, 'utf8') !== text ? backupMap(map) : null;
            writeAtomic(file, text);
            return json(res, 200, { file: relative(ROOT, file), bytes: text.length, entities: doc.entities.length, backup: backup && relative(ROOT, join(BACKUPS, map, backup)) });
          }
          if (path === '/__editor/save-as' && req.method === 'POST') {
            const map = url.searchParams.get('map') ?? '', from = url.searchParams.get('from') ?? '';
            if (!NAME.test(map) || !NAME.test(from)) return json(res, 400, { error: 'bad map name' });
            const dir = join(PUBLIC, 'maps', map);
            if (existsSync(join(dir, 'map.json'))) return json(res, 409, { error: `map '${map}' already exists` });
            const doc = JSON.parse(await readBody(req));
            if (doc?.format !== 'rill.map' || doc.version !== 2) return json(res, 400, { error: 'not a rill.map v2 document' });
            doc.name = map;
            // Until the copy is baked, it uses the source map's lightmaps (same entity IDs).
            if (doc.lightmaps && !doc.lightmaps.startsWith('../')) doc.lightmaps = `../${from}/${doc.lightmaps}`;
            mkdirSync(dir, { recursive: true });
            writeAtomic(join(dir, 'map.json'), formatMapJson(doc));
            return json(res, 200, { map, file: relative(ROOT, join(dir, 'map.json')) });
          }
          if (path === '/__editor/backups' && req.method === 'GET') {
            const map = url.searchParams.get('map') ?? '';
            if (!NAME.test(map)) return json(res, 400, { error: 'bad map name' });
            const dir = join(BACKUPS, map);
            const list = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({ file: f, bytes: statSync(join(dir, f)).size, time: statSync(join(dir, f)).mtimeMs })) : [];
            list.sort((a, b) => b.time - a.time);
            return json(res, 200, list);
          }
          if (path === '/__editor/backup' && req.method === 'GET') {
            const map = url.searchParams.get('map') ?? '', f = url.searchParams.get('file') ?? '';
            if (!NAME.test(map) || !/^[\w.-]+\.json$/.test(f)) return json(res, 400, { error: 'bad name' });
            const file = join(BACKUPS, map, f);
            if (!existsSync(file)) return json(res, 404, { error: 'no such backup' });
            res.setHeader('content-type', 'application/json');
            res.setHeader('cache-control', 'no-store');
            return res.end(readFileSync(file));
          }
          if (path === '/__editor/materials' && req.method === 'GET') {
            const dir = join(PUBLIC, 'materials');
            const list = readdirSync(dir).filter((n) => n.endsWith('.json')).sort().map((n) => {
              const d = JSON.parse(readFileSync(join(dir, n), 'utf8'));
              return {
                name: n.replace(/\.json$/, ''), inherits: d.inherits, shader: d.shader, alphaMode: d.alphaMode, semantic: d.semantic,
                baseColor: d.baseColor, baseColorFactor: d.baseColorFactor, decal: typeof d.texture === 'string', notes: d.notes,
              };
            });
            return json(res, 200, list);
          }
          if (path === '/__editor/asset-files' && req.method === 'GET') {
            const dir = join(PUBLIC, 'assets');
            const files = walk(dir).filter((f) => /\.(glb|model\.json)$/.test(f)).map((f) => ({ path: relative(PUBLIC, f), bytes: statSync(f).size }));
            return json(res, 200, files);
          }
          if (path === '/__editor/registry' && req.method === 'POST') {
            const doc = JSON.parse(await readBody(req));
            if (doc?.format !== 'rill.assets' || !Array.isArray(doc.assets)) return json(res, 400, { error: 'not a rill.assets document' });
            writeAtomic(join(PUBLIC, 'assets', 'registry.json'), formatMapJson(doc));
            return json(res, 200, { assets: doc.assets.length });
          }
          if (path === '/__blender/tasks' && req.method === 'GET') {
            return json(res, 200, Object.entries(TASKS).map(([name, t]) => ({ name, description: t.description, implemented: t.implemented })));
          }
          if (path === '/__blender/jobs' && req.method === 'POST') {
            const { task, params } = JSON.parse(await readBody(req));
            const job = startJob(String(task), params ?? {});
            return json(res, 200, { id: job.id });
          }
          const m = path.match(/^\/__blender\/jobs\/([\w-]+)$/);
          if (m && req.method === 'GET') {
            const job = jobs.get(m[1]);
            if (!job) return json(res, 404, { error: 'no such job' });
            const from = Math.max(0, parseInt(url.searchParams.get('from') ?? '0', 10) || 0);
            return json(res, 200, { id: job.id, task: job.task, status: job.status, startedAt: job.startedAt, endedAt: job.endedAt, result: job.result, logFrom: from, log: job.log.slice(from), logLength: job.log.length });
          }
          if (m && req.method === 'DELETE') {
            const job = jobs.get(m[1]);
            job?.proc?.kill('SIGTERM');
            return json(res, 200, { cancelled: !!job?.proc });
          }
          return json(res, 404, { error: 'unknown editor endpoint' });
        } catch (e) {
          const err = e as Error & { status?: number };
          return json(res, err.status ?? 500, { error: err.message });
        }
      });
    },
  };
}
