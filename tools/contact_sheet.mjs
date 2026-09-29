// Tiles PNG screenshots into one contact sheet: node tools/contact_sheet.mjs out.png cols a.png b.png ...
import { PNG } from 'pngjs';
import fs from 'node:fs';
const [out, colsArg, ...files] = process.argv.slice(2);
const cols = parseInt(colsArg, 10);
const imgs = files.map((f) => PNG.sync.read(fs.readFileSync(f)));
const tw = 640, th = Math.round((tw * imgs[0].height) / imgs[0].width);
const rows = Math.ceil(imgs.length / cols);
const sheet = new PNG({ width: tw * cols, height: th * rows });
imgs.forEach((img, i) => {
  const ox = (i % cols) * tw, oy = Math.floor(i / cols) * th;
  const sx = img.width / tw, sy = img.height / th;
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    // box filter
    let r = 0, g = 0, b = 0, n = 0;
    for (let yy = Math.floor(y * sy); yy < Math.floor((y + 1) * sy); yy++) for (let xx = Math.floor(x * sx); xx < Math.floor((x + 1) * sx); xx++) {
      const s = (yy * img.width + xx) * 4; r += img.data[s]; g += img.data[s + 1]; b += img.data[s + 2]; n++;
    }
    const d = ((oy + y) * sheet.width + ox + x) * 4;
    sheet.data[d] = r / n; sheet.data[d + 1] = g / n; sheet.data[d + 2] = b / n; sheet.data[d + 3] = 255;
  }
});
fs.writeFileSync(out, PNG.sync.write(sheet));
