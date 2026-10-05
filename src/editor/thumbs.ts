import { mat4, vec3, type Mat4 } from 'wgpu-matrix';
import { loadGlb } from '../engine/assets/gltf';
import { builtinMesh } from '../engine/assets/primitives';
import { blockExtent, blockFaces, BLOCK_MATERIAL, type BlockShape } from '../engine/scene/blocks';
import type { BlockObject, Entity, PrefabDocument } from '../engine/scene/mapformat';
import { parseColor } from '../engine/render/materials';

/**
 * Asset browser thumbnails, drawn on the CPU (no GPU work, no renderer
 * involvement): flat-shaded orthographic 3/4 views of an asset, a prefab or a
 * block shape, coloured by each material's average albedo (texture manifest)
 * with depth-edge outlines. Generated lazily, one at a time, and cached in
 * IndexedDB by source + version.
 */

const W = 160, H = 120, SS = 2; // drawn at 2x, downsampled
const VERSION = 2;

type Tri = { p: Float32Array; col: [number, number, number] };

interface MatDef { inherits?: string; baseColor?: string; baseColorFactor?: unknown; alphaMode?: string; shader?: string }

export type ThumbSource =
  | { kind: 'asset'; path: string; version?: string }
  | { kind: 'prefab'; name: string; version?: number }
  | { kind: 'block'; shape: BlockShape | 'room'; material?: string };

export function thumbKey(s: ThumbSource): string {
  if (s.kind === 'asset') return `a:${s.path}@${s.version ?? ''}`;
  if (s.kind === 'prefab') return `p:${s.name}@${s.version ?? 0}`;
  return `b:${s.shape}:${s.material ?? ''}`;
}

export class Thumbnails {
  private urls = new Map<string, string>();
  private queue: { key: string; src: ThumbSource; done: ((url: string | null) => void)[] }[] = [];
  private running = false;
  private db: Promise<IDBDatabase | null>;
  private manifest: Promise<Record<string, { averageAlbedo?: number[] }>>;
  private mats = new Map<string, Promise<[number, number, number] | null>>();

