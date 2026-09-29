// node tools/crop.mjs out.png x y w h in1.png [in2.png ...]  -> stacks 1:1 crops vertically
import { PNG } from 'pngjs';
import fs from 'node:fs';
const [out, xs, ys, ws, hs, ...files] = process.argv.slice(2);
const [x0, y0, w, h] = [xs, ys, ws, hs].map(Number);
const res = new PNG({ width: w, height: h * files.length });
files.forEach((f, k) => {
  const img = PNG.sync.read(fs.readFileSync(f));
  for (let y = 0; y < h; y++) img.data.copy(res.data, ((k * h + y) * w) * 4, ((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + w) * 4);
});
fs.writeFileSync(out, PNG.sync.write(res));
