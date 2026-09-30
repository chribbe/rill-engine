// Restrained, energy-conserving bloom (camera/eye veiling glare), not a glow
// effect: a wide low-amplitude PSF built from a downsample/upsample pyramid
// (13-tap downsample, 3x3 tent upsample, after Jimenez 2014). The first
// downsample decodes the weighted MSAA resolve and uses a Karis average so
// single bright sub-pixel glints cannot flicker.
#include "common"

struct BloomParams {
  texel: vec2f,     // 1 / source size
  mode: u32,        // 0 decode+downsample (Karis), 1 downsample, 2 upsample
  pad: u32,
};

@group(0) @binding(0) var<uniform> B: BloomParams;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

@vertex
fn vsMain(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u)) * 2.0 - 1.0;
  return vec4f(p, 0.0, 1.0);
}

fn decodeTexel(p: vec2i) -> vec3f {
  let s = textureLoad(src, p, 0);
  if (s.a <= 0.0) { return vec3f(0.0); }
  return min(s.rgb / s.a, vec3f(60000.0));
}

fn karisWeight(c: vec3f) -> f32 { return 1.0 / (1.0 + luminance(c)); }

@fragment
fn fsDown(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(src));
  if (B.mode == 0u) {
    // Decode the weighted resolve at full resolution: 4x4 texels -> 1, as four
    // Karis-weighted 2x2 groups.
    let base = vec2i(floor(pos.xy)) * 2 - 1;
    var acc = vec3f(0.0);
    var wsum = 0.0;
    for (var gy = 0; gy < 2; gy++) {
      for (var gx = 0; gx < 2; gx++) {
        var g = vec3f(0.0);
        for (var j = 0; j < 2; j++) {
          for (var i = 0; i < 2; i++) {
            let q = clamp(base + vec2i(gx * 2 + i, gy * 2 + j), vec2i(0), vec2i(size) - 1);
            g += decodeTexel(q);
          }
        }
        g *= 0.25;
        let w = karisWeight(g);
        acc += g * w;
        wsum += w;
      }
    }
    return vec4f(acc / max(wsum, 1e-6), 1.0);
  }
  // 13-tap downsample (bilinear taps on the previous, already decoded level).
  let uv = pos.xy * 2.0 / size;
  let t = B.texel;
  let a = textureSampleLevel(src, samp, uv + t * vec2f(-2.0, -2.0), 0.0).rgb;
  let b = textureSampleLevel(src, samp, uv + t * vec2f(0.0, -2.0), 0.0).rgb;
  let c = textureSampleLevel(src, samp, uv + t * vec2f(2.0, -2.0), 0.0).rgb;
  let d = textureSampleLevel(src, samp, uv + t * vec2f(-2.0, 0.0), 0.0).rgb;
  let e = textureSampleLevel(src, samp, uv, 0.0).rgb;
  let f = textureSampleLevel(src, samp, uv + t * vec2f(2.0, 0.0), 0.0).rgb;
  let g = textureSampleLevel(src, samp, uv + t * vec2f(-2.0, 2.0), 0.0).rgb;
  let h = textureSampleLevel(src, samp, uv + t * vec2f(0.0, 2.0), 0.0).rgb;
  let i = textureSampleLevel(src, samp, uv + t * vec2f(2.0, 2.0), 0.0).rgb;
  let j = textureSampleLevel(src, samp, uv + t * vec2f(-1.0, -1.0), 0.0).rgb;
  let k = textureSampleLevel(src, samp, uv + t * vec2f(1.0, -1.0), 0.0).rgb;
  let l = textureSampleLevel(src, samp, uv + t * vec2f(-1.0, 1.0), 0.0).rgb;
  let m = textureSampleLevel(src, samp, uv + t * vec2f(1.0, 1.0), 0.0).rgb;
  var o = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  return vec4f(o, 1.0);
}

@fragment
fn fsUp(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  // 3x3 tent over the smaller level; blended additively onto the larger level.
  let dstSize = vec2f(textureDimensions(src)) * 2.0;
  let uv = pos.xy / dstSize;
  let t = B.texel;
  var o = textureSampleLevel(src, samp, uv, 0.0).rgb * 4.0;
  o += (textureSampleLevel(src, samp, uv + vec2f(-t.x, 0.0), 0.0).rgb + textureSampleLevel(src, samp, uv + vec2f(t.x, 0.0), 0.0).rgb
      + textureSampleLevel(src, samp, uv + vec2f(0.0, -t.y), 0.0).rgb + textureSampleLevel(src, samp, uv + vec2f(0.0, t.y), 0.0).rgb) * 2.0;
  o += textureSampleLevel(src, samp, uv + vec2f(-t.x, -t.y), 0.0).rgb + textureSampleLevel(src, samp, uv + vec2f(t.x, -t.y), 0.0).rgb
     + textureSampleLevel(src, samp, uv + vec2f(-t.x, t.y), 0.0).rgb + textureSampleLevel(src, samp, uv + vec2f(t.x, t.y), 0.0).rgb;
  return vec4f(o / 16.0, 1.0);
}
