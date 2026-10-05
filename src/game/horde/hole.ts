import { mat4, quat, type Mat4 } from 'wgpu-matrix';
import type { Renderable, Renderer } from '../../engine/render/renderer';
import type { MeshData, PrimitiveData, GpuMesh } from '../../engine/render/geometry';
import type { Material } from '../../engine/render/materials';
import type { ParticleSystem } from '../../engine/render/particles';
import type { World } from '../../engine/scene/world';
import type { Debris, DebrisMesh } from '../../engine/physics/debris';
import { transformAabb } from '../../engine/render/culling';
import type { GameAudio } from '../audio/gameaudio';

/**
 * Bug holes: the ground heaves, cracks and bursts open into a crater of
 * upturned paving slabs and earth around a pitch-black throat, and tomatoes
 * climb and leap out of it. No renderer support needed: the crater sits on
 * top of the ground and the throat is a black disc the crater walls fade into,
 * so anything below ground (a tomato on its way up) is hidden by the ground
 * itself and appears to rise out of the dark.
 */
export interface HoleDef {
  /** Throat, crest and outer radius of the crater (m); crest height (m). */
  throat: number;
  crest: number;
  outer: number;
  height: number;
  /** Upturned slabs around the rim, and slabs thrown flying when it bursts. */
  slabs: number;
  thrown: number;
  /** Seconds of rumble and cracking before it bursts. */
  rumble: number;
  /** Camera shake (degrees at 10 m) building during the rumble, and the kick when it bursts. */
  rumbleShake: number;
  burstShake: number;
}

export const HOLE_DEFAULTS: HoleDef = { throat: 2.1, crest: 3.0, outer: 5.8, height: 1.4, slabs: 22, thrown: 12, rumble: 2.8, rumbleShake: 0.35, burstShake: 4 };

const SOIL: [number, number, number] = [0.2, 0.15, 0.1];
const DUST: [number, number, number] = [0.5, 0.46, 0.41];
const TAU = Math.PI * 2;

type V3 = [number, number, number];

/** Small mesh writer: positions, normals, uv (metres), vertex colour (G = AO), indices. */
class Writer {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, ao = 1) {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(0, ao, 0, 1);
    return this.pos.length / 3 - 1;
  }
  build(material: string): PrimitiveData {
    return {
      positions: new Float32Array(this.pos), normals: new Float32Array(this.nrm), uv0: new Float32Array(this.uv),
      colors: new Float32Array(this.col), indices: new Uint32Array(this.idx), material,
    };
  }
  /** Smooth normals from the faces (for grids built with placeholder normals). */
  smooth() {
    const n = new Float32Array(this.pos.length), P = this.pos, I = this.idx;
    for (let i = 0; i < I.length; i += 3) {
      const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
      for (const k of [a, b, c]) { n[k] += fx; n[k + 1] += fy; n[k + 2] += fz; }
    }
    for (let k = 0; k < n.length; k += 3) {
      const l = Math.hypot(n[k], n[k + 1], n[k + 2]) || 1;
      this.nrm[k] = n[k] / l; this.nrm[k + 1] = n[k + 1] / l; this.nrm[k + 2] = n[k + 2] / l;
    }
  }
}

/** Smooth periodic noise around the circle (a few random harmonics), -1..1-ish. */
function ringNoise(seed: number) {
  let s = seed;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const h = [1, 2, 3, 5, 7, 11].map((k) => ({ k, a: r() * TAU, w: 1 / Math.sqrt(k) }));
  const norm = h.reduce((x, e) => x + e.w, 0);
  return (a: number) => h.reduce((x, e) => x + Math.sin(a * e.k + e.a) * e.w, 0) / norm * 1.6;
}

/**
 * The crater mound: a ring of earth rising steeply from the throat edge (black, deep in AO) to a
 * ragged crest and falling away over the paving. Centred on the origin at ground level.
 */
