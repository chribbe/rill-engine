// Shared frame-level definitions. Keep in sync with src/engine/render/frame.ts.

const PI: f32 = 3.14159265359;
const INV_PI: f32 = 0.31830988618;

struct Frame {
  viewProj: mat4x4f,
  view: mat4x4f,
  proj: mat4x4f,
  invViewProj: mat4x4f,
  cascadeViewProj: array<mat4x4f, 4>,
  cameraPos: vec4f,      // xyz, w = time (s)
  viewport: vec4f,       // w, h, 1/w, 1/h
  sunDir: vec4f,         // xyz toward sun, w = cos(sun angular radius)
  sunColor: vec4f,       // rgb = sun illuminance at ground (lux), w = sun disk luminance scale
  exposure: vec4f,       // x pre-exposure, y ev100, z sky intensity, w indirect intensity
  fog0: vec4f,           // x fog density (1/m) at reference height, y reference height (m), z height falloff (1/m), w haze density (1/m)
  fog1: vec4f,           // x phase g, y start distance (m), z max opacity, w sky fog height fade
  fogColor: vec4f,       // rgb fog albedo, w sun inscatter strength
  shadow0: vec4f,        // x normal offset (texels), y const bias, z softness, w shadow distance
  cascadeSplits: vec4f,  // far view depth per cascade
  cascadeTexel: vec4f,   // world-space texel size per cascade
  mat0: vec4f,           // x detail strength, y macro strength, z mip bias, w normal strength
  mat1: vec4f,           // x specular AA, y wetness, z puddles, w env specular intensity
  clouds: vec4f,         // x cover, y cloud altitude (m), z wind offset x, w wind offset z
  overcast: vec4f,       // rgb overcast zenith radiance (nits), w cloud density
  ground: vec4f,         // rgb ground albedo (for env lower hemisphere), w local light intensity
  lmParams: vec4f,       // x lightmap enabled, y bicubic, z sky layer scale, w sun bounce scale
  debug: vec4u,          // x view mode, y flags, z light count, w decal count
  decalGrid: vec4f,      // x origin x, y origin z, z cell size, w inv cell size
  decalGrid2: vec4u,     // x cells x, y cells z, z max per cell, w reserved
  atmo: vec4f,           // x planet radius (km), y atmosphere top (km), z camera altitude (km), w mie scale
  sky: vec4f,            // x sun TOA illuminance (lux), y horizon haze, z env mip count, w cloud sharpness
  skyTint: vec4f,        // rgb art-direction multiplier on the clear-sky atmosphere radiance
  pvOrigin: vec4f,       // probe volume min corner (probe 0,0,0), w = enabled
  pvInvSpacing: vec4f,   // 1 / probe spacing
  pvDims: vec4u,         // x,y,z probe counts, w = reflection probe count
  season: vec4f,         // x snow cover, y melt water, z dormant-season tint, w 1 / snow texture size (m)
};

// debug.y flags
const F_SHADOWS: u32 = 1u;
const F_FOG: u32 = 2u;
const F_LIGHTMAPS: u32 = 4u;
const F_DETAIL: u32 = 8u;
const F_DECALS: u32 = 16u;
const F_SPEC_AA: u32 = 32u;
const F_LOCAL_LIGHTS: u32 = 64u;
const F_CASCADE_BLEND: u32 = 128u;
const F_SH_RATIO: u32 = 256u;
const F_SPEC_OCCLUSION: u32 = 512u;
const F_ENV_SPEC: u32 = 1024u;
const F_SKY_AMBIENT: u32 = 2048u;
const F_SUN: u32 = 4096u;
const F_A2C: u32 = 8192u;
const F_PCF7: u32 = 0x10000u;
const F_PROBE_VOLUME: u32 = 0x20000u;
const F_REFL_PROBES: u32 = 0x40000u;
const F_DIR_LIGHTMAP: u32 = 0x80000u;

struct Instance {
  model: mat4x4f,
  lmST: vec4f,   // lightmap uv scale (xy) / offset (zw)
  info: vec4u,   // x = lightmap layer + 1 (0 = none), y = flags, z = random seed, w = object id hash
};

// Instance flags
const I_LIGHTMAPPED: u32 = 1u;
const I_NO_DECALS: u32 = 2u;
const I_VIEWMODEL: u32 = 4u;  // first-person weapon: depth squeezed in front of the world

fn luminance(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

fn srgbToLinear(c: vec3f) -> vec3f {
  let lo = c / 12.92;
  let hi = pow((c + 0.055) / 1.055, vec3f(2.4));
  return select(hi, lo, c <= vec3f(0.04045));
}

fn linearToSrgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}

fn hash11(p: u32) -> u32 {
  var x = p;
  x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u;
  return x;
}
fn hashToFloat(h: u32) -> f32 { return f32(h & 0xffffffu) / 16777216.0; }

// Interleaved gradient noise (Jimenez) - stable per-pixel dither.
fn ign(p: vec2f) -> f32 { return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715)))); }

// Encodes a pre-exposed HDR colour for the weighted (tonemap-aware) MSAA resolve.
// Hardware resolve averages (c*w, w); the post pass divides rgb by alpha.
fn encodeResolve(c: vec3f) -> vec4f {
  let w = 1.0 / (1.0 + luminance(c));
  return vec4f(c * w, w);
}

// Cofactor matrix: correct normal transform for non-uniform scale without an inverse.
fn normalMatrix(m: mat4x4f) -> mat3x3f {
  let a = m[0].xyz; let b = m[1].xyz; let c = m[2].xyz;
  return mat3x3f(cross(b, c), cross(c, a), cross(a, b));
}
