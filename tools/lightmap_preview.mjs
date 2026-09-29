// Renders a lightmap .hdr to a viewable PNG (Reinhard, optional exposure) and
// prints per-object statistics from the LightmapSet.
//   node tools/lightmap_preview.mjs public/maps/testmap/lightmaps/lm_0_sky.hdr out.png [exposure]
import fs from 'node:fs';
import { PNG } from 'pngjs';
const [inp, out, expArg] = process.argv.slice(2);
const exp = parseFloat(expArg ?? '1');
const b = fs.readFileSync(inp);
let pos = 0;
const line = () => { let s = ''; while (b[pos] !== 10) s += String.fromCharCode(b[pos++]); pos++; return s; };
line(); while (line() !== '');
const [, H, , W] = line().split(' ').map((v, i) => (i % 2 ? parseInt(v, 10) : v));
const rgbe = new Uint8Array(W * H * 4);
const scan = new Uint8Array(W * 4);
for (let y = 0; y < H; y++) {
  pos += 4;
  for (let c = 0; c < 4; c++) {
    let x = 0;
    while (x < W) {
      let n = b[pos++];
      if (n > 128) { n -= 128; const v = b[pos++]; for (let i = 0; i < n; i++) scan[(x++) * 4 + c] = v; }
      else for (let i = 0; i < n; i++) scan[(x++) * 4 + c] = b[pos++];
    }
  }
  rgbe.set(scan, y * W * 4);
}
const png = new PNG({ width: W, height: H });
for (let i = 0; i < W * H; i++) {
  const e = rgbe[i * 4 + 3];
  const f = e ? Math.pow(2, e - 136) * exp : 0;
  for (let c = 0; c < 3; c++) {
    const v = rgbe[i * 4 + c] * f;
    png.data[i * 4 + c] = Math.round(255 * Math.pow(v / (1 + v), 1 / 2.2));
  }
  png.data[i * 4 + 3] = 255;
}
fs.writeFileSync(out, PNG.sync.write(png));
const setPath = inp.replace(/[^/]+$/, 'lightmapset.json');
if (fs.existsSync(setPath)) {
  const set = JSON.parse(fs.readFileSync(setPath, 'utf8'));
  for (const [id, o] of Object.entries(set.objects)) {
    const [sx, sy, ox, oy] = o.scaleOffset;
    const x0 = Math.round(ox * W), y0 = Math.round(oy * H), w = Math.round(sx * W), h = Math.round(sy * H);
    let sum = 0, n = 0, zero = 0;
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      const i = y * W + x, e = rgbe[i * 4 + 3];
      if (!e) { zero++; continue; }
      const f = Math.pow(2, e - 136);
      sum += (rgbe[i * 4] + rgbe[i * 4 + 1] + rgbe[i * 4 + 2]) / 3 * f; n++;
    }
    console.log(`${id.padEnd(18)} rect ${x0},${y0} ${w}x${h}  mean ${(sum / Math.max(n, 1)).toFixed(3)}  empty ${(100 * zero / (w * h)).toFixed(0)}%`);
  }
}