function buildMound(d: HoleDef, seed: number): { mound: PrimitiveData; throat: PrimitiveData; radius: (a: number) => number } {
  const nh = ringNoise(seed), nr = ringNoise(seed + 7), nb = ringNoise(seed + 13);
  const NA = 96, rings = 22;
  const throatR = (a: number) => d.throat * (1 + 0.1 * nr(a));
  const W = new Writer();
  for (let j = 0; j <= NA; j++) {
    const a = (j / NA) * TAU, ca = Math.cos(a), sa = Math.sin(a);
    const r0 = throatR(a), rc = d.crest * (1 + 0.08 * nr(a + 1)), ro = d.outer * (1 + 0.1 * nb(a));
    const H = d.height * (0.7 + 0.45 * (0.5 + 0.5 * nh(a)));
    for (let i = 0; i <= rings; i++) {
      // Rings bunched at the crest; the first third is the inner wall.
      const u = i / rings;
      let r: number, y: number, ao: number;
      if (u < 0.38) {
        const k = u / 0.38;
        r = r0 + (rc - r0) * Math.pow(k, 0.8);
        y = 0.02 + (H - 0.02) * (1 - Math.pow(1 - k, 2.2));
        ao = 0.02 + 0.98 * Math.pow(k, 1.8);
      } else {
        const k = (u - 0.38) / 0.62;
        r = rc + (ro - rc) * k;
        y = H * Math.pow(1 - k, 1.5) - 0.03 * k;
        ao = 1 - 0.25 * Math.pow(k, 4);
      }
      // Lumps.
      const bump = 0.05 * Math.sin(a * 17 + i * 1.3) * Math.sin(a * 5 - i * 0.7) * (y > 0.05 ? 1 : 0);
      const x = ca * r, z = sa * r;
      W.vert(x, y + bump, z, 0, 1, 0, x, z, ao);
    }
  }
  const row = rings + 1;
  for (let j = 0; j < NA; j++) {
    for (let i = 0; i < rings; i++) {
      const a = j * row + i, b = (j + 1) * row + i;
      W.idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  W.smooth();
  // Throat: a black disc just above the paving, under the wall's foot.
  const T = new Writer();
  const c = T.vert(0, 0.025, 0, 0, 1, 0, 0, 0, 0);
  for (let j = 0; j <= NA; j++) {
    const a = (j / NA) * TAU, r = throatR(a) + 0.06;
    T.vert(Math.cos(a) * r, 0.025, Math.sin(a) * r, 0, 1, 0, 0, 0, 0);
  }
  for (let j = 0; j < NA; j++) T.idx.push(c, c + 2 + j, c + 1 + j);
  // Winding: the grid above runs a (+angle) by r; make sure both face up.
  return { mound: W.build('dirt'), throat: T.build('hole_void'), radius: throatR };
}

/** A paving slab: paving on top, broken concrete on the sides and underneath. Centred, `w` × `l` × `t`. */
function buildSlab(w: number, l: number, t: number): MeshData {
  const top = new Writer(), side = new Writer();
  const hx = w / 2, hz = l / 2, hy = t / 2;
  const quad = (W: Writer, p: V3[], n: V3, uvs: [number, number][], ao = 1) => {
    const b = p.map((q, i) => W.vert(q[0], q[1], q[2], n[0], n[1], n[2], uvs[i][0], uvs[i][1], ao));
    W.idx.push(b[0], b[1], b[2], b[0], b[2], b[3]);
  };
  quad(top, [[-hx, hy, -hz], [-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz]], [0, 1, 0], [[-hx, -hz], [-hx, hz], [hx, hz], [hx, -hz]]);
  quad(side, [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]], [0, -1, 0], [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]], 0.5);
  quad(side, [[hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz], [hx, -hy, hz]], [1, 0, 0], [[-hz, -hy], [-hz, hy], [hz, hy], [hz, -hy]], 0.8);
  quad(side, [[-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz], [-hx, -hy, -hz]], [-1, 0, 0], [[hz, -hy], [hz, hy], [-hz, hy], [-hz, -hy]], 0.8);
  quad(side, [[hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz], [-hx, -hy, hz]], [0, 0, 1], [[hx, -hy], [hx, hy], [-hx, hy], [-hx, -hy]], 0.8);
  quad(side, [[-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz], [hx, -hy, -hz]], [0, 0, -1], [[-hx, -hy], [-hx, hy], [hx, hy], [hx, -hy]], 0.8);
  return { name: 'slab', primitives: [top.build('paving_square'), side.build('concrete_cast')] };
}

