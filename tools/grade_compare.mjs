// Compares the tonal/colour statistics of rendered frames against reference images.
//
//   node tools/grade_compare.mjs reference/insertion2_3.jpeg screenshots/mood_dusk.png [...]
//
// Prints, per image: display-luma percentiles (p5/p25/p50/p75/p95), mean chroma
// (saturation proxy), and the colour cast of shadows / mid-tones / highlights as
// (R-G, B-G) offsets of their mean display colour - enough to steer exposure,
// contrast, saturation and split-tone grading towards a reference look.
// JPEGs are converted with macOS `sips`.
import { PNG } from 'pngjs';
import { readFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';

const tmp = mkdtempSync(join(tmpdir(), 'rill-grade-'));

function load(file) {
  let path = file;
  if (!/\.png$/i.test(file)) {
    path = join(tmp, basename(file) + '.png');
    execFileSync('sips', ['-s', 'format', 'png', file, '--out', path], { stdio: 'ignore' });
  }
  return PNG.sync.read(readFileSync(path));
}

function stats(img) {
  const { width, height, data } = img;
  const n = width * height;
  const ys = new Float32Array(n);
  let chroma = 0;
  for (let i = 0; i < n; i++) {
    const r = data[i * 4] / 255, g = data[i * 4 + 1] / 255, b = data[i * 4 + 2] / 255;
    ys[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    chroma += Math.max(r, g, b) - Math.min(r, g, b);
  }
  const sorted = Float32Array.from(ys).sort();
  const q = (p) => sorted[Math.min(n - 1, Math.floor(p * n))];
  const p25 = q(0.25), p75 = q(0.75);
  const band = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (let i = 0; i < n; i++) {
    const k = ys[i] < p25 ? 0 : ys[i] < p75 ? 1 : 2;
    band[k][0] += data[i * 4] / 255; band[k][1] += data[i * 4 + 1] / 255; band[k][2] += data[i * 4 + 2] / 255; band[k][3]++;
  }
  const cast = band.map(([r, g, b, c]) => [(r - g) / Math.max(1, c), (b - g) / Math.max(1, c)]);
  return { p: [0.05, 0.25, 0.5, 0.75, 0.95].map(q), chroma: chroma / n, cast };
}

const f = (x) => x.toFixed(3);
console.log('image'.padEnd(34), 'luma p5   p25   p50   p75   p95 ', ' chroma', '  cast shadows(R-G,B-G)  mids          highlights');
for (const file of process.argv.slice(2)) {
  const s = stats(load(file));
  console.log(basename(file).padEnd(34), s.p.map(f).join(' '), ' ', f(s.chroma), '  ', s.cast.map(([a, b]) => `${a >= 0 ? '+' : ''}${f(a)},${b >= 0 ? '+' : ''}${f(b)}`).join('   '));
}
