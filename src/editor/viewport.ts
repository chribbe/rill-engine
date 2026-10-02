import { mat4, vec3 } from 'wgpu-matrix';
import { isSpatial, type Entity, type Transform } from '../engine/scene/mapformat';
import { transformMatrix } from '../engine/scene/world';
import type { Editor } from './editor';
import { Gizmo, type Handle } from './gizmo';
import { Picker, viewRay, type PickHit, type Ray } from './picking';
import { applyDelta, type Q4, type V3 } from './xform';

/**
 * The editor viewport: the runtime's WebGPU canvas plus a 2D overlay canvas
 * for helpers and gizmos. Owns the editor camera (right-drag look + WASD fly,
 * middle-drag pan, Alt+left orbit, wheel dolly), picking, gizmo drags (as
 * merged `set_transform` operations), asset / material drops and keyboard
 * shortcuts. In play mode it steps aside for the first-person controller.
 */

const LOOK = 0.0032;

export class Viewport {
  readonly overlay: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  readonly picker: Picker;
  readonly gizmo = new Gizmo();
  private keys = new Set<string>();
  private looking = false;
  private panning = false;
  private orbiting: { pivot: V3; dist: number } | null = null;
  private lastMouse: [number, number] = [0, 0];
  private down: { x: number; y: number; button: number; moved: boolean } | null = null;
  private gesture: { key: string; starts: Map<string, Transform>; label: string } | null = null;
  private dropHit: PickHit | null = null;
  mouse: [number, number] = [-1, -1];
  flySpeed = 12;
  info = '';
  private hint = '';
  private hintUntil = 0;

  constructor(readonly ed: Editor, readonly host: HTMLElement, readonly canvas: HTMLCanvasElement) {
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'vp-overlay';
    host.appendChild(this.overlay);
    this.g = this.overlay.getContext('2d')!;
    this.picker = new Picker(ed);
    this.bind();
  }

  get w() { return this.host.clientWidth; }
  get h() { return this.host.clientHeight; }

  showHint(t: string, ms = 1800) {
    this.hint = t;
    this.hintUntil = performance.now() + ms;
  }

  ray(x: number, y: number): Ray {
    return viewRay(this.ed.rt.camera, x, y, this.w, this.h);
  }

  /** What the cursor is over (selection rules: locked geometry occludes but is not selected). */
  pickAt(x: number, y: number): PickHit | null {
    const hit = this.picker.pick(this.ray(x, y), { includeLocked: true });
    if (hit && this.ed.scene.effectiveLocked(hit.id)) return null;
    return hit;
  }

  /** Surface under the cursor for placement (anything visible, locked included). */
  surfaceAt(x: number, y: number, ignore?: Set<string>): PickHit | null {
    return this.picker.pick(this.ray(x, y), { meshesOnly: true, includeLocked: true, ignore });
  }

  // ------------------------------------------------------------------ input

