import { mat4, vec3, type Mat4 } from 'wgpu-matrix';
import { extractPlanes, type Plane } from './culling';

export const CASCADES = 4;

export interface ShadowSettings {
  enabled: boolean;
  resolution: number;
  distance: number;
  /** Practical split scheme blend: 0 = uniform, 1 = logarithmic. */
  splitLambda: number;
  normalOffset: number;
  constBias: number;
  slopeBias: number;
  /** Penumbra size in metres (filter spread); large for overcast skies. */
  softness: number;
  pcf7: boolean;
  cascadeBlend: boolean;
  /** Metres casters may extend toward the sun beyond the cascade sphere. */
  casterExtension: number;
  /**
   * Render the two far cascades on alternating frames (each keeps the matrix it
   * was rendered with, so sampling stays exact; only their placement and dynamic
   * casters lag one frame). Near cascades always render.
   */
  staggerFar: boolean;
}

export interface Cascade {
  viewProj: Mat4;
  splitFar: number;
  texelWorld: number;
  radius: number;
  center: [number, number, number];
  planes: Plane[];
}

export class ShadowSystem {
  texture!: GPUTexture;
  arrayView!: GPUTextureView;
  layerViews: GPUTextureView[] = [];
  readonly uniforms: GPUBuffer;
  cascades: Cascade[] = [];
  private size = 0;

  constructor(private device: GPUDevice) {
    this.uniforms = device.createBuffer({ label: 'shadow:views', size: 256 * CASCADES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    for (let i = 0; i < CASCADES; i++) {
      this.cascades.push({ viewProj: mat4.identity(), splitFar: 0, texelWorld: 0, radius: 0, center: [0, 0, 0], planes: [] });
    }
  }

  /** Returns true when the texture was (re)created (bind groups must be rebuilt). */
  ensure(resolution: number): boolean {
    if (resolution === this.size) return false;
    this.texture?.destroy();
    this.size = resolution;
    this.texture = this.device.createTexture({
      label: 'shadow:csm',
      size: [resolution, resolution, CASCADES],
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.arrayView = this.texture.createView({ dimension: '2d-array' });
    this.layerViews = [];
    for (let i = 0; i < CASCADES; i++) {
      this.layerViews.push(this.texture.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 }));
    }
    return true;
  }

  get resolution() {
    return this.size;
  }

  /**
   * Stable cascade fit: each cascade is the bounding sphere of its view-frustum
   * slice (rotation invariant, so no size changes as the camera turns), and the
   * light-space origin is snapped to whole shadow texels (no crawling when moving).
   */
  /** Cascades refreshed by the last `update` (bit i = cascade i); the others keep last frame's map. */
  updatedMask = 0;
  private frame = 0;
  private lastKey = '';
  private pendingFull = false;
  private lastPos = vec3.create();
  private lastSun = vec3.create();

  /**
   * Picks the cascades to refresh this frame: all of them after a settings change,
   * a teleport or a sun jump (or when staggering is off / `force`), otherwise the
   * near two plus one far cascade, alternating.
   */
  private chooseMask(camPos: Float32Array, sunDir: [number, number, number], s: ShadowSettings, force: boolean): number {
    const key = `${this.size}:${s.distance}:${s.splitLambda}:${s.casterExtension}`;
    const moved = vec3.distance(camPos, this.lastPos);
    const sunJump = vec3.dot(vec3.normalize(vec3.fromValues(...sunDir)), this.lastSun) < 0.99995;
    // A forced update (probe capture from another viewpoint) also invalidates the next frame.
    const full = force || this.pendingFull || !s.staggerFar || key !== this.lastKey || moved > 4 || sunJump;
    this.pendingFull = force;
    this.lastKey = key;
    vec3.copy(camPos, this.lastPos);
    vec3.normalize(vec3.fromValues(...sunDir), this.lastSun);
    this.frame++;
    if (full) return (1 << CASCADES) - 1;
    return 0b0011 | (this.frame & 1 ? 0b1000 : 0b0100);
  }

  update(camPos: Float32Array, camForward: Float32Array, fovY: number, aspect: number, near: number, sunDir: [number, number, number], s: ShadowSettings, force = false) {
    const mask = this.chooseMask(camPos, sunDir, s, force);
    this.updatedMask = mask;
    const far = s.distance;
    const k = Math.tan(fovY / 2) * Math.sqrt(1 + aspect * aspect);
    const k2 = k * k;
    const L = vec3.normalize(vec3.fromValues(...sunDir));
    const up = Math.abs(L[1]) > 0.99 ? vec3.fromValues(1, 0, 0) : vec3.fromValues(0, 1, 0);
    const right = vec3.normalize(vec3.cross(up, L));
    const lup = vec3.cross(L, right);
    let prev = near;
    for (let i = 0; i < CASCADES; i++) {
      const t = (i + 1) / CASCADES;
      const logS = near * Math.pow(far / near, t);
      const uniS = near + (far - near) * t;
      const split = s.splitLambda * logS + (1 - s.splitLambda) * uniS;
      const n = prev;
      const f = split;
      let cz: number, r: number;
      if (k2 >= (f - n) / (f + n)) {
        cz = f;
        r = f * k;
      } else {
        cz = 0.5 * (f + n) * (1 + k2);
        r = 0.5 * Math.sqrt((f - n) * (f - n) + 2 * (f * f + n * n) * k2 + (f + n) * (f + n) * k2 * k2);
      }
      r = Math.ceil(r * 16) / 16;
      const center = vec3.addScaled(camPos, camForward, cz);
      const texel = (2 * r) / this.size;
      // Snap the sphere centre to the light-space texel grid.
      const cx = Math.floor(vec3.dot(center, right) / texel) * texel;
      const cy = Math.floor(vec3.dot(center, lup) / texel) * texel;
      const cd = vec3.dot(center, L);
      const snapped = vec3.add(vec3.add(vec3.scale(right, cx), vec3.scale(lup, cy)), vec3.scale(L, cd));
      const ext = s.casterExtension;
      const eye = vec3.addScaled(snapped, L, r + ext);
      const view = mat4.lookAt(eye, snapped, lup);
      const proj = mat4.ortho(-r, r, -r, r, 0, 2 * r + ext);
      const vp = mat4.multiply(proj, view);
      const c = this.cascades[i];
      if (!(mask & (1 << i))) { prev = split; continue; }
      c.viewProj = vp;
      c.splitFar = split;
      c.texelWorld = texel;
      c.radius = r;
      c.center = [snapped[0], snapped[1], snapped[2]];
      // Culling: side planes + far plane only; casters toward the sun are kept
      // (they are depth-clamped onto the near plane: "pancaking").
      c.planes = extractPlanes(vp, { near: false, far: true, zeroToOne: true });
      prev = split;
    }
    const buf = new Float32Array(64 * CASCADES);
    for (let i = 0; i < CASCADES; i++) {
      buf.set(this.cascades[i].viewProj, i * 64);
      buf.set(this.wind, i * 64 + 16);
    }
    this.device.queue.writeBuffer(this.uniforms, 0, buf);
  }

  private wind = new Float32Array(8);
  /** Wind uniforms for the caster vertex stage (after `update`, every frame). */
  writeWind(w1: number[], w2: number[]) {
    this.wind.set(w1, 0);
    this.wind.set(w2, 4);
    for (let i = 0; i < CASCADES; i++) this.device.queue.writeBuffer(this.uniforms, i * 256 + 64, this.wind);
  }
}
