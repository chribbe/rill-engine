import { mat4, quat, vec3 } from 'wgpu-matrix';
import { BLOCK_MATERIAL, blockFaces, FACE_AXIS, FACE_LABELS, type BlockShape } from '../engine/scene/blocks';
import type { BlockObject } from '../engine/scene/mapformat';
import { blockAxis, blockFrame, boxCorners, clampOpening, faceFrame, openingBox, wallCoords, wallFrame, type WallFrame } from './blockedit';
import type { Editor } from './editor';
import type { PickHit, Ray } from './picking';
import type { Viewport } from './viewport';
import { axisAngleQuat, type Q4, type V3 } from './xform';

/**
 * Blockout in the viewport (tool B, plus face handles in the select / scale
 * tools):
 *
 * - Draw: drag a footprint on any surface (floors, walls, other blocks; snapped
 *   to the grid in the surface's frame), release, move the mouse to set the
 *   height, click. A click without dragging stamps the last size. Stairs and
 *   ramps climb in the direction you drag (Tab turns them).
 * - Face handles on a selected block: drag to push / pull a face, Shift+drag to
 *   extrude a new block from it.
 * - Openings: hover a wall, click to cut a door / window (or drag a custom one).
 */

export type DrawShape = BlockShape | 'room';
export type OpeningPreset = 'door' | 'double_door' | 'window' | 'wide_window' | 'passage' | 'custom';

export const OPENINGS: Record<Exclude<OpeningPreset, 'custom'>, { label: string; size: [number, number]; bottom: number }> = {
  door: { label: 'Door', size: [0.9, 2.1], bottom: 0 },
  double_door: { label: 'Double door', size: [1.6, 2.1], bottom: 0 },
  window: { label: 'Window', size: [1.2, 1.2], bottom: 0.9 },
  wide_window: { label: 'Wide window', size: [2.4, 1.2], bottom: 0.9 },
  passage: { label: 'Passage', size: [1.8, 2.5], bottom: 0 },
};

export interface BlockToolState {
  mode: 'draw' | 'opening';
  shape: DrawShape;
  material: string;
  /** Rooms: wall thickness and whether to add a ceiling. */
  thickness: number;
  ceiling: boolean;
  opening: OpeningPreset;
  /** Last drawn size per shape (stamped by a plain click). */
  last: Record<DrawShape, V3>;
}

export function defaultBlockTool(): BlockToolState {
  return {
    mode: 'draw', shape: 'box', material: BLOCK_MATERIAL, thickness: 0.2, ceiling: true, opening: 'door',
    last: { box: [1, 1, 1], wedge: [2, 1, 3], stairs: [1.2, 1.7, 2.8], cylinder: [0.6, 3, 0.6], room: [6, 3, 5] },
  };
}

/** A drawing frame: the new block's world axes (x, y up, z) and the snapping origin. */
interface Frame {
  ax: [V3, V3, V3];
  origin: V3;
  rotation: Q4 | undefined;
  /** Floor mode: footprint in x / z, extruded along +-y. Wall mode: footprint in x / y, extruded along +z. */
  wall: boolean;
  /** Floor mode: +1 extrudes up (floors), -1 down (ceilings). */
  up: number;
}

interface Drawing {
  frame: Frame;
  shape: DrawShape;
  /** Local corner coordinates (snapped); the plane coordinate is the surface. */
  a: V3;
  b: V3;
  phase: 'base' | 'height';
  h: number;
  /** Height phase baseline: extrusion when it started, mouse there, and ray parameter. */
  h0: number;
  m0: [number, number];
  s0: number | null;
  /** Climb direction for stairs / ramps: 0..3 quarter turns from the drag's own direction. */
  turn: number;
  moved: boolean;
}

interface FaceDrag {
  id: string;
  face: string;
  key: string;
  start: BlockObject;
  center: V3;
  normal: V3;
  t0: number;
  /** Shift-drag: the new block being extruded from the face. */
  extrude: string | null;
  d: number;
}

interface OpeningDrag {
  id: string;
  face: string;
  wf: WallFrame;
  a: [number, number];
  b: [number, number];
}

const HANDLE_PX = 6;
const AXIS_COL = ['#ff5a5a', '#62d26f', '#5aa0ff'];
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const fmt = (v: number) => `${v.toFixed(2)} m`;

function v3(a: ArrayLike<number>): V3 { return [a[0], a[1], a[2]]; }
function dot(a: ArrayLike<number>, b: ArrayLike<number>) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a: ArrayLike<number>, b: ArrayLike<number>): V3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a: ArrayLike<number>): V3 { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

function rotationOf(ax: [V3, V3, V3]): Q4 | undefined {
  const m = mat4.identity();
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c * 4 + r] = ax[c][r];
  const q = quat.fromMat(m);
  if (q[3] < 0) quat.scale(q, -1, q);
  if (Math.abs(q[3]) > 1 - 1e-7) return undefined;
  return [r3n(q[0]), r3n(q[1]), r3n(q[2]), r3n(q[3])];
}
const r3n = (v: number) => Math.round(v * 1e6) / 1e6;

/** Whether a direction is (nearly) a world axis. */
function worldAxis(n: V3): number {
  for (let k = 0; k < 3; k++) if (Math.abs(n[k]) > 0.9999) return k;
  return -1;
}

