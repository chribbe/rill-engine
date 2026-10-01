// Standard lit surface shader (opaque + alpha-masked foliage).
#include "frame_bindings"
#include "brdf"
#include "shadows"
#include "fog"
#include "lighting"

struct MaterialParams {
  baseColor: vec4f,
  uvTransform: vec4f,      // xy = 1 / physical size (m), zw = offset
  detailTransform: vec4f,  // xy detail uv scale, z albedo strength, w normal strength
  macroTransform: vec4f,   // xy macro uv scale, z albedo strength, w roughness strength
  pbr: vec4f,              // x roughness, y metallic, z normal strength, w ao strength
  pbr2: vec4f,             // x specular (0.5 = 4% F0), y alpha cutoff, z porosity, w translucency
  emissive: vec4f,         // rgb emissive (nits), w detail fade distance (m)
  flags: vec4u,            // x feature bits
  extra: vec4f,            // x roughness min, y roughness max, z triplanar sharpness, w macro stain strength
  bBaseColor: vec4f,       // blend layer B
  bUvTransform: vec4f,
  bPbr: vec4f,             // x roughness, y metallic, z normal strength, w ao strength
  blendParams: vec4f,      // x contrast, y height influence, z noise, w roughness range
  misc: vec4f,             // x alpha: averaged coverage at distance (sparse twigs), y snow affinity, z season (dry) tint strength, w spare
  dryTint: vec4f,          // rgb albedo multiplier for the dry/dormant season look
};

const M_DETAIL_ALBEDO: u32 = 8u;
const M_DETAIL_NORMAL: u32 = 16u;
const M_MACRO: u32 = 32u;
const M_TRIPLANAR: u32 = 64u;
const M_MASK: u32 = 128u;
const M_FOLIAGE: u32 = 256u;
const M_UNLIT: u32 = 1024u;
const M_DOUBLE_SIDED: u32 = 2048u;
const M_NO_LIGHTMAP_SH_RATIO: u32 = 4096u;
const M_BLEND: u32 = 8192u;

// Pipeline specialisation. The renderer compiles one variant per (material
// features x active global features); disabled blocks are removed by the
// compiler. A single runtime uber-shader carried the register footprint of
// every feature and cost ~3-4x with MSAA on Apple GPUs (see docs/ENGINE.md).
override DEBUG_VIEWS: bool = true;
override USE_TRIPLANAR: bool = true;
override USE_DETAIL: bool = true;
override USE_MACRO: bool = true;
override USE_DECALS: bool = true;
override USE_WETNESS: bool = true;
override USE_SHADOWS: bool = true;
override USE_LIGHTMAP: bool = true;
override USE_LOCAL_LIGHTS: bool = true;
override USE_FOG: bool = true;
override USE_FOLIAGE: bool = true;
override USE_SPEC_AA: bool = true;
override USE_DIR_LIGHTMAP: bool = true;
override USE_PROBE_VOLUME: bool = true;
override USE_REFL_PROBES: bool = true;
override USE_BLEND: bool = true;
override USE_SNOW: bool = true;
// Dithered LOD crossfade (only pipelines that draw instances inside a transition band).
override USE_LOD_FADE: bool = false;
// Prefiltered environment reflections (compiled out for rough foliage).
override USE_ENV_SPEC: bool = true;
// Spot-light shadow lookups (compiled in only while a shadowed spot such as the flashlight exists).
override USE_SPOT_SHADOWS: bool = true;
// Foliage colour pass: fog and ambient (sky SH + probe volume) come from the vertex
// stage (vsFoliage). Cards are small, so per-vertex is indistinguishable, and the
// lighter fragment shader matters most under MSAA (cost tracks compiled size).
override USE_VERTEX_LIGHT: bool = false;

// Half-Life 2 radiosity normal mapping basis (tangent space).
const RNM0: vec3f = vec3f(0.81649658, 0.0, 0.57735027);
const RNM1: vec3f = vec3f(-0.40824829, 0.70710678, 0.57735027);
const RNM2: vec3f = vec3f(-0.40824829, -0.70710678, 0.57735027);

// --- reflection probes ---------------------------------------------------------
fn reflProbeWeight(i: u32, wp: vec3f) -> f32 {
  let p = reflProbes[i];
  let d = min(wp - p.bmin.xyz, p.bmax.xyz - wp);
  return saturate(min(d.x, min(d.y, d.z)) / max(p.bmin.w, 0.05));
}

fn reflProbeDir(i: u32, wp: vec3f, R: vec3f) -> vec3f {
  // Box projection (parallax correction) against the probe's box.
  let p = reflProbes[i];
  let inv = 1.0 / select(R, vec3f(1e-5), abs(R) < vec3f(1e-5));
  let t = max((p.bmax.xyz - wp) * inv, (p.bmin.xyz - wp) * inv);
  let tHit = max(min(t.x, min(t.y, t.z)), 0.0);
  return wp + R * tHit - p.pos.xyz;
}

fn shEvalProbe(i: u32, n: vec3f) -> vec3f {
  let c = reflProbes[i].sh;
  var r = c[0].rgb * 0.282095;
  r += c[1].rgb * 0.488603 * n.y;
  r += c[2].rgb * 0.488603 * n.z;
  r += c[3].rgb * 0.488603 * n.x;
  r += c[4].rgb * 1.092548 * n.x * n.y;
  r += c[5].rgb * 1.092548 * n.y * n.z;
  r += c[6].rgb * 0.315392 * (3.0 * n.z * n.z - 1.0);
  r += c[7].rgb * 1.092548 * n.x * n.z;
  r += c[8].rgb * 0.546274 * (n.x * n.x - n.y * n.y);
  return max(r, vec3f(0.0));
}

@group(1) @binding(0) var<uniform> material: MaterialParams;
@group(1) @binding(1) var baseColorTex: texture_2d<f32>;
@group(1) @binding(2) var normalTex: texture_2d<f32>;
@group(1) @binding(3) var ormTex: texture_2d<f32>;
@group(1) @binding(4) var detailAlbedoTex: texture_2d<f32>;
@group(1) @binding(5) var detailNormalTex: texture_2d<f32>;
@group(1) @binding(6) var macroTex: texture_2d<f32>;
@group(1) @binding(7) var bBaseColorTex: texture_2d<f32>;
@group(1) @binding(8) var bNormalTex: texture_2d<f32>;
@group(1) @binding(9) var bOrmTex: texture_2d<f32>;

fn matFlag(bit: u32) -> bool { return (material.flags.x & bit) != 0u; }

struct VSIn {
  @location(0) position: vec3f,
  @location(1) normal: vec4f,
  @location(2) tangent: vec4f,
  @location(3) uv0: vec2f,
  @location(4) uv1: vec2f,
  @location(5) color: vec4f,
  @builtin(instance_index) instance: u32,
};

struct VSOut {
  // Invariant: the masked depth prepass and the colour pass (depth == equal)
  // must produce bit-identical depths.
  @invariant @builtin(position) pos: vec4f,
  @location(0) worldPos: vec3f,
  @location(1) normal: vec3f,
  @location(2) tangent: vec4f,
  @location(3) uv0: vec2f,
  @location(4) lmUv: vec2f,
  @location(5) viewDepth: f32,
  @location(6) @interpolate(flat) slot: u32,
  @location(7) color: vec4f,
  // LOD crossfade: 0 = none, t in (0,1] = incoming (visible where dither < t), -t = outgoing.
  @location(8) @interpolate(flat) lodFade: f32,
};

// Every vertex entry point that feeds the masked prepass / equal-depth colour pass
// pair must compute positions through this one function (bit-identical depths).
fn clipPosition(inst: Instance, wp: vec4f) -> vec4f {
  var p = frame.viewProj * wp;
  if ((inst.info.y & I_VIEWMODEL) != 0u) {
    // Same projection as the world (muzzle effects line up), depth remapped into
    // [0.75, 1] of reverse-Z so the weapon never clips into walls.
    p.z = p.z * 0.25 + p.w * 0.75;
  }
  return p;
}

