/** Tiny DOM helpers (no framework: the editor UI is plain elements updated on editor events). */

type Attrs = Record<string, unknown> & { class?: string; style?: string };
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export function clear(el: HTMLElement) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Number field committing on Enter / blur; drag the label horizontally to scrub (one merged edit). */
export function numberField(opts: {
  label: string;
  value: number;
  step?: number;
  precision?: number;
  onCommit: (v: number) => void;
  onScrub?: (v: number, done: boolean) => void;
  title?: string;
}): HTMLElement {
  const prec = opts.precision ?? 3;
  const input = h('input', { type: 'text', class: 'num', value: fmt(opts.value, prec), title: opts.title });
  const commit = () => {
    const v = evalNumber(input.value);
    if (v === null) { input.value = fmt(opts.value, prec); return; }
    if (Math.abs(v - opts.value) > 1e-9) opts.onCommit(v);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { commit(); input.blur(); }
    if (e.key === 'Escape') { input.value = fmt(opts.value, prec); input.blur(); }
    e.stopPropagation();
  });
  input.addEventListener('blur', commit);
  const lab = h('span', { class: 'num-label', title: 'Drag to scrub' }, opts.label);
  lab.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    lab.setPointerCapture(e.pointerId);
    const x0 = e.clientX, v0 = opts.value, step = opts.step ?? 0.01;
    let v = v0;
    const move = (ev: PointerEvent) => {
      v = v0 + (ev.clientX - x0) * step * (ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1);
      input.value = fmt(v, prec);
      (opts.onScrub ?? ((x: number) => opts.onCommit(x)))(v, false);
    };
    const up = () => {
      lab.removeEventListener('pointermove', move);
      lab.removeEventListener('pointerup', up);
      opts.onScrub?.(v, true);
    };
    lab.addEventListener('pointermove', move);
    lab.addEventListener('pointerup', up);
  });
  return h('label', { class: 'numf' }, lab, input);
}

function fmt(v: number, prec: number) {
  if (!Number.isFinite(v)) return '';
  return String(Math.round(v * 10 ** prec) / 10 ** prec);
}

/** Accepts plain numbers and simple arithmetic ("2*3.5", "-1.2+0.4"). */
export function evalNumber(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  if (!/^[-+*/().\d\se]+$/i.test(t)) return null;
  try {
    const v = Function(`"use strict"; return (${t});`)() as number;
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

export function textField(value: string, onCommit: (v: string) => void, opts: { placeholder?: string; list?: string; multiline?: boolean } = {}) {
  const el = opts.multiline
    ? h('textarea', { rows: 3, placeholder: opts.placeholder ?? '' })
    : h('input', { type: 'text', placeholder: opts.placeholder ?? '', list: opts.list });
  el.value = value;
  const commit = () => { if (el.value !== value) onCommit(el.value); };
  el.addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'Enter' && (!opts.multiline || ke.metaKey || ke.ctrlKey)) { commit(); el.blur(); }
    if (ke.key === 'Escape') { el.value = value; el.blur(); }
    e.stopPropagation();
  });
  el.addEventListener('blur', commit);
  return el;
}

export function checkbox(value: boolean, onChange: (v: boolean) => void, label?: string, title?: string) {
  const c = h('input', { type: 'checkbox' });
  c.checked = value;
  c.addEventListener('change', () => onChange(c.checked));
  return label ? h('label', { class: 'chk', title }, c, label) : c;
}

export function select(options: string[], value: string, onChange: (v: string) => void, labels?: Record<string, string>) {
  const s = h('select', {});
  for (const o of options) s.append(h('option', { value: o }, labels?.[o] ?? o));
  s.value = value;
  s.addEventListener('change', () => onChange(s.value));
  s.addEventListener('keydown', (e) => e.stopPropagation());
  return s;
}

export const ICONS: Record<string, string> = {
  group: '▸', mesh: '◆', instances: '⁂', light: '✸', decal: '▧', marker: '⚑', probeVolume: '⋮', reflectionProbe: '◎', sign: '▭',
};
