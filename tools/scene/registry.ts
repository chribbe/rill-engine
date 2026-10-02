// Builds / refreshes the asset registry (public/assets/registry.json):
//   node tools/scene/registry.ts
// Scans public/assets for meshes (.glb, not LOD files) and model descriptors, keeps
// existing entries (hand edits survive), and adds new ones with a category, display
// name, entity defaults and prefab children derived from how the maps already use them
// (e.g. a streetlight's lamp light, in asset-local space).
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { mat4, quat } from 'wgpu-matrix';
import { formatMapJson } from '../../src/engine/scene/mapjson.ts';

type Obj = Record<string, any>;
const ROOT = join(import.meta.dirname, '..', '..');
const PUBLIC = join(ROOT, 'public');
const OUT = join(PUBLIC, 'assets', 'registry.json');

const CATEGORIES = ['buildings', 'structural', 'props', 'vegetation', 'roads', 'lighting', 'vehicles', 'terrain', 'environment', 'reference'];

function walk(dir: string, out: string[] = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function glbBounds(path: string): { min: number[]; max: number[] } | undefined {
  const buf = readFileSync(path);
  const len = buf.readUInt32LE(12);
  const j = JSON.parse(buf.subarray(20, 20 + len).toString('utf8'));
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const m of j.meshes ?? []) for (const p of m.primitives) {
    const a = j.accessors[p.attributes.POSITION];
    if (!a?.min) continue;
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], a.min[k]); max[k] = Math.max(max[k], a.max[k]); }
  }
  if (!Number.isFinite(min[0])) return undefined;
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return { min: min.map(r), max: max.map(r) };
}

/** Category, semantic, unique flag from the file name (the two content sets use consistent names). */
function classify(stem: string): { category: string; semantic?: string; unique?: boolean; tags?: string[] } {
  const s = stem;
  if (/^terrain_/.test(s)) return { category: 'terrain', semantic: 'terrain', unique: true };
  if (/^(road_|street_|path_(forest|north|south)|plaza|parking)/.test(s)) return { category: 'roads', semantic: /road|street_road/.test(s) ? 'road' : 'path', unique: true };
  if (/^(far_|landscape_far)/.test(s)) return { category: 'environment', semantic: 'scenery', unique: true, tags: ['distant'] };
  if (/^bldg_|^building_/.test(s)) return { category: 'buildings', semantic: 'building', unique: /^bldg_/.test(s), tags: ['architecture'] };
  if (/^(station_|platform|viaduct_|abutment_|track_|retaining_wall|stairs|stair_rails|underpass)/.test(s)) return { category: 'structural', semantic: /rail/.test(s) ? 'railing' : 'structure', unique: true, tags: ['architecture'] };
  if (/^(tree_|shrub_)/.test(s)) return { category: 'vegetation', semantic: 'vegetation', tags: [/pine|spruce/.test(s) ? 'conifer' : 'broadleaf'] };
  if (/^clutter_/.test(s)) return { category: 'vegetation', semantic: 'vegetation', tags: ['ground clutter'] };
  if (/^rock_/.test(s)) return { category: 'environment', semantic: 'rock', tags: ['bedrock'] };
  if (/^(streetlight|lamp_|path_light)/.test(s)) return { category: 'lighting', semantic: 'streetlight' };
  if (/^car_/.test(s)) return { category: 'vehicles', semantic: 'vehicle' };
  if (/^human_reference/.test(s)) return { category: 'reference', semantic: 'reference' };
  if (/^turnstile/.test(s)) return { category: 'props', semantic: 'turnstile' };
  if (/^resenarer/.test(s)) return { category: 'props', semantic: 'artwork', tags: ['sculpture'] };
  if (/^fence/.test(s)) return { category: 'structural', semantic: 'fence' };
  return { category: 'props', semantic: 'prop' };
}

