// Standard lit surface shader (opaque + alpha-masked foliage).
#include "frame_bindings"
#include "brdf"
#include "shadows"
#include "fog"

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

@group(1) @binding(0) var<uniform> material: MaterialParams;
@group(1) @binding(1) var baseColorTex: texture_2d<f32>;
@group(1) @binding(2) var normalTex: texture_2d<f32>;
@group(1) @binding(3) var ormTex: texture_2d<f32>;
@group(1) @binding(4) var detailAlbedoTex: texture_2d<f32>;
@group(1) @binding(5) var detailNormalTex: texture_2d<f32>;
@group(1) @binding(6) var macroTex: texture_2d<f32>;

fn matFlag(bit: u32) -> bool { return (material.flags.x & bit) != 0u; }

struct VSIn {
  @location(0) position: vec3f,
  @location(1) normal: vec4f,
  @location(2) tangent: vec4f,
  @location(3) uv0: vec2f,
  @location(4) uv1: vec2f,
  @builtin(instance_index) instance: u32,
};

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) worldPos: vec3f,
  @location(1) normal: vec3f,
  @location(2) tangent: vec4f,
  @location(3) uv0: vec2f,
  @location(4) lmUv: vec2f,
  @location(5) viewDepth: f32,
  @location(6) @interpolate(flat) slot: u32,
};

@vertex
fn vsMain(v: VSIn) -> VSOut {
  let slot = visibleList[v.instance];
  let inst = instances[slot];
  let wp = inst.model * vec4f(v.position, 1.0);
  var o: VSOut;
  o.pos = frame.viewProj * wp;
  o.worldPos = wp.xyz;
  o.normal = normalize(normalMatrix(inst.model) * v.normal.xyz);
  o.tangent = vec4f(normalize((inst.model * vec4f(v.tangent.xyz, 0.0)).xyz), select(-1.0, 1.0, v.tangent.w >= 0.0));
  o.uv0 = v.uv0;
  o.lmUv = v.uv1 * inst.lmST.xy + inst.lmST.zw;
  o.viewDepth = -(frame.view * wp).z;
  o.slot = slot;
  return o;
}

// ------------------------------------------------------------------ helpers

fn decodeNormal(t: vec4f) -> vec4f {
  // rgb: unit normal, a: 1 - 2 * (normal variance -> added GGX alpha^2)
  let n = normalize(t.xyz * 2.0 - 1.0);
  return vec4f(n, (1.0 - t.a) * 0.5);
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

// Bicubic B-spline lightmap filtering with 4 bilinear taps (Sigg & Hadwiger).
fn sampleLightmap(uv: vec2f, layer: i32) -> vec3f {
  if (frame.lmParams.y < 0.5) {
    return textureSampleLevel(lightmaps, sampClamp, uv, layer, 0.0).rgb;
  }
  let size = vec2f(textureDimensions(lightmaps).xy);
  let p = uv * size - 0.5;
  let i = floor(p);
  let f = p - i;
  let w = cubicBSplineWeights(f);
  let g0 = vec2f(w[0].x + w[0].y, w[1].x + w[1].y);
  let g1 = vec2f(w[0].z + w[0].w, w[1].z + w[1].w);
  let h0 = (vec2f(w[0].y, w[1].y) / g0 - 1.0 + i + 0.5) / size;
  let h1 = (vec2f(w[0].w, w[1].w) / g1 + 1.0 + i + 0.5) / size;
  let a = textureSampleLevel(lightmaps, sampClamp, vec2f(h0.x, h0.y), layer, 0.0).rgb;
  let b = textureSampleLevel(lightmaps, sampClamp, vec2f(h1.x, h0.y), layer, 0.0).rgb;
  let c = textureSampleLevel(lightmaps, sampClamp, vec2f(h0.x, h1.y), layer, 0.0).rgb;
  let d = textureSampleLevel(lightmaps, sampClamp, vec2f(h1.x, h1.y), layer, 0.0).rgb;
  return g0.y * (g0.x * a + g1.x * b) + g1.y * (g0.x * c + g1.x * d);
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
  }
}

