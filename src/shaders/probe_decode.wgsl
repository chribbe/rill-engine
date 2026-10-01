// Converts one rendered capture face (weighted-resolve encoding, fixed
// pre-exposure, right-handed camera) into a cube-map face of absolute radiance.
// Cube faces are left-handed in texel space, so the image is mirrored in x.
struct DecodeParams {
  invPreExposure: f32,
  face: u32,
  pad0: u32,
  pad1: u32,
};

@group(0) @binding(0) var<uniform> D: DecodeParams;
@group(0) @binding(1) var captured: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d_array<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(captured);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let s = textureLoad(captured, vec2i(i32(size.x - 1u - id.x), i32(id.y)), 0);
  var c = vec3f(0.0);
  if (s.a > 0.0) { c = s.rgb / s.a; }
  // Keep the sun disk from dominating rough reflections after prefiltering.
  c = min(c * D.invPreExposure, vec3f(2.0e5));
  textureStore(dst, vec2u(id.xy), D.face, vec4f(c, 1.0));
}
