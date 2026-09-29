// Full-screen sky pass drawn after opaque geometry at the far plane (reverse-Z 0).
#include "frame_bindings"
#include "brdf"
#include "sky_eval"
#include "fog"

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) ndc: vec2f,
};

@vertex
fn vsMain(@builtin(vertex_index) vi: u32) -> VOut {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u)) * 2.0 - 1.0;
  var o: VOut;
  o.pos = vec4f(p, 0.0, 1.0);
  o.ndc = p;
  return o;
}

@fragment
fn fsMain(in: VOut) -> @location(0) vec4f {
  let near = frame.invViewProj * vec4f(in.ndc, 1.0, 1.0);
  let d = normalize(near.xyz / near.w - frame.cameraPos.xyz);
  let mode = frame.debug.x;
  if (mode != 0u && mode != 11u && mode != 17u && mode != 6u && mode != 12u && mode != 13u && mode != 14u && mode != 15u) {
    return vec4f(0.08, 0.08, 0.1, -1.0);
  }
  let pixelAngle = 2.0 * frame.viewport.w / max(frame.proj[1][1], 1e-3);
  var L = skyRadiance(d, true, pixelAngle);
  let fog = computeFog(frame.cameraPos.xyz, d, 1e9, true);
  L = L * fog.transmittance + fog.inscatter;
  // Pre-exposed sun disk can exceed fp16 range; clamp well below it.
  let c = min(L * frame.exposure.x, vec3f(30000.0));
  // Tiny dither before the 16-bit target to avoid banding in smooth gradients.
  return encodeResolve(c);
}
