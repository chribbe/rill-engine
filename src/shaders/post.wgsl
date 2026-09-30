// Final display pass: weighted-resolve decode, tone mapping, restrained grading,
// sRGB encode and dither. No sharpening, grain, vignette or lens effects.
#include "common"

struct PostParams {
  tonemapper: u32,      // 0 AgX, 1 Khronos PBR Neutral, 2 ACES (Hill), 3 Reinhard (luma), 4 clamp, 5 AgX Punchy
  debugRaw: u32,
  dither: u32,
  pad: u32,
  grade: vec4f,         // x exposure compensation (stops), y contrast, z saturation, w white balance temperature shift
  tint: vec4f,          // rgb white balance gains
  bloom: vec4f,         // x strength (energy-conserving mix), y 1 / pyramid levels
};

@group(0) @binding(0) var<uniform> P: PostParams;
@group(0) @binding(1) var hdrTex: texture_2d<f32>;
@group(0) @binding(2) var bloomTex: texture_2d<f32>;
@group(0) @binding(3) var bloomSamp: sampler;

@vertex
fn vsMain(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u)) * 2.0 - 1.0;
  return vec4f(p, 0.0, 1.0);
}

// --- AgX (Troy Sobotka), fitted by Benjamin Wrensch; "base" look.
fn agxContrast(x: vec3f) -> vec3f {
  let x2 = x * x;
  let x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
fn agx(c: vec3f, punchy: bool) -> vec3f {
  let m = mat3x3f(vec3f(0.842479062253094, 0.0423282422610123, 0.0423756549057051),
                  vec3f(0.0784335999999992, 0.878468636469772, 0.0784336),
                  vec3f(0.0792237451477643, 0.0791661274605434, 0.879142973793104));
  let mi = mat3x3f(vec3f(1.19687900512017, -0.0528968517574562, -0.0529716355144438),
                   vec3f(-0.0980208811401368, 1.15190312990417, -0.0980434501171241),
                   vec3f(-0.0990297440797205, -0.0989611768448433, 1.15107367264116));
  let minEv = -12.47393;
  let maxEv = 4.026069;
  var v = m * c;
  v = clamp(log2(max(v, vec3f(1e-10))), vec3f(minEv), vec3f(maxEv));
  v = (v - minEv) / (maxEv - minEv);
  v = agxContrast(v);
  if (punchy) {
    // AgX "Punchy" look (Blender): power 1.35, saturation 1.4 in display space.
    v = pow(max(v, vec3f(0.0)), vec3f(1.35));
    let l2 = dot(v, vec3f(0.2126, 0.7152, 0.0722));
    v = l2 + 1.4 * (v - l2);
  }
  v = mi * v;
  // AgX output is display-encoded (~ gamma 2.2); convert back to linear for the sRGB encode.
  return pow(max(v, vec3f(0.0)), vec3f(2.2));
}

// --- Khronos PBR Neutral: keeps base colours faithful up to highlights.
fn pbrNeutral(cIn: vec3f) -> vec3f {
  let startCompression = 0.8 - 0.04;
  let desaturation = 0.15;
  let x = min(cIn.r, min(cIn.g, cIn.b));
  let offset = select(0.04, x - 6.25 * x * x, x < 0.08);
  var c = cIn - offset;
  let peak = max(c.r, max(c.g, c.b));
  if (peak < startCompression) { return c; }
  let d = 1.0 - startCompression;
  let newPeak = 1.0 - d * d / (peak + d - startCompression);
  c *= newPeak / peak;
  let g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return mix(c, vec3f(newPeak), g);
}

// --- ACES fitted (Stephen Hill)
fn acesHill(cIn: vec3f) -> vec3f {
  let inM = mat3x3f(vec3f(0.59719, 0.07600, 0.02840), vec3f(0.35458, 0.90834, 0.13383), vec3f(0.04823, 0.01566, 0.83777));
  let outM = mat3x3f(vec3f(1.60475, -0.10208, -0.00327), vec3f(-0.53108, 1.10813, -0.07276), vec3f(-0.07367, -0.00605, 1.07602));
  let v = inM * cIn;
  let a = v * (v + 0.0245786) - 0.000090537;
  let b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return saturate(outM * (a / b));
}

fn reinhardLuma(c: vec3f) -> vec3f {
  let l = luminance(c);
  return c / (1.0 + l);
}

@fragment
fn fsMain(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let s = textureLoad(hdrTex, vec2i(pos.xy), 0);
  var c: vec3f;
  var out: vec3f;
  if (s.a < 0.0) {
    // Raw debug view: value is already display-referred linear.
    c = s.rgb / max(-s.a, 1e-6);
    out = saturate(c);
  } else {
    c = s.rgb / max(s.a, 1e-6);
    if (P.bloom.x > 0.0) {
      // Veiling glare: redistributes a small fraction of the energy (no gain).
      let uv = pos.xy / vec2f(textureDimensions(hdrTex));
      let b = textureSampleLevel(bloomTex, bloomSamp, uv, 0.0).rgb * P.bloom.y;
      c = mix(c, b, P.bloom.x);
    }
    c *= exp2(P.grade.x);
    c *= P.tint.rgb;
    // Contrast around mid grey in log space, then saturation - both default neutral.
    let l = max(luminance(c), 1e-6);
    let lc = 0.18 * pow(l / 0.18, P.grade.y);
    c *= lc / l;
    c = max(mix(vec3f(luminance(c)), c, P.grade.z), vec3f(0.0));
    switch (P.tonemapper) {
      case 0u: { out = agx(c, false); }
      case 5u: { out = agx(c, true); }
      case 1u: { out = pbrNeutral(c); }
      case 2u: { out = acesHill(c); }
      case 3u: { out = reinhardLuma(c); }
      default: { out = saturate(c); }
    }
  }
  var srgb = linearToSrgb(saturate(out));
  if (P.dither != 0u) {
    srgb += (ign(pos.xy) - 0.5) / 255.0;
  }
  return vec4f(srgb, 1.0);
}
