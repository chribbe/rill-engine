// Bind group 0 shared by every forward pass (opaque, masked, sky, debug views).
// Layout mirrors FrameBindings in src/engine/render/renderer.ts.
#include "common"

struct Light {
  posRange: vec4f,  // xyz position, w range (m)
  color: vec4f,     // rgb luminous intensity (cd), w fog scatter scale
  dirCone: vec4f,   // xyz spot direction, w cos(outer)
  params: vec4f,    // x cos(inner), y type (0 point, 1 spot), z source radius, w spot shadow layer + 1 (0 = none)
};

struct Decal {
  row0: vec4f,      // world -> decal box ([-0.5, 0.5]^3), 3x4 affine rows
  row1: vec4f,
  row2: vec4f,
  params: vec4f,    // x layer, y opacity, z crater relief strength, w roughness (<0 = keep)
  tint: vec4f,      // rgb tint, w uv repeat along x
  axis: vec4f,      // xyz projection axis (world, points out of surface), w angle fade start
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> instances: array<Instance>;
@group(0) @binding(2) var<storage, read> visibleList: array<u32>;
@group(0) @binding(3) var sampAniso: sampler;
@group(0) @binding(4) var sampClamp: sampler;
@group(0) @binding(5) var sampShadow: sampler_comparison;
@group(0) @binding(6) var shadowMap: texture_depth_2d_array;
@group(0) @binding(7) var envSpecular: texture_cube<f32>;
@group(0) @binding(8) var<storage, read> shSky: array<vec4f, 12>;
@group(0) @binding(9) var brdfLut: texture_2d<f32>;
@group(0) @binding(10) var lightmaps: texture_2d_array<f32>;
@group(0) @binding(11) var<storage, read> lights: array<Light>;
@group(0) @binding(12) var skyViewLut: texture_2d<f32>;
@group(0) @binding(13) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(14) var<storage, read> decals: array<Decal>;
@group(0) @binding(15) var<storage, read> decalCells: array<u32>;
@group(0) @binding(16) var decalAtlas: texture_2d_array<f32>;
@group(0) @binding(17) var debugGridTex: texture_2d<f32>;
@group(0) @binding(18) var cloudNoise: texture_2d<f32>;
@group(0) @binding(19) var probeVolume: texture_3d<f32>;
@group(0) @binding(20) var reflCubes: texture_cube_array<f32>;

struct ReflProbe {
  sh: array<vec4f, 12>,  // irradiance/PI SH (same encoding as shSky)
  pos: vec4f,            // capture point, w = cube array layer
  bmin: vec4f,           // box min, w = blend distance
  bmax: vec4f,           // box max, w = priority
  pad: vec4f,
};
@group(0) @binding(21) var<storage, read> reflProbes: array<ReflProbe>;
// Global snow layer (weather), projected from above in world space.
@group(0) @binding(22) var snowAlbedoTex: texture_2d<f32>;
@group(0) @binding(23) var snowNormalTex: texture_2d<f32>;
@group(0) @binding(24) var snowOrmTex: texture_2d<f32>;
// Dynamic spot-light shadows (flashlight): depth layers + light-space matrices.
@group(0) @binding(25) var spotShadowMap: texture_depth_2d_array;
@group(0) @binding(26) var<storage, read> spotShadowMats: array<mat4x4f>;
// Local-light XZ grid (frame.lightGrid*): per cell [count, light index...], from
// word lightGrid2.w.
@group(0) @binding(27) var<storage, read> lightCells: array<u32>;
// The same fog-glow lights as copies in a uniform buffer: every pixel reads the same
// few lights, which the constant cache serves far faster than storage loads.
struct FogLights {
  count: vec4u,
  l: array<Light, 8>,
};
@group(0) @binding(28) var<uniform> fogLights: FogLights;

/// Start of the light list of the grid cell containing `wp` (count at the start; 0 = none).
fn lightCellBase(wp: vec3f) -> u32 {
  let g = frame.lightGrid;
  let c = vec2i(floor((wp.xz - g.xy) * g.w));
  let n = vec2i(frame.lightGrid2.xy);
  if (any(c < vec2i(0)) || any(c >= n)) { return 0xFFFFFFFFu; }
  return frame.lightGrid2.w + u32(c.y * n.x + c.x) * (frame.lightGrid2.z + 1u);
}

fn hasFlag(bit: u32) -> bool { return (frame.debug.y & bit) != 0u; }