interface Part {
  r: Renderable;
  /** Final pose (relative to the hole centre) and where it bursts up from; delay and time to settle. */
  end: Mat4;
  pos0: V3;
  pos1: V3;
  rot0: Float32Array;
  rot1: Float32Array;
  scale: V3;
  delay: number;
}

/** One hole: its crater pieces, timeline and what it still has to let out. */
export class BugHole {
  readonly centre: V3 = [0, 0, 0];
  t = 0;
  active = false;
  burst = false;
  /** Tomatoes still to come out, the clock between them. */
  pending = 0;
  nextT = 0;
  /** Seconds since it last emptied (the director refills it). */
  idleT = 0;
  /** Nav links taken away under the crater (restored on clear). */
  navUndo: (() => void) | null = null;
  readonly parts: Part[] = [];
  mound!: Renderable;
  throat!: Renderable;
  throatR: (a: number) => number = () => 2;
  /** Cracks painted so far; the crater's random turn. */
  cracks = 0;
  spin = 0;

  get open() {
    return this.active && this.t > this.def.rumble + 0.35;
  }

  constructor(readonly def: HoleDef) {}

  /** A start point below ground in the throat (for a tomato on its way up), towards angle `a`. */
  throatPoint(a: number, out: V3, depth = 1.2, edge = 0.5) {
    const r = this.throatR(a) * edge * (0.6 + Math.random() * 0.4);
    out[0] = this.centre[0] + Math.cos(a) * r;
    out[1] = this.centre[1] - depth;
    out[2] = this.centre[2] + Math.sin(a) * r;
    return out;
  }

  /** Crest height towards angle `a` (above the centre's ground). */
  crestHeight() {
    return this.def.height * 0.85;
  }
}

const QA = quat.create();
const M = mat4.create();

/** All holes in play: building their meshes once, running their timelines, the eruption effects. */
export class HoleField {
  readonly holes: BugHole[] = [];
  def: HoleDef = { ...HOLE_DEFAULTS };
  /** Camera shake to apply this frame (degrees), and an impulse when one bursts. */
  shake = 0;
  kick = 0;
  /** A hole burst (game: nav, keep the player out, crush what stood there). */
  onBurst: ((h: BugHole) => void)[] = [];
  private slabMeshes: { mesh: GpuMesh; materials: Material[]; debris: DebrisMesh }[] = [];
  private mound: { mesh: GpuMesh; materials: Material[]; radius: (a: number) => number } | null = null;
  private throatMesh: { mesh: GpuMesh; materials: Material[] } | null = null;

  constructor(private renderer: Renderer, private world: World, private particles: ParticleSystem, private debris: Debris, private audio: GameAudio) {}

  async load() {
    const R = this.renderer;
    const mats = async (m: GpuMesh) => Promise.all(m.primitives.map((q) => R.materials.get(q.material)));
    const geo = buildMound(this.def, 41);
    const mm = R.arena.upload({ name: 'hole_mound', primitives: [geo.mound] });
    this.mound = { mesh: mm, materials: await mats(mm), radius: geo.radius };
    const tm = R.arena.upload({ name: 'hole_throat', primitives: [geo.throat] });
    this.throatMesh = { mesh: tm, materials: await mats(tm) };
    for (const [w, l] of [[0.95, 0.7], [1.15, 0.62], [0.72, 0.56], [0.85, 0.85]]) {
      const mesh = R.arena.upload(buildSlab(w, l, 0.12));
      const materials = await mats(mesh);
      this.slabMeshes.push({ mesh, materials, debris: { mesh, materials, radius: Math.max(w, l) * 0.42, flatAxis: [0, 1, 0], rest: 0.06 } });
    }
  }

  private renderable(id: string, mesh: GpuMesh, materials: Material[], castShadow = true): Renderable {
    const r: Renderable = { slot: this.renderer.instances.alloc(), mesh, materials, castShadow, visible: false, id, worldMin: new Float32Array(3), worldMax: new Float32Array(3) };
    this.world.renderables.push(r);
    return r;
  }

