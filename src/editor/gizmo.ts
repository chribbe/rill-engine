import { mat4, vec3, type Mat4 } from 'wgpu-matrix';
import type { Camera } from '../engine/scene/camera';
import type { Ray } from './picking';
import { axisAngleQuat, rotationAbout, scaleAbout, snap, type Q4, type V3 } from './xform';

/**
 * Translate / rotate / scale gizmo, drawn on the 2D overlay canvas and hit-tested
 * in screen space. A drag produces a world-space delta matrix relative to the
 * drag start; the viewport turns it into `set_transform` operations.
 */

export type GizmoTool = 'translate' | 'rotate' | 'scale';
export interface Handle {
  kind: 'axis' | 'plane' | 'center' | 'ring' | 'scale' | 'uniform';
  axis: number;
}

const COLORS = ['#e5484d', '#46a758', '#3e8ef7'];
const HOVER = '#ffd23f';
const SIZE_PX = 110;

type P2 = [number, number];

export class Gizmo {
  tool: GizmoTool = 'translate';
  origin: V3 = [0, 0, 0];
  rotation: Q4 = [0, 0, 0, 1];
  axes: [V3, V3, V3] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  /** World length of the handles (constant screen size). */
  len = 1;
  hover: Handle | null = null;
  active: Handle | null = null;
  private cam!: Camera;
  private w = 1;
  private h = 1;
  private drag: {
    h: Handle; mouse: P2; plane?: { n: V3; p0: V3 }; tangent?: P2; radiusPx?: number; screenAxis?: P2; axisPx?: number; angle: number; last?: V3;
  } | null = null;

  layout(cam: Camera, w: number, h: number, origin: V3, rotation: Q4 | undefined, tool: GizmoTool) {
    this.cam = cam;
    this.w = w;
    this.h = h;
    this.tool = tool;
    if (!this.drag) {
      this.origin = origin;
      this.rotation = rotation ?? [0, 0, 0, 1];
      const R = mat4.fromQuat(this.rotation);
      this.axes = [[R[0], R[1], R[2]], [R[4], R[5], R[6]], [R[8], R[9], R[10]]];
    }
    // Handle length: SIZE_PX on screen at the origin's depth.
    const d = vec3.distance(cam.position, this.origin);
    this.len = Math.max(1e-3, (d * Math.tan(cam.fovY / 2) * 2 * SIZE_PX) / h);
  }

  project(p: ArrayLike<number>): P2 | null {
    const v = vec3.transformMat4(p, this.cam.viewProj);
    // Behind the camera: the reverse-Z clip w would be negative.
    const m = this.cam.viewProj;
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    if (w <= 1e-4) return null;
    return [(v[0] * 0.5 + 0.5) * this.w, (0.5 - v[1] * 0.5) * this.h];
  }

  private at(axis: number, s: number): V3 {
    const a = this.axes[axis], o = this.origin, l = this.len * s;
    return [o[0] + a[0] * l, o[1] + a[1] * l, o[2] + a[2] * l];
  }

  /** Axis nearly along the view direction: its handle would degenerate. */
  private edgeOn(axis: number) {
    const o = this.project(this.origin), e = this.project(this.at(axis, 1));
    return !o || !e || Math.hypot(e[0] - o[0], e[1] - o[1]) < 12;
  }

