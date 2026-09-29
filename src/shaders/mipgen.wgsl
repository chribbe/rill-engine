// Texture mip generation.
//  mode 0: colour, sRGB-encoded storage, filtered in linear space
//  mode 1: linear data (ORM, masks, macro)
//  mode 2: tangent-space normal map; rgb = unit normal, a encodes the normal
//          variance lost by averaging (consumed as extra GGX roughness)
// filter 0: box, 1: Lanczos-2 (6x6 taps, slightly crisper distant textures)
#include "common"

struct MipParams {
  mode: u32,
  filterMode: u32,
  wrap: u32,
  pad: u32,
};

@group(0) @binding(0) var<uniform> P: MipParams;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba8unorm, write>;

fn fetch(p: vec2i, size: vec2i) -> vec4f {
  var q = p;
  if (P.wrap != 0u) {
    q = ((p % size) + size) % size;
  } else {
    q = clamp(p, vec2i(0), size - 1);
  }
  var c = textureLoad(src, q, 0);
  if (P.mode == 0u) { c = vec4f(srgbToLinear(c.rgb), c.a); }
  return c;
}

const LANCZOS: array<f32, 6> = array<f32, 6>(-0.0412, 0.1144, 0.4268, 0.4268, 0.1144, -0.0412);

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let dsize = vec2i(textureDimensions(dst));
  let ssize = vec2i(textureDimensions(src));
  if (i32(id.x) >= dsize.x || i32(id.y) >= dsize.y) { return; }
  let base = vec2i(id.xy) * 2;
  // Handle 1-texel-wide sources (non-square chains).
  let step = vec2i(select(0, 1, ssize.x > 1), select(0, 1, ssize.y > 1));

  if (P.mode == 2u) {
    var sum = vec3f(0.0);
    var varSum = 0.0;
    for (var j = 0; j < 2; j++) {
      for (var i = 0; i < 2; i++) {
        let t = fetch(base + vec2i(i, j) * step, ssize);
        sum += normalize(t.xyz * 2.0 - 1.0);
        varSum += (1.0 - t.a) * 0.5;
      }
    }
    let avg = sum * 0.25;
    let r = min(length(avg), 0.9999);
    // von Mises-Fisher fit: kappa from mean length; 1/kappa ~ GGX alpha^2 increase.
    let kappa = (3.0 * r - r * r * r) / (1.0 - r * r);
    let v = clamp(varSum * 0.25 + 1.0 / kappa, 0.0, 0.5);
    let n = normalize(avg + vec3f(0.0, 0.0, 1e-6));
    textureStore(dst, id.xy, vec4f(n * 0.5 + 0.5, 1.0 - 2.0 * v));
    return;
  }

  var c = vec4f(0.0);
  if (P.filterMode == 1u && ssize.x >= 4 && ssize.y >= 4) {
    for (var j = 0; j < 6; j++) {
      var row = vec4f(0.0);
      for (var i = 0; i < 6; i++) {
        row += fetch(base + vec2i(i - 2, j - 2), ssize) * LANCZOS[i];
      }
      c += row * LANCZOS[j];
    }
    c = clamp(c, vec4f(0.0), vec4f(1.0));
  } else {
    c = (fetch(base, ssize) + fetch(base + vec2i(step.x, 0), ssize)
       + fetch(base + vec2i(0, step.y), ssize) + fetch(base + step, ssize)) * 0.25;
  }
  if (P.mode == 0u) { c = vec4f(linearToSrgb(c.rgb), c.a); }
  textureStore(dst, id.xy, c);
}
