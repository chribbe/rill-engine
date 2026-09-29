import { defineConfig, type Plugin } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';

/**
 * Dev-only capture endpoint: the page POSTs PNGs to /__capture?name=... and
 * they land in ./screenshots. Lets tools (and later an AI agent) grab exact
 * renderer frames without screen scraping.
 */
function captureEndpoint(): Plugin {
  return {
    name: 'rill-capture',
    configureServer(server) {
      server.middlewares.use('/__capture', (req, res) => {
        const url = new URL(req.url ?? '', 'http://x');
        const name = (url.searchParams.get('name') ?? `shot-${Date.now()}`).replace(/[^\w.-]/g, '_');
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const dir = join(process.cwd(), 'screenshots');
          mkdirSync(dir, { recursive: true });
          const file = join(dir, name.endsWith('.png') ? name : `${name}.png`);
          const body = Buffer.concat(chunks);
          const w = parseInt(url.searchParams.get('w') ?? '0', 10);
          const h = parseInt(url.searchParams.get('h') ?? '0', 10);
          if (w > 0 && h > 0) {
            // Raw RGBA from the page: encode here (fast, deterministic).
            const png = new PNG({ width: w, height: h });
            body.copy(png.data, 0, 0, w * h * 4);
            writeFileSync(file, PNG.sync.write(png, { colorType: 6 }));
          } else {
            writeFileSync(file, body);
          }
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ file }));
        });
      });
    },
  };
}

export default defineConfig({
  // No SPA fallback: missing assets must 404 instead of returning index.html.
  appType: 'mpa',
  plugins: [captureEndpoint()],
  server: { port: 5173, strictPort: true, host: '127.0.0.1' },
  build: { target: 'es2023', sourcemap: true },
});
