// Map format v1 -> v2 (the web scene becomes the authoritative map):
//   node tools/scene/migrate.ts <map> [--in path/to/v1.json] [--dry]
//
// 1. Standalone unique assets exported in world space (buildings, walls, stairs...) are re-centred:
//    their GLB vertex positions are shifted so the asset origin is the bottom centre of its bounds,
//    and the entity transform carries the offset. UVs (and so the existing lightmap bake) are
//    untouched. Tiled world surfaces (terrain, roads, streets) stay world-anchored: their chunks
//    share seam vertices bit-exactly, which a per-chunk offset would break.
// 2. Compact `instances` groups (scattered trees, rocks, lamps, cars) become one mesh entity per
//    instance under a group with the old ID, so each one can be selected and edited.
// 3. Outliner hierarchy: category groups; lamp lights become children of their posts; signs,
//    decals and lights attached to a building become its children (moving it carries them).
// 4. The document-level spawn becomes a 'player_start' marker; turnstile data moves to local space.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { formatMapJson } from '../../src/engine/scene/mapjson.ts';

type V3 = [number, number, number];
type Q = [number, number, number, number];
// Loose JSON shapes: the migration reads v1 documents whatever their exact fields.
type Obj = Record<string, any>;

const ROOT = join(import.meta.dirname, '..', '..');
const PUBLIC = join(ROOT, 'public');
const args = process.argv.slice(2);
const mapName = args.find((a) => !a.startsWith('--'));
if (!mapName) {
  console.error('usage: node tools/scene/migrate.ts <map> [--in v1.json] [--dry]');
  process.exit(1);
}
const dry = args.includes('--dry');
const inIdx = args.indexOf('--in');
const mapPath = join(PUBLIC, 'maps', mapName, 'map.json');
const src = JSON.parse(readFileSync(inIdx >= 0 ? args[inIdx + 1] : mapPath, 'utf8')) as Obj;
if (src.version !== 1) {
  console.error(`${mapName}: already version ${src.version}`);
  process.exit(1);
}

/** Semantics whose unique, world-space assets get a real pivot. */
const RECENTRE = new Set(['building', 'wall', 'stairs', 'railing', 'underpass', 'prop', 'artwork', 'reference']);

// ------------------------------------------------------------------ GLB access
interface Glb { json: Obj; bin: Buffer; path: string }
const glbs = new Map<string, Glb>();
function glb(asset: string): Glb | null {
  if (!asset.endsWith('.glb')) return null;
  let g = glbs.get(asset);
  if (!g) {
    const path = join(PUBLIC, asset);
    if (!existsSync(path)) return null;
    const buf = readFileSync(path);
    let off = 12, json: Obj | null = null, bin: Buffer | null = null;
    while (off < buf.length) {
      const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
      const data = buf.subarray(off + 8, off + 8 + len);
      if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
      else if (type === 0x004e4942) bin = Buffer.from(data);
      off += 8 + len;
    }
    g = { json: json!, bin: bin!, path };
    glbs.set(asset, g);
  }
  return g;
}

function nodesIdentity(g: Glb) {
  return (g.json.nodes ?? []).every((n: Obj) => !n.matrix && !n.translation && !n.rotation && !n.scale);
}

function positionAccessors(g: Glb): number[] {
  const s = new Set<number>();
  for (const m of g.json.meshes ?? []) for (const p of m.primitives) if (p.attributes.POSITION !== undefined) s.add(p.attributes.POSITION);
  return [...s];
}

function forEachPosition(g: Glb, acc: number, fn: (o: number) => void) {
  const a = g.json.accessors[acc];
  const bv = g.json.bufferViews[a.bufferView];
  const stride = bv.byteStride ?? 12;
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  for (let i = 0; i < a.count; i++) fn(base + i * stride);
}

function bounds(g: Glb): { min: V3; max: V3 } {
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const acc of positionAccessors(g)) {
    forEachPosition(g, acc, (o) => {
      for (let k = 0; k < 3; k++) {
        const v = g.bin.readFloatLE(o + k * 4);
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    });
  }
  return { min, max };
}