export class BlockTool {
  private drawing: Drawing | null = null;
  private faceDrag: FaceDrag | null = null;
  private openingDrag: OpeningDrag | null = null;
  private hoverHandle: { face: string } | null = null;
  info = '';

  constructor(readonly vp: Viewport, readonly ed: Editor) {}

  get st() { return this.ed.blockTool; }
  get active() { return !!(this.drawing || this.faceDrag || this.openingDrag); }

  private snapOn(e: { ctrlKey: boolean; metaKey: boolean }) {
    return this.ed.snap.enabled !== (e.ctrlKey || e.metaKey);
  }

  // ------------------------------------------------------------------ frames

  private frameFor(hit: PickHit): Frame {
    const ed = this.ed;
    const e = ed.rt.world.entityOf(hit.inner ?? hit.id);
    // A block face: build in that block's frame (rotated blocks keep their grid).
    if (e?.type === 'block' && hit.face && FACE_AXIS[hit.face]) {
      const ff = faceFrame(e, hit.face);
      if (ff && dot(ff.normal, hit.normal) > 0.99) {
        const f = blockFrame(e);
        const axes: [V3, V3, V3] = [blockAxis(f, 0), blockAxis(f, 1), blockAxis(f, 2)];
        const aligned = worldAxis(axes[0]) >= 0 && worldAxis(axes[1]) === 1;
        if (!aligned) {
          if (ff.axis === 1) return { ax: axes, origin: v3(f.transform.position), rotation: f.transform.rotation as Q4 | undefined, wall: false, up: ff.sign };
          const z = ff.normal, y = axes[1], x = cross(y, z);
          return { ax: [x, y, z], origin: v3(f.transform.position), rotation: rotationOf([x, y, z]), wall: true, up: 1 };
        }
        return this.worldFrame(ff.normal);
      }
    }
    return this.worldFrame(hit.normal);
  }