// Slim vertex stage for the masked depth prepass: only what coverage needs. On a
// tile-based GPU every varying is written to and read back from memory per
// vertex, which is most of the prepass cost on dense foliage.
struct VSOutDepth {
  @invariant @builtin(position) pos: vec4f,
  @location(0) uv0: vec2f,
  @location(1) @interpolate(flat) lodFade: f32,
};

@vertex
fn vsDepth(@location(0) position: vec3f, @location(3) uv0: vec2f, @builtin(instance_index) instance: u32) -> VSOutDepth {
  let e = visibleList[instance];
  let inst = instances[e & 0xFFFFFFu];
  var o: VSOutDepth;
  o.pos = clipPosition(inst, inst.model * vec4f(position, 1.0));
  o.uv0 = uv0;
  let mode = e >> 30u;
  let q = f32((e >> 24u) & 63u) / 63.0;
  o.lodFade = select(select(0.0, -q, mode == 1u), q, mode == 2u);
  return o;
}

/// Per-vertex fog and ambient for foliage (see USE_VERTEX_LIGHT).
struct VertexLight {
  fog: vec4f,      // rgb in-scatter (scene units, not pre-exposed), a transmittance
  ambFront: vec3f, // irradiance/PI for the card's front side
  ambBack: vec3f,  // ... and for its back side (double-sided cards flip the normal)
};

fn noVertexLight() -> VertexLight {
  return VertexLight(vec4f(0.0, 0.0, 0.0, 1.0), vec3f(0.0), vec3f(0.0));
}

struct VSOutFoliage {
  @invariant @builtin(position) pos: vec4f,
  @location(0) worldPos: vec3f,
  @location(1) normal: vec3f,
  @location(2) tangent: vec4f,
  @location(3) uv0: vec2f,
  @location(4) lmUv: vec2f,
  @location(5) viewDepth: f32,
  @location(6) @interpolate(flat) slot: u32,
  @location(7) color: vec4f,
  @location(8) @interpolate(flat) lodFade: f32,
  @location(9) fog: vec4f,
  @location(10) ambFront: vec3f,
  @location(11) ambBack: vec3f,
};

fn vertexAmbient(wp: vec3f, n: vec3f) -> vec3f {
  var irr = shEval(n);
  if (USE_PROBE_VOLUME && hasFlag(F_PROBE_VOLUME)) {
    let pv = probeVolumeIrradiance(wp, n, skyUpRadiance());
    irr = mix(irr, pv.rgb, pv.a);
  }
  return irr;
}

@vertex
fn vsMain(v: VSIn) -> VSOut {
  return vertexCommon(v);
}

@vertex
fn vsFoliage(v: VSIn) -> VSOutFoliage {
  let b = vertexCommon(v);
  var o: VSOutFoliage;
  o.pos = b.pos; o.worldPos = b.worldPos; o.normal = b.normal; o.tangent = b.tangent;
  o.uv0 = b.uv0; o.lmUv = b.lmUv; o.viewDepth = b.viewDepth; o.slot = b.slot;
  o.color = b.color; o.lodFade = b.lodFade;
  o.fog = vec4f(0.0, 0.0, 0.0, 1.0);
  if (USE_FOG) {
    let cam = frame.cameraPos.xyz;
    let toP = b.worldPos - cam;
    let d = max(length(toP), 1e-4);
    let f = computeFog(cam, toP / d, d, false);
    o.fog = vec4f(f.inscatter, f.transmittance);
  }
  o.ambFront = vec3f(0.0);
  o.ambBack = vec3f(0.0);
  if (hasFlag(F_SKY_AMBIENT)) {
    o.ambFront = vertexAmbient(b.worldPos, b.normal);
    o.ambBack = vertexAmbient(b.worldPos, -b.normal);
  }
  return o;
}

fn vertexCommon(v: VSIn) -> VSOut {
  // Visible-list entry: slot (24 bits) | fade (6 bits) | mode (2 bits: 1 out, 2 in).
  let e = visibleList[v.instance];
  let slot = e & 0xFFFFFFu;
  let inst = instances[slot];
  let wp = inst.model * vec4f(v.position, 1.0);
  var o: VSOut;
  o.pos = clipPosition(inst, wp);
  o.worldPos = wp.xyz;
  o.normal = normalize(normalMatrix(inst.model) * v.normal.xyz);
  // Not normalised here: a zero tangent must stay zero (the fragment stage orthonormalises with a fallback).
  o.tangent = vec4f((inst.model * vec4f(v.tangent.xyz, 0.0)).xyz, select(-1.0, 1.0, v.tangent.w >= 0.0));
  o.uv0 = v.uv0;
  o.lmUv = v.uv1 * inst.lmST.xy + inst.lmST.zw;
  o.viewDepth = -(frame.view * wp).z;
  o.slot = slot;
  o.color = v.color;
  let mode = e >> 30u;
  let q = f32((e >> 24u) & 63u) / 63.0;
  o.lodFade = select(select(0.0, -q, mode == 1u), q, mode == 2u);
  return o;
}

// ------------------------------------------------------------------ ground clutter
struct ClutterInst {
  posYaw: vec4f,   // xyz ground position, w yaw (rad)
  scale: vec4f,    // x uniform scale, yz the ground's lightmap UV (atlas), w lightmap page + 1 (0 = none)
};
struct ClutterParams {
  slot: u32,       // instance slot with neutral per-object data (no lightmap, no decals)
  pageSlot0: u32,  // first of one slot per lightmap page (lightmap layer set, no decals)
  fadeStart: f32,
  maxDist: f32,
};
@group(2) @binding(0) var<storage, read> clutterInst: array<ClutterInst>;
@group(2) @binding(1) var<uniform> clutterParams: ClutterParams;

/** Detail-prop vertex stage: compact per-instance transform, dithered fade with distance. */
@vertex
fn vsClutter(v: VSIn) -> VSOut {
  let ci = clutterInst[v.instance];
  let c = cos(ci.posYaw.w);
  let sn = sin(ci.posYaw.w);
  var k = ci.scale.x;
  let page = u32(ci.scale.w + 0.5);
  var slot = clutterParams.slot;
  // Lit like the ground it grows from: sample the ground's lightmap at the root.
  var expo = 1.0;
  if (page > 0u) {
    slot = clutterParams.pageSlot0 + page - 1u;
    let layer = i32(instances[slot].info.x) - 1;
    expo = saturate(textureSampleLevel(lightmaps, sampClamp, ci.scale.yz, layer, 0.0).g * 1.4);
  }
  // Same snow-cover estimate as the ground: tufts sink under thick snow.
  if (frame.season.x > 0.0) {
    let patchy = saturate((textureSampleLevel(cloudNoise, sampAniso, ci.posYaw.xz * (1.0 / 29.0), 0.0).r - 0.5) * 2.6 + 0.5);
    let cov = saturate((patchy - (1.0 - frame.season.x * expo)) * 7.0 + 0.5);
    k *= 1.0 - smoothstep(0.3, 0.85, cov);
  }
  let lp = v.position * k;
  let wp = ci.posYaw.xyz + vec3f(c * lp.x + sn * lp.z, lp.y, -sn * lp.x + c * lp.z);
  let rot = mat3x3f(vec3f(c, 0.0, -sn), vec3f(0.0, 1.0, 0.0), vec3f(sn, 0.0, c));
  var o: VSOut;
  o.pos = frame.viewProj * vec4f(wp, 1.0);
  let d = distance(frame.cameraPos.xyz, ci.posYaw.xyz);
  let t = saturate((d - clutterParams.fadeStart) / max(clutterParams.maxDist - clutterParams.fadeStart, 0.01));
  if (t >= 1.0) { o.pos = vec4f(0.0, 0.0, -1.0, 1.0); } // beyond range: outside the clip volume
  o.worldPos = wp;
  o.normal = rot * v.normal.xyz;
  o.tangent = vec4f(rot * v.tangent.xyz, select(-1.0, 1.0, v.tangent.w >= 0.0));
  o.uv0 = v.uv0;
  o.lmUv = ci.scale.yz;
  o.viewDepth = -(frame.view * vec4f(wp, 1.0)).z;
  o.slot = slot;
  o.color = v.color;
  o.lodFade = select(0.0, -t, t > 0.0);
  return o;
}

