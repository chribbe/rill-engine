// Depth-only shadow caster pass (one draw list per cascade).
#include "common"

struct ShadowView {
  viewProj: mat4x4f,
};

struct MaterialParams {
  baseColor: vec4f,
  uvTransform: vec4f,
  detailTransform: vec4f,
  macroTransform: vec4f,
  pbr: vec4f,
  pbr2: vec4f,
  emissive: vec4f,
  flags: vec4u,
  extra: vec4f,
};

@group(0) @binding(0) var<uniform> view: ShadowView;
@group(0) @binding(1) var<storage, read> instances: array<Instance>;
@group(0) @binding(2) var<storage, read> visibleList: array<u32>;
@group(0) @binding(3) var sampAniso: sampler;

@group(1) @binding(0) var<uniform> material: MaterialParams;
@group(1) @binding(1) var baseColorTex: texture_2d<f32>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vsMain(@location(0) position: vec3f, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  let inst = instances[visibleList[ii]];
  return view.viewProj * (inst.model * vec4f(position, 1.0));
}

@vertex
fn vsMasked(@location(0) position: vec3f, @location(3) uv0: vec2f, @builtin(instance_index) ii: u32) -> VOut {
  let inst = instances[visibleList[ii]];
  var o: VOut;
  o.pos = view.viewProj * (inst.model * vec4f(position, 1.0));
  o.uv = uv0 * material.uvTransform.xy + material.uvTransform.zw;
  return o;
}

@fragment
fn fsMasked(in: VOut) {
  let a = textureSample(baseColorTex, sampAniso, in.uv).a * material.baseColor.a;
  if (a < material.pbr2.y) { discard; }
}
