// Lighting helpers shared by the standard surface shader and particles:
// probe-volume ambient cubes, sky-up radiance, dynamic spot shadows.
#include "frame_bindings"
#include "brdf"

fn skyUpRadiance() -> vec3f { return shEval(vec3f(0.0, 1.0, 0.0)); }

// --- probe volume (ambient cubes, slab-packed 3D texture) ---------------------
fn probeSlab(g: vec3f, slab: u32) -> vec3f {
  let dims = vec3f(frame.pvDims.xyz);
  let gz = clamp(g.z, 0.0, dims.z - 1.0);
  let uvw = vec3f((g.x + 0.5) / dims.x, (g.y + 0.5) / dims.y, (f32(slab) * dims.z + gz + 0.5) / (dims.z * 12.0));
  return textureSampleLevel(probeVolume, sampClamp, uvw, 0.0).rgb;
}

fn ambientCube(g: vec3f, n: vec3f, comp: u32) -> vec3f {
  let n2 = n * n;
  let b = comp * 6u;
  return n2.x * probeSlab(g, b + select(1u, 0u, n.x >= 0.0))
       + n2.y * probeSlab(g, b + select(3u, 2u, n.y >= 0.0))
       + n2.z * probeSlab(g, b + select(5u, 4u, n.z >= 0.0));
}

/// Irradiance/PI from the probe volume (rgb) and coverage weight (a).
fn probeVolumeIrradiance(wp: vec3f, n: vec3f, skyUp: vec3f) -> vec4f {
  let g = (wp - frame.pvOrigin.xyz) * frame.pvInvSpacing.xyz;
  let dims = vec3f(frame.pvDims.xyz);
  let d = min(g + 0.5, dims - 0.5 - g);
  let w = saturate(min(d.x, min(d.y, d.z)) * 0.5);
  if (w <= 0.0) { return vec4f(0.0); }
  let sky = ambientCube(g, n, 0u);
  let sun = ambientCube(g, n, 1u);
  return vec4f(sky * skyUp * frame.lmParams.z + sun * frame.sunColor.rgb * frame.lmParams.w, w);
}

// ------------------------------------------------------------------ spot-light shadows
fn spotShadow(layer: u32, wp: vec3f, n: vec3f, dist: f32) -> f32 {
  // Normal offset grows with distance (texel footprint of a 1024^2 cone map).
  let p = wp + n * (0.015 + dist * 0.004);
  let c = spotShadowMats[layer] * vec4f(p, 1.0);
  if (c.w <= 0.0) { return 1.0; }
  let ndc = c.xyz / c.w;
  let uv = ndc.xy * vec2f(0.5, -0.5) + 0.5;
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return 1.0; }
  let refZ = ndc.z - 0.0004;
  let ts = 1.0 / 1024.0;
  var sh = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      sh += textureSampleCompareLevel(spotShadowMap, sampShadow, uv + vec2f(f32(x), f32(y)) * ts, i32(layer), refZ);
    }
  }
  return sh * (1.0 / 9.0);
}