/**
 * Alpha-mask coverage. Near/magnified: a sharp alpha test with a ~1 px antialiased
 * edge (plus a little coverage-preserving boost over the first mips). Once the
 * texture's features are sub-pixel, the mip's averaged alpha *is* the coverage, so
 * sparse twigs fade to a see-through haze instead of thickening into a solid crown.
 */
fn maskCoverage(alphaRaw: f32, mip: f32, cutoff: f32) -> f32 {
  // Dense sprays (needles, leaves) overlap into solid crowns: keep the Golus-style
  // coverage boost. Sparse twig cards (misc.x) switch to averaged coverage instead.
  let avg = material.misc.x;
  let a = alphaRaw * (1.0 + mip * 0.25 * (1.0 - avg) + min(mip, 1.5) * 0.25 * avg);
  let sharp = saturate((a - cutoff) / max(fwidth(a), 1e-4) + 0.5);
  let far = saturate((mip - 1.5) * 0.5) * avg;
  return mix(sharp, saturate(alphaRaw * 1.15), far);
}

/** Complementary screen-space dither for LOD crossfades: each pixel shows exactly one LOD. */
fn lodFadeKill(pos: vec2f, f: f32) -> bool {
  if (f == 0.0) { return false; }
  let d = ign(pos + vec2f(37.0, 17.0));
  return select((d < -f), (d >= f), f > 0.0);
}

// ------------------------------------------------------------------ helpers

fn decodeNormal(t: vec4f) -> vec4f {
  // xy from the texture, z rebuilt: BC5 normal maps store only xy (their variance is
  // folded into the ORM roughness offline); uncompressed maps are unit vectors with
  // a: 1 - 2 * (normal variance -> added GGX alpha^2).
  let xy = t.xy * 2.0 - 1.0;
  return vec4f(xy, sqrt(saturate(1.0 - dot(xy, xy))), (1.0 - t.a) * 0.5);
}

fn blendRNM(n1: vec3f, n2: vec3f) -> vec3f {
  let t = n1 + vec3f(0.0, 0.0, 1.0);
  let u = n2 * vec3f(-1.0, -1.0, 1.0);
  return normalize(t * dot(t, u) / t.z - u);
}

fn scaleNormal(n: vec3f, s: f32) -> vec3f {
  return normalize(vec3f(n.xy * s, max(n.z, 1e-3)));
}

fn cubicBSplineWeights(f: vec2f) -> array<vec4f, 2> {
  let f2 = f * f; let f3 = f2 * f;
  let w0 = (1.0 - f) * (1.0 - f) * (1.0 - f) / 6.0;
  let w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  let w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  let w3 = f3 / 6.0;
  return array<vec4f, 2>(vec4f(w0.x, w1.x, w2.x, w3.x), vec4f(w0.y, w1.y, w2.y, w3.y));
}

// Lightmap filtering. Bicubic B-spline (4 bilinear taps, Sigg & Hadwiger) only
// where a texel spans more than ~2 pixels; minified lightmaps look identical with
// one bilinear tap, which matters because every tap is ~4x dearer under MSAA.
// Tap positions/weights are shared by all layers of a page.
struct LmTaps {
  uv: vec2f,
  h0: vec2f,
  h1: vec2f,
  g0: vec2f,
  g1: vec2f,
  cubic: f32,  // 0 = bilinear, 1 = bicubic, between = blend band
};

fn lightmapTaps(uv: vec2f, footprint: f32) -> LmTaps {
  var t: LmTaps;
  t.uv = uv;
  // footprint 0 = constant lightmap UV over the primitive (clutter): one tap is exact.
  t.cubic = select(0.0, smoothstep(0.6, 0.35, footprint), frame.lmParams.y > 0.5 && footprint > 0.0);
  if (t.cubic > 0.0) {
    let size = vec2f(textureDimensions(lightmaps).xy);
    let p = uv * size - 0.5;
    let i = floor(p);
    let w = cubicBSplineWeights(p - i);
    t.g0 = vec2f(w[0].x + w[0].y, w[1].x + w[1].y);
    t.g1 = vec2f(w[0].z + w[0].w, w[1].z + w[1].w);
    t.h0 = (vec2f(w[0].y, w[1].y) / t.g0 - 1.0 + i + 0.5) / size;
    t.h1 = (vec2f(w[0].w, w[1].w) / t.g1 + 1.0 + i + 0.5) / size;
  }
  return t;
}

fn sampleLightmap(t: LmTaps, layer: i32) -> vec3f {
  var lin = vec3f(0.0);
  if (t.cubic < 1.0) { lin = textureSampleLevel(lightmaps, sampClamp, t.uv, layer, 0.0).rgb; }
  if (t.cubic <= 0.0) { return lin; }
  let a = textureSampleLevel(lightmaps, sampClamp, vec2f(t.h0.x, t.h0.y), layer, 0.0).rgb;
  let b = textureSampleLevel(lightmaps, sampClamp, vec2f(t.h1.x, t.h0.y), layer, 0.0).rgb;
  let c = textureSampleLevel(lightmaps, sampClamp, vec2f(t.h0.x, t.h1.y), layer, 0.0).rgb;
  let d = textureSampleLevel(lightmaps, sampClamp, vec2f(t.h1.x, t.h1.y), layer, 0.0).rgb;
  let cub = t.g0.y * (t.g0.x * a + t.g1.x * b) + t.g1.y * (t.g0.x * c + t.g1.x * d);
  return mix(lin, cub, t.cubic);
}

struct Surface {
  albedo: vec3f,
  alpha: f32,
  N: vec3f,          // shading normal (world)
  Ng: vec3f,         // geometric normal (world)
  roughness: f32,    // perceptual
  metallic: f32,
  ao: f32,
  normalVariance: f32,
  emissive: vec3f,
};

// Texture fetch with material mip bias; derivatives are passed explicitly so the
// same code works inside non-uniform control flow (decals, triplanar).
fn texGrad(t: texture_2d<f32>, uv: vec2f, dx: vec2f, dy: vec2f) -> vec4f {
  let b = exp2(frame.mat0.z);
  return textureSampleGrad(t, sampAniso, uv, dx * b, dy * b);
}

