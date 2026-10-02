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
  fog1: vec4f,           // x phase g, y start distance (m), z max opacity, w indoor fog scale (camera sky visibility)
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
  lightGrid: vec4f,      // local-light XZ grid: x origin x, y origin z, z cell size, w inv cell size
  lightGrid2: vec4u,     // x cells x, y cells z, z max lights per cell, w word offset of the cells in lightCells
  wind: vec4f,           // xy direction (world xz, unit), z strength (0..1), w time (s)
  wind2: vec4f,          // x gustiness, y gust scale (1/m), z gust speed (m/s), w twig flutter
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
const I_WIND: u32 = 8u;       // vegetation: animated by the wind (all passes, identical positions)

// ------------------------------------------------------------------ wind
fn windHash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }

fn windNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(windHash(i), windHash(i + vec2f(1.0, 0.0)), u.x), mix(windHash(i + vec2f(0.0, 1.0)), windHash(i + vec2f(1.0, 1.0)), u.x), u.y);
}

// Procedural tree wind from the vertex's position relative to the tree base (no
// per-vertex data, so every LOD, the impostors and every pass move identically):
// a gust field rolling across the map with the wind, trunk bending with height^2
// around a slow per-tree sway, branches flexing with the distance from the trunk
// axis, and a fast twig/needle flutter on top.
fn windOffset(wp: vec3f, base: vec3f, seed: u32, wind: vec4f, wind2: vec4f) -> vec3f {
  let s = wind.z;
  if (s <= 0.0) { return vec3f(0.0); }
  let d = vec3f(wind.x, 0.0, wind.y);
  let side = vec3f(-wind.y, 0.0, wind.x);
  let t = wind.w;
  let rel = wp - base;
  let h = max(rel.y, 0.0);
  let r = length(rel.xz);
  let ph = f32(seed & 1023u) * (6.2831853 / 1024.0);
  let gp = (base.xz - wind.xy * (wind2.z * t)) * wind2.y;
  let gust = windNoise(gp) * 0.65 + windNoise(gp * 2.7 + vec2f(13.0, 7.0)) * 0.35;
  let g = mix(1.0, smoothstep(0.2, 0.85, gust) * 1.7, wind2.x);
  let f1 = 0.42 + 0.22 * fract(ph * 1.7);
  let sway = sin(t * f1 * 6.2831853 + ph) * 0.35 + sin(t * f1 * 3.9 + ph * 1.3) * 0.15;
  let hh = h * h * 0.0016 * s;
  var off = d * (hh * (g * 0.8 + sway * (0.45 + 0.55 * g))) + side * (hh * 0.3 * sin(t * f1 * 5.1 + ph * 2.0));
  let flexW = smoothstep(0.25, 2.5, r) * smoothstep(0.4, 2.0, h);
  let bp = dot(wp, vec3f(0.35, 0.21, 0.29));
  let br = sin(t * 1.9 + bp + ph) * 0.6 + sin(t * 3.1 + bp * 1.7) * 0.4;
  off += (d * (0.6 * g + 0.4 * br) + vec3f(0.0, br * 0.35, 0.0)) * (s * flexW * 0.16);
  let fl = sin(t * 7.3 + dot(wp, vec3f(2.3, 1.7, 2.9))) * sin(t * 4.1 + dot(wp, vec3f(1.1, 2.6, 0.7)));
  off += (side * 0.6 + vec3f(0.0, 0.8, 0.0)) * (fl * s * wind2.w * flexW * 0.045 * g);
  // bend rather than shear: points sink a little as they swing away
  off.y -= dot(off.xz, off.xz) / max(2.0 * (h + 1.0), 2.0);
  return off;
}

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
