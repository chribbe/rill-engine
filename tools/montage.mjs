import { PNG } from 'pngjs';
import fs from 'node:fs';
const [out, cols, ...files] = process.argv.slice(2);
const ims = files.map((f) => PNG.sync.read(fs.readFileSync(f)));
const w = ims[0].width, h = ims[0].height, c = +cols, rows = Math.ceil(ims.length / c);
const o = new PNG({ width: w * c, height: h * rows });
ims.forEach((im, i) => {
  const ox = (i % c) * w, oy = Math.floor(i / c) * h;
  for (let y = 0; y < h; y++) im.data.copy(o.data, ((oy + y) * w * c + ox) * 4, y * w * 4, (y + 1) * w * 4);
});
fs.writeFileSync(out, PNG.sync.write(o));