fn applyDecals(wp: vec3f, dpx: vec3f, dpy: vec3f, s: ptr<function, Surface>) {
  if (!hasFlag(F_DECALS) || frame.debug.w == 0u) { return; }
  let g = frame.decalGrid;
  let cell = vec2i(floor((wp.xz - g.xy) * g.w));
  let cells = vec2i(frame.decalGrid2.xy);
  if (any(cell < vec2i(0)) || any(cell >= cells)) { return; }
  let maxPer = frame.decalGrid2.z;
  let base = u32(cell.y * cells.x + cell.x) * (maxPer + 1u);
  let count = min(decalCells[base], maxPer);
  for (var k = 0u; k < count; k++) {
    let d = decals[decalCells[base + 1u + k]];
    let lp = vec3f(dot(d.row0, vec4f(wp, 1.0)), dot(d.row1, vec4f(wp, 1.0)), dot(d.row2, vec4f(wp, 1.0)));
    if (any(abs(lp) > vec3f(0.5))) { continue; }
    let facing = dot((*s).Ng, d.axis.xyz);
    if (facing < 0.05) { continue; }
    let angleFade = saturate((facing - 0.05) / max(d.axis.w, 0.01));
    let edgeFade = saturate((0.5 - abs(lp.z)) * 8.0);
    let uv = vec2f(lp.x * d.tint.w + 0.5, 0.5 - lp.y);
    let ddx = vec2f(dot(d.row0.xyz, dpx) * d.tint.w, -dot(d.row1.xyz, dpx));
    let ddy = vec2f(dot(d.row0.xyz, dpy) * d.tint.w, -dot(d.row1.xyz, dpy));
    let c = textureSampleGrad(decalAtlas, sampAniso, uv, i32(d.params.x), ddx, ddy);
    let a = c.a * d.params.y * angleFade * edgeFade;
    (*s).albedo = mix((*s).albedo, c.rgb * d.tint.rgb, a);
    if (d.params.w >= 0.0) { (*s).roughness = mix((*s).roughness, d.params.w, a); }
    (*s).ao = mix((*s).ao, 1.0, a * 0.5);
    if (d.params.z > 0.0) {
      // Bullet-hole relief from an analytic height profile: pit + raised lip.
      let r = length(lp.xy) * 2.0;
      let pit = exp(-r * r * 16.0);
      let lip = exp(-(r - 0.42) * (r - 0.42) * 120.0);
      let dhdr = 32.0 * r * pit - 0.15 * 240.0 * (r - 0.42) * lip;
      let radial = normalize(d.row0.xyz) * lp.x + normalize(d.row1.xyz) * lp.y;
      let rl = length(radial);
      if (rl > 1e-5) {
        let k = d.params.z * d.params.y * angleFade * edgeFade;
        (*s).N = normalize((*s).N - radial / rl * dhdr * k);
      }
    }
  }
}

// ------------------------------------------------------------------ shading

struct ShadeOut {
  color: vec4f,      // pre-exposed HDR colour (a = coverage for masked)
  raw: bool,
};


