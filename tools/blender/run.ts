// Runs Rill's Blender tooling headlessly:
//   npm run bake -- [--map hasselby] [--samples N] [--size 2048] [--out dir]
//   npm run map | npm run map:hasselby   (legacy whole-map generators, see below)
//
// Maps are authored in the web editor (map format v2). The two generators that
// originally built the test maps in Blender would overwrite editor work, so they
// refuse to run on an editor-owned map unless --regenerate is given; their v1
// output then goes to build/<map>.generated.json and is imported with
// `node tools/scene/migrate.ts <map> --in build/<map>.generated.json`.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const candidates = [process.env.BLENDER, '/Applications/Blender.app/Contents/MacOS/Blender', 'blender'].filter(Boolean) as string[];
const blender = candidates.find((c) => c === 'blender' || existsSync(c))!;
const [cmd, ...rest] = process.argv.slice(2);
const script = { build: 'build_testmap.py', hasselby: 'build_hasselby.py', bake: 'bake_lightmaps.py' }[cmd as 'build' | 'hasselby' | 'bake'];
if (!script) {
  console.error('usage: run.ts build|hasselby|bake [-- args]');
  process.exit(1);
}
const env = { ...process.env };
if (cmd === 'build' || cmd === 'hasselby') {
  const map = cmd === 'build' ? 'testmap' : 'hasselby';
  const mapPath = join(ROOT, 'public', 'maps', map, 'map.json');
  const version = existsSync(mapPath) ? JSON.parse(readFileSync(mapPath, 'utf8')).version : 0;
  if (version >= 2) {
    if (!rest.includes('--regenerate')) {
      console.error(`maps/${map}/map.json is editor-owned (format v${version}). Re-running the Blender generator would\n` +
        `overwrite its assets. To regenerate anyway: npm run ${cmd === 'build' ? 'map' : 'map:hasselby'} -- --regenerate\n` +
        `(then import: node tools/scene/migrate.ts ${map} --in build/${map}.generated.json)`);
      process.exit(1);
    }
    mkdirSync(join(ROOT, 'build'), { recursive: true });
    env.RILL_MAP_OUT = join(ROOT, 'build', `${map}.generated.json`);
  }
}
const args = rest.filter((a) => a !== '--regenerate');
const r = spawnSync(blender, ['-b', '--factory-startup', '-P', join(import.meta.dirname, script), '--', ...args], { stdio: 'inherit', env });
process.exit(r.status ?? 1);