  private bind() {
    const o = this.overlay;
    o.addEventListener('contextmenu', (e) => e.preventDefault());
    o.addEventListener('pointerdown', (e) => this.onDown(e));
    o.addEventListener('pointermove', (e) => this.onMove(e));
    o.addEventListener('pointerup', (e) => this.onUp(e));
    o.addEventListener('dblclick', (e) => {
      const hit = this.pickAt(e.offsetX, e.offsetY);
      if (hit) {
        this.ed.select(hit.id);
        this.focus();
      }
    });
    o.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    o.addEventListener('dragover', (e) => {
      const types = e.dataTransfer?.types ?? [];
      if (!types.includes('application/x-rill-asset') && !types.includes('application/x-rill-material')) return;
      e.preventDefault();
      this.mouse = [e.offsetX, e.offsetY];
      this.dropHit = this.surfaceAt(e.offsetX, e.offsetY);
    });
    o.addEventListener('dragleave', () => (this.dropHit = null));
    o.addEventListener('drop', (e) => {
      e.preventDefault();
      this.dropHit = null;
      const asset = e.dataTransfer?.getData('application/x-rill-asset');
      const material = e.dataTransfer?.getData('application/x-rill-material');
      if (asset) this.placeAt(asset, e.offsetX, e.offsetY);
      else if (material) {
        const hit = this.picker.pick(this.ray(e.offsetX, e.offsetY), { meshesOnly: true, includeLocked: false });
        if (hit?.slot) {
          this.ed.tryExec('assign_material', { ids: [hit.id], slot: hit.slot, material });
          this.ed.select(hit.id);
        } else this.showHint('Drop materials onto an (unlocked) mesh');
      }
    });
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    // Play mode: fire while the mouse is captured.
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0 && document.pointerLockElement === this.canvas) this.ed.rt.sandbox.trigger = true;
    });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.ed.rt.sandbox.trigger = false; });
  }

  private onDown(e: PointerEvent) {
    if (this.ed.mode !== 'edit') return;
    this.overlay.setPointerCapture(e.pointerId);
    this.lastMouse = [e.offsetX, e.offsetY];
    this.down = { x: e.offsetX, y: e.offsetY, button: e.button, moved: false };
    if (e.button === 2) {
      this.looking = true;
      return;
    }
    if (e.button === 1) {
      e.preventDefault();
      this.panning = true;
      return;
    }
    if (e.button !== 0) return;
    if (e.altKey) {
      const hit = this.surfaceAt(e.offsetX, e.offsetY);
      const c = this.ed.rt.camera.position;
      const sel = this.ed.selection.length ? this.ed.boundsOf(this.ed.selection[this.ed.selection.length - 1]) : null;
      const pivot: V3 = sel ? [(sel.min[0] + sel.max[0]) / 2, (sel.min[1] + sel.max[1]) / 2, (sel.min[2] + sel.max[2]) / 2] : hit ? hit.point : [c[0] + this.ed.rt.camera.forward[0] * 10, c[1] + this.ed.rt.camera.forward[1] * 10, c[2] + this.ed.rt.camera.forward[2] * 10];
      this.orbiting = { pivot, dist: Math.hypot(pivot[0] - c[0], pivot[1] - c[1], pivot[2] - c[2]) };
      return;
    }
    if (this.ed.placing) return;
    const h = this.gizmoVisible() ? this.gizmo.hit(e.offsetX, e.offsetY) : null;
    if (h) this.beginGizmo(h, e);
  }

  private onMove(e: PointerEvent) {
    const x = e.offsetX, y = e.offsetY;
    const dx = x - this.lastMouse[0], dy = y - this.lastMouse[1];
    this.lastMouse = [x, y];
    this.mouse = [x, y];
    if (this.down && Math.hypot(x - this.down.x, y - this.down.y) > 3) this.down.moved = true;
    const cam = this.ed.rt.camera;
    if (this.looking) {
      cam.yaw += dx * LOOK;
      cam.pitch = Math.max(-1.55, Math.min(1.55, cam.pitch - dy * LOOK));
      return;
    }
    if (this.panning) {
      const k = this.panScale();
      for (let i = 0; i < 3; i++) cam.position[i] += -cam.right[i] * dx * k + this.up()[i] * dy * k;
      return;
    }
    if (this.orbiting) {
      const o = this.orbiting;
      cam.yaw += dx * LOOK;
      cam.pitch = Math.max(-1.55, Math.min(1.55, cam.pitch - dy * LOOK));
      const cp = Math.cos(cam.pitch), f = [Math.sin(cam.yaw) * cp, Math.sin(cam.pitch), -Math.cos(cam.yaw) * cp];
      for (let i = 0; i < 3; i++) cam.position[i] = o.pivot[i] - f[i] * o.dist;
      return;
    }
    if (this.gizmo.dragging) {
      this.updateGizmo(e);
      return;
    }
    if (this.ed.mode === 'edit' && this.gizmoVisible() && !this.down) this.gizmo.hover = this.gizmo.hit(x, y);
  }

  private onUp(e: PointerEvent) {
    const d = this.down;
    this.down = null;
    this.overlay.releasePointerCapture?.(e.pointerId);
    if (this.looking && e.button === 2) {
      this.looking = false;
      // Right click without dragging: nothing (context menus later).
      return;
    }
    if (e.button === 1) { this.panning = false; return; }
    if (this.orbiting) { this.orbiting = null; return; }
    if (this.gizmo.dragging) {
      this.endGizmo();
      return;
    }
    if (e.button !== 0 || !d || d.moved || this.ed.mode !== 'edit') return;
    if (this.ed.placing) {
      this.placeAt(this.ed.placing, e.offsetX, e.offsetY);
      if (!e.shiftKey) {
        this.ed.placing = null;
        this.ed.emit('tool');
      }
      return;
    }
    const hit = this.pickAt(e.offsetX, e.offsetY);
    const how = e.shiftKey ? 'add' : e.ctrlKey || e.metaKey ? 'toggle' : 'set';
    this.ed.select(hit?.id ?? null, how);
  }

  private onWheel(e: WheelEvent) {
    if (this.ed.mode !== 'edit') return;
    e.preventDefault();
    if (this.looking) {
      this.flySpeed = Math.max(0.5, Math.min(400, this.flySpeed * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
      this.showHint(`Fly speed ${this.flySpeed.toFixed(1)} m/s`);
      return;
    }
    // Dolly towards the point under the cursor, proportional to its distance.
    const hit = this.surfaceAt(e.offsetX, e.offsetY);
    const cam = this.ed.rt.camera;
    const r = this.ray(e.offsetX, e.offsetY);
    const dist = hit ? hit.t : 20;
    const step = Math.max(0.05, dist * 0.12) * Math.sign(-e.deltaY) * Math.min(3, Math.abs(e.deltaY) / 50 + 0.5);
    for (let i = 0; i < 3; i++) cam.position[i] += r.d[i] * step;
  }

  private up(): number[] {
    const c = this.ed.rt.camera;
    const f = c.forward, r = c.right;
    return [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  }

  private panScale() {
    const hit = this.surfaceAt(this.w / 2, this.h / 2);
    const d = hit ? hit.t : 20;
    return (d * Math.tan(this.ed.rt.camera.fovY / 2) * 2) / this.h;
  }

  private onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const ed = this.ed;
    const mod = e.ctrlKey || e.metaKey;
    if (e.code === 'F5' || (mod && e.code === 'KeyP')) {
      e.preventDefault();
      if (ed.mode === 'play') ed.stop();
      else ed.play(e.shiftKey ? 'spawn' : 'camera');
      return;
    }
    if (ed.mode === 'play') {
      if (e.code === 'Escape' && !document.pointerLockElement) ed.stop();
      if (e.code === 'KeyL') ed.rt.sandbox.toggleFlashlight();
      if (e.code === 'KeyX') ed.rt.sandbox.toggleWeapon();
      return;
    }
    this.keys.add(e.code);
    if (this.looking) return; // WASD / QE fly the camera
    if (mod && e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) ed.redo(); else ed.undo(); return; }
    if (mod && e.code === 'KeyY') { e.preventDefault(); ed.redo(); return; }
    if (mod && e.code === 'KeyS') { e.preventDefault(); void ed.save(); return; }
    if (mod && e.code === 'KeyD') { e.preventDefault(); this.duplicate(); return; }
    if (mod && e.code === 'KeyG') {
      e.preventDefault();
      const r = ed.tryExec<{ id: string }>('create_group', { name: 'Group', ids: ed.selectionRoots });
      if (r) ed.select(r.id);
      return;
    }
    if (mod) return;
    switch (e.code) {
      case 'KeyQ': ed.tool = 'select'; ed.emit('tool'); break;
      case 'KeyW': ed.tool = 'translate'; ed.emit('tool'); break;
      case 'KeyE': ed.tool = 'rotate'; ed.emit('tool'); break;
      case 'KeyR': ed.tool = 'scale'; ed.emit('tool'); break;
      case 'KeyX': ed.space = ed.space === 'world' ? 'local' : 'world'; ed.emit('tool'); this.showHint(`Gizmo axes: ${ed.space}`); break;
      case 'KeyF': this.focus(); break;
      case 'KeyH': if (ed.selection.length) ed.tryExec('set_visibility', { ids: ed.selection, visible: false }); break;
      case 'Delete': case 'Backspace':
        if (ed.selection.length) { e.preventDefault(); ed.tryExec('delete_entity', { ids: ed.selectionRoots }); }
        break;
      case 'Escape':
        if (ed.placing) { ed.placing = null; ed.emit('tool'); }
        else ed.setSelection([]);
        break;
      case 'BracketLeft': ed.snap.grid = Math.max(1 / 64, ed.snap.grid / 2); ed.emit('tool'); this.showHint(`Grid ${ed.snap.grid} m`); break;
      case 'BracketRight': ed.snap.grid = Math.min(64, ed.snap.grid * 2); ed.emit('tool'); this.showHint(`Grid ${ed.snap.grid} m`); break;
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': case 'PageUp': case 'PageDown':
        e.preventDefault();
        this.nudge(e.code, e.shiftKey ? 10 : 1);
        break;
    }
  }

  /** Arrow keys: move the selection one grid step along the camera's ground-plane axes; PageUp/Down vertically. */
  private nudge(code: string, mult: number) {
    const ed = this.ed;
    if (!ed.selection.length) return;
    const g = ed.snap.grid * mult, cam = ed.rt.camera;
    const f = [Math.sin(cam.yaw), -Math.cos(cam.yaw)];
    // Snap the camera's facing to the nearest world axis (Hammer-style nudging).
    const fx = Math.abs(f[0]) > Math.abs(f[1]) ? [Math.sign(f[0]), 0] : [0, Math.sign(f[1])];
    const rx = [-fx[1], fx[0]];
    const d: Record<string, V3> = {
      ArrowUp: [fx[0] * g, 0, fx[1] * g], ArrowDown: [-fx[0] * g, 0, -fx[1] * g],
      ArrowRight: [rx[0] * g, 0, rx[1] * g], ArrowLeft: [-rx[0] * g, 0, -rx[1] * g],
      PageUp: [0, g, 0], PageDown: [0, -g, 0],
    };
    ed.tryExec('move_entity', { ids: ed.selectionRoots, delta: d[code] }, { merge: 'nudge', label: 'Nudge' });
  }

  duplicate() {
    const ed = this.ed;
    if (!ed.selection.length) return;
    const r = ed.tryExec<{ ids: string[] }>('duplicate_entity', { ids: ed.selectionRoots });
    if (r) {
      ed.setSelection(r.ids);
      this.showHint(`Duplicated ${r.ids.length} - drag the gizmo to move the copy`);
    }
  }

  /** Frames the selection (or the entity under the cursor). */
  focus() {
    const ed = this.ed;
    let min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
    for (const id of ed.selection) {
      const b = ed.boundsOf(id);
      if (!b) continue;
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], b.min[k]); max[k] = Math.max(max[k], b.max[k]); }
    }
    if (!Number.isFinite(min[0])) return;
    const c = [0, 1, 2].map((k) => (min[k] + max[k]) / 2);
    const r = Math.max(0.5, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
    const cam = ed.rt.camera;
    const dist = Math.min(600, r / Math.tan(cam.fovY / 2) * 1.15);
    for (let i = 0; i < 3; i++) cam.position[i] = c[i] - cam.forward[i] * dist;
  }

  placeAt(asset: string, x: number, y: number) {
    const ed = this.ed;
    const hit = this.surfaceAt(x, y);
    let pos: V3;
    if (hit) pos = hit.point;
    else {
      const r = this.ray(x, y);
      pos = [r.o[0] + r.d[0] * 15, r.o[1] + r.d[1] * 15, r.o[2] + r.d[2] * 15];
    }
    if (ed.snap.enabled) pos = [Math.round(pos[0] / ed.snap.grid) * ed.snap.grid, pos[1], Math.round(pos[2] / ed.snap.grid) * ed.snap.grid];
    const tpl = ENTITY_TEMPLATES[asset];
    if (tpl) {
      const ent = tpl(pos, ed);
      const r = ed.tryExec<{ id: string }>('create_entity', { entity: ent });
      if (r) ed.select(r.id);
      return;
    }
    const r = ed.tryExec<{ id: string }>('place_asset', { asset, position: pos.map((v) => Math.round(v * 1000) / 1000) });
    if (r) ed.select(r.id);
  }

  // ------------------------------------------------------------------ gizmo

  gizmoVisible() {
    const ed = this.ed;
    if (ed.mode !== 'edit' || ed.tool === 'select' || !ed.selection.length) return false;
    return ed.selectionRoots.some((id) => !ed.scene.effectiveLocked(id));
  }

  /** Entities a gizmo drag sets transforms on: the selection roots, groups expanded to their members. */
  private dragTargets(): string[] {
    const ed = this.ed;
    const out: string[] = [];
    const add = (id: string) => {
      const e = ed.scene.get(id);
      if (!e || ed.scene.effectiveLocked(id)) return;
      if (isSpatial(e)) out.push(id);
      else for (const c of ed.scene.children(id)) add(c);
    };
    for (const id of ed.selectionRoots) add(id);
    return out;
  }

  private gizmoFrame(): { origin: V3; rotation?: Q4 } | null {
    const ed = this.ed;
    const roots = ed.selectionRoots.filter((id) => !ed.scene.effectiveLocked(id));
    if (!roots.length) return null;
    const pts = roots.map((id) => ed.pivotOf(id)).filter((p): p is V3 => !!p);
    if (!pts.length) return null;
    const origin = [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length) as V3;
    const prim = ed.primary;
    // Scale always uses local axes (world-axis scaling of rotated objects would shear).
    const local = ed.space === 'local' || ed.tool === 'scale';
    const rotation = local && prim && isSpatial(prim) ? (prim.transform.rotation as Q4 | undefined) : undefined;
    return { origin, rotation };
  }

  private beginGizmo(h: Handle, e: PointerEvent) {
    const targets = this.dragTargets();
    if (!targets.length) return;
    if (!this.gizmo.begin(h, this.ray(e.offsetX, e.offsetY), e.offsetX, e.offsetY)) return;
    const starts = new Map<string, Transform>();
    for (const id of targets) {
      const ent = this.ed.scene.get(id);
      if (ent && isSpatial(ent)) starts.set(id, structuredClone(ent.transform));
    }
    const verb = { translate: 'Move', rotate: 'Rotate', scale: 'Scale' }[this.ed.tool as 'translate' | 'rotate' | 'scale'] ?? 'Transform';
    const n = this.ed.selectionRoots.length;
    this.gesture = { key: `gizmo:${performance.now()}`, starts, label: `${verb} ${n === 1 ? this.ed.primary?.name ?? this.ed.primary?.id : `${n} entities`}` };
  }

  private updateGizmo(e: PointerEvent) {
    const g = this.gesture;
    if (!g) return;
    const ed = this.ed;
    const doSnap = ed.snap.enabled !== (e.ctrlKey || e.metaKey);
    const r = this.gizmo.update(this.ray(e.offsetX, e.offsetY), e.offsetX, e.offsetY, doSnap, ed.snap);
    if (!r) return;
    const transforms: Record<string, Transform> = {};
    for (const [id, t] of g.starts) transforms[id] = applyDelta(r.D, t);
    this.info = r.info;
    ed.tryExec('set_transform', { transforms }, { merge: g.key, label: g.label });
  }

  private endGizmo() {
    this.gizmo.end();
    if (this.gesture) {
      this.ed.history.seal();
      const top = this.ed.history.undoStack[this.ed.history.undoStack.length - 1];
      if (top?.label === this.gesture.label) this.ed.log('op', `${top.label} (${this.info})`);
    }
    this.gesture = null;
    this.info = '';
  }

  // ------------------------------------------------------------------ per frame

  /** Editor camera flight (edit mode). */
  updateCamera(dt: number) {
    if (!this.looking) return;
    const k = this.keys, cam = this.ed.rt.camera;
    let fx = 0, fz = 0, up = 0;
    if (k.has('KeyW')) fz += 1;
    if (k.has('KeyS')) fz -= 1;
    if (k.has('KeyD')) fx += 1;
    if (k.has('KeyA')) fx -= 1;
    if (k.has('KeyE') || k.has('Space')) up += 1;
    if (k.has('KeyQ')) up -= 1;
    const sp = this.flySpeed * (k.has('ShiftLeft') || k.has('ShiftRight') ? 4 : k.has('AltLeft') ? 0.25 : 1) * dt;
    const f = cam.forward, r = cam.right;
    for (let i = 0; i < 3; i++) cam.position[i] += (f[i] * fz + r[i] * fx) * sp + (i === 1 ? up * sp : 0);
  }

  /** Overlay: helpers, selection boxes, gizmo, HUD. */
  draw() {
    const o = this.overlay, ed = this.ed;
    const dpr = window.devicePixelRatio || 1;
    const W = this.w, H = this.h;
    if (o.width !== Math.round(W * dpr) || o.height !== Math.round(H * dpr)) {
      o.width = Math.round(W * dpr);
      o.height = Math.round(H * dpr);
    }
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    o.style.pointerEvents = ed.mode === 'edit' ? 'auto' : 'none';
    if (ed.mode === 'play') {
      this.drawHud(g, W, H);
      return;
    }
    const cam = ed.rt.camera;
    const vp = cam.viewProj;
    const proj = (p: ArrayLike<number>): [number, number, number] | null => {
      const w = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
      if (w <= 0.05) return null;
      const x = (vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12]) / w;
      const y = (vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13]) / w;
      return [(x * 0.5 + 0.5) * W, (0.5 - y * 0.5) * H, w];
    };
    const line = (a: ArrayLike<number>, b: ArrayLike<number>) => {
      // Clip against a near plane in front of the camera.
      const wa = vp[3] * a[0] + vp[7] * a[1] + vp[11] * a[2] + vp[15];
      const wb = vp[3] * b[0] + vp[7] * b[1] + vp[11] * b[2] + vp[15];
      const n = 0.05;
      if (wa <= n && wb <= n) return;
      let A = a, B = b;
      if (wa <= n) { const t = (n - wa) / (wb - wa); A = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
      if (wb <= n) { const t = (n - wb) / (wa - wb); B = [b[0] + (a[0] - b[0]) * t, b[1] + (a[1] - b[1]) * t, b[2] + (a[2] - b[2]) * t]; }
      const pa = proj(A), pb = proj(B);
      if (!pa || !pb) return;
      g.moveTo(pa[0], pa[1]);
      g.lineTo(pb[0], pb[1]);
    };
    const box = (m: ArrayLike<number>) => {
      const c = (i: number) => vec3.transformMat4([(i & 1 ? 0.5 : -0.5), (i & 2 ? 0.5 : -0.5), (i & 4 ? 0.5 : -0.5)], m as Float32Array);
      const E = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
      for (const [i, j] of E) line(c(i), c(j));
    };
    const aabb = (min: ArrayLike<number>, max: ArrayLike<number>) => {
      const m = mat4.translation([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]);
      mat4.scale(m, [max[0] - min[0], max[1] - min[1], max[2] - min[2]], m);
      box(m);
    };
    const sel = new Set(ed.selection);
    const eye = cam.position;
    const near = (p: ArrayLike<number>, r: number) => Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]) < r;

    // Helpers.
    for (const e of ed.scene.entities) {
      if (!isSpatial(e) || !ed.scene.effectiveVisible(e.id)) continue;
      const p = e.transform.position;
      const s = sel.has(e.id) || (e.parent !== undefined && sel.has(e.parent));
      if (e.type === 'light' && (ed.show.lights || s)) {
        if (!s && !near(p, 120)) continue;
        const q = proj(p);
        if (!q) continue;
        const c = e.light.color, col = `rgb(${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0})`;
        g.beginPath();
        g.arc(q[0], q[1], s ? 7 : 5, 0, Math.PI * 2);
        g.fillStyle = col;
        g.fill();
        g.lineWidth = s ? 2 : 1;
        g.strokeStyle = s ? '#ff8a1f' : 'rgba(0,0,0,0.7)';
        g.stroke();
        if (e.light.kind === 'spot' && s) {
          // Cone: axis -Y in light space.
          const m = transformMatrix({ position: p, rotation: e.transform.rotation });
          const r = Math.min(e.light.range, 6);
          const a = ((e.light.outerAngle ?? 60) / 2) * (Math.PI / 180);
          g.beginPath();
          const tip = vec3.transformMat4([0, 0, 0], m);
          for (let i = 0; i < 8; i++) {
            const t = (i / 8) * Math.PI * 2;
            line(tip, vec3.transformMat4([Math.cos(t) * Math.sin(a) * r, -Math.cos(a) * r, Math.sin(t) * Math.sin(a) * r], m));
          }
          g.strokeStyle = 'rgba(255,200,90,0.8)';
          g.lineWidth = 1;
          g.stroke();
        }
      } else if (e.type === 'marker' && (ed.show.markers || s)) {
        const q = proj(p);
        if (!q) continue;
        const spawn = e.semantic === 'spawn';
        const yaw = ((e.yaw ?? 0) * Math.PI) / 180;
        const tipW = vec3.add(p, [Math.sin(yaw) * 1.2, 0, -Math.cos(yaw) * 1.2]);
        const qt = proj(tipW);
        g.beginPath();
        if (spawn) { g.arc(q[0], q[1] - 6, 5, 0, Math.PI * 2); g.moveTo(q[0], q[1] - 1); g.lineTo(q[0], q[1] + 8); }
        else g.rect(q[0] - 6, q[1] - 4, 12, 8);
        if (qt) { g.moveTo(q[0], q[1]); g.lineTo(qt[0], qt[1]); }
        g.strokeStyle = s ? '#ff8a1f' : spawn ? '#5be37d' : '#c9b6ff';
        g.lineWidth = s ? 2.5 : 1.5;
        g.stroke();
      } else if (e.type === 'decal' && (s || (ed.show.decals && near(p, 18)))) {
        const m = transformMatrix({ position: p, rotation: e.transform.rotation });
        mat4.scale(m, e.decal.size, m);
        g.beginPath();
        box(m);
        g.strokeStyle = s ? '#ff8a1f' : 'rgba(120,200,255,0.35)';
        g.lineWidth = s ? 1.5 : 1;
        g.stroke();
      } else if (e.type === 'sign' && s) {
        const m = transformMatrix({ position: p, rotation: e.transform.rotation });
        mat4.scale(m, [e.sign.size[0], e.sign.size[1], Math.max(0.02, e.sign.depth ?? 0.02)], m);
        g.beginPath();
        box(m);
        g.strokeStyle = '#ff8a1f';
        g.lineWidth = 1.5;
        g.stroke();
      } else if ((e.type === 'reflectionProbe' || e.type === 'probeVolume') && (ed.show.probes || s)) {
        const q = proj(p);
        if (q && (s || near(p, 150))) {
          g.beginPath();
          g.arc(q[0], q[1], 6, 0, Math.PI * 2);
          g.strokeStyle = s ? '#ff8a1f' : 'rgba(110,190,255,0.8)';
          g.lineWidth = 1.5;
          g.stroke();
          g.beginPath();
          g.arc(q[0], q[1], 2.5, 0, Math.PI * 2);
          g.fillStyle = 'rgba(110,190,255,0.9)';
          g.fill();
        }
        if (s) {
          g.beginPath();
          if (e.type === 'reflectionProbe') aabb(e.probe.boxMin, e.probe.boxMax);
          else aabb(p.map((v, k) => v - e.volume.size[k] / 2), p.map((v, k) => v + e.volume.size[k] / 2));
          g.strokeStyle = 'rgba(255,138,31,0.8)';
          g.lineWidth = 1;
          g.stroke();
        }
      }
    }
    // Selected groups / multi-selection: bounds.
    for (const id of ed.selection) {
      const e = ed.scene.get(id);
      if (e?.type !== 'group') continue;
      const b = ed.boundsOf(id);
      if (!b) continue;
      g.beginPath();
      aabb(b.min, b.max);
      g.setLineDash([5, 4]);
      g.strokeStyle = 'rgba(255,138,31,0.9)';
      g.lineWidth = 1;
      g.stroke();
      g.setLineDash([]);
    }
    // Drop / placement preview.
    const ph = this.dropHit ?? (ed.placing && this.mouse[0] >= 0 ? this.surfaceAt(this.mouse[0], this.mouse[1]) : null);
    if (ph) {
      const q = proj(ph.point);
      if (q) {
        g.beginPath();
        g.arc(q[0], q[1], 8, 0, Math.PI * 2);
        g.moveTo(q[0] - 12, q[1]); g.lineTo(q[0] + 12, q[1]);
        g.moveTo(q[0], q[1] - 12); g.lineTo(q[0], q[1] + 12);
        g.strokeStyle = '#5be37d';
        g.lineWidth = 2;
        g.stroke();
      }
    }
    // Gizmo.
    if (this.gizmoVisible()) {
      const f = this.gizmoFrame();
      if (f) {
        this.gizmo.layout(cam, W, H, f.origin, f.rotation, ed.tool as 'translate' | 'rotate' | 'scale');
        this.gizmo.draw(g);
      }
    } else this.gizmo.hover = null;
    this.drawHud(g, W, H);
  }

  private drawHud(g: CanvasRenderingContext2D, W: number, H: number) {
    const ed = this.ed;
    g.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.textBaseline = 'top';
    const lines: string[] = [];
    if (ed.mode === 'play') {
      lines.push(document.pointerLockElement ? 'PLAY  ·  WASD move · Shift run · Space jump · F fly · L flashlight · X weapon · Esc release mouse' : 'PLAY  ·  click the view to capture the mouse · F5 or Esc to stop');
    } else {
      const c = ed.rt.camera.position;
      lines.push(`${ed.tool.toUpperCase()}  ${ed.space}  snap ${ed.snap.enabled ? `${ed.snap.grid} m / ${ed.snap.angle}°` : 'off'}   cam ${c[0].toFixed(1)} ${c[1].toFixed(1)} ${c[2].toFixed(1)}  ${this.flySpeed.toFixed(0)} m/s`);
      if (ed.placing) lines.push(`Placing ${ed.placing}: click to place (Shift: keep placing) · Esc to cancel`);
      if (this.info) lines.push(this.info);
    }
    if (performance.now() < this.hintUntil) lines.push(this.hint);
    let y = 8;
    for (const l of lines) {
      const w = g.measureText(l).width;
      g.fillStyle = 'rgba(10,12,14,0.6)';
      g.fillRect(8, y - 2, w + 10, 16);
      g.fillStyle = ed.mode === 'play' ? '#9fe8b0' : '#dfe3e8';
      g.fillText(l, 13, y + 1);
      y += 18;
    }
    void H;
  }
}