  /** World-aligned frame for a surface normal (walls snap to the nearest world axis within ~15°). */
  private worldFrame(n: V3): Frame {
    if (n[1] > 0.65) return { ax: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], origin: [0, 0, 0], rotation: undefined, wall: false, up: 1 };
    if (n[1] < -0.65) return { ax: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], origin: [0, 0, 0], rotation: undefined, wall: false, up: -1 };
    let z = norm([n[0], 0, n[2]]);
    const k = Math.abs(z[0]) > Math.abs(z[2]) ? 0 : 2;
    if (Math.abs(z[k]) > 0.966) z = k === 0 ? [Math.sign(z[0]), 0, 0] : [0, 0, Math.sign(z[2])];
    const y: V3 = [0, 1, 0], x = cross(y, z);
    return { ax: [x, y, z], origin: [0, 0, 0], rotation: rotationOf([x, y, z]), wall: true, up: 1 };
  }

  private toLocal(f: Frame, p: ArrayLike<number>): V3 {
    const d = [p[0] - f.origin[0], p[1] - f.origin[1], p[2] - f.origin[2]];
    return [dot(d, f.ax[0]), dot(d, f.ax[1]), dot(d, f.ax[2])];
  }

  private toWorld(f: Frame, l: ArrayLike<number>): V3 {
    const o = f.origin, a = f.ax;
    return [0, 1, 2].map((k) => o[k] + a[0][k] * l[0] + a[1][k] * l[1] + a[2][k] * l[2]) as V3;
  }

  /** Axis indices of the footprint plane (u, v) and the extrusion axis. */
  private axes(f: Frame): { u: number; v: number; n: number } {
    return f.wall ? { u: 0, v: 1, n: 2 } : { u: 0, v: 2, n: 1 };
  }

  private snapLocal(f: Frame, l: V3, on: boolean): V3 {
    if (!on) return l;
    const g = this.ed.snap.grid, { u, v } = this.axes(f);
    const out = [...l] as V3;
    out[u] = Math.round(l[u] / g) * g;
    out[v] = Math.round(l[v] / g) * g;
    return out;
  }

  /** Mouse ray against the drawing plane, in local coordinates. */
  private planeLocal(d: Drawing, ray: Ray): V3 | null {
    const f = d.frame, { n } = this.axes(f);
    const nw = f.ax[n];
    const p0 = this.toWorld(f, d.a);
    const den = dot(ray.d, nw);
    if (Math.abs(den) < 1e-6) return null;
    const t = dot([p0[0] - ray.o[0], p0[1] - ray.o[1], p0[2] - ray.o[2]], nw) / den;
    if (t < 0) return null;
    const l = this.toLocal(f, [ray.o[0] + ray.d[0] * t, ray.o[1] + ray.d[1] * t, ray.o[2] + ray.d[2] * t]);
    l[n] = d.a[n];
    return l;
  }

  // ------------------------------------------------------------------ the block a drawing makes

  /** Climb direction of a stairs / ramp drawing: quarter turns of the frame (0: towards -z / -y in wall mode...). */
  private climbTurns(d: Drawing): number {
    const { u, v } = this.axes(d.frame);
    const du = d.b[u] - d.a[u], dv = d.b[v] - d.a[v];
    let k: number;
    if (d.frame.wall) k = 0; // into the wall
    else if (!d.moved) {
      // Stamp: climb away from the camera.
      const f = this.ed.rt.camera.forward;
      const fu = dot(f, d.frame.ax[0]), fv = dot(f, d.frame.ax[2]);
      k = Math.abs(fu) > Math.abs(fv) ? (fu > 0 ? 3 : 1) : fv > 0 ? 2 : 0;
    } else k = Math.abs(du) > Math.abs(dv) ? (du > 0 ? 3 : 1) : dv > 0 ? 2 : 0;
    return (k + d.turn) % 4;
  }

  /** World bottom-centre, size and rotation of the block a drawing describes. */
  private result(d: Drawing): { position: V3; size: V3; rotation: Q4 | undefined; shape: DrawShape } {
    const f = d.frame, { u, v, n } = this.axes(f);
    const lo = [Math.min(d.a[u], d.b[u]), Math.min(d.a[v], d.b[v])], hi = [Math.max(d.a[u], d.b[u]), Math.max(d.a[v], d.b[v])];
    const su = hi[0] - lo[0], sv = hi[1] - lo[1];
    const h = Math.max(0.01, d.h);
    const c: V3 = [0, 0, 0];
    c[u] = (lo[0] + hi[0]) / 2;
    c[v] = (lo[1] + hi[1]) / 2;
    let size: V3;
    if (f.wall) {
      // Footprint on the wall: x along it, y up it; extruded outward along z.
      c[v] = lo[1];
      c[n] = d.a[n] + h / 2;
      size = [su, sv, h];
    } else {
      c[n] = f.up > 0 ? d.a[n] : d.a[n] - h;
      size = [su, h, sv];
    }
    let rot = f.rotation;
    const turnable = d.shape === 'stairs' || d.shape === 'wedge';
    if (turnable) {
      const k = this.climbTurns(d);
      // A quarter turn swaps the block's x and z extents (same box on the ground).
      if (k % 2 === 1) size = [size[2], size[1], size[0]];
      if (k) {
        // Quarter turns about the block's up axis.
        const q = axisAngleQuat([0, 1, 0], k * 90);
        const base = f.rotation ?? [0, 0, 0, 1];
        const m = quat.multiply(quat.fromValues(base[0], base[1], base[2], base[3]), quat.fromValues(q[0], q[1], q[2], q[3]));
        rot = Math.abs(m[3]) > 1 - 1e-7 ? undefined : [r3n(m[0]), r3n(m[1]), r3n(m[2]), r3n(m[3])];
      }
    }
    const shape = d.shape === 'room' && f.wall ? 'box' : d.shape;
    return { position: this.toWorld(f, c).map(r3) as V3, size: size.map(r3) as V3, rotation: rot, shape };
  }

  private commit(d: Drawing) {
    const ed = this.ed, st = this.st;
    const r = this.result(d);
    if (r.size.some((s) => s < 0.01)) return;
    st.last[d.shape] = [...r.size] as V3;
    if (r.shape === 'room') {
      // Rooms take a yaw: recover it from the frame rotation (rooms are drawn on floors).
      const q = r.rotation;
      const yaw = q ? (Math.atan2(2 * (q[3] * q[1] + q[0] * q[2]), 1 - 2 * (q[1] * q[1] + q[2] * q[2])) * 180) / Math.PI : 0;
      const res = ed.tryExec<{ group: string }>('create_room', { position: r.position, size: r.size, ...(yaw ? { yaw: r3(yaw) } : {}), thickness: st.thickness, ceiling: st.ceiling, ...(st.material !== BLOCK_MATERIAL ? { materials: { walls: st.material } } : {}) });
      if (res) ed.select(res.group);
      return;
    }
    const res = ed.tryExec<{ id: string }>('create_block', {
      position: r.position, size: r.size, shape: r.shape, ...(r.rotation ? { rotation: r.rotation } : {}), ...(st.material !== BLOCK_MATERIAL ? { material: st.material } : {}),
    });
    if (res) ed.select(res.id);
  }

  // ------------------------------------------------------------------ face handles

  /** The single selected, unlocked block whose faces get handles. */
  private handleBlock(): BlockObject | null {
    const ed = this.ed;
    if (ed.mode !== 'edit' || (ed.tool !== 'select' && ed.tool !== 'scale' && ed.tool !== 'block') || ed.selection.length !== 1) return null;
    if (ed.tool === 'block' && this.st.mode === 'opening') return null;
    const p = ed.primary;
    return p?.type === 'block' && !ed.scene.effectiveLocked(p.id) && ed.scene.effectiveVisible(p.id) ? p : null;
  }

  /** Whether the scale gizmo steps aside for face handles. */
  replacesGizmo(): boolean {
    return this.ed.tool === 'scale' && !!this.handleBlock();
  }

  private handles(b: BlockObject) {
    const eye = this.ed.rt.camera.position;
    return Object.keys(FACE_AXIS).map((face) => {
      const ff = faceFrame(b, face)!;
      const toEye = [eye[0] - ff.center[0], eye[1] - ff.center[1], eye[2] - ff.center[2]];
      return { face, center: ff.center, normal: ff.normal, axis: ff.axis, front: dot(toEye, ff.normal) > 0, q: this.vp.project(ff.center) };
    });
  }

  private handleAt(x: number, y: number): { face: string } | null {
    const b = this.handleBlock();
    if (!b) return null;
    let best: { face: string } | null = null, bd = HANDLE_PX + 4, front = false;
    for (const hd of this.handles(b)) {
      if (!hd.q) continue;
      const dd = Math.hypot(hd.q[0] - x, hd.q[1] - y);
      // Front-facing handles win over the ones behind the block.
      if (dd < bd + (hd.front && !front ? 4 : 0) && (hd.front || !front)) { bd = dd; best = { face: hd.face }; front = hd.front; }
    }
    return best;
  }

  /** Ray parameter along the handle line closest to the mouse ray. */
  private lineParam(c: V3, n: V3, ray: Ray): number | null {
    // Closest points between lines c + n s and o + d t.
    const w = [c[0] - ray.o[0], c[1] - ray.o[1], c[2] - ray.o[2]];
    const b = dot(n, ray.d), d0 = dot(n, w), e0 = dot(ray.d, w);
    const den = 1 - b * b;
    if (den < 1e-5) return null;
    return (b * e0 - d0) / den;
  }

  // ------------------------------------------------------------------ input

  /** Pointer down (left button, edit mode): true when the block tool takes it. */
  down(e: PointerEvent): boolean {
    const ed = this.ed;
    const h = this.handleAt(e.offsetX, e.offsetY);
    if (h) {
      this.beginFaceDrag(h.face, e);
      return true;
    }
    if (ed.tool !== 'block') return false;
    if (this.st.mode === 'opening') {
      const hit = this.vp.pickAt(e.offsetX, e.offsetY);
      const o = hit && this.openingTarget(hit);
      if (!o) { this.vp.showHint('Click a wall (a box block) to cut an opening'); return true; }
      if (this.st.opening === 'custom') {
        const c = this.snap2(wallCoords(o.wf, hit!.point), e);
        this.openingDrag = { id: o.id, face: o.face, wf: o.wf, a: c, b: c };
      } else this.cutPreset(o, hit!.point, e);
      return true;
    }
    // Height phase: the click that ends it.
    if (this.drawing?.phase === 'height') {
      const d = this.drawing;
      this.drawing = null;
      this.commit(d);
      return true;
    }
    const hit = this.vp.surfaceAt(e.offsetX, e.offsetY);
    if (!hit) { this.vp.showHint('Start the block on a surface (ground, wall, another block)'); return true; }
    const frame = this.frameFor(hit);
    const a = this.snapLocal(frame, this.toLocal(frame, hit.point), this.snapOn(e));
    this.drawing = { frame, shape: this.st.shape, a, b: [...a] as V3, phase: 'base', h: 0, h0: 0, m0: [e.offsetX, e.offsetY], s0: null, turn: 0, moved: false };
    return true;
  }

  move(e: PointerEvent): boolean {
    const x = e.offsetX, y = e.offsetY;
    if (this.faceDrag) {
      if (!(e.buttons & 1)) { this.endFaceDrag(); return true; }
      this.updateFaceDrag(e);
      return true;
    }
    if (this.openingDrag) {
      if (!(e.buttons & 1)) { this.finishOpeningDrag(); return true; }
      const od = this.openingDrag;
      const hit = this.vp.pickAt(x, y);
      if (hit && hit.id === od.id) od.b = this.snap2(wallCoords(od.wf, hit.point), e);
      else {
        // Off the block: intersect the wall plane.
        const p = this.rayWallPlane(od.wf, this.vp.ray(x, y));
        if (p) od.b = this.snap2(wallCoords(od.wf, p), e);
      }
      return true;
    }
    const d = this.drawing;
    if (d) {
      const ray = this.vp.ray(x, y);
      if (d.phase === 'base') {
        if (!(e.buttons & 1)) { this.endBase(e); return true; }
        const l = this.planeLocal(d, ray);
        if (l) {
          d.b = this.snapLocal(d.frame, l, this.snapOn(e));
          const { u, v } = this.axes(d.frame);
          if (Math.abs(d.b[u] - d.a[u]) > 1e-6 || Math.abs(d.b[v] - d.a[v]) > 1e-6) d.moved = true;
        }
      } else this.updateHeight(d, e);
      return true;
    }
    this.hoverHandle = this.handleAt(x, y);
    return false;
  }

  up(e: PointerEvent): boolean {
    if (this.faceDrag) { this.endFaceDrag(); return true; }
    if (this.openingDrag) { this.finishOpeningDrag(); return true; }
    if (this.drawing?.phase === 'base') { this.endBase(e); return true; }
    if (this.drawing) return true;
    return this.ed.tool === 'block' && e.button === 0;
  }

  /** Releasing the footprint drag: tiny = stamp the last size, else on to the height. */
  private endBase(e: PointerEvent) {
    const d = this.drawing!;
    const { u, v } = this.axes(d.frame);
    const g = this.snapOn(e) ? this.ed.snap.grid : 0.05;
    const small = Math.abs(d.b[u] - d.a[u]) < g * 0.5 || Math.abs(d.b[v] - d.a[v]) < g * 0.5;
    if (small && !d.moved) {
      // Stamp: the last size of this shape, centred on the click (floors) / on the wall point.
      const L = this.st.last[d.shape];
      const turns = (d.shape === 'stairs' || d.shape === 'wedge') ? this.climbTurns(d) : 0;
      if (d.frame.wall) {
        d.a = [d.a[0] - L[0] / 2, d.a[1] - L[1] / 2, d.a[2]];
        d.b = [d.a[0] + L[0], d.a[1] + L[1], d.a[2]];
        d.h = L[2];
      } else {
        const fu = turns % 2 ? L[2] : L[0], fv = turns % 2 ? L[0] : L[2];
        d.a = [d.a[0] - fu / 2, d.a[1], d.a[2] - fv / 2];
        d.b = [d.a[0] + fu, d.a[1], d.a[2] + fv];
        d.h = L[1];
      }
      this.drawing = null;
      this.commit(d);
      return;
    }
    if (small) { this.drawing = null; return; }
    // Height phase: start from the last height of this shape.
    const L = this.st.last[d.shape];
    d.phase = 'height';
    d.h = d.frame.wall ? L[2] : L[1];
    d.h0 = d.h;
    d.m0 = [e.offsetX, e.offsetY];
    d.s0 = null;
    this.vp.showHint('Move the mouse to set the height · click to create · Esc cancels' + (d.shape === 'stairs' || d.shape === 'wedge' ? ' · Tab turns' : ''), 4000);
  }

  private updateHeight(d: Drawing, e: PointerEvent) {
    const f = d.frame;
    const nw = f.wall ? f.ax[2] : (f.ax[1].map((c) => c * f.up) as V3);
    const r = this.result({ ...d, h: Math.max(0.01, d.h) });
    const centre = r.position;
    const cam = this.ed.rt.camera, fw = cam.forward;
    const g = this.ed.snap.grid;
    let h: number;
    // Plane through the extrusion axis facing the camera; looking along the axis falls back to screen pixels.
    const m = [fw[0] - nw[0] * dot(fw, nw), fw[1] - nw[1] * dot(fw, nw), fw[2] - nw[2] * dot(fw, nw)];
    const ray = this.vp.ray(e.offsetX, e.offsetY);
    if (Math.hypot(m[0], m[1], m[2]) > 0.2) {
      const pn = norm(m);
      const den = dot(ray.d, pn);
      const t = Math.abs(den) > 1e-6 ? dot([centre[0] - ray.o[0], centre[1] - ray.o[1], centre[2] - ray.o[2]], pn) / den : -1;
      if (t <= 0) return;
      const p = [ray.o[0] + ray.d[0] * t, ray.o[1] + ray.d[1] * t, ray.o[2] + ray.d[2] * t];
      const s = dot(p, nw);
      if (d.s0 === null) d.s0 = s;
      h = d.h0 + (s - d.s0);
    } else {
      const dist = Math.hypot(centre[0] - cam.position[0], centre[1] - cam.position[1], centre[2] - cam.position[2]);
      h = d.h0 + ((d.m0[1] - e.offsetY) * dist * Math.tan(cam.fovY / 2) * 2) / this.vp.h;
    }
    if (this.snapOn(e)) h = Math.round(h / g) * g;
    d.h = Math.max(this.snapOn(e) ? g : 0.01, r3(h));
  }

  key(e: KeyboardEvent): boolean {
    const ed = this.ed;
    if (e.code === 'Escape' && (this.drawing || this.openingDrag)) {
      this.drawing = null;
      this.openingDrag = null;
      this.vp.showHint('Cancelled');
      return true;
    }
    if (ed.tool !== 'block') return false;
    if (e.code === 'Tab') {
      e.preventDefault();
      if (this.drawing) this.drawing.turn = (this.drawing.turn + 1) % 4;
      return true;
    }
    if (e.code === 'Enter' && this.drawing?.phase === 'height') {
      const d = this.drawing;
      this.drawing = null;
      this.commit(d);
      return true;
    }
    const shapes: Record<string, DrawShape> = { Digit1: 'box', Digit2: 'wedge', Digit3: 'stairs', Digit4: 'cylinder', Digit5: 'room' };
    if (shapes[e.code]) {
      this.st.shape = shapes[e.code];
      this.st.mode = 'draw';
      if (this.drawing) this.drawing.shape = this.st.shape;
      ed.emit('tool');
      this.vp.showHint(`Block: ${this.st.shape}`);
      return true;
    }
    if (e.code === 'KeyO') {
      this.st.mode = this.st.mode === 'opening' ? 'draw' : 'opening';
      this.drawing = null;
      ed.emit('tool');
      this.vp.showHint(this.st.mode === 'opening' ? `Openings: click a wall to cut a ${this.st.opening.replace('_', ' ')} · O back to drawing` : 'Drawing blocks');
      return true;
    }
    return false;
  }

  /**
   * A pointer release the viewport did not route here (lost capture, blur):
   * ends button-held gestures. The height phase runs with the button up, so it
   * stays (Esc / tool change end it).
   */
  cancel() {
    if (this.faceDrag) this.endFaceDrag();
    if (this.drawing?.phase === 'base') this.drawing = null;
    this.openingDrag = null;
  }

  // ------------------------------------------------------------------ face drags

  private beginFaceDrag(face: string, e: PointerEvent) {
    const b = this.handleBlock()!;
    const ff = faceFrame(b, face)!;
    const t0 = this.lineParam(ff.center, ff.normal, this.vp.ray(e.offsetX, e.offsetY)) ?? 0;
    const key = `face:${performance.now()}`;
    let extrude: string | null = null;
    if (e.shiftKey) {
      const r = this.ed.tryExec<{ ids: string[] }>('duplicate_entity', { ids: [b.id] }, { merge: key, label: `Extrude ${b.name ?? b.id}` });
      extrude = r?.ids[0] ?? null;
      if (!extrude) return;
    }
    this.faceDrag = { id: b.id, face, key, start: structuredClone(b), center: ff.center, normal: ff.normal, t0, extrude, d: 0 };
  }

  private updateFaceDrag(e: PointerEvent) {
    const fd = this.faceDrag!;
    const t = this.lineParam(fd.center, fd.normal, this.vp.ray(e.offsetX, e.offsetY));
    if (t === null) return;
    let d = t - fd.t0;
    const g = this.ed.snap.grid;
    if (this.snapOn(e)) {
      const k = worldAxis(fd.normal);
      if (k >= 0) {
        // World-aligned face: its world coordinate lands on the grid.
        const c0 = fd.center[k], s = Math.sign(fd.normal[k]);
        d = (Math.round((c0 + s * d) / g) * g - c0) * s;
      } else d = Math.round(d / g) * g;
    }
    const [axis, sign] = FACE_AXIS[fd.face];
    const f0 = blockFrame(fd.start);
    const min = this.snapOn(e) ? g : 0.01;
    if (!fd.extrude) {
      const size = Math.max(min, f0.size[axis] + d);
      fd.d = size - f0.size[axis];
      this.ed.tryExec('resize_block', { id: fd.id, face: fd.face, size: r3(size) }, { merge: fd.key, label: `Resize ${fd.start.name ?? fd.id}` });
      this.info = `${FACE_LABELS[fd.face]}: ${['width', 'height', 'depth'][axis]} ${fmt(size)} (${fd.d >= 0 ? '+' : ''}${fd.d.toFixed(2)})`;
      return;
    }
    // Extrusion: a copy sized `depth` along the axis, against the face.
    const depth = Math.max(min, d);
    fd.d = depth;
    const shift: V3 = [0, 0, 0];
    if (axis === 1) shift[1] = sign > 0 ? f0.size[1] : -depth;
    else shift[axis] = sign * (f0.size[axis] / 2 + depth / 2);
    const p = vec3.transformMat4(shift, f0.M);
    const size = [...f0.size] as V3;
    size[axis] = r3(depth);
    const tr = { position: [r3(p[0]), r3(p[1]), r3(p[2])], ...(f0.transform.rotation ? { rotation: f0.transform.rotation } : {}) };
    this.ed.tryExec('set_transform', { transforms: { [fd.extrude]: tr } }, { merge: fd.key });
    this.ed.tryExec('set_block', { ids: [fd.extrude], size }, { merge: fd.key });
    this.info = `Extrude ${FACE_LABELS[fd.face]}: ${fmt(depth)}`;
  }

  private endFaceDrag() {
    const fd = this.faceDrag;
    this.faceDrag = null;
    this.info = '';
    if (!fd) return;
    this.ed.history.seal();
    if (fd.extrude && this.ed.scene.has(fd.extrude)) this.ed.select(fd.extrude);
  }

  // ------------------------------------------------------------------ openings

  private openingTarget(hit: PickHit): { id: string; face: string; wf: WallFrame } | null {
    const ed = this.ed;
    const e = ed.scene.get(hit.id);
    if (e?.type !== 'block' || e.block.shape !== 'box' || !hit.face || !FACE_AXIS[hit.face]) return null;
    const others = ed.scene.entities.filter((x): x is BlockObject => x.type === 'block' && x.id !== e.id && x.block.shape === 'box' && ed.scene.effectiveVisible(x.id));
    return { id: e.id, face: hit.face, wf: wallFrame(e, hit.face, others) };
  }

  private snap2(c: [number, number], e: { ctrlKey: boolean; metaKey: boolean }): [number, number] {
    if (!this.snapOn(e)) return c;
    const g = this.ed.snap.grid;
    return [Math.round(c[0] / g) * g, Math.round(c[1] / g) * g];
  }

  /** Preset opening centred (horizontally) at a wall point. */
  private presetPlacement(o: { wf: WallFrame }, p: V3, e: { ctrlKey: boolean; metaKey: boolean }): { size: [number, number]; off: [number, number] } {
    const pr = OPENINGS[this.st.opening as Exclude<OpeningPreset, 'custom'>];
    const c = this.snap2(wallCoords(o.wf, p), e);
    const floor = o.wf.axis === 1;
    const off = clampOpening(o.wf, pr.size, floor ? c : [c[0], pr.bottom]);
    return { size: pr.size, off };
  }

  private cutPreset(o: { id: string; face: string; wf: WallFrame }, p: V3, e: PointerEvent) {
    const { size, off } = this.presetPlacement(o, p, e);
    const floor = o.wf.axis === 1;
    const r = this.ed.tryExec<{ cut: string[] }>('cut_opening', { id: o.id, face: o.face, size, ...(floor ? { offset: off } : { along: r3(off[0]), bottom: r3(off[1]) }) }, { label: `Cut ${OPENINGS[this.st.opening as Exclude<OpeningPreset, 'custom'>].label.toLowerCase()}` });
    if (r) this.vp.showHint(`Cut ${r.cut.length} block${r.cut.length === 1 ? '' : 's'}`);
  }

  private finishOpeningDrag() {
    const od = this.openingDrag!;
    this.openingDrag = null;
    const w = Math.abs(od.b[0] - od.a[0]), hgt = Math.abs(od.b[1] - od.a[1]);
    if (w < 0.05 || hgt < 0.05) return;
    const floor = od.wf.axis === 1;
    const cu = (od.a[0] + od.b[0]) / 2;
    const params = floor
      ? { offset: [r3(cu), r3((od.a[1] + od.b[1]) / 2)], size: [r3(w), r3(hgt)] }
      : { along: r3(cu), bottom: r3(Math.min(od.a[1], od.b[1])), size: [r3(w), r3(hgt)] };
    this.ed.tryExec('cut_opening', { id: od.id, face: od.face, ...params }, { label: 'Cut opening' });
  }

  private rayWallPlane(wf: WallFrame, ray: Ray): V3 | null {
    const k = wf.axis;
    const n = v3([wf.M[k * 4], wf.M[k * 4 + 1], wf.M[k * 4 + 2]]);
    const lc: V3 = [0, 0, 0];
    lc[k] = wf.sign > 0 ? wf.max[k] : wf.min[k];
    const p0 = vec3.transformMat4(lc, wf.M);
    const den = dot(ray.d, n);
    if (Math.abs(den) < 1e-6) return null;
    const t = dot([p0[0] - ray.o[0], p0[1] - ray.o[1], p0[2] - ray.o[2]], n) / den;
    return t > 0 ? [ray.o[0] + ray.d[0] * t, ray.o[1] + ray.d[1] * t, ray.o[2] + ray.d[2] * t] : null;
  }

  // ------------------------------------------------------------------ overlay

  draw(g: CanvasRenderingContext2D, line: (a: ArrayLike<number>, b: ArrayLike<number>) => void) {
    const ed = this.ed, vp = this.vp;
    if (this.drawing && ed.tool !== 'block') this.drawing = null;
    const label = (p: ArrayLike<number>, text: string, col = '#ffd23f') => {
      const q = vp.project(p);
      if (!q) return;
      g.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      const w = g.measureText(text).width;
      g.fillStyle = 'rgba(10,12,14,0.75)';
      g.fillRect(q[0] - w / 2 - 4, q[1] - 8, w + 8, 16);
      g.fillStyle = col;
      g.textBaseline = 'middle';
      g.fillText(text, q[0] - w / 2, q[1]);
      g.textBaseline = 'top';
    };
    const stroke = (col: string, width = 1.5, dash?: number[]) => {
      if (dash) g.setLineDash(dash);
      g.strokeStyle = col;
      g.lineWidth = width;
      g.stroke();
      if (dash) g.setLineDash([]);
    };

    // Drawing preview: the exact shape, with its dimensions.
    const d = this.drawing;
    if (d) {
      const r = this.result({ ...d, h: d.phase === 'base' ? Math.max(0.01, d.h || 0.01) : d.h });
      const shape = r.shape === 'room' ? 'box' : r.shape;
      const M = transformMatrixQ(r.position, r.rotation);
      g.beginPath();
      for (const f of blockFaces(shape as BlockShape, r.size, {})) {
        for (let i = 0; i < f.pts.length; i++) line(vec3.transformMat4(f.pts[i], M), vec3.transformMat4(f.pts[(i + 1) % f.pts.length], M));
      }
      stroke('#5be37d', 1.5);
      const at = (l: V3) => v3(vec3.transformMat4(l, M));
      const [sx, sy, sz] = r.size;
      // Dimensions along the edges at the corner nearest the camera.
      const eye = ed.rt.camera.position;
      let xc = sx / 2, zc = sz / 2, best = Infinity;
      for (const cx of [-sx / 2, sx / 2]) for (const cz of [-sz / 2, sz / 2]) {
        const w = at([cx, 0, cz]), dd = Math.hypot(w[0] - eye[0], w[1] - eye[1], w[2] - eye[2]);
        if (dd < best) { best = dd; xc = cx; zc = cz; }
      }
      label(at([0, 0, zc]), fmt(sx));
      label(at([xc, 0, 0]), fmt(sz));
      if (d.phase === 'height') label(at([xc, sy / 2, zc]), fmt(sy));
      if (d.shape === 'stairs') label(at([0, sy + 0.25, 0]), `${Math.max(1, Math.round(sy / 0.17))} steps`, '#dfe3e8');
      if (d.shape === 'room') label(at([0, sy + 0.25, 0]), `room · ${this.st.thickness} m walls${this.st.ceiling ? '' : ' · open top'}`, '#dfe3e8');
      return;
    }

    // Hover: the snapped start point and the face it would build on.
    if (ed.tool === 'block' && this.st.mode === 'draw' && vp.mouse[0] >= 0 && !this.hoverHandle) {
      const hit = vp.surfaceAt(vp.mouse[0], vp.mouse[1]);
      if (hit) {
        const f = this.frameFor(hit);
        const p = this.toWorld(f, this.snapLocal(f, this.toLocal(f, hit.point), ed.snap.enabled));
        const q = vp.project(p);
        if (q) {
          g.beginPath();
          g.moveTo(q[0] - 7, q[1]); g.lineTo(q[0] + 7, q[1]);
          g.moveTo(q[0], q[1] - 7); g.lineTo(q[0], q[1] + 7);
          stroke('#5be37d', 2);
        }
        if (hit.face) this.drawFace(g, line, hit.inner ?? hit.id, hit.face, 'rgba(91,227,125,0.5)');
      }
    }

    // Openings: preview at the cursor / the custom rectangle.
    if (ed.tool === 'block' && this.st.mode === 'opening' && vp.mouse[0] >= 0) {
      const od = this.openingDrag;
      if (od) {
        const size: [number, number] = [Math.abs(od.b[0] - od.a[0]), Math.abs(od.b[1] - od.a[1])];
        const floor = od.wf.axis === 1;
        const off: [number, number] = floor ? [(od.a[0] + od.b[0]) / 2, (od.a[1] + od.b[1]) / 2] : [(od.a[0] + od.b[0]) / 2, Math.min(od.a[1], od.b[1])];
        this.drawOpening(g, line, label, od.wf, size, off, `${fmt(size[0])} × ${fmt(size[1])}`);
      } else {
        const hit = vp.pickAt(vp.mouse[0], vp.mouse[1]);
        const o = hit && this.openingTarget(hit);
        if (o && this.st.opening !== 'custom') {
          const { size, off } = this.presetPlacement(o, hit!.point, { ctrlKey: false, metaKey: false });
          const pr = OPENINGS[this.st.opening as Exclude<OpeningPreset, 'custom'>];
          this.drawOpening(g, line, label, o.wf, size, off, `${pr.label} ${size[0]} × ${size[1]}`);
        } else if (o) this.drawFace(g, line, o.id, o.face, 'rgba(127,209,196,0.7)');
      }
    }

    // Face handles on the selected block.
    const b = this.handleBlock();
    if (b) {
      const fd = this.faceDrag;
      const f = blockFrame(b);
      if (ed.tool === 'block' || fd) label(vec3.transformMat4([0, f.size[1] + 0.3, 0], f.M), `${f.size[0].toFixed(2)} × ${f.size[1].toFixed(2)} × ${f.size[2].toFixed(2)} m`, '#dfe3e8');
      for (const hd of this.handles(b)) {
        if (!hd.q) continue;
        const hot = fd ? fd.face === hd.face : this.hoverHandle?.face === hd.face;
        const s = hot ? HANDLE_PX + 1 : HANDLE_PX;
        g.globalAlpha = hd.front || hot ? 1 : 0.35;
        g.fillStyle = hot ? '#ffd23f' : AXIS_COL[hd.axis];
        g.fillRect(hd.q[0] - s, hd.q[1] - s, s * 2, s * 2);
        g.strokeStyle = '#000';
        g.lineWidth = 1;
        g.strokeRect(hd.q[0] - s, hd.q[1] - s, s * 2, s * 2);
        g.globalAlpha = 1;
        if (hot && !fd) this.drawFace(g, line, b.id, hd.face, 'rgba(255,210,63,0.8)', true);
      }
      if (fd) {
        const hd = this.handles(fd.extrude ? (ed.scene.get(fd.extrude) as BlockObject ?? b) : b).find((x) => x.face === fd.face);
        if (hd) label(hd.center, this.info.split(': ').pop() ?? '');
      }
    }
  }

  /** Outlines every polygon of a block face (stairs treads share an ID). Box faces of other shapes use the bounding box. */
  drawFace(g: CanvasRenderingContext2D, line: (a: ArrayLike<number>, b: ArrayLike<number>) => void, id: string, face: string, col: string, bbox = false) {
    const e = this.ed.rt.world.entityOf(id);
    if (e?.type !== 'block') return;
    const f = blockFrame(e);
    const polys = bbox ? blockFaces('box', f.size).filter((x) => x.id === face) : blockFaces(e.block.shape, f.size, { steps: e.block.steps, segments: e.block.segments }).filter((x) => x.id === face);
    g.beginPath();
    for (const p of polys) for (let i = 0; i < p.pts.length; i++) line(vec3.transformMat4(p.pts[i], f.M), vec3.transformMat4(p.pts[(i + 1) % p.pts.length], f.M));
    g.strokeStyle = col;
    g.lineWidth = 2;
    g.stroke();
  }

  private drawOpening(g: CanvasRenderingContext2D, line: (a: ArrayLike<number>, b: ArrayLike<number>) => void, label: (p: ArrayLike<number>, t: string, c?: string) => void, wf: WallFrame, size: [number, number], off: [number, number], text: string) {
    const [mn, mx] = openingBox(wf, size, off);
    const c = boxCorners(mn, mx, wf.M);
    const E = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
    g.beginPath();
    for (const [i, j] of E) line(c[i], c[j]);
    g.strokeStyle = '#7fd1c4';
    g.lineWidth = 2;
    g.stroke();
    const mid = [0, 1, 2].map((k) => (mn[k] + mx[k]) / 2) as V3;
    label(vec3.transformMat4(mid, wf.M), text, '#7fd1c4');
  }

  hud(): string | null {
    const ed = this.ed;
    if (ed.tool !== 'block') return null;
    const st = this.st;
    if (st.mode === 'opening') return `OPENING ${st.opening.replace('_', ' ')}: click a wall${st.opening === 'custom' ? ' and drag the rectangle' : ''} · O draws blocks again`;
    const d = this.drawing;
    if (d?.phase === 'height') return `BLOCK ${d.shape}: move to set the height · click / Enter creates · Esc cancels${d.shape === 'stairs' || d.shape === 'wedge' ? ' · Tab turns' : ''}`;
    if (d) return `BLOCK ${d.shape}: drag the footprint · release for the height`;
    return `BLOCK ${st.shape} (1 box 2 ramp 3 stairs 4 pillar 5 room · O openings): drag on a surface · click stamps ${st.last[st.shape].join(' × ')} m · face handles push / pull, Shift extrudes`;
  }
}

function transformMatrixQ(p: V3, q: Q4 | undefined) {
  const m = mat4.translation(p);
  if (q) mat4.multiply(m, mat4.fromQuat(q), m);
  return m;
}
