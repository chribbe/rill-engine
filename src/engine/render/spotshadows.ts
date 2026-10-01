import { mat4, vec3 } from 'wgpu-matrix';
import { extractPlanes, type Plane } from './culling';

/**
 * Shadow maps for a few dynamic spot lights (flashlight, vehicle lights...):
 * one depth layer each, re-rendered every frame from the light. Static lamps
 * stay unshadowed (their occlusion is baked); dynamic lights are the ones that
 * need shadows to sit in the world.
 */
export const SPOT_LAYERS = 2;
export const SPOT_SIZE = 1024;

export interface SpotShadowView {
  viewProj: Float32Array;
  planes: Plane[];
}

export class SpotShadows {
  readonly texture: GPUTexture;
  readonly layerViews: GPUTextureView[] = [];
  readonly arrayView: GPUTextureView;
  /** 256-byte aligned viewProj per layer (vertex uniform for the caster pass). */
  readonly uniforms: GPUBuffer;
  /** Same matrices as a storage array for sampling in the lit pass. */
  readonly mats: GPUBuffer;
  readonly views: SpotShadowView[] = [];
  active = 0;

  constructor(private device: GPUDevice) {
    this.texture = device.createTexture({
      label: 'spotShadows', size: [SPOT_SIZE, SPOT_SIZE, SPOT_LAYERS], format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    for (let i = 0; i < SPOT_LAYERS; i++) {
      this.layerViews.push(this.texture.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 }));
    }
    this.arrayView = this.texture.createView({ dimension: '2d-array' });
    this.uniforms = device.createBuffer({ label: 'spotShadowViews', size: 256 * SPOT_LAYERS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.mats = device.createBuffer({ label: 'spotShadowMats', size: 64 * SPOT_LAYERS, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }

  /** Builds the light-space projections for this frame's shadowed spots (outer cone + margin). */
  update(spots: { position: ArrayLike<number>; direction: ArrayLike<number>; outerAngle: number; range: number }[]) {
    this.active = Math.min(SPOT_LAYERS, spots.length);
    this.views.length = 0;
    const all = new Float32Array(16 * SPOT_LAYERS);
    for (let i = 0; i < this.active; i++) {
      const s = spots[i];
      const p = vec3.fromValues(s.position[0], s.position[1], s.position[2]);
      const d = vec3.normalize(vec3.fromValues(s.direction[0], s.direction[1], s.direction[2]));
      const up = Math.abs(d[1]) > 0.95 ? vec3.fromValues(1, 0, 0) : vec3.fromValues(0, 1, 0);
      const view = mat4.lookAt(p, vec3.add(p, d), up);
      const fov = Math.min(Math.PI * 0.95, 2 * (s.outerAngle * Math.PI) / 180 + 0.1);
      const proj = mat4.perspective(fov, 1, 0.05, Math.max(1, s.range));
      const vp = mat4.multiply(proj, view) as Float32Array;
      this.views.push({ viewProj: vp, planes: extractPlanes(vp, { near: true, far: true, zeroToOne: true }) });
      this.device.queue.writeBuffer(this.uniforms, i * 256, vp as Float32Array<ArrayBuffer>);
      all.set(vp, i * 16);
    }
    this.device.queue.writeBuffer(this.mats, 0, all);
  }

  get bytes() {
    return SPOT_SIZE * SPOT_SIZE * 4 * SPOT_LAYERS;
  }
}