function displayName(stem: string) {
  const m = stem.match(/^bldg_(\d+)_(\w+)$/);
  if (m) return `Building ${m[1]} (${m[2]})`;
  const s = stem.replace(/_/g, ' ').replace(/\b([a-z])\b/g, (c) => c.toUpperCase());
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ------------------------------------------------------------------ usage in maps
const usage = new Map<string, { entity: Obj; children: Obj[] }>();
for (const map of readdirSync(join(PUBLIC, 'maps'))) {
  const f = join(PUBLIC, 'maps', map, 'map.json');
  if (!existsSync(f)) continue;
  const doc = JSON.parse(readFileSync(f, 'utf8'));
  const ents: Obj[] = doc.entities ?? [];
  const kids = new Map<string, Obj[]>();
  for (const e of ents) if (e.parent) (kids.get(e.parent) ?? kids.set(e.parent, []).get(e.parent)!).push(e);
  for (const e of ents) {
    if (e.type !== 'mesh' || usage.has(e.asset)) continue;
    usage.set(e.asset, { entity: e, children: (kids.get(e.id) ?? []).filter((c) => c.type === 'light') });
  }
}

function toLocal(parent: Obj, child: Obj): Obj {
  const M = mat4.translation(parent.transform.position);
  if (parent.transform.rotation) mat4.multiply(M, mat4.fromQuat(parent.transform.rotation), M);
  const C = mat4.translation(child.transform.position);
  if (child.transform.rotation) mat4.multiply(C, mat4.fromQuat(child.transform.rotation), C);
  const L = mat4.multiply(mat4.inverse(M), C);
  const q = quat.fromMat(L);
  const r = (v: number, k = 1e4) => Math.round(v * k) / k;
  const t: Obj = { position: [r(L[12]), r(L[13]), r(L[14])] };
  if (Math.abs(q[3]) < 0.999999) t.rotation = [r(q[0], 1e6), r(q[1], 1e6), r(q[2], 1e6), r(q[3], 1e6)];
  return t;
}

// ------------------------------------------------------------------ build
const prev: Obj = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { assets: [] };
const known = new Map<string, Obj>(prev.assets.map((a: Obj) => [a.path, a]));
const files = walk(join(PUBLIC, 'assets')).map((f) => relative(PUBLIC, f)).filter((f) => /\.(glb|model\.json)$/.test(f)).sort();
// LOD meshes belong to a model descriptor; a .glb with a sibling .model.json is listed via the descriptor.
const isLod = (f: string) => /_lod\d+\.glb$/.test(f) || (f.endsWith('.glb') && files.includes(f.replace(/\.glb$/, '.model.json')));
const out: Obj[] = [];
let added = 0;
for (const f of files) {
  if (isLod(f)) continue;
  if (known.has(f)) {
    out.push(known.get(f));
    continue;
  }
  const set = f.split('/')[1];
  const stem = f.split('/').pop()!.replace(/\.(glb|model\.json)$/, '');
  const c = classify(stem);
  const a: Obj = { id: `${set}/${stem}`, name: displayName(stem), category: c.category, path: f };
  if (c.semantic) a.semantic = c.semantic;
  if (c.tags) a.tags = c.tags;
  if (c.unique) a.unique = true;
  const u = usage.get(f);
  if (u) {
    const d: Obj = {};
    for (const k of ['castShadow', 'collision', 'receiveDecals', 'lightmap']) if (u.entity[k] !== undefined) d[k] = u.entity[k];
    if (Object.keys(d).length) a.defaults = d;
    if (u.children.length) a.children = u.children.map((ch) => { const { id: _i, parent: _p, ...rest } = ch; return { ...rest, transform: toLocal(u.entity, ch) }; });
  }
  const glbPath = f.endsWith('.glb') ? join(PUBLIC, f) : (() => {
    const m = JSON.parse(readFileSync(join(PUBLIC, f), 'utf8'));
    const lod0 = [...m.lods].sort((x: Obj, y: Obj) => x.distance - y.distance)[0];
    return join(PUBLIC, f.slice(0, f.lastIndexOf('/') + 1), lod0.mesh);
  })();
  if (existsSync(glbPath)) {
    const b = glbBounds(glbPath);
    if (b) a.bounds = b;
  }
  out.push(a);
  added++;
}
const doc = { format: 'rill.assets', version: 1, categories: CATEGORIES, assets: out };
writeFileSync(OUT, formatMapJson(doc));
console.log(`[registry] ${out.length} assets (${added} new) -> ${relative(ROOT, OUT)}`);
