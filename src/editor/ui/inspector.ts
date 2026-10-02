import { isSpatial, type Entity, type Transform } from '../../engine/scene/mapformat';
import { transformMatrix } from '../../engine/scene/world';
import type { Editor } from '../editor';
import { editableProperties } from '../commands';
import { eulerToQuat, quatToEuler, type V3 } from '../xform';
import { checkbox, clear, h, ICONS, numberField, select, textField } from './dom';

/**
 * Properties of the selected entity. Every field commits through an editor
 * operation (set_transform, set_property, assign_material...); dragging a
 * field label scrubs the value as one merged undo step.
 */
export class Inspector {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private shown: Entity | null = null;
  private shownSel = '';
  private scrubbing = false;

  constructor(readonly ed: Editor) {
    this.body = h('div', { class: 'insp-body' });
    this.el = h('div', { class: 'inspector' }, h('div', { class: 'panel-head' }, h('span', {}, 'Inspector')), this.body);
    const refresh = () => {
      if (this.scrubbing) return;
      const p = ed.primary ?? null;
      const key = `${ed.selection.join('|')}#${ed.subSelection ?? ''}`;
      if (p === this.shown && key === this.shownSel) return;
      this.render();
    };
    ed.on('selection', refresh);
    ed.on('scene', refresh);
    ed.on('status', () => { this.shown = null; refresh(); });
    this.render();
  }

