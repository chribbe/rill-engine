/**
 * CPU mirror of the WGSL `Frame` uniform (src/shaders/common.wgsl).
 * Offsets are in 32-bit words.
 */
export const FRAME_WORDS = 216;
export const FRAME_BYTES = FRAME_WORDS * 4;

export const FO = {
  viewProj: 0,
  view: 16,
  proj: 32,
  invViewProj: 48,
  cascadeViewProj: 64,
  cameraPos: 128,
  viewport: 132,
  sunDir: 136,
  sunColor: 140,
  exposure: 144,
  fog0: 148,
  fog1: 152,
  fogColor: 156,
  shadow0: 160,
  cascadeSplits: 164,
  cascadeTexel: 168,
  mat0: 172,
  mat1: 176,
  clouds: 180,
  overcast: 184,
  ground: 188,
  lmParams: 192,
  debug: 196,
  decalGrid: 200,
  decalGrid2: 204,
  atmo: 208,
  sky: 212,
} as const;

/** Render flags (Frame.debug.y). Keep in sync with common.wgsl. */
export const RF = {
  SHADOWS: 1,
  FOG: 2,
  LIGHTMAPS: 4,
  DETAIL: 8,
  DECALS: 16,
  SPEC_AA: 32,
  LOCAL_LIGHTS: 64,
  CASCADE_BLEND: 128,
  SH_RATIO: 256,
  SPEC_OCCLUSION: 512,
  ENV_SPEC: 1024,
  SKY_AMBIENT: 2048,
  SUN: 4096,
  A2C: 8192,
  PCF7: 0x10000,
} as const;

export class FrameUniforms {
  readonly data = new ArrayBuffer(FRAME_BYTES);
  readonly f = new Float32Array(this.data);
  readonly u = new Uint32Array(this.data);

  mat(offset: number, m: ArrayLike<number>) {
    this.f.set(m as Float32Array, offset);
  }
  vec4(offset: number, x: number, y = 0, z = 0, w = 0) {
    const f = this.f;
    f[offset] = x;
    f[offset + 1] = y;
    f[offset + 2] = z;
    f[offset + 3] = w;
  }
  uvec4(offset: number, x: number, y = 0, z = 0, w = 0) {
    const u = this.u;
    u[offset] = x >>> 0;
    u[offset + 1] = y >>> 0;
    u[offset + 2] = z >>> 0;
    u[offset + 3] = w >>> 0;
  }
}
