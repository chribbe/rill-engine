// Debug line rendering (bounds, frusta, wireframe overlay).
#include "common"

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> instances: array<Instance>;
@group(0) @binding(2) var<storage, read> visibleList: array<u32>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) color: vec4f,
};

// World-space colored lines (CPU generated).
@vertex
fn vsLines(@location(0) p: vec3f, @location(1) c: vec4f) -> VOut {
  var o: VOut;
  o.pos = frame.viewProj * vec4f(p, 1.0);
  o.color = c;
  return o;
}

// Wireframe: mesh edges via a line-list index buffer, instanced like the mesh.
@vertex
fn vsWire(@location(0) p: vec3f, @builtin(instance_index) ii: u32) -> VOut {
  let inst = instances[visibleList[ii] & 0xFFFFFFu];
  var o: VOut;
  o.pos = frame.viewProj * (inst.model * vec4f(p, 1.0));
  // Pull slightly toward the camera (reverse-Z: larger = closer).
  o.pos.z += 2e-5 * o.pos.w;
  o.color = vec4f(0.1, 0.9, 1.0, 1.0);
  return o;
}

// Editor selection: the selected objects' edges, depth tested, in the selection colour.
@vertex
fn vsWireSelect(@location(0) p: vec3f, @builtin(instance_index) ii: u32) -> VOut {
  let inst = instances[visibleList[ii] & 0xFFFFFFu];
  var o: VOut;
  o.pos = frame.viewProj * (inst.model * vec4f(p, 1.0));
  o.pos.z += 4e-5 * o.pos.w;
  o.color = vec4f(1.0, 0.5, 0.08, 1.0);
  return o;
}

@fragment
fn fsMain(in: VOut) -> @location(0) vec4f {
  // Unlit overlay: written with weight 1 so the resolve leaves it as-is (pre-exposure ignored).
  let c = in.color.rgb * in.color.a;
  return encodeResolve(c * 1.0);
}

// Overdraw visualisation: additive constant per fragment.
@fragment
fn fsOverdraw() -> @location(0) vec4f {
  return vec4f(0.04, 0.02, 0.01, 0.0);
}