  private render() {
    const ed = this.ed;
    clear(this.body);
    const e = ed.primary ?? null;
    this.shown = e;
    this.shownSel = `${ed.selection.join('|')}#${ed.subSelection ?? ''}`;
    if (!e) {
      this.body.append(h('div', { class: 'insp-empty' }, 'Nothing selected.', h('br'), h('small', {}, 'Click an object in the viewport or the scene list. Drag assets from the Assets tab into the view to place them.')));
      return;
    }
    const ids = ed.selection;
    const sameType = ids.filter((id) => ed.scene.get(id)?.type === e.type);
    const multi = ids.length > 1;
    const set = (key: string, value: unknown) => ed.tryExec('set_property', { ids: sameType.filter((id) => editableProperties(ed.scene.get(id)!.type).includes(key)), key, value });

    // Header.
    this.body.append(h('div', { class: 'insp-title' },
      h('span', { class: `ol-icon t-${e.type}` }, ICONS[e.type] ?? '•'),
      h('span', { class: 'insp-type' }, e.type),
      h('code', { class: 'insp-id', title: 'Stable ID (click to copy)', onclick: () => navigator.clipboard?.writeText(e.id) }, e.id),
    ));
    if (multi) this.body.append(h('div', { class: 'insp-multi' }, `${ids.length} selected · fields edit the ${sameType.length} ${e.type} entit${sameType.length === 1 ? 'y' : 'ies'}; transform edits the last selected`));

    const sec = (title: string, ...rows: (HTMLElement | null | false)[]) => {
      this.body.append(h('div', { class: 'insp-sec' }, h('div', { class: 'insp-sec-title' }, title), ...rows.filter(Boolean) as HTMLElement[]));
    };
    const row = (label: string, ...field: (HTMLElement | string)[]) => h('div', { class: 'insp-row' }, h('span', { class: 'insp-label' }, label), h('div', { class: 'insp-field' }, ...field));

    sec('Entity',
      row('Name', textField(e.name ?? '', (v) => set('name', v || null), { placeholder: e.id })),
      row('Semantic', textField(e.semantic ?? '', (v) => set('semantic', v || null), { placeholder: 'building, tree, streetlight…', list: 'rill-semantics' })),
      row('Tags', textField((e.tags ?? []).join(', '), (v) => set('tags', v.trim() ? v.split(',').map((t) => t.trim()).filter(Boolean) : null), { placeholder: 'comma separated' })),
      row('Parent', h('span', { class: 'insp-ro' }, e.parent ? `${ed.scene.get(e.parent)?.name ?? e.parent}` : '—')),
      row('', checkbox(e.visible !== false, (v) => ed.tryExec('set_visibility', { ids, visible: v }), 'Visible'), checkbox(e.locked === true, (v) => ed.tryExec('set_locked', { ids, locked: v }), 'Locked', 'Not pickable in the viewport; transforms and delete refused')),
    );

    if (isSpatial(e)) this.transformSection(e, sec, row);

    switch (e.type) {
      case 'mesh':
      case 'instances':
        this.meshSection(e, sec, row, set);
        break;
      case 'light': {
        const l = e.light;
        const col = '#' + l.color.map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0')).join('');
        const ci = h('input', { type: 'color', value: col });
        ci.addEventListener('change', () => {
          const v = ci.value;
          set('light.color', [1, 3, 5].map((i) => Math.round((parseInt(v.slice(i, i + 2), 16) / 255) * 1000) / 1000));
        });
        sec('Light',
          row('Kind', select(['point', 'spot'], l.kind, (v) => set('light.kind', v))),
          row('Colour', ci),
          row('Intensity', this.num('cd', l.intensity, 10, 0, (v, m) => this.prop(sameType, 'light.intensity', Math.max(0, v), m))),
          row('Range', this.num('m', l.range, 0.1, 2, (v, m) => this.prop(sameType, 'light.range', Math.max(0.1, v), m))),
          l.kind === 'spot' && row('Cone', this.num('in°', l.innerAngle ?? 30, 0.5, 1, (v, m) => this.prop(sameType, 'light.innerAngle', v, m)), this.num('out°', l.outerAngle ?? 60, 0.5, 1, (v, m) => this.prop(sameType, 'light.outerAngle', v, m))),
          row('Source', this.num('r m', l.sourceRadius ?? 0.05, 0.005, 3, (v, m) => this.prop(sameType, 'light.sourceRadius', Math.max(0, v), m)), this.num('fog', l.fogScatter ?? 1, 0.01, 2, (v, m) => this.prop(sameType, 'light.fogScatter', Math.max(0, v), m))),
          row('', checkbox(l.always === true, (v) => set('light.always', v || null), 'Indoor (on in every mood)')),
        );
        break;
      }
      case 'decal': {
        const d = e.decal;
        const mats = ed.materials.filter((m) => m.decal).map((m) => m.name);
        sec('Decal',
          row('Material', select(mats.includes(d.material) ? mats : [d.material, ...mats], d.material, (v) => set('decal.material', v))),
          row('Size', ...[0, 1, 2].map((k) => this.num(['w', 'h', 'depth'][k], d.size[k], 0.01, 3, (v, m) => { const s = [...d.size]; s[k] = Math.max(0.01, v); this.prop([e.id], 'decal.size', s, m); }))),
          row('Opacity', this.num('', d.opacity ?? 1, 0.01, 2, (v, m) => this.prop(sameType, 'decal.opacity', Math.max(0, Math.min(1, v)), m)), this.num('repeat', d.repeat ?? 1, 0.1, 2, (v, m) => this.prop(sameType, 'decal.repeat', Math.max(0.01, v), m))),
        );
        break;
      }
      case 'sign': {
        const s = e.sign;
        sec('Sign',
          row('Text', textField(s.text, (v) => set('sign.text', v), { multiline: true })),
          row('Size', this.num('w', s.size[0], 0.01, 2, (v, m) => this.prop([e.id], 'sign.size', [Math.max(0.05, v), s.size[1]], m)), this.num('h', s.size[1], 0.01, 2, (v, m) => this.prop([e.id], 'sign.size', [s.size[0], Math.max(0.05, v)], m))),
          row('Font', select(['Barlow Condensed', 'Jost', 'Archivo Black', 'Pacifico', 'Inter'], s.font ?? 'Barlow Condensed', (v) => set('sign.font', v))),
          row('Colours', textField(s.color ?? '#ffffff', (v) => set('sign.color', v || null), { placeholder: 'text' }), textField(s.background ?? '', (v) => set('sign.background', v || null), { placeholder: 'background' })),
          row('Backlit', this.num('', s.backlit ?? 0, 0.1, 2, (v, m) => this.prop(sameType, 'sign.backlit', Math.max(0, v), m)), this.num('depth', s.depth ?? 0, 0.01, 2, (v, m) => this.prop(sameType, 'sign.depth', Math.max(0, v), m))),
        );
        break;
      }
      case 'marker':
        sec('Marker',
          row('View', this.num('yaw°', e.yaw ?? 0, 0.5, 1, (v, m) => this.prop([e.id], 'yaw', v, m)), this.num('pitch°', e.pitch ?? 0, 0.5, 1, (v, m) => this.prop([e.id], 'pitch', v, m))),
          row('', h('button', { onclick: () => this.markerFromCamera(e.id) }, 'Set from camera'), h('button', { onclick: () => this.gotoMarker(e) }, 'Look through')),
        );
        break;
      case 'reflectionProbe': {
        const p = e.probe;
        sec('Reflection probe',
          row('Box min', ...[0, 1, 2].map((k) => this.num('xyz'[k], p.boxMin[k], 0.05, 2, (v, m) => { const b = [...p.boxMin]; b[k] = v; this.prop([e.id], 'probe.boxMin', b, m); }))),
          row('Box max', ...[0, 1, 2].map((k) => this.num('xyz'[k], p.boxMax[k], 0.05, 2, (v, m) => { const b = [...p.boxMax]; b[k] = v; this.prop([e.id], 'probe.boxMax', b, m); }))),
          row('Blend', this.num('m', p.blend ?? 1.5, 0.05, 2, (v, m) => this.prop([e.id], 'probe.blend', Math.max(0, v), m)), this.num('priority', p.priority ?? 0, 1, 0, (v, m) => this.prop([e.id], 'probe.priority', Math.round(v), m))),
        );
        break;
      }
      case 'probeVolume':
        sec('Probe volume (baked)',
          row('Size', ...[0, 1, 2].map((k) => this.num('xyz'[k], e.volume.size[k], 0.5, 1, (v, m) => { const s = [...e.volume.size]; s[k] = Math.max(1, v); this.prop([e.id], 'volume.size', s, m); }))),
          row('Spacing', ...[0, 1, 2].map((k) => this.num('xyz'[k], e.volume.spacing[k], 0.1, 2, (v, m) => { const s = [...e.volume.spacing]; s[k] = Math.max(0.5, v); this.prop([e.id], 'volume.spacing', s, m); }))),
          h('div', { class: 'insp-note' }, 'Probe volumes are baked with the lightmaps (Bake lighting).'),
        );
        break;
      case 'scatter': {
        const sc = e.scatter;
        const rto = ed.rt.world.objects.get(e.id);
        const presets = ed.scatterPresets.map((p) => p.name);
        const pinfo = ed.scatterPresets.find((p) => p.name === sc.preset);
        const n = rto?.renderables.length ?? 0;
        const brush = sc.brush ?? [];
        sec('Scatter',
          row('Preset', select(presets.includes(sc.preset) ? presets : [sc.preset, ...presets], sc.preset, (v) => set('scatter.preset', v), Object.fromEntries(ed.scatterPresets.map((p) => [p.name, p.title])))),
          pinfo?.description ? h('div', { class: 'insp-note' }, pinfo.description) : null,
          row('Density', this.num('/100m²', sc.density ?? pinfo?.density ?? 1, 0.05, 2, (v, m) => this.prop([e.id], 'scatter.density', Math.max(0.05, Math.min(60, v)), m)),
            h('button', { class: 'mini', title: 'Use the preset density', onclick: () => set('scatter.density', null) }, '↺')),
          row('Seed', this.num('', sc.seed, 1, 0, (v, m) => this.prop([e.id], 'scatter.seed', Math.round(Math.abs(v)), m)),
            h('button', { onclick: () => set('scatter.seed', Math.floor(Math.random() * 100000)) }, 'Reroll')),
          row('Slope max', this.num('°', sc.slopeMax ?? 40, 0.5, 1, (v, m) => this.prop([e.id], 'scatter.slopeMax', Math.max(1, Math.min(89, v)), m))),
          row('On', textField((sc.surfaces ?? ['terrain']).join(', '), (v) => set('scatter.surfaces', v.trim() ? v.split(',').map((x) => x.trim()).filter(Boolean) : null), { placeholder: 'ground semantics, e.g. terrain' })),
          row('', h('span', { class: 'insp-ro small' }, `${n} instances · ${brush.length} brush circles${sc.area ? ' · area polygon' : ''} · ${sc.exclude?.length ?? 0} removed${rto?.scatter ? ` · ${rto.scatter.ms.toFixed(1)} ms` : ''}`)),
          row('', h('button', { onclick: () => { ed.tool = 'paint'; ed.emit('tool'); } }, 'Paint (B)'),
            h('button', { disabled: !brush.length, onclick: () => set('scatter.brush', null) }, 'Clear brush'),
            h('button', { disabled: !sc.exclude?.length, onclick: () => set('scatter.exclude', null) }, 'Restore removed')),
          row('', h('button', { title: 'Replace the scatter by ordinary mesh entities (hand placement)', onclick: () => ed.tryExec('scatter_detach', { id: e.id }) }, 'Convert to entities')),
          ed.subSelection ? h('div', { class: 'insp-sub' },
            h('span', {}, `Instance ${ed.subSelection}`),
            h('button', { onclick: () => ed.tryExec('scatter_remove', { id: e.id, keys: [ed.subSelection!] }) }, 'Remove (Del)'),
            h('button', { title: 'Make this instance an ordinary entity', onclick: () => { const r = ed.tryExec<{ ids: string[] }>('scatter_detach', { id: e.id, keys: [ed.subSelection!] }); if (r) ed.setSelection(r.ids); } }, 'Detach')) : null,
        );
        break;
      }
      case 'spline': {
        const sp = e.spline;
        const rto = ed.rt.world.objects.get(e.id);
        const b = rto?.spline?.build;
        const presets = ed.splinePresets.map((p) => p.name);
        const pinfo = ed.splinePresets.find((p) => p.name === sp.preset);
        const widthy = rto?.spline?.preset.parts.some((pt) => pt.widthFromSpline);
        const pi = ed.subSelection?.startsWith('p') ? +ed.subSelection.slice(1) : -1;
        // World XZ of the selected point (local -> world through the entity transform).
        const wp = pi >= 0 && sp.points[pi] ? (() => {
          const M = transformMatrix(e.transform), q = sp.points[pi];
          return [M[0] * q[0] + M[8] * q[2] + M[12], 0, M[2] * q[0] + M[10] * q[2] + M[14]];
        })() : undefined;
        sec('Spline',
          row('Preset', select(presets.includes(sp.preset) ? presets : [sp.preset, ...presets], sp.preset, (v) => ed.tryExec('modify_spline', { id: e.id, preset: v }), Object.fromEntries(ed.splinePresets.map((p) => [p.name, p.title])))),
          pinfo?.description ? h('div', { class: 'insp-note' }, pinfo.description) : null,
          widthy ? row('Width', this.num('m', sp.width ?? rto?.spline?.preset.width ?? 2.5, 0.01, 2, (v, m) => this.prop([e.id], 'spline.width', Math.max(0.2, v), m)),
            h('button', { class: 'mini', title: 'Preset width', onclick: () => set('spline.width', null) }, '↺')) : null,
          row('', checkbox(!!sp.closed, (v) => ed.tryExec('modify_spline', { id: e.id, closed: v }), 'Closed loop'), checkbox(sp.drape !== false, (v) => set('spline.drape', v ? null : false), 'Follow ground')),
          row('', h('span', { class: 'insp-ro small' }, `${sp.points.length} points · ${b ? b.length.toFixed(1) : '?'} m${b?.lightmapResolution ? ` · lightmap ${b.lightmapResolution.join('×')}` : ' · not lightmapped'}${rto?.spline ? ` · ${rto.spline.ms.toFixed(1)} ms` : ''}`)),
          row('', h('button', { onclick: () => set('spline.points', [...sp.points].reverse()) }, 'Reverse'), h('button', { onclick: () => { ed.tool = 'spline'; ed.emit('tool'); } }, 'Extend (N)')),
          h('div', { class: 'insp-note' }, 'Drag the orange points in the view; with the Spline tool, clicks extend from the nearest end. Del removes a selected point.'),
          pi >= 0 && wp ? h('div', { class: 'insp-sub' },
            h('span', {}, `Point ${pi}`),
            ...[0, 2].map((k) => this.num('xz'[k / 2], wp[k], 0.05, 2, (v) => { const q = [...wp]; q[k] = v; ed.tryExec('modify_spline', { id: e.id, move: { index: pi, point: q } }); })),
            h('button', { disabled: sp.points.length <= 2, onclick: () => { ed.tryExec('modify_spline', { id: e.id, remove: pi }); ed.setSelection([e.id]); } }, 'Remove')) : null,
        );
        break;
      }
      case 'group': {
        const n = ed.scene.descendants(e.id).length;
        sec('Group', row('Members', h('span', { class: 'insp-ro' }, `${ed.scene.children(e.id).length} children, ${n} descendants`)),
          row('', h('button', { onclick: () => ed.setSelection(ed.scene.children(e.id)) }, 'Select children')));
        break;
      }
    }
  }

