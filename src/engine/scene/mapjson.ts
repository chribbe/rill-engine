/**
 * Canonical map JSON text: stable key order as authored, numbers rounded to
 * 6 decimals (float noise from transform maths never reaches the file), short
 * objects and number arrays on one line. One entity changes a handful of lines,
 * so map diffs stay reviewable. Shared by the dev server (save), the migration
 * tool and the editor. No imports: node scripts load it directly.
 */

const LINE = 110;

function round(v: number): number {
  if (Number.isInteger(v)) return v;
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
}

/** One-line form: `{ "a": 1, "b": [1, 2] }`. */
function inline(v: unknown): string {
  if (typeof v === 'number') return JSON.stringify(round(v));
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(inline).join(', ')}]`;
  const e = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
  return e.length ? `{ ${e.map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')} }` : '{}';
}

function fmt(v: unknown, indent: string): string {
  if (v === null || typeof v !== 'object') return inline(v);
  const c = inline(v);
  if (c.length + indent.length <= LINE) return c;
  const next = indent + '  ';
  if (Array.isArray(v)) {
    if (v.every((x) => x === null || typeof x !== 'object')) return c;
    return `[\n${v.map((x) => next + fmt(x, next)).join(',\n')}\n${indent}]`;
  }
  const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
  return `{\n${entries.map(([k, x]) => `${next}${JSON.stringify(k)}: ${fmt(x, next)}`).join(',\n')}\n${indent}}`;
}

export function formatMapJson(doc: unknown): string {
  return fmt(doc, '') + '\n';
}
