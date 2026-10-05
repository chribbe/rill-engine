/**
 * Tuning data files (public/game/<name>.json). `data` is the live object the
 * game reads every tick and the tuning panel edits in place; `saved` is the
 * file's state. Missing keys fall back to the code defaults, so adding a
 * parameter never breaks an older file. Save writes through the dev server.
 */
export class ConfigFile<T extends object> {
  readonly data: T;
  private saved: T;
  /** Fired after load / revert / defaults (UI refresh). */
  onReplace: (() => void)[] = [];

  constructor(readonly name: string, readonly defaults: T) {
    this.data = structuredClone(defaults);
    this.saved = structuredClone(defaults);
  }

  get url() {
    return `/game/${this.name}.json`;
  }

  async load() {
    try {
      const r = await fetch(this.url, { cache: 'no-store' });
      if (r.ok) {
        const file = (await r.json()) as Partial<T>;
        this.saved = merge(structuredClone(this.defaults), file);
      } else {
        console.warn(`[game] ${this.url}: ${r.status}, using defaults`);
      }
    } catch (e) {
      console.warn(`[game] ${this.url} unreadable, using defaults`, e);
    }
    this.assign(this.saved);
  }

  /** Writes the live values to the file (dev server). */
  async save(): Promise<string> {
    const r = await fetch(`/__game/save?name=${encodeURIComponent(this.name)}`, { method: 'POST', body: JSON.stringify(this.data) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? `save failed (${r.status})`);
    this.saved = structuredClone(this.data);
    return j.file as string;
  }

  /** Back to the file's values. */
  revert() {
    this.assign(this.saved);
  }

  /** Back to the code defaults (not saved until Save). */
  factory() {
    this.assign(this.defaults);
  }

  /** Whether a top-level / nested key differs from the file. */
  changed(path: string): boolean {
    const get = (o: unknown) => path.split('.').reduce((a, k) => (a as Record<string, unknown> | undefined)?.[k], o);
    return JSON.stringify(get(this.data)) !== JSON.stringify(get(this.saved));
  }

  get dirty() {
    return JSON.stringify(this.data) !== JSON.stringify(this.saved);
  }

  /** In-place copy (controllers keep their bound objects). */
  private assign(src: T) {
    copyInto(this.data as Record<string, unknown>, structuredClone(src) as Record<string, unknown>);
    for (const f of this.onReplace) f();
  }
}

function merge<T>(base: T, over: Partial<T> | undefined): T {
  if (!over) return base;
  const out = base as Record<string, unknown>;
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)) merge(b, v as Record<string, unknown>);
    else out[k] = v;
  }
  return base;
}

function copyInto(dst: Record<string, unknown>, src: Record<string, unknown>) {
  for (const [k, v] of Object.entries(src)) {
    const d = dst[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && d && typeof d === 'object' && !Array.isArray(d)) copyInto(d as Record<string, unknown>, v as Record<string, unknown>);
    else dst[k] = v;
  }
}