  /** Number input bound to an operation; scrubbing merges into one undo entry. */
  private num(label: string, value: number, step: number, precision: number, apply: (v: number, merge?: string) => void) {
    let key = '';
    return numberField({
      label, value, step, precision,
      onCommit: (v) => apply(v),
      onScrub: (v, done) => {
        if (!key) { key = `scrub:${performance.now()}`; this.scrubbing = true; }
        if (!done) apply(v, key);
        else {
          this.ed.history.seal();
          key = '';
          this.scrubbing = false;
          this.shown = null;
          this.render();
        }
      },
    });
  }

  private prop(ids: string[], key: string, value: unknown, merge?: string) {
    this.ed.tryExec('set_property', { ids, key, value }, merge ? { merge, label: `Set ${key}` } : {});
  }

  private transformSection(e: Exclude<Entity, { type: 'group' }>, sec: (t: string, ...r: (HTMLElement | null | false)[]) => void, row: (l: string, ...f: (HTMLElement | string)[]) => HTMLElement) {
    const ed = this.ed;
    const t = e.transform;
    const eul = quatToEuler(t.rotation);
    const sc = t.scale ?? [1, 1, 1];
    const locked = ed.scene.effectiveLocked(e.id);
    const commit = (next: Transform, merge?: string) => ed.tryExec('set_transform', { transforms: { [e.id]: next } }, merge ? { merge, label: 'Transform' } : {});
    const withPos = (k: number, v: number): Transform => { const p = [...t.position] as V3; p[k] = v; return { ...t, position: p }; };
    const withRot = (k: number, v: number): Transform => { const r = [...eul] as V3; r[k] = v; const q = eulerToQuat(r); return { ...t, rotation: Math.abs(q[3]) > 1 - 1e-12 ? undefined : q }; };
    const withScale = (k: number, v: number): Transform => { const s = [...sc] as V3; s[k] = v; return { ...t, scale: s.every((x) => x === 1) ? undefined : s }; };
    const pivot = ed.pivotOf(e.id);
    const anchored = e.type === 'mesh' && pivot && Math.hypot(pivot[0] - t.position[0], pivot[2] - t.position[2]) > 1;
    sec('Transform',
      row('Position', ...[0, 1, 2].map((k) => this.num('xyz'[k], t.position[k], 0.01, 3, (v, m) => commit(withPos(k, v), m)))),
      e.type !== 'marker' && row('Rotation', ...[0, 1, 2].map((k) => this.num('xyz'[k], eul[k], 0.5, 2, (v, m) => commit(withRot(k, v), m)))),
      (e.type === 'mesh' || e.type === 'sign') && row('Scale', ...[0, 1, 2].map((k) => this.num('xyz'[k], sc[k], 0.01, 3, (v, m) => commit(withScale(k, v || 1), m)))),
      anchored ? h('div', { class: 'insp-note' }, 'World-anchored geometry: the gizmo pivots about the bounds; numeric rotation turns about the map origin.') : null,
      locked ? h('div', { class: 'insp-note warn' }, 'Locked: transform edits are refused.') : null,
    );
  }