  private place(r: Renderable, m: Mat4) {
    r.visible = true;
    transformAabb(m, r.mesh.aabb.min, r.mesh.aabb.max, r.worldMin, r.worldMax);
    this.renderer.instances.set(r.slot, m, null, -1, this.renderer.probeBits(r.worldMin, r.worldMax), 1, 0x401e);
  }

  /**
   * Starts a hole at ground point `at`: rumble, cracks, then the burst. With all four in use, the
   * one furthest from `near` (if more than 35 m away) closes to make room.
   */
  open(at: ArrayLike<number>, near?: ArrayLike<number>): BugHole | null {
    if (!this.mound || !this.throatMesh) return null;
    let h = this.holes.find((x) => !x.active);
    if (!h && this.holes.length >= 4 && near) {
      let bd = 35;
      for (const x of this.holes) {
        const d = Math.hypot(x.centre[0] - near[0], x.centre[2] - near[2]);
        if (d > bd) { bd = d; h = x; }
      }
      if (h) this.close(h);
    }
    if (!h) {
      if (this.holes.length >= 4) return null;
      h = new BugHole(this.def);
      h.mound = this.renderable(`hole${this.holes.length}/mound`, this.mound.mesh, this.mound.materials);
      h.throat = this.renderable(`hole${this.holes.length}/throat`, this.throatMesh.mesh, this.throatMesh.materials, false);
      for (let i = 0; i < this.def.slabs; i++) {
        const s = this.slabMeshes[i % this.slabMeshes.length];
        h.parts.push({ r: this.renderable(`hole${this.holes.length}/slab${i}`, s.mesh, s.materials), end: mat4.create(), pos0: [0, 0, 0], pos1: [0, 0, 0], rot0: quat.create(), rot1: quat.create(), scale: [1, 1, 1], delay: 0 });
      }
      this.holes.push(h);
    }
    const d = this.def;
    h.centre[0] = at[0]; h.centre[1] = at[1]; h.centre[2] = at[2];
    h.t = 0;
    h.active = true;
    h.burst = false;
    h.pending = 0;
    h.nextT = 0;
    h.idleT = 0;
    const spin = (h.spin = Math.random() * TAU);
    h.throatR = (a: number) => this.mound!.radius(a + spin);
    h.cracks = 0;
    // Rim slabs heaved up around the crest at every angle, some lying half buried on the slope, the odd
    // one flipped; they burst up from below.
    for (let i = 0; i < h.parts.length; i++) {
      const p = h.parts[i];
      const a = (i / h.parts.length) * TAU + (Math.random() - 0.5) * 0.35;
      const lying = i % 3 === 2;
      const r = lying ? d.crest + 0.5 + Math.random() * 1.6 : d.crest - 0.35 + Math.random() * 0.7;
      const tilt = lying ? 0.2 + Math.random() * 0.4 : 0.45 + Math.random() * 0.8;
      // On the mound's surface there (the outer slope falls as (1 - k)^1.5), sunk in a little.
      const slope = Math.max(0, Math.min(1, (r - d.crest) / (d.outer - d.crest)));
      const y = d.height * Math.pow(1 - slope, 1.5) * (lying ? 0.9 : 0.7) - 0.05;
      p.pos1 = [Math.cos(a) * r, y, Math.sin(a) * r];
      p.pos0 = [Math.cos(a) * r * 0.55, -0.4, Math.sin(a) * r * 0.55];
      // Local +z points out; the inner edge is heaved up, so the top faces up and out; turned and rolled.
      const flip = Math.random() < 0.15 ? Math.PI : 0;
      quat.fromEuler(tilt, Math.PI / 2 - a + (Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.7 + flip, 'yxz', p.rot1);
      quat.fromEuler(0, Math.PI / 2 - a + (Math.random() - 0.5), 0, 'yxz', p.rot0);
      const k = 0.85 + Math.random() * 0.4;
      p.scale = [k, 1, k * (0.85 + Math.random() * 0.3)];
      p.delay = Math.random() * 0.12;
      p.r.visible = false;
    }
    h.mound.visible = false;
    h.throat.visible = false;
    this.audio.play('hole_rumble', { pos: [at[0], at[1] + 0.5, at[2]] });
    return h;
  }

  clear() {
    for (const h of this.holes) this.close(h);
  }

  /** Takes a hole away (its crater, its nav block). */
  close(h: BugHole) {
    h.active = false;
    h.pending = 0;
    h.mound.visible = false;
    h.throat.visible = false;
    for (const p of h.parts) p.r.visible = false;
    h.navUndo?.();
    h.navUndo = null;
  }

  update(dt: number, eye: ArrayLike<number>) {
    this.shake = 0;
    this.kick = 0;
    for (const h of this.holes) if (h.active) this.step(h, dt, eye);
  }

  private step(h: BugHole, dt: number, eye: ArrayLike<number>) {
    const d = this.def, c = h.centre, P = this.particles;
    h.t += dt;
    const t = h.t, T = d.rumble;
    const dist = Math.max(3, Math.hypot(c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]));
    const near = 10 / dist;
    const spin = h.spin;
    if (t < T) {
      // Rumble: the shake swells, dust spits from the joints, cracks spread outwards.
      const k = t / T;
      this.shake = Math.max(this.shake, d.rumbleShake * k * k * near);
      if (Math.random() < dt * (8 + 50 * k)) {
        const a = Math.random() * TAU, r = Math.random() * d.outer * (0.3 + 0.7 * k);
        P.emit('dust', { count: 2, pos: [c[0] + Math.cos(a) * r, c[1] + 0.05, c[2] + Math.sin(a) * r], dir: [0, 1, 0], spread: 0.4, speed: [0.6, 2 + 3.5 * k], life: [0.9, 2], size: [0.15, 0.6 + 1.2 * k], color: DUST, alpha: 0.45, drag: 2.5, gravity: 0.3 });
        P.emit('debris', { count: 4, pos: [c[0] + Math.cos(a) * r, c[1] + 0.03, c[2] + Math.sin(a) * r], dir: [0, 1, 0], spread: 0.6, speed: [0.6, 3 * k + 0.8], life: [0.6, 1.2], size: [0.012, 0.035], color: [0.45, 0.44, 0.42], alpha: 1, drag: 0.5, gravity: 9.8, floor: c[1] });
      }
      // Cracks race outwards from the middle.
      const want = Math.floor(4 + Math.min(1, k * 1.4) * 14);
      while (h.cracks < want) {
        const a = Math.random() * TAU, r = 0.4 + (h.cracks / 18) * d.outer * 1.1 + Math.random() * 0.6;
        this.world.addDecal('decal_crack', [c[0] + Math.cos(a) * r, c[1] + 0.05, c[2] + Math.sin(a) * r], [0, 1, 0], 1.6 + Math.random() * 1.8, true, -a + Math.PI / 2);
        h.cracks++;
      }
      // The ground heaves: a mound pushing up through the cracked paving, trembling.
      const bulge = Math.max(0, (k - 0.25) / 0.75);
      const tremble = 1 + 0.06 * Math.sin(t * 47) * bulge;
      mat4.translation(c, M);
      mat4.rotateY(M, spin, M);
      mat4.scale(M, [0.5 + 0.25 * bulge, (0.02 + 0.33 * Math.pow(bulge, 1.4)) * tremble, 0.5 + 0.25 * bulge], M);
      if (bulge > 0) this.place(h.mound, M);
      return;
    }
    if (!h.burst) {
      h.burst = true;
      this.kick = d.burstShake * near;
      this.audio.play('hole_burst', { pos: [c[0], c[1] + 0.5, c[2]] });
      this.erupt(h);
      for (const f of this.onBurst) f(h);
    }
    // Burst: the mound rises with a little overshoot, the throat opens, slabs flip up into place.
    const b = t - T;
    const e = (x: number) => { const s = 1.6; const u = Math.min(1, x) - 1; return 1 + (s + 1) * u * u * u + s * u * u; };
    const mk = e(b / 0.35);
    mat4.translation(c, M);
    mat4.rotateY(M, spin, M);
    mat4.scale(M, [0.75 + 0.25 * mk, 0.35 + 0.65 * mk, 0.75 + 0.25 * mk], M);
    this.place(h.mound, M);
    const tk = Math.min(1, b / 0.3);
    mat4.translation(c, M);
    mat4.rotateY(M, spin, M);
    mat4.uniformScale(M, Math.max(0.01, tk), M);
    this.place(h.throat, M);
    for (const p of h.parts) {
      const u = Math.max(0, b - p.delay) / 0.32;
      if (u <= 0) continue;
      const k = e(u);
      const pos: V3 = [p.pos0[0] + (p.pos1[0] - p.pos0[0]) * k, p.pos0[1] + (p.pos1[1] - p.pos0[1]) * k, p.pos0[2] + (p.pos1[2] - p.pos0[2]) * k];
      quat.slerp(p.rot0, p.rot1, Math.min(1, k), QA);
      mat4.fromQuat(QA, p.end);
      mat4.translation([c[0] + pos[0], c[1] + pos[1], c[2] + pos[2]], M);
      mat4.multiply(M, p.end, M);
      mat4.scale(M, p.scale, M);
      this.place(p.r, M);
    }
    // A breath of dust out of the dark now and then.
    if (Math.random() < dt * 1.5) {
      const a = Math.random() * TAU, r = Math.random() * d.throat * 0.8;
      P.emit('dust', { count: 1, pos: [c[0] + Math.cos(a) * r, c[1] + 0.1, c[2] + Math.sin(a) * r], dir: [0, 1, 0], spread: 0.3, speed: [0.3, 0.8], life: [2.5, 4], size: [0.4, 1.6], color: [0.3, 0.27, 0.24], alpha: 0.18, drag: 1.5, gravity: -0.05 });
    }
  }

