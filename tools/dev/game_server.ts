import type { Plugin } from 'vite';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/**
 * Dev-only endpoint for gameplay tuning: the in-game panel saves live values
 * back to public/game/<name>.json (`name` may have one folder, e.g.
 * weapons/carbine). Files are pretty-printed with the key order of the payload.
 */
const ROOT = join(import.meta.dirname, '..', '..');
const GAME = join(ROOT, 'public', 'game');
const NAME = /^[a-z0-9_]+(\/[a-z0-9_]+)?$/;

export function gameServer(): Plugin {
  return {
    name: 'rill-game-server',
    configureServer(server) {
      server.middlewares.use('/__game/save', (req, res) => {
        const send = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
        };
        if (req.method !== 'POST') return send(405, { error: 'POST only' });
        const name = new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? '';
        if (!NAME.test(name)) return send(400, { error: `bad config name '${name}'` });
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!data || typeof data !== 'object' || Array.isArray(data)) return send(400, { error: 'expected a JSON object' });
            const file = join(GAME, `${name}.json`);
            mkdirSync(dirname(file), { recursive: true });
            const text = JSON.stringify(data, null, 2) + '\n';
            if (existsSync(file) && readFileSync(file, 'utf8') === text) return send(200, { file: relative(ROOT, file), unchanged: true });
            writeFileSync(file + '.tmp', text);
            renameSync(file + '.tmp', file);
            send(200, { file: relative(ROOT, file) });
          } catch (e) {
            send(400, { error: String(e) });
          }
        });
      });
    },
  };
}
