// Bind group 0 shared by every forward pass (opaque, masked, sky, debug views).
// Layout mirrors FrameBindings in src/engine/render/renderer.ts.
#include "common"

struct Light {
  posRange: vec4f,  // xyz position, w range (m)
  color: vec4f,     // rgb luminous intensity (cd), w fog scatter scale
  dirCone: vec4f,   // xyz spot direction, w cos(outer)
  params: vec4f,    // x cos(inner), y type (0 point, 1 spot), z source radius, w reserved
};

struct Decal {
  row0: vec4f,      // world -> decal box ([-0.5, 0.5]^3), 3x4 affine rows
  row1: vec4f,
  row2: vec4f,
  params: vec4f,    // x layer, y opacity, z normal strength, w roughness (<0 = keep)
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

fn hasFlag(bit: u32) -> bool { return (frame.debug.y & bit) != 0u; }
