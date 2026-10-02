// Render-regression check over screenshot sets:
//   node tools/regress.mjs <prefixA> <prefixB> [threshold=8]
// compares screenshots/<prefixA>_<i>.png with screenshots/<prefixB>_<i>.png (every index present in
// both) and prints mean / max channel difference and the share of pixels differing by > threshold.
// Writes amplified difference images to screenshots/diff_<prefixB>_<i>.png.
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';

const [pa, pb, thr = '8'] = process.argv.slice(2);
if (!pa || !pb) {
  console.error('usage: node tools/regress.mjs <prefixA> <prefixB> [threshold]');
  process.exit(1);
}
const dir = path.join(process.cwd(), 'screenshots');
const T = +thr;
let worst = 0;
for (let i = 0; i < 100; i++) {
  const fa = path.join(dir, `${pa}_${i}.png`), fb = path.join(dir, `${pb}_${i}.png`);
  if (!fs.existsSync(fa) || !fs.existsSync(fb)) continue;
  const A = PNG.sync.read(fs.readFileSync(fa)), B = PNG.sync.read(fs.readFileSync(fb));
  if (A.width !== B.width || A.height !== B.height) {
    console.log(`${i}: size mismatch ${A.width}x${A.height} vs ${B.width}x${B.height}`);
    continue;
  }
  const D = new PNG({ width: A.width, height: A.height });
  let sum = 0, max = 0, over = 0;
  const n = A.width * A.height;
  for (let p = 0; p < n * 4; p += 4) {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(A.data[p + c] - B.data[p + c]));
    sum += d;
    if (d > max) max = d;
    if (d > T) over++;
    D.data[p] = D.data[p + 1] = D.data[p + 2] = Math.min(255, d * 8);
    D.data[p + 3] = 255;
  }
  const pct = (100 * over) / n;
  worst = Math.max(worst, pct);
  console.log(`${String(i).padStart(2)}: mean ${(sum / n).toFixed(3)}  max ${String(max).padStart(3)}  >${T}: ${pct.toFixed(3)}%`);
  fs.writeFileSync(path.join(dir, `diff_${pb}_${i}.png`), PNG.sync.write(D));
}
console.log(`worst view: ${worst.toFixed(3)}% of pixels differ by more than ${T}`);