  private ring(axis: number, n = 72): { pts: (P2 | null)[]; front: boolean[]; world: V3[] } {
    const a = this.axes[(axis + 1) % 3], b = this.axes[(axis + 2) % 3], o = this.origin, l = this.len;
    const pts: (P2 | null)[] = [], front: boolean[] = [], world: V3[] = [];
    const c = this.cam.position;
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * Math.PI * 2, ca = Math.cos(t) * l, sb = Math.sin(t) * l;
      const p: V3 = [o[0] + a[0] * ca + b[0] * sb, o[1] + a[1] * ca + b[1] * sb, o[2] + a[2] * ca + b[2] * sb];
      world.push(p);
      pts.push(this.project(p));
      // Front half: the side of the ring facing the camera.
      const toC = [c[0] - o[0], c[1] - o[1], c[2] - o[2]];
      front.push((p[0] - o[0]) * toC[0] + (p[1] - o[1]) * toC[1] + (p[2] - o[2]) * toC[2] >= -1e-6);
    }
    return { pts, front, world };
  }

  hit(mx: number, my: number): Handle | null {
    const o = this.project(this.origin);
    if (!o) return null;
    const segDist = (a: P2, b: P2) => {
      const vx = b[0] - a[0], vy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((mx - a[0]) * vx + (my - a[1]) * vy) / (vx * vx + vy * vy || 1)));
      return Math.hypot(mx - (a[0] + vx * t), my - (a[1] + vy * t));
    };
    if (this.tool === 'rotate') {
      let best: Handle | null = null, bd = 9;
      for (let k = 0; k < 3; k++) {
        const r = this.ring(k, 48);
        for (let i = 0; i < r.pts.length - 1; i++) {
          const a = r.pts[i], b = r.pts[i + 1];
          if (!a || !b || !r.front[i]) continue;
          const d = segDist(a, b);
          if (d < bd) { bd = d; best = { kind: 'ring', axis: k }; }
        }
      }
      return best;
    }
    if (Math.hypot(mx - o[0], my - o[1]) < 9) return { kind: this.tool === 'scale' ? 'uniform' : 'center', axis: -1 };
    if (this.tool === 'translate') {
      // Plane handles first (they sit between the axes).
      for (let k = 0; k < 3; k++) {
        const i = (k + 1) % 3, j = (k + 2) % 3;
        const q = this.planeQuad(i, j);
        if (q && pointInQuad([mx, my], q)) return { kind: 'plane', axis: k };
      }
    }
    let best: Handle | null = null, bd = 9;
    for (let k = 0; k < 3; k++) {
      if (this.edgeOn(k)) continue;
      const e = this.project(this.at(k, 1));
      if (!e) continue;
      const d = segDist(o, e);
      if (d < bd) { bd = d; best = { kind: this.tool === 'scale' ? 'scale' : 'axis', axis: k }; }
    }
    return best;
  }

  private planeQuad(i: number, j: number): P2[] | null {
    const o = this.origin, a = this.axes[i], b = this.axes[j], l = this.len;
    const c = (s: number, t: number) => this.project([o[0] + (a[0] * s + b[0] * t) * l, o[1] + (a[1] * s + b[1] * t) * l, o[2] + (a[2] * s + b[2] * t) * l]);
    const q = [c(0.22, 0.22), c(0.42, 0.22), c(0.42, 0.42), c(0.22, 0.42)];
    if (q.some((p) => !p)) return null;
    // Skip planes seen edge-on.
    const area = Math.abs(polyArea(q as P2[]));
    return area > 30 ? (q as P2[]) : null;
  }

  draw(g: CanvasRenderingContext2D) {
    const o = this.project(this.origin);
    if (!o) return;
    const cur = this.active ?? this.hover;
    const col = (k: number, kind?: Handle['kind']) => (cur && cur.axis === k && (!kind || cur.kind === kind) ? HOVER : COLORS[k]);
    g.lineCap = 'round';
    if (this.tool === 'rotate') {
      for (let k = 0; k < 3; k++) {
        const r = this.ring(k);
        for (const front of [false, true]) {
          g.beginPath();
          let pen = false;
          for (let i = 0; i < r.pts.length; i++) {
            const p = r.pts[i];
            if (!p || r.front[i] !== front) { pen = false; continue; }
            if (!pen) g.moveTo(p[0], p[1]);
            else g.lineTo(p[0], p[1]);
            pen = true;
          }
          g.strokeStyle = front ? col(k) : 'rgba(150,150,150,0.35)';
          g.lineWidth = front ? (cur?.axis === k ? 3.5 : 2.5) : 1.25;
          g.stroke();
        }
      }
      if (this.drag && this.active) {
        g.fillStyle = 'rgba(0,0,0,0.6)';
        g.font = '12px ui-monospace, Menlo, monospace';
        g.fillText(`${this.drag.angle.toFixed(1)}°`, o[0] + 12, o[1] - 12);
      }
      return;
    }
    // Planes (translate).
    if (this.tool === 'translate') {
      for (let k = 0; k < 3; k++) {
        const q = this.planeQuad((k + 1) % 3, (k + 2) % 3);
        if (!q) continue;
        g.beginPath();
        g.moveTo(q[0][0], q[0][1]);
        for (let i = 1; i < 4; i++) g.lineTo(q[i][0], q[i][1]);
        g.closePath();
        const hot = cur?.kind === 'plane' && cur.axis === k;
        g.fillStyle = hot ? 'rgba(255,210,63,0.55)' : hexA(COLORS[k], 0.28);
        g.fill();
        g.strokeStyle = hot ? HOVER : hexA(COLORS[k], 0.8);
        g.lineWidth = 1;
        g.stroke();
      }
    }
    for (let k = 0; k < 3; k++) {
      if (this.edgeOn(k)) continue;
      const e = this.project(this.at(k, 1));
      if (!e) continue;
      const c = col(k);
      g.strokeStyle = c;
      g.lineWidth = cur?.axis === k ? 3.5 : 2.5;
      g.beginPath();
      g.moveTo(o[0], o[1]);
      g.lineTo(e[0], e[1]);
      g.stroke();
      g.fillStyle = c;
      const dx = e[0] - o[0], dy = e[1] - o[1], L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
      if (this.tool === 'translate') {
        g.beginPath();
        g.moveTo(e[0] + ux * 12, e[1] + uy * 12);
        g.lineTo(e[0] - uy * 5, e[1] + ux * 5);
        g.lineTo(e[0] + uy * 5, e[1] - ux * 5);
        g.closePath();
        g.fill();
      } else {
        g.fillRect(e[0] - 5, e[1] - 5, 10, 10);
      }
    }
    const hotC = cur?.kind === 'center' || cur?.kind === 'uniform';
    g.fillStyle = hotC ? HOVER : 'rgba(235,235,235,0.9)';
    g.strokeStyle = 'rgba(0,0,0,0.6)';
    g.lineWidth = 1;
    g.beginPath();
    if (this.tool === 'scale') g.rect(o[0] - 6, o[1] - 6, 12, 12);
    else g.arc(o[0], o[1], 5, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  }

  // ------------------------------------------------------------------ dragging

  private rayPlane(ray: Ray, n: V3, p0: V3): V3 | null {
    const den = n[0] * ray.d[0] + n[1] * ray.d[1] + n[2] * ray.d[2];
    if (Math.abs(den) < 1e-6) return null;
    const t = ((p0[0] - ray.o[0]) * n[0] + (p0[1] - ray.o[1]) * n[1] + (p0[2] - ray.o[2]) * n[2]) / den;
    if (t < 0) return null;
    return [ray.o[0] + ray.d[0] * t, ray.o[1] + ray.d[1] * t, ray.o[2] + ray.d[2] * t];
  }

  begin(h: Handle, ray: Ray, mx: number, my: number): boolean {
    const view = this.cam.forward;
    const o = this.origin;
    this.active = h;
    this.drag = { h, mouse: [mx, my], angle: 0 };
    if (h.kind === 'axis') {
      const a = this.axes[h.axis];
      // The plane through the axis that faces the camera best.
      const t = vec3.cross(view, a);
      const n = vec3.normalize(vec3.cross(a, t));
      this.drag.plane = { n: [n[0], n[1], n[2]], p0: o };
    } else if (h.kind === 'plane') {
      this.drag.plane = { n: this.axes[h.axis], p0: o };
    } else if (h.kind === 'center') {
      this.drag.plane = { n: [-view[0], -view[1], -view[2]], p0: o };
    } else if (h.kind === 'ring') {
      // Tangent of the ring at the grabbed point, on screen: drag along it to turn.
      const r = this.ring(h.axis, 72);
      let bi = 0, bd = Infinity;
      r.pts.forEach((p, i) => { if (p && r.front[i]) { const d = Math.hypot(p[0] - mx, p[1] - my); if (d < bd) { bd = d; bi = i; } } });
      // Positive rotation (right-handed about the axis) moves the grabbed point along axis x (g - o).
      const gw = r.world[bi], ax = this.axes[h.axis];
      const T = vec3.normalize(vec3.cross(ax, vec3.sub(gw, o)));
      const a = this.project(gw), b = this.project(vec3.add(gw, vec3.scale(T, this.len * 0.05))), c = this.project(o);
      if (!a || !b || !c) return false;
      const tx = b[0] - a[0], ty = b[1] - a[1], tl = Math.hypot(tx, ty) || 1;
      this.drag.tangent = [tx / tl, ty / tl];
      // Sensitivity from the gizmo's screen radius (not the grab point: foreshortened rings would spin).
      this.drag.radiusPx = SIZE_PX;
    } else if (h.kind === 'scale' || h.kind === 'uniform') {
      const c = this.project(o);
      if (!c) return false;
      if (h.kind === 'scale') {
        const e = this.project(this.at(h.axis, 1));
        if (!e) return false;
        const L = Math.hypot(e[0] - c[0], e[1] - c[1]) || 1;
        this.drag.screenAxis = [(e[0] - c[0]) / L, (e[1] - c[1]) / L];
        this.drag.axisPx = L;
      }
    }
    if (this.drag.plane) {
      const p = this.rayPlane(ray, this.drag.plane.n, this.drag.plane.p0);
      if (!p) { this.end(); return false; }
      this.drag.last = p;
      this.drag.plane.p0 = o;
      (this.drag as { start?: V3 }).start = p;
    }
    return true;
  }

  /**
   * Delta matrix (world) from the drag start for the current mouse position, and
   * a short readout. `doSnap`: grid / angle / scale steps.
   */
  update(ray: Ray, mx: number, my: number, doSnap: boolean, steps: { grid: number; angle: number; scale: number }): { D: Mat4; info: string } | null {
    const d = this.drag;
    if (!d) return null;
    const o = this.origin;
    const h = d.h;
    if (d.plane) {
      const p = this.rayPlane(ray, d.plane.n, d.plane.p0);
      const s = (d as { start?: V3 }).start;
      if (!p || !s) return null;
      let delta: V3 = [p[0] - s[0], p[1] - s[1], p[2] - s[2]];
      if (h.kind === 'axis') {
        const a = this.axes[h.axis];
        let k = delta[0] * a[0] + delta[1] * a[1] + delta[2] * a[2];
        if (doSnap) k = snap(k, steps.grid);
        delta = [a[0] * k, a[1] * k, a[2] * k];
      } else if (doSnap) {
        // Snap along the gizmo axes in the plane.
        const out: V3 = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
          if (h.kind === 'plane' && i === h.axis) continue;
          const a = this.axes[i];
          const k = snap(delta[0] * a[0] + delta[1] * a[1] + delta[2] * a[2], steps.grid);
          out[0] += a[0] * k; out[1] += a[1] * k; out[2] += a[2] * k;
        }
        delta = out;
      }
      return { D: mat4.translation(delta), info: `Δ ${delta.map((v) => v.toFixed(3)).join(', ')} m` };
    }
    if (h.kind === 'ring') {
      const px = (mx - d.mouse[0]) * d.tangent![0] + (my - d.mouse[1]) * d.tangent![1];
      let deg = (px / d.radiusPx!) * (180 / Math.PI);
      const a = this.axes[h.axis];
      if (doSnap) deg = snap(deg, steps.angle);
      d.angle = deg;
      return { D: rotationAbout(axisAngleQuat(a, deg), o), info: `${deg.toFixed(1)}°` };
    }
    if (h.kind === 'scale') {
      let s = 1 + ((mx - d.mouse[0]) * d.screenAxis![0] + (my - d.mouse[1]) * d.screenAxis![1]) / d.axisPx!;
      if (doSnap) s = snap(s, steps.scale);
      s = Math.max(0.01, s);
      const f: V3 = [1, 1, 1];
      f[h.axis] = s;
      return { D: scaleAbout(f, o, this.rotation), info: `× ${s.toFixed(3)}` };
    }
    if (h.kind === 'uniform') {
      let s = 1 + ((mx - d.mouse[0]) - (my - d.mouse[1])) / 120;
      if (doSnap) s = snap(s, steps.scale);
      s = Math.max(0.01, s);
      return { D: scaleAbout([s, s, s], o, this.rotation), info: `× ${s.toFixed(3)}` };
    }
    return null;
  }

  get dragging() {
    return !!this.drag;
  }

  end() {
    this.drag = null;
    this.active = null;
  }
}

function hexA(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function polyArea(q: P2[]) {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const p = q[i], n = q[(i + 1) % q.length];
    a += p[0] * n[1] - n[0] * p[1];
  }
  return a / 2;
}

function pointInQuad(p: P2, q: P2[]) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const c = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const s = Math.sign(c);
    if (s === 0) continue;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}
