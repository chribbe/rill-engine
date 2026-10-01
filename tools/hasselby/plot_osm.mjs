// Top-down preview of the OSM extract (layout reference for build_hasselby.py).
//   node tools/hasselby/plot_osm.mjs [out.png] [halfSizeMetres] [pxPerMetre]
// Projection: local metres around Hässelby gård station (x east, y north).
import { PNG } from 'pngjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LAT0 = 59.36694, LON0 = 17.84444;
const KX = 111320 * Math.cos((LAT0 * Math.PI) / 180), KY = 110540;
const out = process.argv[2] ?? 'osm_plot.png';
const HALF = +(process.argv[3] ?? 200), PPM = +(process.argv[4] ?? 2.5);
const d = JSON.parse(readFileSync(join(import.meta.dirname, 'osm.json'), 'utf8'));
const nodes = new Map();
// Overpass lists tagged nodes and again as untagged skeleton nodes: keep the tags.
for (const e of d.elements) if (e.type === 'node' && (e.tags || !nodes.has(e.id))) nodes.set(e.id, e);
const ways = d.elements.filter((e) => e.type === 'way' && e.tags);
const W = Math.round(HALF * 2 * PPM);
const img = new PNG({ width: W, height: W });
img.data.fill(255);
const px = (x, y) => [(x + HALF) * PPM, (HALF - y) * PPM];
const xy = (n) => [(n.lon - LON0) * KX, (n.lat - LAT0) * KY];
function set(x, y, c, a = 1) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= W || y >= W) return;
  const o = (y * W + x) * 4;
  for (let k = 0; k < 3; k++) img.data[o + k] = img.data[o + k] * (1 - a) + c[k] * a;
}
function line(p, q, c, w = 1) {
  const [x0, y0] = px(...p), [x1, y1] = px(...q);
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n, y = y0 + ((y1 - y0) * i) / n;
    for (let a = -w; a <= w; a++) for (let b = -w; b <= w; b++) if (a * a + b * b <= w * w) set(x + a, y + b, c);
  }
}
function fill(pts, c, a = 1) {
  const P = pts.map((p) => px(...p));
  const ys = P.map((p) => p[1]);
  for (let y = Math.max(0, Math.floor(Math.min(...ys))); y <= Math.min(W - 1, Math.ceil(Math.max(...ys))); y++) {
    const xs = [];
    for (let i = 0; i < P.length; i++) {
      const [ax, ay] = P[i], [bx, by] = P[(i + 1) % P.length];
      if ((ay <= y && by > y) || (by <= y && ay > y)) xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((m, n) => m - n);
    for (let i = 0; i + 1 < xs.length; i += 2) for (let x = Math.ceil(xs[i]); x <= xs[i + 1]; x++) set(x, y, c, a);
  }
}
const pts = (w) => w.nodes.map((id) => nodes.get(id)).filter(Boolean).map(xy);
const roadW = { primary: 5, secondary: 4.5, tertiary: 4, residential: 3, unclassified: 3, service: 2, footway: 1, cycleway: 1, path: 1, pedestrian: 2, steps: 1 };
// areas first
for (const w of ways) {
  const t = w.tags, p = pts(w);
  if (p.length < 3) continue;
  if (t.landuse === 'grass' || t.leisure === 'park' || t.landuse === 'recreation_ground') fill(p, [200, 230, 190]);
  if (t.natural === 'wood' || t.landuse === 'forest') fill(p, [150, 200, 140]);
  if (t.natural === 'bare_rock' || t.natural === 'scrub') fill(p, [190, 190, 160]);
  if (t.amenity === 'parking') fill(p, [215, 215, 215]);
  if (t.highway === 'pedestrian' || t['area:highway'] || t.place === 'square') fill(p, [235, 220, 200]);
}
for (const w of ways) {
  const t = w.tags, p = pts(w);
  if (t.highway && !t.area) for (let i = 0; i + 1 < p.length; i++) line(p[i], p[i + 1], t.highway === 'footway' || t.highway === 'cycleway' || t.highway === 'path' ? [170, 140, 110] : [90, 90, 90], Math.round((roadW[t.highway] ?? 1) * PPM / 2.5));
}
for (const w of ways) {
  const t = w.tags, p = pts(w);
  if (!(t.building || t['building:part']) || p.length < 3) continue;
  const lv = +(t['building:levels'] ?? 1);
  const g = Math.max(60, 200 - lv * 9);
  fill(p, t.building === 'retail' ? [200, 120, 90] : [g, g, g + 20]);
  for (let i = 0; i + 1 < p.length; i++) line(p[i], p[i + 1], [40, 40, 60], 0);
}
for (const w of ways) {
  const t = w.tags, p = pts(w);
  if (t.railway === 'platform') fill(p, [120, 120, 220]);
  if (t.railway && t.railway !== 'platform') for (let i = 0; i + 1 < p.length; i++) line(p[i], p[i + 1], t.bridge ? [220, 0, 0] : t.layer === '-1' ? [220, 150, 150] : [140, 0, 0], 1);
}
// point features
for (const n of nodes.values()) {
  if (!n.tags) continue;
  const [x, y] = xy(n);
  const c = n.tags.natural === 'tree' ? [30, 140, 30] : n.tags.highway === 'street_lamp' ? [230, 180, 0] : n.tags.shop || n.tags.amenity ? [200, 0, 160] : null;
  if (!c) continue;
  const [X, Y] = px(x, y);
  for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) set(X + a, Y + b, c);
}
// 10 m grid ticks and origin
for (let g = -HALF; g <= HALF; g += 50) { line([g, -HALF], [g, HALF], [210, 210, 255], 0); line([-HALF, g], [HALF, g], [210, 210, 255], 0); }
line([-3, 0], [3, 0], [0, 0, 255], 1); line([0, -3], [0, 3], [0, 0, 255], 1);
writeFileSync(out, PNG.sync.write(img));
console.log(`wrote ${out} (${W}x${W}, ${PPM} px/m, ±${HALF} m)`);