/** Built-in entity templates (asset browser "Entities" category), keyed by pseudo asset ID. */
export const ENTITY_TEMPLATES: Record<string, (p: V3, ed: Editor) => Partial<Entity> & { type: Entity['type'] }> = {
  'entity:point_light': (p) => ({ name: 'Point light', type: 'light', semantic: 'light', transform: { position: [p[0], p[1] + 2.5, p[2]] }, light: { kind: 'point', color: [1, 0.85, 0.7], intensity: 400, range: 10, sourceRadius: 0.05, fogScatter: 0.5 } }),
  'entity:spot_light': (p) => ({ name: 'Spot light', type: 'light', semantic: 'light', transform: { position: [p[0], p[1] + 4, p[2]] }, light: { kind: 'spot', color: [1, 0.8, 0.6], intensity: 1500, range: 16, innerAngle: 30, outerAngle: 60, sourceRadius: 0.1, fogScatter: 1 } }),
  'entity:decal': (p) => ({ name: 'Decal', type: 'decal', semantic: 'decal', transform: { position: p, rotation: [-0.707107, 0, 0, 0.707107] }, decal: { material: 'decal_stain', size: [1.5, 1.5, 0.3], opacity: 1 } }),
  'entity:sign': (p) => ({ name: 'Sign', type: 'sign', semantic: 'sign', transform: { position: [p[0], p[1] + 2.5, p[2]] }, sign: { text: 'SIGN', size: [1.6, 0.4], color: '#ffffff', background: '#1b4f9c' } }),
  'entity:viewpoint': (p, ed) => ({ name: 'Viewpoint', type: 'marker', semantic: 'viewpoint', transform: { position: [p[0], p[1], p[2]] }, yaw: Math.round((ed.rt.camera.yaw * 180) / Math.PI) }),
  'entity:reflection_probe': (p) => ({ name: 'Reflection probe', type: 'reflectionProbe', semantic: 'lighting', transform: { position: [p[0], p[1] + 1.5, p[2]] }, probe: { boxMin: [p[0] - 5, p[1] - 0.2, p[2] - 5], boxMax: [p[0] + 5, p[1] + 4, p[2] + 5], blend: 1, priority: 1 } }),
  'entity:group': () => ({ name: 'Group', type: 'group' }),
};