// ------------------------------------------------------------------ shading

struct ShadeOut {
  color: vec4f,      // pre-exposed HDR colour (a = coverage for masked)
  raw: bool,
};

fn skyUpRadiance() -> vec3f { return shEval(vec3f(0.0, 1.0, 0.0)); }

fn shade(in: VSOut, front: bool) -> ShadeOut {
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

  var Ng = normalize(in.normal);
  var T = in.tangent.xyz;
  if (!front) { Ng = -Ng; }
  T = normalize(T - Ng * dot(Ng, T));
  let B = cross(Ng, T) * in.tangent.w * select(-1.0, 1.0, front);

  var s: Surface;
  var bc: vec4f;
  var nt: vec4f;
  var orm: vec4f;
  if (matFlag(M_TRIPLANAR)) {
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
  s.ao = mix(1.0, orm.r, material.pbr.w);
  s.emissive = material.emissive.rgb;
  s.Ng = Ng;

  // --- tangent-space normal with detail layer
  var tn = scaleNormal(nt.xyz, material.pbr.z * frame.mat0.w);
  let detailFade = saturate(1.0 - dist / max(material.emissive.w, 0.01));
  if (hasFlag(F_DETAIL) && detailFade > 0.0) {
    let duv = in.uv0 * material.detailTransform.xy;
    let dDx = uv0Dx * material.detailTransform.xy;
    let dDy = uv0Dy * material.detailTransform.xy;
    let strength = frame.mat0.x * detailFade;
    if (matFlag(M_DETAIL_ALBEDO)) {
      let da = texGrad(detailAlbedoTex, duv, dDx, dDy).r;
      // Detail albedo is an overlay around 0.5 grey (x2 multiply).
      s.albedo *= mix(1.0, da * 2.0, material.detailTransform.z * strength);
    }
    if (matFlag(M_DETAIL_NORMAL) && !matFlag(M_TRIPLANAR)) {
      let dn = decodeNormal(texGrad(detailNormalTex, duv, dDx, dDy));
      tn = blendRNM(tn, scaleNormal(dn.xyz, material.detailTransform.w * strength));
      s.normalVariance += dn.w * material.detailTransform.w * strength;
    }
  }
  // --- macro variation (large-scale, breaks tiling on big surfaces)
  if (matFlag(M_MACRO) && frame.mat0.y > 0.0) {
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
  if (!matFlag(M_TRIPLANAR)) {
    s.N = normalize(T * tn.x + B * tn.y + Ng * tn.z);
  }

  // --- global wetness: porous darkening + smoother, flatter surfaces
  let wet = frame.mat1.y * material.pbr2.z * saturate(Ng.y * 0.8 + 0.4);
  if (wet > 0.0) {
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

  if ((inst.info.y & I_NO_DECALS) == 0u) { applyDecals(wp, dpx, dpy, &s); }

  // ---------------------------------------------------------------- debug (raw)
  let mode = frame.debug.x;
  var out: ShadeOut;
  out.raw = false;
  out.color = vec4f(0.0, 0.0, 0.0, s.alpha);
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

  // ---------------------------------------------------------------- lighting
  let N = s.N;
  let NoV = max(dot(N, V), 1e-4);
  let diffuseColor = s.albedo * (1.0 - s.metallic);
  let spec = material.pbr2.x;
  let f0 = mix(vec3f(0.16 * spec * spec), s.albedo, s.metallic);
  var a = max(s.roughness * s.roughness, 0.002);
  // Normal-map variance (Toksvig/vMF, stored per mip) + geometric specular AA.
  a = sqrt(a * a + s.normalVariance);
  if (hasFlag(F_SPEC_AA)) { a = specularAA(N, a, frame.mat1.x); }
  let foliage = matFlag(M_FOLIAGE);

  // Sun
  var direct = vec3f(0.0);
  var shadowTerm = 1.0;
  var cascade = -1.0;
  if (hasFlag(F_SUN)) {
    let L = frame.sunDir.xyz;
    let NoLg = dot(Ng, L);
    let sh = sunShadow(wp, Ng, NoLg, in.viewDepth);
    shadowTerm = sh.x;
    cascade = sh.y;
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
    }
    direct *= frame.sunColor.rgb * shadowTerm;
  }

  // Indirect diffuse: lightmap (static) or sky SH (dynamic / non-lightmapped).
  var irr = vec3f(0.0);         // radiance of a white Lambertian (irradiance / PI)
  let shN = shEval(N);
  let lmLayer = i32(inst.info.x) - 1;
  let useLm = lmLayer >= 0 && hasFlag(F_LIGHTMAPS);
  if (useLm) {
    let lmSky = sampleLightmap(in.lmUv, lmLayer) * frame.lmParams.z;
    let lmSun = sampleLightmap(in.lmUv, lmLayer + 1) * frame.lmParams.w;
    var ratio = vec3f(1.0);
    if (hasFlag(F_SH_RATIO)) {
      // Re-introduce normal-map detail into the non-directional lightmap using
      // the directional distribution of the current sky.
      ratio = clamp(shN / max(shEval(Ng), vec3f(1e-4)), vec3f(0.4), vec3f(1.8));
    }
    irr = (lmSky * skyUpRadiance() + lmSun * frame.sunColor.rgb * INV_PI) * ratio;
  } else if (hasFlag(F_SKY_AMBIENT)) {
    irr = shN;
    if (foliage) {
      // Crude canopy self-occlusion until probe volumes exist: darker low in the tree.
      let localY = (wp.y - inst.model[3].y) / max(length(inst.model[1].xyz), 0.01);
      irr *= mix(0.35, 1.0, saturate(localY / 14.0));
    }
  }
  irr *= frame.exposure.w;
  let Fenv = f0 + (max(vec3f(1.0 - s.roughness), f0) - f0) * pow(1.0 - NoV, 5.0);
  var indirectDiffuse = diffuseColor * irr * s.ao * (1.0 - Fenv * 0.5);
  if (foliage) { indirectDiffuse += diffuseColor * irr * material.pbr2.w * 0.35; }

  // Indirect specular: prefiltered environment probe with split-sum BRDF.
  var indirectSpec = vec3f(0.0);
  if (hasFlag(F_ENV_SPEC)) {
    let R = reflect(-V, N);
    let rough = sqrt(a);
    let lod = rough * (frame.sky.z - 1.0);
    let env = textureSampleLevel(envSpecular, sampClamp, R, lod).rgb;
    let ab = textureSampleLevel(brdfLut, sampClamp, vec2f(NoV, rough), 0.0).rg;
    var so = 1.0;
    if (hasFlag(F_SPEC_OCCLUSION)) {
      if (useLm) {
        // Reflection normalisation (Source 2 style): scale the probe by the ratio
        // of local baked irradiance to the probe's own irradiance.
        so = saturate(luminance(irr) / max(luminance(shN) * frame.exposure.w, 1e-4));
        so = so * so * (3.0 - 2.0 * so);
      } else {
        so = specOcclusionFromAO(NoV, s.ao, a);
      }
      // Horizon occlusion: reflections pointing below the geometric surface.
      let h = saturate(1.0 + 1.1 * dot(R, Ng));
      so *= h * h;
    }
    indirectSpec = env * (f0 * ab.x + ab.y) * so * frame.mat1.w;
  }

  // Local lights (small list, brute force for now; clustered later if needed).
  var local = vec3f(0.0);
  if (hasFlag(F_LOCAL_LIGHTS)) {
    for (var i = 0u; i < frame.debug.z; i++) {
      let l = lights[i];
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
      let H = normalize(V + Ld);
      let NoH = saturate(dot(N, H));
      let VoH = saturate(dot(V, H));
      let Fs = F_Schlick(f0, VoH);
      let sb = D_GGX(NoH, a) * V_SmithGGX(NoV, NoL, a) * Fs;
      var c = (diffuseColor * INV_PI * (1.0 - Fs) + sb) * NoL;
      if (foliage) { c += diffuseColor * material.pbr2.w * saturate(dot(-N, Ld)) * INV_PI; }
      local += c * l.color.rgb * att;
    }
    local *= frame.ground.w;
  }

  var color = direct + indirectDiffuse + indirectSpec + local + s.emissive;
  if (matFlag(M_UNLIT)) { color = s.emissive + s.albedo * irr; }

  // ---------------------------------------------------------------- debug (lit)
  if (mode == 11u) {
    let cc = array<vec3f, 5>(vec3f(1.0, 0.25, 0.25), vec3f(0.25, 1.0, 0.25), vec3f(0.3, 0.45, 1.0), vec3f(1.0, 1.0, 0.25), vec3f(0.6));
    let ci = u32(clamp(cascade, 0.0, 4.0));
    color = color * cc[ci];
  }
  if (mode == 6u || mode == 14u) { color = indirectDiffuse; }
  if (mode == 13u) { color = direct; }
  if (mode == 15u) { color = indirectSpec + direct * select(0.0, 1.0, s.metallic > 0.5); }
  if (mode == 18u) { out.raw = true; out.color = vec4f(vec3f(shadowTerm), s.alpha); return out; }

  // ---------------------------------------------------------------- fog
  let fog = computeFog(camPos, -V, dist, false);
  if (mode == 19u) { out.raw = true; out.color = vec4f(vec3f(fog.transmittance), s.alpha); return out; }
  color = color * fog.transmittance + fog.inscatter + fogLightScatter(camPos, -V, dist);

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
  return finalize(shade(in, front));
}

struct MaskedOut {
  @location(0) color: vec4f,
  @builtin(sample_mask) mask: u32,
};

// Alpha-masked surfaces (foliage, fences). With MSAA we emit a custom
// alpha-to-coverage mask so the colour alpha stays free for the resolve weight.
@fragment
fn fsMasked(in: VSOut, @builtin(front_facing) front: bool) -> MaskedOut {
  let uv = in.uv0 * material.uvTransform.xy + material.uvTransform.zw;
  let texSize = vec2f(textureDimensions(baseColorTex));
  let dUv = max(length(dpdx(uv) * texSize), length(dpdy(uv) * texSize));
  let mip = max(log2(dUv), 0.0);
  var alpha = texGrad(baseColorTex, uv, dpdx(uv), dpdy(uv)).a * material.baseColor.a;
  // Preserve coverage in distant mips (Golus), then sharpen to a ~1px edge.
  alpha *= 1.0 + mip * 0.25;
  let cutoff = material.pbr2.y;
  let sharpened = (alpha - cutoff) / max(fwidth(alpha), 1e-4) + 0.5;
  let o = shade(in, front);
  var out: MaskedOut;
  out.color = finalize(o);
  if (hasFlag(F_A2C)) {
    let cov = saturate(sharpened);
    let dither = ign(in.pos.xy) - 0.5;
    let n = u32(clamp(round(cov * 4.0 + dither * 0.9), 0.0, 4.0));
    if (n == 0u) { discard; }
    let rot = u32(in.pos.x + in.pos.y * 2.0) & 3u;
    let m = (0xFu >> (4u - n));
    out.mask = ((m << rot) | (m >> (4u - rot))) & 0xFu;
  } else {
    if (alpha < cutoff) { discard; }
    out.mask = 0xFFFFFFFFu;
  }
  return out;
}