  /** The burst: an earth and dust plume, slabs and clods thrown, dirt around. */
  private erupt(h: BugHole) {
    const d = this.def, c = h.centre, P = this.particles;
    P.emit('dust', { count: 20, pos: [c[0], c[1] + 0.4, c[2]], dir: [0, 1, 0], spread: 0.45, speed: [4, 15], life: [2, 4.5], size: [0.5, 2.6], color: DUST, alpha: 0.45, drag: 2.2, gravity: -0.1 });
    P.emit('dust', { count: 14, pos: [c[0], c[1] + 0.2, c[2]], dir: [0, 0.25, 0], spread: 1, speed: [4, 10], life: [1.5, 3], size: [0.5, 2], color: [0.42, 0.38, 0.33], alpha: 0.38, drag: 3, gravity: 0.05 });
    P.emit('debris', { count: 220, pos: [c[0], c[1] + 0.3, c[2]], dir: [0, 1, 0], spread: 0.75, speed: [3, 13], life: [1.5, 3.5], size: [0.02, 0.09], color: SOIL, alpha: 1, drag: 0.2, gravity: 9.8, floor: c[1] });
    P.emit('debris', { count: 120, pos: [c[0], c[1] + 0.3, c[2]], dir: [0, 1, 0], spread: 0.9, speed: [2, 9], life: [1.2, 3], size: [0.015, 0.05], color: [0.48, 0.47, 0.45], alpha: 1, drag: 0.3, gravity: 9.8, floor: c[1] });
    for (let i = 0; i < d.thrown; i++) {
      const s = this.slabMeshes[i % this.slabMeshes.length];
      const a = Math.random() * TAU, r = Math.random() * d.throat;
      const sp = 3 + Math.random() * 6, up = 5 + Math.random() * 7;
      quat.fromEuler(Math.random() * 6.3, Math.random() * 6.3, Math.random() * 6.3, 'xyz', QA);
      this.debris.spawn(s.debris, [c[0] + Math.cos(a) * r, c[1] + 0.3, c[2] + Math.sin(a) * r], QA, [Math.cos(a) * sp, up, Math.sin(a) * sp],
        [(Math.random() - 0.5) * 14, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 14], { scale: 0.7 + Math.random() * 0.5, life: 90, bounce: 0.25, friction: 0.6 });
    }
    // Earth spilled around the crater.
    for (let i = 0; i < 8; i++) {
      const a = Math.random() * TAU, r = d.outer * (0.8 + Math.random() * 0.6);
      this.world.addDecal('decal_stain', [c[0] + Math.cos(a) * r, c[1] + 0.05, c[2] + Math.sin(a) * r], [0, 1, 0], 1.5 + Math.random() * 2, true, Math.random() * TAU);
    }
  }
}