fn shade(in: VSOut, front: bool, vl: VertexLight) -> ShadeOut {
  let inst = instances[in.slot];
  let camPos = frame.cameraPos.xyz;
  let wp = in.worldPos;
  let toCam = camPos - wp;
  let dist = length(toCam);
  let V = toCam / dist;
  let dpx = dpdx(wp);
  let dpy = dpdy(wp);

  // --- base layer UVs (world metres -> material physical size)
  let uv = in.uv0 * material.uvTransform.xy + material.uvTransform.zw;
  let uvDx = dpdx(uv);
  let uvDy = dpdy(uv);
  // All derivatives up front: later branches are not in uniform control flow.
  let uv0Dx = dpdx(in.uv0);
  let uv0Dy = dpdy(in.uv0);
  let lmSize = f32(textureDimensions(lightmaps).x);
  let lmFootprint = max(length(dpdx(in.lmUv)), length(dpdy(in.lmUv))) * lmSize;

  var Ng = normalize(in.normal);
  var T = in.tangent.xyz;
  if (!front) { Ng = -Ng; }
  // Gram-Schmidt; when the tangent is (near) parallel to the normal or missing
  // (bent foliage normals at impostor/card edges), fall back to any perpendicular
  // instead of normalising a zero vector into NaN.
  T = T - Ng * dot(Ng, T);
  if (!(dot(T, T) > 1e-8)) {
    T = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(Ng.x) < 0.9);
    T = T - Ng * dot(Ng, T);
  }
  T = normalize(T);
  let B = cross(Ng, T) * in.tangent.w * select(-1.0, 1.0, front);

  var s: Surface;
  var bc: vec4f;
  var nt: vec4f;
  var orm: vec4f;
  if (USE_TRIPLANAR && matFlag(M_TRIPLANAR)) {
    // World-space triplanar projection for organic surfaces (rock, soil).
    let sharp = material.extra.z;
    var w = pow(abs(Ng), vec3f(sharp));
    w = w / (w.x + w.y + w.z);
    let sc = material.uvTransform.xy;
    let uvX = wp.zy * sc; let uvY = wp.xz * sc; let uvZ = wp.xy * sc;
    let dX = vec4f(dpx.zy * sc, dpy.zy * sc);
    let dY = vec4f(dpx.xz * sc, dpy.xz * sc);
    let dZ = vec4f(dpx.xy * sc, dpy.xy * sc);
    bc = texGrad(baseColorTex, uvX, dX.xy, dX.zw) * w.x + texGrad(baseColorTex, uvY, dY.xy, dY.zw) * w.y + texGrad(baseColorTex, uvZ, dZ.xy, dZ.zw) * w.z;
    orm = texGrad(ormTex, uvX, dX.xy, dX.zw) * w.x + texGrad(ormTex, uvY, dY.xy, dY.zw) * w.y + texGrad(ormTex, uvZ, dZ.xy, dZ.zw) * w.z;
    // Whiteout-style triplanar normal blend in world space.
    let tnX = decodeNormal(texGrad(normalTex, uvX, dX.xy, dX.zw));
    let tnY = decodeNormal(texGrad(normalTex, uvY, dY.xy, dY.zw));
    let tnZ = decodeNormal(texGrad(normalTex, uvZ, dZ.xy, dZ.zw));
    let ns = material.pbr.z * frame.mat0.w;
    let nX = vec3f(0.0, tnX.y * ns, tnX.x * ns) * sign(Ng.x);
    let nY = vec3f(tnY.x * ns, 0.0, tnY.y * ns) * sign(Ng.y);
    let nZ = vec3f(tnZ.x * ns, tnZ.y * ns, 0.0) * sign(Ng.z);
    s.N = normalize(Ng + nX * w.x + nY * w.y + nZ * w.z);
    s.normalVariance = tnX.w * w.x + tnY.w * w.y + tnZ.w * w.z;
    nt = vec4f(0.0, 0.0, 1.0, 0.0);
  } else {
    bc = texGrad(baseColorTex, uv, uvDx, uvDy);
    nt = decodeNormal(texGrad(normalTex, uv, uvDx, uvDy));
    orm = texGrad(ormTex, uv, uvDx, uvDy);
    s.normalVariance = nt.w;
  }
  bc *= material.baseColor;
  s.albedo = bc.rgb;
  s.alpha = bc.a;
  s.roughness = mix(material.extra.x, material.extra.y, orm.g) * material.pbr.x;
  s.metallic = orm.b * material.pbr.y;
  // Texture AO x baked vertex AO (vertex colour G; 1 for meshes without colours).
  s.ao = mix(1.0, orm.r, material.pbr.w) * in.color.g;
  // Emission (lamp lenses) follows the environment's local-light switch.
  s.emissive = material.emissive.rgb * frame.ground.w;
  s.Ng = Ng;

  // --- tangent-space normal with detail layer
  var tn = scaleNormal(nt.xyz, material.pbr.z * frame.mat0.w);

  // --- second material layer, height-blended by vertex colour R
  if (USE_BLEND && matFlag(M_BLEND)) {
    let bs = material.bUvTransform.xy;
    let buv = in.uv0 * bs;
    let bb = texGrad(bBaseColorTex, buv, uv0Dx * bs, uv0Dy * bs) * material.bBaseColor;
    let bn = decodeNormal(texGrad(bNormalTex, buv, uv0Dx * bs, uv0Dy * bs));
    let bo = texGrad(bOrmTex, buv, uv0Dx * bs, uv0Dy * bs);
    var noise = 0.0;
    if (USE_MACRO) {
      let ms = material.macroTransform.xy * 3.0 + vec2f(0.013);
      noise = texGrad(macroTex, in.uv0 * ms + vec2f(0.37, 0.11), uv0Dx * ms, uv0Dy * ms).r - 0.5;
    }
    let x = (in.color.r - 0.5) * 2.0 + (bo.a - orm.a) * material.blendParams.y + noise * material.blendParams.z;
    let t = saturate(x * material.blendParams.x * 0.5 + 0.5);
    s.albedo = mix(s.albedo, bb.rgb, t);
    s.roughness = mix(s.roughness, bo.g * material.bPbr.x, t);
    s.metallic = mix(s.metallic, bo.b * material.bPbr.y, t);
    s.ao = mix(s.ao, mix(1.0, bo.r, material.bPbr.w), t);
    tn = normalize(mix(tn, scaleNormal(bn.xyz, material.bPbr.z * frame.mat0.w), t));
    s.normalVariance = mix(s.normalVariance, bn.w, t);
  }
  let detailFade = saturate(1.0 - dist / max(material.emissive.w, 0.01));
  if (USE_DETAIL && hasFlag(F_DETAIL) && detailFade > 0.0) {
    let duv = in.uv0 * material.detailTransform.xy;
    let dDx = uv0Dx * material.detailTransform.xy;
    let dDy = uv0Dy * material.detailTransform.xy;
    let strength = frame.mat0.x * detailFade;
    if (matFlag(M_DETAIL_ALBEDO)) {
      let da = texGrad(detailAlbedoTex, duv, dDx, dDy).r;
      // Detail albedo is an overlay around 0.5 grey (x2 multiply).
      s.albedo *= mix(1.0, da * 2.0, material.detailTransform.z * strength);
    }
    if (matFlag(M_DETAIL_NORMAL) && !(USE_TRIPLANAR && matFlag(M_TRIPLANAR))) {
      let dn = decodeNormal(texGrad(detailNormalTex, duv, dDx, dDy));
      tn = blendRNM(tn, scaleNormal(dn.xyz, material.detailTransform.w * strength));
      s.normalVariance += dn.w * material.detailTransform.w * strength;
    }
  }
  // --- macro variation (large-scale, breaks tiling on big surfaces)
  if (USE_MACRO && matFlag(M_MACRO) && frame.mat0.y > 0.0) {
    let muv = in.uv0 * material.macroTransform.xy;
    let mdx = uv0Dx * material.macroTransform.xy;
    let mdy = uv0Dy * material.macroTransform.xy;
    let m = texGrad(macroTex, muv, mdx, mdy);
    let m2 = texGrad(macroTex, muv * 4.3 + vec2f(0.31, 0.77), mdx * 4.3, mdy * 4.3);
    let k = frame.mat0.y;
    s.albedo *= 1.0 + (m.r - 0.5) * 2.0 * material.macroTransform.z * k;
    s.albedo *= 1.0 - m2.g * material.extra.w * k;
    s.roughness = saturate(s.roughness + (m.b - 0.5) * material.macroTransform.w * k);
  }
  if (!(USE_TRIPLANAR && matFlag(M_TRIPLANAR))) {
    s.N = normalize(T * tn.x + B * tn.y + Ng * tn.z);
  }

  // --- season: dormant tint, snow cover, melt water
  // Kept deliberately small: shader size costs more than texture fetches under MSAA here.
  var meltWet = 0.0;
  if (USE_SNOW) {
    s.albedo *= mix(vec3f(1.0), material.dryTint.rgb, saturate(frame.season.z * material.misc.z));
    if (frame.season.x > 0.0 && material.misc.y > 0.0) {
      // Sky exposure: baked sky visibility on lightmapped surfaces (1 = open sky),
      // vertex AO elsewhere (crown AO on trees, 1 on props).
      var expo = in.color.g;
      let lmIdx = i32(inst.info.x) - 1;
      if (USE_LIGHTMAP && lmIdx >= 0 && hasFlag(F_LIGHTMAPS)) {
        expo = saturate(textureSampleLevel(lightmaps, sampClamp, in.lmUv, lmIdx, 0.0).g * 1.4);
      }
      // Faces up (bent crown normals for foliage).
      let slope = select(smoothstep(0.45, 0.85, s.N.y) * smoothstep(0.2, 0.5, Ng.y), smoothstep(0.3, 0.8, s.N.y) * mix(1.0, orm.r, 0.7), matFlag(M_FOLIAGE));
      // Thaw patches: world noise remapped towards uniform so the amount ~ covered
      // fraction; hollows (low ORM height) keep snow longest.
      let patchy = saturate((textureSampleLevel(cloudNoise, sampAniso, wp.xz * (1.0 / 29.0), 0.0).r - 0.5) * 2.6 + 0.5);
      var x = patchy + (0.5 - orm.a) * 0.25 - (1.0 - frame.season.x * material.misc.y * expo * slope);
      if (x > -0.25) {
        let sc = frame.season.w;
        let sa = texGrad(snowAlbedoTex, wp.xz * sc, dpx.xz * sc, dpy.xz * sc); // a = snow relief
        x += (sa.a - 0.5) * 0.3;
        let cov = saturate(x * 7.0 + 0.5);
        s.albedo = mix(s.albedo, sa.rgb, cov);
        s.roughness = mix(s.roughness, 0.55, cov);
        s.metallic *= 1.0 - cov;
        s.N = normalize(mix(s.N, Ng, cov * 0.8));
        meltWet = frame.season.y * smoothstep(-0.25, 0.0, x) * (1.0 - cov);
      } else {
        meltWet = 0.0;
      }
    }
  }

  // --- global wetness: porous darkening + smoother, flatter surfaces
  let wet = max(frame.mat1.y, meltWet) * material.pbr2.z * saturate(Ng.y * 0.8 + 0.4);
  if (USE_WETNESS && wet > 0.0) {
    s.albedo *= mix(1.0, 0.5, wet);
    s.roughness = mix(s.roughness, 0.12, wet * 0.8);
    s.N = normalize(mix(s.N, Ng, wet * 0.5));
    // Puddles in flat areas, masked by the macro texture.
    if (frame.mat1.z > 0.0 && Ng.y > 0.97) {
      let pm = texGrad(macroTex, wp.xz * 0.045, dpx.xz * 0.045, dpy.xz * 0.045).g;
      let puddle = smoothstep(1.0 - frame.mat1.z, 1.0 - frame.mat1.z + 0.08, pm) * wet;
      s.roughness = mix(s.roughness, 0.03, puddle);
      s.N = normalize(mix(s.N, Ng, puddle));
      s.albedo *= mix(1.0, 0.85, puddle);
    }
  }

  if (USE_DECALS && (inst.info.y & I_NO_DECALS) == 0u) { applyDecals(wp, dpx, dpy, &s); }

  // ---------------------------------------------------------------- debug (raw)
  let mode = select(0u, frame.debug.x, DEBUG_VIEWS);
  var out: ShadeOut;
  out.raw = false;
  out.color = vec4f(0.0, 0.0, 0.0, s.alpha);
  if (DEBUG_VIEWS) {
  if (mode == 1u) { out.raw = true; out.color = vec4f(s.albedo, s.alpha); return out; }
  if (mode == 2u) { out.raw = true; out.color = vec4f(s.N * 0.5 + 0.5, s.alpha); return out; }
  if (mode == 3u) { out.raw = true; out.color = vec4f(Ng * 0.5 + 0.5, s.alpha); return out; }
  if (mode == 4u) {
    let f = fract(in.uv0);
    let line = select(0.0, 1.0, any(fract(in.uv0 * 10.0) < vec2f(0.04)));
    out.raw = true; out.color = vec4f(mix(vec3f(f, 0.0), vec3f(1.0), line * 0.5), s.alpha); return out;
  }
  if (mode == 5u) { out.raw = true; out.color = vec4f(fract(in.lmUv), 0.0, s.alpha); return out; }
  if (mode == 7u) {
    let size = vec2f(textureDimensions(lightmaps).xy);
    let t = floor(in.lmUv * size);
    let chk = (i32(t.x) + i32(t.y)) & 1;
    let lmd = select(vec3f(0.9, 0.3, 0.3), vec3f(0.3, 0.3, 0.9), chk == 0);
    out.raw = true;
    out.color = vec4f(select(vec3f(0.5), lmd, inst.info.x > 0u), s.alpha);
    return out;
  }
  if (mode == 8u) { out.raw = true; out.color = vec4f(vec3f(s.roughness), s.alpha); return out; }
  if (mode == 9u) { out.raw = true; out.color = vec4f(vec3f(s.metallic), s.alpha); return out; }
  if (mode == 10u) { out.raw = true; out.color = vec4f(vec3f(s.ao), s.alpha); return out; }
  if (mode == 16u || mode == 22u) {
    let size = vec2f(textureDimensions(baseColorTex));
    let dx = uvDx * size; let dy = uvDy * size;
    let lx = length(dx); let ly = length(dy);
    let maxL = max(lx, ly); let minL = max(min(lx, ly), 1e-6);
    let lodAniso = log2(max(minL, maxL / 16.0));
    out.raw = true;
    if (mode == 16u) {
      let cols = array<vec3f, 8>(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 0.5, 1.0), vec3f(0.0, 1.0, 1.0), vec3f(0.0, 1.0, 0.0), vec3f(1.0, 1.0, 0.0), vec3f(1.0, 0.5, 0.0), vec3f(1.0, 0.0, 0.0), vec3f(1.0, 0.0, 1.0));
      let l = clamp(lodAniso, 0.0, 7.0);
      let i0 = u32(floor(l));
      let c = mix(cols[i0], cols[min(i0 + 1u, 7u)], fract(l));
      out.color = vec4f(c * (0.4 + 0.6 * luminance(s.albedo) / max(luminance(material.baseColor.rgb), 0.05)), s.alpha);
    } else {
      // texels per pixel (texture-space density): green = 1:1, red = magnified, blue = minified
      let tpp = maxL;
      let c = select(vec3f(0.0, 0.3, 1.0) * saturate(log2(tpp) / 4.0) + vec3f(0.0, 0.7, 0.0) * (1.0 - saturate(log2(tpp) / 4.0)),
                     vec3f(1.0, 0.0, 0.0) * saturate(-log2(tpp) / 3.0) + vec3f(0.0, 0.7, 0.0) * (1.0 - saturate(-log2(tpp) / 3.0)), tpp < 1.0);
      out.color = vec4f(c, s.alpha);
    }
    return out;
  }
  if (mode == 17u) {
    // World-scale debug grid (4 m tile) replacing the albedo; lit normally.
    let guv = in.uv0 * 0.25;
    s.albedo = texGrad(debugGridTex, guv, uv0Dx * 0.25, uv0Dy * 0.25).rgb;
    s.roughness = 0.7; s.metallic = 0.0; s.N = Ng; s.ao = 1.0;
  }
  if (mode == 12u || mode == 6u || mode == 13u || mode == 14u) { s.albedo = vec3f(0.5); s.metallic = 0.0; }
  }

  // ---------------------------------------------------------------- lighting
  let N = s.N;
  let NoV = max(dot(N, V), 1e-4);
  let diffuseColor = s.albedo * (1.0 - s.metallic);
  let spec = material.pbr2.x;
  let f0 = mix(vec3f(0.16 * spec * spec), s.albedo, s.metallic);
  var a = max(s.roughness * s.roughness, 0.002);
  // Normal-map variance (Toksvig/vMF, stored per mip) + geometric specular AA.
  a = sqrt(a * a + s.normalVariance);
  if (USE_SPEC_AA && hasFlag(F_SPEC_AA)) { a = specularAA(N, a, frame.mat1.x); }
  let foliage = USE_FOLIAGE && matFlag(M_FOLIAGE);

  // Sun
  var direct = vec3f(0.0);
  var shadowTerm = 1.0;
  var cascade = -1.0;
  if (hasFlag(F_SUN)) {
    let L = frame.sunDir.xyz;
    let NoLg = dot(Ng, L);
    // Faces turned away from the sun get no direct light (geoMask), so skip the
    // shadow lookups there; foliage keeps them for its transmission term.
    if (USE_SHADOWS && (foliage || NoLg > -0.04)) {
      let sh = sunShadow(wp, Ng, NoLg, in.viewDepth);
      shadowTerm = sh.x;
      cascade = sh.y;
    }
    let NoL = saturate(dot(N, L));
    // Terminator softening: normal maps must not light faces turned away from the sun.
    let geoMask = saturate(NoLg * 6.0 + 0.2);
    if (NoL > 0.0) {
      let H = normalize(V + L);
      let NoH = saturate(dot(N, H));
      let VoH = saturate(dot(V, H));
      let Fs = F_Schlick(f0, VoH);
      let specBrdf = D_GGX(NoH, a) * V_SmithGGX(NoV, NoL, a) * Fs;
      direct = (diffuseColor * INV_PI * (1.0 - Fs) + specBrdf) * NoL * geoMask;
    }
    if (foliage) {
      // Thin-leaf transmission: light through the card from behind.
      let back = saturate(dot(-N, L)) * 0.6 + 0.4 * saturate(dot(-V, L));
      direct += diffuseColor * material.pbr2.w * back * INV_PI;
      // Inner-crown occlusion finer than the shadow map resolves (baked vertex AO).
      direct *= mix(0.3, 1.0, in.color.g);
    }
    direct *= frame.sunColor.rgb * shadowTerm;
  }

  // Indirect diffuse: lightmap (static) or sky SH (dynamic / non-lightmapped).
  var irr = vec3f(0.0);         // radiance of a white Lambertian (irradiance / PI)
  let shN = shEval(N);
  let lmLayer = i32(inst.info.x) - 1;
  let useLm = USE_LIGHTMAP && lmLayer >= 0 && hasFlag(F_LIGHTMAPS);
  if (useLm) {
    var ratio = vec3f(1.0);
    if (hasFlag(F_SH_RATIO)) {
      // Normal-map detail for non-directional terms using the live sky's
      // directional distribution.
      ratio = clamp(shN / max(shEval(Ng), vec3f(1e-4)), vec3f(0.4), vec3f(1.8));
    }
    // All layers store irradiance/PI (Cycles "light" pass): sky per unit sky
    // radiance, sun bounce per unit sun illuminance (calibrated, see docs).
    if (USE_DIR_LIGHTMAP && hasFlag(F_DIR_LIGHTMAP)) {
      // Directional lightmap: flat sky bake for the absolute level, the three
      // radiosity-normal-mapping basis bakes as a direction ratio (Valve's
      // squared, normalised weights). Exact for unperturbed normals.
      var n = tn;
      if (USE_TRIPLANAR && matFlag(M_TRIPLANAR)) { n = vec3f(0.0, 0.0, 1.0); }
      var w = saturate(vec3f(dot(n, RNM0), dot(n, RNM1), dot(n, RNM2)));
      w = w * w;
      w = w / max(w.x + w.y + w.z, 1e-4);
      let taps = lightmapTaps(in.lmUv, lmFootprint);
      let flat = sampleLightmap(taps, lmLayer);
      // Basis layers are low frequency: plain bilinear is enough.
      let l0 = textureSampleLevel(lightmaps, sampClamp, in.lmUv, lmLayer + 1, 0.0).rgb;
      let l1 = textureSampleLevel(lightmaps, sampClamp, in.lmUv, lmLayer + 2, 0.0).rgb;
      let l2 = textureSampleLevel(lightmaps, sampClamp, in.lmUv, lmLayer + 3, 0.0).rgb;
      let mean = (l0 + l1 + l2) * (1.0 / 3.0);
      let dirRatio = clamp((l0 * w.x + l1 * w.y + l2 * w.z) / max(mean, vec3f(1e-4)), vec3f(0.0), vec3f(3.0));
      let lmSky = flat * dirRatio * frame.lmParams.z;
      let lmSun = sampleLightmap(taps, lmLayer + 4) * frame.lmParams.w;
      irr = lmSky * skyUpRadiance() + lmSun * frame.sunColor.rgb * ratio;
    } else {
      let taps = lightmapTaps(in.lmUv, lmFootprint);
      let lmSky = sampleLightmap(taps, lmLayer) * frame.lmParams.z;
      let lmSun = sampleLightmap(taps, lmLayer + 1) * frame.lmParams.w;
      irr = (lmSky * skyUpRadiance() + lmSun * frame.sunColor.rgb) * ratio;
    }
  } else if (USE_VERTEX_LIGHT) {
    irr = select(vl.ambBack, vl.ambFront, front);
  } else if (hasFlag(F_SKY_AMBIENT)) {
    irr = shN;
    if (USE_PROBE_VOLUME && hasFlag(F_PROBE_VOLUME)) {
      // Baked ambient cubes: occlusion and bounce for dynamic / instanced objects.
      let pv = probeVolumeIrradiance(wp, N, skyUpRadiance());
      irr = mix(irr, pv.rgb, pv.a);
    }
  }
  irr *= frame.exposure.w;
  let Fenv = f0 + (max(vec3f(1.0 - s.roughness), f0) - f0) * pow(1.0 - NoV, 5.0);
  var indirectDiffuse = diffuseColor * irr * s.ao * (1.0 - Fenv * 0.5);
  if (foliage) { indirectDiffuse += diffuseColor * irr * s.ao * material.pbr2.w * 0.35; }

  // Indirect specular: prefiltered environment probe with split-sum BRDF.
  var indirectSpec = vec3f(0.0);
  if (USE_ENV_SPEC && hasFlag(F_ENV_SPEC)) {
    let R = reflect(-V, N);
    let rough = sqrt(a);
    let lod = rough * (frame.sky.z - 1.0);
    var env = vec3f(0.0);
    var probeIrr = vec3f(0.0);
    var wLeft = 1.0;
    if (USE_REFL_PROBES && hasFlag(F_REFL_PROBES)) {
      // Two most relevant box-projected probes (priority first, then weight) among
      // the up to three chosen per object on the CPU (instance flag bits 8..31);
      // the global sky probe fills whatever weight remains.
      var b0 = -1; var b1 = -1;
      var s0 = 0.0; var s1 = 0.0;
      for (var k = 0u; k < 3u; k++) {
        let id = (inst.info.y >> (8u + 8u * k)) & 0xFFu;
        if (id == 0u) { break; }
        let i = id - 1u;
        let w = reflProbeWeight(i, wp);
        if (w <= 0.0) { continue; }
        let score = w + reflProbes[i].bmax.w * 2.0;
        if (score > s0) { b1 = b0; s1 = s0; b0 = i32(i); s0 = score; }
        else if (score > s1) { b1 = i32(i); s1 = score; }
      }
      if (b0 >= 0) {
        let i0 = u32(b0);
        let w0 = reflProbeWeight(i0, wp);
        env += textureSampleLevel(reflCubes, sampClamp, reflProbeDir(i0, wp, R), i32(reflProbes[i0].pos.w), lod).rgb * w0;
        probeIrr += shEvalProbe(i0, N) * w0;
        wLeft = 1.0 - w0;
        if (b1 >= 0 && wLeft > 0.0) {
          let i1 = u32(b1);
          let w1 = reflProbeWeight(i1, wp) * wLeft;
          env += textureSampleLevel(reflCubes, sampClamp, reflProbeDir(i1, wp, R), i32(reflProbes[i1].pos.w), lod).rgb * w1;
          probeIrr += shEvalProbe(i1, N) * w1;
          wLeft -= w1;
        }
      }
    }
    if (wLeft > 0.0) {
      env += textureSampleLevel(envSpecular, sampClamp, R, lod).rgb * wLeft;
      probeIrr += shN * wLeft;
    }
    let ab = textureSampleLevel(brdfLut, sampClamp, vec2f(NoV, rough), 0.0).rg;
    var so = 1.0;
    if (hasFlag(F_SPEC_OCCLUSION)) {
      if (useLm || (USE_PROBE_VOLUME && hasFlag(F_PROBE_VOLUME))) {
        // Reflection normalisation (Source 2 style): scale the probe by the ratio
        // of local (baked) irradiance to the irradiance the probe itself saw.
        so = saturate(luminance(irr) / max(luminance(probeIrr) * frame.exposure.w, 1e-4));
        so = so * so * (3.0 - 2.0 * so);
        so = min(so, specOcclusionFromAO(NoV, s.ao, a) * 1.5);
      } else {
        so = specOcclusionFromAO(NoV, s.ao, a);
      }
      // Horizon occlusion: reflections pointing below the geometric surface.
      let h = saturate(1.0 + 1.1 * dot(R, Ng));
      so *= h * h;
    }
    indirectSpec = env * (f0 * ab.x + ab.y) * so * frame.mat1.w;
  }

  // Local lights: only those whose range reaches this pixel's light-grid cell.
  var local = vec3f(0.0);
  if (USE_LOCAL_LIGHTS && hasFlag(F_LOCAL_LIGHTS)) {
    let lcBase = lightCellBase(wp);
    var lcCount = 0u;
    if (lcBase != 0xFFFFFFFFu) { lcCount = lightCells[lcBase]; }
    for (var k = 0u; k < lcCount; k++) {
      let l = lights[lightCells[lcBase + 1u + k]];
      let toL = l.posRange.xyz - wp;
      let d2 = dot(toL, toL);
      let r2 = l.posRange.w * l.posRange.w;
      if (d2 > r2) { continue; }
      let Ld = toL * inverseSqrt(d2);
      let win = saturate(1.0 - (d2 / r2) * (d2 / r2));
      var att = win * win / max(d2, l.params.z * l.params.z);
      if (l.params.y > 0.5) {
        att *= smoothstep(l.dirCone.w, l.params.x, dot(-Ld, l.dirCone.xyz));
      }
      let NoL = saturate(dot(N, Ld));
      if (att <= 0.0) { continue; }
      if (USE_SPOT_SHADOWS && l.params.w > 0.5) { att *= spotShadow(u32(l.params.w + 0.5) - 1u, wp, Ng, sqrt(d2)); }
      let H = normalize(V + Ld);
      let NoH = saturate(dot(N, H));
      let VoH = saturate(dot(V, H));
      let Fs = F_Schlick(f0, VoH);
      let sb = D_GGX(NoH, a) * V_SmithGGX(NoV, NoL, a) * Fs;
      var c = (diffuseColor * INV_PI * (1.0 - Fs) + sb) * NoL;
      if (foliage) { c += diffuseColor * material.pbr2.w * saturate(dot(-N, Ld)) * INV_PI; }
      local += c * l.color.rgb * att;
    }
  }

  var color = direct + indirectDiffuse + indirectSpec + local + s.emissive;
  if (matFlag(M_UNLIT)) { color = s.emissive + s.albedo * irr; }

  // ---------------------------------------------------------------- debug (lit)
  if (DEBUG_VIEWS) {
  if (mode == 11u) {
    let cc = array<vec3f, 5>(vec3f(1.0, 0.25, 0.25), vec3f(0.25, 1.0, 0.25), vec3f(0.3, 0.45, 1.0), vec3f(1.0, 1.0, 0.25), vec3f(0.6));
    let ci = u32(clamp(cascade, 0.0, 4.0));
    color = color * cc[ci];
  }
  if (mode == 6u || mode == 14u) { color = indirectDiffuse; }
  if (mode == 13u) { color = direct; }
  if (mode == 15u) { color = indirectSpec + direct * select(0.0, 1.0, s.metallic > 0.5); }
  if (mode == 18u) { out.raw = true; out.color = vec4f(vec3f(shadowTerm), s.alpha); return out; }
  }

  // ---------------------------------------------------------------- fog
  if (USE_VERTEX_LIGHT) {
    color = color * vl.fog.a + vl.fog.rgb;
    // Lamp glow stays per pixel: its cones and halos are sharper than card vertices.
    if (USE_FOG && USE_LOCAL_LIGHTS) { color += fogLightScatter(camPos, -V, dist); }
  } else if (USE_FOG) {
    let fog = computeFog(camPos, -V, dist, false);
    if (DEBUG_VIEWS && mode == 19u) { out.raw = true; out.color = vec4f(vec3f(fog.transmittance), s.alpha); return out; }
    color = color * fog.transmittance + fog.inscatter;
    if (USE_LOCAL_LIGHTS) { color += fogLightScatter(camPos, -V, dist); }
  }

  out.color = vec4f(color * frame.exposure.x, s.alpha);
  return out;
}

