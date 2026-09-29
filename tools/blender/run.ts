// Runs Rill's Blender tooling headlessly:  npm run map  |  npm run bake -- [--samples N] [--size 2048]
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const candidates = [process.env.BLENDER, '/Applications/Blender.app/Contents/MacOS/Blender', 'blender'].filter(Boolean) as string[];
const blender = candidates.find((c) => c === 'blender' || existsSync(c))!;
const [cmd, ...rest] = process.argv.slice(2);
const script = { build: 'build_testmap.py', bake: 'bake_lightmaps.py' }[cmd as 'build' | 'bake'];
if (!script) {
  console.error('usage: run.ts build|bake [-- args]');
  process.exit(1);
}
const r = spawnSync(blender, ['-b', '--factory-startup', '-P', join(import.meta.dirname, script), '--', ...rest], { stdio: 'inherit' });
process.exit(r.status ?? 1);
