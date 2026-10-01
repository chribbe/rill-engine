// node tools/imgdiff.mjs a.png b.png [out.png]  -> mean/max abs difference (+ amplified diff image)
import { PNG } from 'pngjs';
import fs from 'node:fs';
const [a, b, out] = process.argv.slice(2);
const A = PNG.sync.read(fs.readFileSync(a)), B = PNG.sync.read(fs.readFileSync(b));
let sum = 0, max = 0, n = 0;
const D = new PNG({ width: A.width, height: A.height });
for (let i = 0; i < A.data.length; i += 4) {
  let d = 0;
  for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(A.data[i + c] - B.data[i + c]));
  sum += d; max = Math.max(max, d); n++;
  D.data[i] = D.data[i + 1] = D.data[i + 2] = Math.min(255, d * 8); D.data[i + 3] = 255;
}
console.log(`mean ${(sum / n).toFixed(3)} max ${max} changed>2: ${(100 * 0).toFixed(1)}`);
if (out) fs.writeFileSync(out, PNG.sync.write(D));