fn finalize(o: ShadeOut) -> vec4f {
  if (o.raw) {
    // Raw debug values bypass tonemapping: flagged by storing them in a range
    // the post pass recognises (negative weight).
    let c = max(o.color.rgb, vec3f(0.0));
    return vec4f(c, -1.0);
  }
  return encodeResolve(max(o.color.rgb, vec3f(0.0)));
}

@fragment
fn fsOpaque(in: VSOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  if (USE_LOD_FADE && lodFadeKill(in.pos.xy, in.lodFade)) { discard; }
  return finalize(shade(in, front, noVertexLight()));
}

struct MaskedOut {
  @location(0) color: vec4f,
  @builtin(sample_mask) mask: u32,
};

// Alpha-masked surfaces (foliage, fences). With MSAA we emit a custom
// alpha-to-coverage mask so the colour alpha stays free for the resolve weight.
@fragment
fn fsMasked(in: VSOut, @builtin(front_facing) front: bool) -> MaskedOut {
  if (USE_LOD_FADE && lodFadeKill(in.pos.xy, in.lodFade)) { discard; }
  let uv = in.uv0 * material.uvTransform.xy + material.uvTransform.zw;
  let texSize = vec2f(textureDimensions(baseColorTex));
  let dUv = max(length(dpdx(uv) * texSize), length(dpdy(uv) * texSize));
  let mip = max(log2(dUv), 0.0);
  let alpha = texGrad(baseColorTex, uv, dpdx(uv), dpdy(uv)).a * material.baseColor.a;
  let cov = maskCoverage(alpha, mip, material.pbr2.y);
  let o = shade(in, front, noVertexLight());
  var out: MaskedOut;
  out.color = finalize(o);
  if (hasFlag(F_A2C)) {
    let dither = ign(in.pos.xy) - 0.5;
    let n = u32(clamp(round(cov * 4.0 + dither * 0.9), 0.0, 4.0));
    if (n == 0u) { discard; }
    let rot = u32(in.pos.x + in.pos.y * 2.0) & 3u;
    let m = (0xFu >> (4u - n));
    out.mask = ((m << rot) | (m >> (4u - rot))) & 0xFu;
  } else {
    if (cov <= ign(in.pos.xy)) { discard; }
    out.mask = 0xFFFFFFFFu;
  }
  return out;
}

