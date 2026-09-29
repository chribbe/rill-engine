/**
 * Tiny WGSL preprocessor: resolves `#include "name"` against the files in
 * src/shaders. Each chunk is included at most once per shader. No macros —
 * variants are expressed with WGSL `override` constants or uniforms instead.
 */

const sources = import.meta.glob('../../shaders/**/*.wgsl', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const chunks = new Map<string, string>();
for (const [path, src] of Object.entries(sources)) {
  const name = path.replace(/^.*\/shaders\//, '').replace(/\.wgsl$/, '');
  chunks.set(name, src);
}

export function shaderSource(name: string): string {
  const seen = new Set<string>();
  const expand = (n: string, stack: string[]): string => {
    const src = chunks.get(n);
    if (src === undefined) throw new Error(`Shader chunk not found: ${n} (from ${stack.join(' > ')})`);
    if (seen.has(n)) return '';
    seen.add(n);
    return src.replace(/^\s*#include\s+"([^"]+)"\s*$/gm, (_m, inc: string) => expand(inc, [...stack, n]));
  };
  return expand(name, []);
}

const moduleCache = new Map<string, GPUShaderModule>();

export function shaderModule(device: GPUDevice, name: string): GPUShaderModule {
  let mod = moduleCache.get(name);
  if (!mod) {
    const code = shaderSource(name);
    mod = device.createShaderModule({ label: name, code });
    mod.getCompilationInfo().then((info) => {
      for (const m of info.messages) {
        const line = code.split('\n')[m.lineNum - 1] ?? '';
        const log = m.type === 'error' ? console.error : console.warn;
        log(`[wgsl:${name}] ${m.type} ${m.lineNum}:${m.linePos} ${m.message}\n  ${line}`);
      }
    });
    moduleCache.set(name, mod);
  }
  return mod;
}
