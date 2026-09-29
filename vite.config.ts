import { defineConfig, type Plugin } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
          writeFileSync(file, Buffer.concat(chunks));
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