// ---------------------------------------------------------------- masked depth prepass
// Alpha-tested geometry (foliage, fences) writes depth + MSAA coverage here with
// a minimal shader; the lit colour pass then runs with depth == equal and no
// discard, so each visible sample is shaded once and tile HSR stays effective.
struct DepthOut {
  @builtin(sample_mask) mask: u32,
};

@fragment
fn fsDepthMasked(in: VSOut) -> DepthOut {
  if (USE_LOD_FADE && lodFadeKill(in.pos.xy, in.lodFade)) { discard; }
  let uv = in.uv0 * material.uvTransform.xy + material.uvTransform.zw;
  let texSize = vec2f(textureDimensions(baseColorTex));
  let dUv = max(length(dpdx(uv) * texSize), length(dpdy(uv) * texSize));
  let mip = max(log2(dUv), 0.0);
  let alpha = texGrad(baseColorTex, uv, dpdx(uv), dpdy(uv)).a * material.baseColor.a;
  let cov = maskCoverage(alpha, mip, material.pbr2.y);
  var out: DepthOut;
  if (hasFlag(F_A2C)) {
    let dither = ign(in.pos.xy) - 0.5;
    let n = u32(clamp(round(cov * 4.0 + dither * 0.9), 0.0, 4.0));
    if (n == 0u) { discard; }
    let rot = u32(in.pos.x + in.pos.y * 2.0) & 3u;
    let m = (0xFu >> (4u - n));
    out.mask = ((m << rot) | (m >> (4u - rot))) & 0xFu;
  } else {
    if (cov <= ign(in.pos.xy)) { discard; }
    out.mask = 0xFFFFFFFFu;
  }
  return out;
}