  private meshSection(e: Extract<Entity, { type: 'mesh' | 'instances' }>, sec: (t: string, ...r: (HTMLElement | null | false)[]) => void, row: (l: string, ...f: (HTMLElement | string)[]) => HTMLElement, set: (k: string, v: unknown) => void) {
    const ed = this.ed;
    const r = ed.renderablesOf(e.id)[0];
    const slots = r ? [...new Set(r.mesh.primitives.map((p) => p.material))] : Object.keys(e.materialOverrides ?? {});
    const asset = ed.assets.get(e.asset);
    const flags = e.type === 'mesh' ? [
      checkbox(e.static ?? true, (v) => set('static', v), 'Static'),
      checkbox(e.castShadow ?? true, (v) => set('castShadow', v), 'Shadows'),
      checkbox(e.collision ?? e.static ?? true, (v) => set('collision', v), 'Collision'),
      checkbox(e.receiveDecals !== false, (v) => set('receiveDecals', v ? null : false), 'Decals'),
    ] : [checkbox(e.castShadow ?? true, (v) => set('castShadow', v), 'Shadows')];
    const lm = e.type === 'mesh' && e.lightmap
      ? (ed.rt.world.lightmaps?.doc.objects[e.id] ? `baked (${e.lightmap.resolution.join('×')} texels)${ed.rt.world.lightingStale ? ' - scene changed since the bake' : ''}` : `not baked yet (${e.lightmap.resolution.join('×')}) - Bake lighting`)
      : 'probe lit (not lightmapped)';
    sec(e.type === 'mesh' ? 'Mesh' : 'Instances',
      row('Asset', h('span', { class: 'insp-ro', title: e.asset }, asset ? `${asset.name}` : e.asset.split('/').pop()!)),
      row('', ...flags.slice(0, 2)),
      flags.length > 2 ? row('', ...flags.slice(2)) : null,
      row('Lighting', h('span', { class: 'insp-ro small' }, lm)),
    );
    if (!slots.length) return;
    const names = ed.materials.filter((m) => !m.decal).map((m) => m.name);
    const rows = slots.map((slot) => {
      const ov = e.materialOverrides?.[slot];
      const cur = typeof ov === 'string' ? ov : typeof ov === 'object' ? `${ov.inherits ?? slot} (edited)` : slot;
      const input = h('input', { type: 'text', list: 'rill-materials', value: typeof ov === 'object' ? ov.inherits ?? slot : cur, title: 'Material (type to search; Enter to apply)' });
      const apply = () => {
        const v = input.value.trim();
        if (!v || v === (typeof ov === 'string' ? ov : slot)) return;
        if (!names.includes(v)) { ed.log('warn', `No material '${v}'`); return; }
        ed.tryExec('assign_material', { ids: [e.id, ...ed.selection.filter((id) => id !== e.id && ed.scene.get(id)?.type === e.type)], slot, material: v });
      };
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') apply(); ev.stopPropagation(); });
      input.addEventListener('change', apply);
      const tint = typeof ov === 'object' && Array.isArray(ov.baseColorFactor) ? ov.baseColorFactor as number[] : null;
      const ci = h('input', { type: 'color', value: tint ? '#' + tint.slice(0, 3).map((c) => Math.round(Math.min(1, c) * 255).toString(16).padStart(2, '0')).join('') : '#ffffff', title: 'Tint (per-object material override)' });
      ci.addEventListener('change', () => {
        const v = ci.value;
        ed.tryExec('set_material_parameter', { ids: [e.id], slot, param: 'baseColorFactor', value: [1, 3, 5].map((i) => Math.round((parseInt(v.slice(i, i + 2), 16) / 255) * 1000) / 1000) });
      });
      const reset = h('button', { class: 'mini', title: 'Restore the asset\'s material', disabled: ov === undefined, onclick: () => ed.tryExec('assign_material', { ids: [e.id], slot, material: null }) }, '↺');
      return h('div', { class: 'insp-mat' }, h('div', { class: 'insp-mat-slot', title: `slot ${slot}` }, slot, ov !== undefined ? h('span', { class: 'ov' }, ' • override') : ''), h('div', { class: 'insp-mat-row' }, input, ci, reset));
    });
    sec('Materials', ...rows, h('div', { class: 'insp-note' }, 'Tip: drag a material from the Materials tab onto a surface in the view.'));
  }

  private markerFromCamera(id: string) {
    const ed = this.ed, c = ed.rt.camera;
    ed.history.begin('Viewpoint from camera');
    try {
      ed.exec('set_transform', { transforms: { [id]: { position: [c.position[0], c.position[1] - 1.65, c.position[2]].map((v) => Math.round(v * 100) / 100) } } }, { quiet: true });
      ed.exec('set_property', { ids: [id], key: 'yaw', value: Math.round(((c.yaw * 180) / Math.PI) * 10) / 10 }, { quiet: true });
      ed.exec('set_property', { ids: [id], key: 'pitch', value: Math.round(((c.pitch * 180) / Math.PI) * 10) / 10 }, { quiet: true });
      ed.history.commit();
    } catch {
      ed.history.rollback();
    }
  }

  private gotoMarker(e: Extract<Entity, { type: 'marker' }>) {
    const c = this.ed.rt.camera, p = e.transform.position;
    c.position[0] = p[0]; c.position[1] = p[1] + 1.65; c.position[2] = p[2];
    c.yaw = ((e.yaw ?? 0) * Math.PI) / 180;
    c.pitch = ((e.pitch ?? 0) * Math.PI) / 180;
  }
}