function recentre(g: Glb, pivot: V3) {
  for (const acc of positionAccessors(g)) {
    const a = g.json.accessors[acc];
    const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
    forEachPosition(g, acc, (o) => {
      for (let k = 0; k < 3; k++) {
        const v = Math.fround(g.bin.readFloatLE(o + k * 4) - pivot[k]);
        g.bin.writeFloatLE(v, o + k * 4);
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    });
    a.min = min;
    a.max = max;
  }
}

function writeGlb(g: Glb) {
  let json = Buffer.from(JSON.stringify(g.json), 'utf8');
  if (json.length % 4) json = Buffer.concat([json, Buffer.alloc(4 - (json.length % 4), 0x20)]);
  const header = Buffer.alloc(12), jh = Buffer.alloc(8), bh = Buffer.alloc(8);
  const total = 12 + 8 + json.length + 8 + g.bin.length;
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8);
  jh.writeUInt32LE(json.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  bh.writeUInt32LE(g.bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  writeFileSync(g.path, Buffer.concat([header, jh, json, bh, g.bin]));
}

// ------------------------------------------------------------------ maths
const r2 = (v: number) => Math.round(v * 100) / 100;
const isIdentity = (t: Obj) => (!t.position || t.position.every((v: number) => v === 0)) && (!t.rotation || (t.rotation[0] === 0 && t.rotation[1] === 0 && t.rotation[2] === 0)) && (!t.scale || t.scale.every((v: number) => v === 1));
function yawQuat(yawDeg: number): Q {
  // Matches the v1 runtime: rotateY(-yaw).
  const a = (-yawDeg * Math.PI) / 360;
  return [0, +Math.sin(a).toFixed(6), 0, +Math.cos(a).toFixed(6)];
}
function qrot(q: number[], v: number[]): V3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
const qconj = (q: number[]) => [-q[0], -q[1], -q[2], q[3]];
const round = (v: number[], k = 1e4) => v.map((x) => Math.round(x * k) / k) as V3;

// ------------------------------------------------------------------ 1. entities
const use = new Map<string, number>();
for (const o of src.objects) if (o.asset) use.set(o.asset, (use.get(o.asset) ?? 0) + 1);

const out: Obj[] = [];
const recentredAssets = new Set<string>();
const report = { recentred: [] as string[], exploded: 0, groups: 0, parented: 0, turnstiles: 0 };
/** World AABB per entity id (for attachment heuristics). */
const worldBox = new Map<string, { min: V3; max: V3 }>();

for (const o of src.objects as Obj[]) {
  if (o.type === 'instances') {
    const kids = o.instances.map((it: number[], i: number) => {
      // Defaults (static, castShadow) are left out: thousands of these.
      const e: Obj = {
        id: `${o.id}_${String(i).padStart(3, '0')}`,
        type: 'mesh',
        semantic: o.semantic,
        parent: o.id,
        asset: o.asset,
        transform: { position: [it[0], it[1], it[2]], rotation: yawQuat(it[3]), ...(it[4] !== 1 ? { scale: [it[4], it[4], it[4]] } : {}) },
        ...(o.castShadow === false ? { castShadow: false } : {}),
        // Instances never collided or took decals in v1.
        collision: o.collision ?? false,
        receiveDecals: false,
        ...(o.materialOverrides ? { materialOverrides: o.materialOverrides } : {}),
        ...(o.tags ? { tags: o.tags } : {}),
      };
      return e;
    });
    out.push({ id: o.id, name: o.name ?? o.id, type: 'group', semantic: o.semantic }, ...kids);
    report.exploded += kids.length;
    report.groups++;
    continue;
  }
  const e: Obj = structuredClone(o);
  if (e.type === 'mesh') {
    const g = e.asset.startsWith('builtin:') ? null : glb(e.asset);
    if (g && isIdentity(e.transform) && use.get(e.asset) === 1 && RECENTRE.has(e.semantic) && nodesIdentity(g)) {
      const b = bounds(g);
      const pivot: V3 = [r2((b.min[0] + b.max[0]) / 2), r2(b.min[1]), r2((b.min[2] + b.max[2]) / 2)];
      recentre(g, pivot);
      recentredAssets.add(e.asset);
      e.transform = { position: pivot };
      report.recentred.push(`${e.id} @ ${pivot.join(', ')}`);
      worldBox.set(e.id, b);
    } else if (g && isIdentity(e.transform)) {
      worldBox.set(e.id, bounds(g));
    }
    if (e.turnstile) {
      // World -> entity-local (rotation + translation only).
      const t = e.transform, q = t.rotation ?? [0, 0, 0, 1], iq = qconj(q), p = t.position;
      const toLocal = (w: number[]) => round(qrot(iq, [w[0] - p[0], w[1] - p[1], w[2] - p[2]]));
      const dir = (w: number[]) => round(qrot(iq, w));
      e.turnstile = { pivot: toLocal(e.turnstile.pivot), axis: dir(e.turnstile.axis), lane: toLocal(e.turnstile.lane), dir: dir(e.turnstile.dir) };
      report.turnstiles++;
    }
  }
  out.push(e);
}

if (src.spawn) {
  out.push({ id: 'player_start', name: 'Player start', type: 'marker', semantic: 'spawn', transform: { position: src.spawn.position }, yaw: src.spawn.yaw, pitch: src.spawn.pitch });
}

// ------------------------------------------------------------------ 2. attachments
const byId = new Map(out.map((e) => [e.id, e]));
const posts = out.filter((e) => e.type === 'mesh' && e.semantic === 'streetlight');
for (const e of out) {
  if (e.type !== 'light' || e.parent) continue;
  const p = e.transform.position;
  // Lamp head of a post: named <post>_lamp, else the nearest post within 3 m horizontally, below the lamp.
  let best: Obj | null = byId.get(e.id.replace(/_lamp$/, '')) ?? null;
  if (!best || best === e || best.semantic !== 'streetlight') {
    best = null;
    let bd = 3;
    for (const s of posts) {
      const q = s.transform.position;
      const d = Math.hypot(p[0] - q[0], p[2] - q[2]);
      if (d < bd && p[1] > q[1]) { bd = d; best = s; }
    }
  }
  if (best) { e.parent = best.id; report.parented++; }
}
// Facade signs, grime decals and interior lights belong to the building they sit on.
const buildings = out.filter((e) => e.type === 'mesh' && e.semantic === 'building' && worldBox.has(e.id));
for (const e of out) {
  if (e.parent || !['sign', 'decal', 'light'].includes(e.type)) continue;
  const p = e.transform.position;
  for (const b of buildings) {
    const { min, max } = worldBox.get(b.id)!;
    const m = 0.6;
    if (p[0] > min[0] - m && p[0] < max[0] + m && p[1] > min[1] + 0.3 && p[1] < max[1] + m && p[2] > min[2] - m && p[2] < max[2] + m) {
      e.parent = b.id;
      report.parented++;
      break;
    }
  }
}

// ------------------------------------------------------------------ 3. category groups
const CATEGORIES: [string, string, (e: Obj) => boolean][] = [
  ['grp_spawn', 'Player start & viewpoints', (e) => e.type === 'marker'],
  ['grp_terrain', 'Terrain', (e) => e.semantic === 'terrain'],
  ['grp_streets', 'Streets, paths & ground', (e) => ['road', 'path', 'plaza', 'parking', 'ground'].includes(e.semantic)],
  ['grp_distant', 'Distant scenery', (e) => /^(far_|landscape_far)/.test(e.id) || e.semantic === 'water'],
  ['grp_architecture', 'Architecture', (e) => ['building', 'wall', 'stairs', 'railing', 'underpass', 'structure', 'turnstile'].includes(e.semantic) || (e.type === 'mesh' && e.semantic === 'prop' && !e.parent)],
  ['grp_signs', 'Signs', (e) => e.type === 'sign'],
  ['grp_lighting', 'Street & area lighting', (e) => e.semantic === 'streetlight' || e.type === 'light'],
  ['grp_furniture', 'Street furniture & props', (e) => ['bench', 'bollard', 'utility', 'fence', 'prop', 'artwork'].includes(e.semantic)],
  ['grp_vehicles', 'Vehicles', (e) => e.semantic === 'vehicle'],
  ['grp_vegetation', 'Vegetation & rocks', (e) => ['vegetation', 'rock'].includes(e.semantic) && !/^far_/.test(e.id)],
  ['grp_decals', 'Decals', (e) => e.type === 'decal'],
  ['grp_probes', 'Lighting probes', (e) => e.type === 'probeVolume' || e.type === 'reflectionProbe'],
  ['grp_reference', 'Reference & material gallery', (e) => ['gallery', 'reference'].includes(e.semantic)],
];
const OTHER: [string, string] = ['grp_other', 'Other'];
const LOCKED_GROUPS = new Set(['grp_terrain', 'grp_streets', 'grp_distant']);
const buckets = new Map<string, Obj[]>();
for (const e of out) {
  if (e.parent) continue;
  const cat = CATEGORIES.find((c) => c[2](e));
  const gid = cat ? cat[0] : OTHER[0];
  if (!buckets.has(gid)) buckets.set(gid, []);
  buckets.get(gid)!.push(e);
}
// Children follow their parent; top-level entities in category order.
const children = new Map<string, Obj[]>();
for (const e of out) if (e.parent) (children.get(e.parent) ?? children.set(e.parent, []).get(e.parent)!).push(e);
const ordered: Obj[] = [];
const emit = (e: Obj) => {
  ordered.push(e);
  for (const c of children.get(e.id) ?? []) emit(c);
};
for (const [gid, name] of [...CATEGORIES.map((c) => [c[0], c[1]] as [string, string]), OTHER]) {
  const list = buckets.get(gid);
  if (!list?.length) continue;
  // World surfaces are locked: clicking the ground deselects instead of grabbing a terrain chunk.
  ordered.push({ id: gid, name, type: 'group', ...(LOCKED_GROUPS.has(gid) ? { locked: true } : {}) });
  report.groups++;
  for (const e of list) {
    e.parent = gid;
    emit(e);
  }
}
// Sanity: every entity emitted exactly once, IDs unique.
const seen = new Set(ordered.map((e) => e.id));
if (seen.size !== ordered.length) throw new Error('duplicate entity IDs after migration');
const missing = out.filter((e) => !seen.has(e.id)).map((e) => e.id);
if (missing.length) throw new Error(`entities lost in ordering: ${missing.slice(0, 5).join(', ')}`);

// Field order: identity first, then placement, then type data.
const KEY_ORDER = ['id', 'name', 'type', 'semantic', 'tags', 'parent', 'asset', 'transform'];
const sorted = ordered.map((e) => {
  const o: Obj = {};
  for (const k of KEY_ORDER) if (e[k] !== undefined) o[k] = e[k];
  for (const k of Object.keys(e)) if (!(k in o)) o[k] = e[k];
  return o;
});

const doc = {
  format: 'rill.map',
  version: 2,
  name: src.name,
  ...(src.description ? { description: src.description } : {}),
  environment: src.environment,
  ...(src.lightmaps ? { lightmaps: src.lightmaps } : {}),
  nextId: 1,
  entities: sorted,
};

console.log(`[migrate] ${mapName}: ${src.objects.length} v1 objects -> ${sorted.length} entities`);
console.log(`[migrate]   re-centred ${report.recentred.length} assets, exploded ${report.exploded} instances, ${report.groups} groups, ${report.parented} attachments, ${report.turnstiles} turnstiles`);
for (const r of report.recentred) console.log(`[migrate]     ${r}`);
if (dry) process.exit(0);
for (const a of recentredAssets) writeGlb(glbs.get(a)!);
writeFileSync(mapPath, formatMapJson(doc));
console.log(`[migrate] wrote ${mapPath} (${recentredAssets.size} GLBs rewritten)`);