// Hardware alpha-to-coverage variant of the prepass: no discard, no sample
// mask builtin (both force slow paths with MSAA on tile-based GPUs). Colour
// writes are masked off, so alpha only drives coverage.
@fragment
fn fsDepthA2C(in: VSOut) -> @location(0) vec4f {
  if (USE_LOD_FADE && lodFadeKill(in.pos.xy, in.lodFade)) { discard; }
  let uv = in.uv0 * material.uvTransform.xy + material.uvTransform.zw;
  let texSize = vec2f(textureDimensions(baseColorTex));
  let dUv = max(length(dpdx(uv) * texSize), length(dpdy(uv) * texSize));
  let mip = max(log2(dUv), 0.0);
  let alpha = texGrad(baseColorTex, uv, dpdx(uv), dpdy(uv)).a * material.baseColor.a;
  return vec4f(0.0, 0.0, 0.0, maskCoverage(alpha, mip, material.pbr2.y));
}

fn prepassCoverage(uv0: vec2f) -> f32 {
  let uv = uv0 * material.uvTransform.xy + material.uvTransform.zw;
  let texSize = vec2f(textureDimensions(baseColorTex));
  let dUv = max(length(dpdx(uv) * texSize), length(dpdy(uv) * texSize));
  let mip = max(log2(dUv), 0.0);
  let alpha = texGrad(baseColorTex, uv, dpdx(uv), dpdy(uv)).a * material.baseColor.a;
  return maskCoverage(alpha, mip, material.pbr2.y);
}

// Prepass entries for vsDepth (the VSOut versions above serve ground clutter).
@fragment
fn fsDepthA2CSlim(in: VSOutDepth) -> @location(0) vec4f {
  if (USE_LOD_FADE && lodFadeKill(in.pos.xy, in.lodFade)) { discard; }
  return vec4f(0.0, 0.0, 0.0, prepassCoverage(in.uv0));
}

@fragment
fn fsDepthMaskedSlim(in: VSOutDepth) -> DepthOut {
  if (USE_LOD_FADE && lodFadeKill(in.pos.xy, in.lodFade)) { discard; }
  let cov = prepassCoverage(in.uv0);
  var out: DepthOut;
  if (hasFlag(F_A2C)) {
    let dither = ign(in.pos.xy) - 0.5;
    let n = u32(clamp(round(cov * 4.0 + dither * 0.9), 0.0, 4.0));
    if (n == 0u) { discard; }
    let rot = u32(in.pos.x + in.pos.y * 2.0) & 3u;
    let m = (0xFu >> (4u - n));
    out.mask = ((m << rot) | (m >> (4u - rot))) & 0xFu;
  } else {
    if (cov <= ign(in.pos.xy)) { discard; }
    out.mask = 0xFFFFFFFFu;
  }
  return out;
}

// Foliage colour pass after the prepass: fog and ambient from vsFoliage.
@fragment
fn fsFoliageColor(f: VSOutFoliage, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  let in = VSOut(f.pos, f.worldPos, f.normal, f.tangent, f.uv0, f.lmUv, f.viewDepth, f.slot, f.color, f.lodFade);
  return finalize(shade(in, front, VertexLight(f.fog, f.ambFront, f.ambBack)));
}

// Lit colour pass for masked geometry after the prepass (no discard).
@fragment
fn fsMaskedColor(in: VSOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  return finalize(shade(in, front, noVertexLight()));
}