  constructor(private prefabDoc: (name: string) => Promise<PrefabDocument>) {
    this.db = new Promise((res) => {
      try {
        const r = indexedDB.open('rill-thumbs', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('t');
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
      } catch {
        res(null);
      }
    });
    this.manifest = fetch('/textures/manifest.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  }

  /** The thumbnail if ready (else undefined; `get` makes it). */
  peek(src: ThumbSource): string | undefined {
    return this.urls.get(`${VERSION}|${thumbKey(src)}`);
  }

  /** Thumbnail data URL (cached, else generated in the background queue). */
  get(src: ThumbSource): Promise<string | null> {
    const key = `${VERSION}|${thumbKey(src)}`;
    const have = this.urls.get(key);
    if (have) return Promise.resolve(have);
    return new Promise((res) => {
      const q = this.queue.find((x) => x.key === key);
      if (q) q.done.push(res);
      else this.queue.push({ key, src, done: [res] });
      void this.pump();
    });
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift()!;
        let url: string | null = null;
        try {
          url = (await this.load(job.key)) ?? null;
          if (!url) {
            url = await this.render(job.src);
            if (url) void this.store(job.key, url);
          }
        } catch (e) {
          console.warn(`[thumbs] ${job.key}: ${(e as Error).message}`);
        }
        if (url) this.urls.set(job.key, url);
        for (const d of job.done) d(url);
        // Keep the editor responsive between thumbnails.
        await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      this.running = false;
    }
  }

  private async load(key: string): Promise<string | undefined> {
    const db = await this.db;
    if (!db) return undefined;
    return new Promise((res) => {
      try {
        const r = db.transaction('t').objectStore('t').get(key);
        r.onsuccess = () => res(r.result as string | undefined);
        r.onerror = () => res(undefined);
      } catch {
        res(undefined);
      }
    });
  }

  private async store(key: string, url: string) {
    const db = await this.db;
    if (!db) return;
    try { db.transaction('t', 'readwrite').objectStore('t').put(url, key); } catch { /* full / private mode */ }
  }

  // ------------------------------------------------------------------ geometry

  /** Linear average albedo of a material (manifest average x factor), following `inherits`. */
  private material(name: string): Promise<[number, number, number] | null> {
    let p = this.mats.get(name);
    if (!p) {
      p = (async () => {
        let factor: [number, number, number] = [1, 1, 1];
        let tex: string | undefined, n = name;
        for (let depth = 0; depth < 6 && n; depth++) {
          const r = await fetch(`/materials/${encodeURIComponent(n)}.json`);
          if (!r.ok) break;
          const d = (await r.json()) as MatDef;
          if (d.shader === 'foliage' || d.alphaMode === 'blend') factor = [factor[0] * 0.9, factor[1] * 0.9, factor[2] * 0.9];
          const f = parseColor(d.baseColorFactor as never, [1, 1, 1, 1]);
          factor = [factor[0] * f[0], factor[1] * f[1], factor[2] * f[2]];
          tex ??= d.baseColor;
          n = d.inherits ?? '';
        }
        const man = await this.manifest;
        const set = tex?.replace(/_albedo\.\w+$/, '').replace(/\.\w+$/, '');
        const avg = set ? man[set]?.averageAlbedo : undefined;
        const base = avg ?? (tex ? [0.35, 0.35, 0.35] : [0.8, 0.8, 0.8]);
        return [base[0] * factor[0], base[1] * factor[1], base[2] * factor[2]] as [number, number, number];
      })().catch(() => null);
      this.mats.set(name, p);
    }
    return p;
  }

  private async meshTris(path: string, M: Mat4, override?: Record<string, unknown>): Promise<Tri[]> {
    let mesh;
    if (path.startsWith('builtin:')) mesh = builtinMesh(path);
    else {
      let glb = path;
      if (path.endsWith('.model.json')) {
        const d = await (await fetch(`/${path}`)).json() as { lods: { mesh: string; distance: number }[] };
        const lod = [...d.lods].sort((a, b) => a.distance - b.distance)[0];
        glb = path.replace(/[^/]*$/, '') + lod.mesh;
      }
      mesh = (await loadGlb(`/${glb}`)).mesh;
    }
    const out: Tri[] = [];
    for (const p of mesh.primitives) {
      const ov = override?.[p.material];
      const col = (await this.material(typeof ov === 'string' ? ov : p.material)) ?? [0.5, 0.5, 0.5];
      const P = p.positions, I = p.indices;
      for (let i = 0; i < I.length; i += 3) {
        const t = new Float32Array(9);
        for (let k = 0; k < 3; k++) {
          const v = vec3.transformMat4([P[I[i + k] * 3], P[I[i + k] * 3 + 1], P[I[i + k] * 3 + 2]], M);
          t.set(v, k * 3);
        }
        out.push({ p: t, col });
      }
    }
    return out;
  }

  private async blockTris(e: BlockObject, M: Mat4): Promise<Tri[]> {
    const { size } = blockExtent(e);
    const out: Tri[] = [];
    for (const f of blockFaces(e.block.shape, size, { steps: e.block.steps, segments: e.block.segments })) {
      const col = (await this.material(e.block.faces?.[f.id] ?? e.block.material ?? BLOCK_MATERIAL)) ?? [0.5, 0.5, 0.5];
      for (let k = 1; k < f.pts.length - 1; k++) {
        const t = new Float32Array(9);
        [f.pts[0], f.pts[k], f.pts[k + 1]].forEach((q, j) => t.set(vec3.transformMat4(q, M), j * 3));
        out.push({ p: t, col });
      }
    }
    return out;
  }

  private async entityTris(ents: Entity[], depth = 0): Promise<Tri[]> {
    const out: Tri[] = [];
    for (const e of ents) {
      if (e.visible === false || !('transform' in e) || !e.transform) continue;
      const t = e.transform;
      const M = mat4.translation(t.position);
      if (t.rotation) mat4.multiply(M, mat4.fromQuat(t.rotation), M);
      if (e.type === 'block') {
        out.push(...(await this.blockTris(e, M)));
        continue;
      }
      if (t.scale) mat4.scale(M, t.scale, M);
      if (e.type === 'mesh') out.push(...(await this.meshTris(e.asset, M, e.materialOverrides as Record<string, unknown> | undefined)));
      else if (e.type === 'prefab' && depth < 4) {
        const pd = await this.prefabDoc(e.prefab);
        for (const tri of await this.entityTris(pd.entities, depth + 1)) {
          const q = new Float32Array(9);
          for (let k = 0; k < 3; k++) q.set(vec3.transformMat4([tri.p[k * 3], tri.p[k * 3 + 1], tri.p[k * 3 + 2]], M), k * 3);
          out.push({ p: q, col: tri.col });
        }
      }
    }
    return out;
  }

  private async render(src: ThumbSource): Promise<string | null> {
    let tris: Tri[];
    if (src.kind === 'asset') tris = await this.meshTris(src.path, mat4.identity());
    else if (src.kind === 'prefab') tris = await this.entityTris((await this.prefabDoc(src.name)).entities);
    else {
      const size: [number, number, number] = src.shape === 'room' ? [6, 3, 5] : src.shape === 'stairs' ? [1.2, 1.7, 2.8] : src.shape === 'wedge' ? [2, 1, 3] : src.shape === 'cylinder' ? [1, 3, 1] : [2, 2, 2];
      const shape = src.shape === 'room' ? 'box' : src.shape;
      const b: BlockObject = { id: 't', type: 'block', transform: { position: [0, 0, 0] }, block: { shape, size, material: src.material } };
      tris = await this.blockTris(b, mat4.identity());
      if (src.shape === 'room') {
        // A room reads as walls: drop the near walls and the ceiling.
        tris = tris.filter((t) => !(t.p[1] > 2.99 && t.p[4] > 2.99 && t.p[7] > 2.99) && !(t.p[2] > 2.49 && t.p[5] > 2.49 && t.p[8] > 2.49) && !(t.p[0] > 2.99 && t.p[3] > 2.99 && t.p[6] > 2.99));
      }
    }
    if (!tris.length) return null;
    return rasterise(tris);
  }
}

/** Orthographic 3/4 view (yaw 35° from +Z towards +X, 28° down) fitted to the triangles. */
function rasterise(tris: Tri[]): string {
  const w = W * SS, h = H * SS;
  const yaw = (35 * Math.PI) / 180, pitch = (28 * Math.PI) / 180;
  // View basis: camera looks along -f.
  const f: [number, number, number] = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
  const r = norm([f[2], 0, -f[0]]);
  const u = cross(f, r);
  // Project everything, fit the bounds.
  const proj = (x: number, y: number, z: number) => [x * r[0] + y * r[1] + z * r[2], x * u[0] + y * u[1] + z * u[2], x * f[0] + y * f[1] + z * f[2]];
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const pts = tris.map((t) => {
    const a = proj(t.p[0], t.p[1], t.p[2]), b = proj(t.p[3], t.p[4], t.p[5]), c = proj(t.p[6], t.p[7], t.p[8]);
    for (const q of [a, b, c]) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }
    return [a, b, c];
  });
  const span = Math.max((x1 - x0) / (w * 0.86), (y1 - y0) / (h * 0.86), 1e-6);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const toPx = (q: number[]): [number, number, number] => [w / 2 + (q[0] - cx) / span, h / 2 - (q[1] - cy) / span, q[2]];
  const depth = new Float32Array(w * h).fill(-Infinity);
  const color = new Float32Array(w * h * 3);
  const L = norm([-0.45, 0.8, 0.4]);
  tris.forEach((t, i) => {
    const [A, B, C] = pts[i].map(toPx);
    // World normal (either side faces the light: thin assets are often one-sided).
    const e1 = [t.p[3] - t.p[0], t.p[4] - t.p[1], t.p[5] - t.p[2]], e2 = [t.p[6] - t.p[0], t.p[7] - t.p[1], t.p[8] - t.p[2]];
    let n = norm(cross(e1 as [number, number, number], e2 as [number, number, number]));
    if (n[0] * f[0] + n[1] * f[1] + n[2] * f[2] < 0) n = [-n[0], -n[1], -n[2]];
    const diff = Math.max(0, n[0] * L[0] + n[1] * L[1] + n[2] * L[2]);
    const sky = 0.5 + 0.5 * n[1];
    const k = 0.25 + 0.15 * sky + 0.85 * diff;
    const col = [t.col[0] * k, t.col[1] * k, t.col[2] * k];
    const minX = Math.max(0, Math.floor(Math.min(A[0], B[0], C[0]))), maxX = Math.min(w - 1, Math.ceil(Math.max(A[0], B[0], C[0])));
    const minY = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1]))), maxY = Math.min(h - 1, Math.ceil(Math.max(A[1], B[1], C[1])));
    const area = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
    if (Math.abs(area) < 1e-9) return;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((B[0] - px) * (C[1] - py) - (B[1] - py) * (C[0] - px)) / area;
        const w1 = ((C[0] - px) * (A[1] - py) - (C[1] - py) * (A[0] - px)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * A[2] + w1 * B[2] + w2 * C[2];
        const o = y * w + x;
        if (z <= depth[o]) continue;
        depth[o] = z;
        color[o * 3] = col[0]; color[o * 3 + 1] = col[1]; color[o * 3 + 2] = col[2];
      }
    }
  });
  // Depth-edge outlines (silhouettes and creases), then a 2x box downsample.
  const zr = Math.max(1e-6, (x1 - x0 + y1 - y0) * 0.01);
  const img = new ImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r0 = 0, g0 = 0, b0 = 0, a0 = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const X = x * SS + sx, Y = y * SS + sy, o = Y * w + X;
        if (depth[o] === -Infinity) continue;
        let edge = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const q = (Y + dy) * w + (X + dx);
          if (X + dx < 0 || X + dx >= w || Y + dy < 0 || Y + dy >= h || depth[q] === -Infinity || Math.abs(depth[q] - depth[o]) > zr) edge = 1;
        }
        const s = edge ? 0.55 : 1;
        r0 += color[o * 3] * s; g0 += color[o * 3 + 1] * s; b0 += color[o * 3 + 2] * s; a0++;
      }
      const i = (y * W + x) * 4, n = SS * SS;
      if (!a0) continue;
      const enc = (v: number) => Math.round(255 * Math.min(1, Math.pow(Math.max(0, v / a0), 1 / 2.2)));
      img.data[i] = enc(r0); img.data[i + 1] = enc(g0); img.data[i + 2] = enc(b0); img.data[i + 3] = Math.round((255 * a0) / n);
    }
  }
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  cv.getContext('2d')!.putImageData(img, 0, 0);
  return cv.toDataURL('image/png');
}

function cross(a: number[], b: number[]): [number, number, number] { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a: number[]): [number, number, number] { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
