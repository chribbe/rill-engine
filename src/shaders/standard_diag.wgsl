// Diagnostic fragment entry points used for performance bisection
// (renderer.diagFragment). Kept out of the production module.
#include "standard"

// ---------------------------------------------------------------- diagnostics
// Bisection entry points for performance investigations (see docs/ENGINE.md).
@fragment
fn fsDiagTrivial(in: VSOut) -> @location(0) vec4f {
  return encodeResolve(vec3f(in.uv0.x * 0.0 + 0.1));
}

@fragment
fn fsDiagTextures(in: VSOut) -> @location(0) vec4f {
  let uv = in.uv0 * material.uvTransform.xy + material.uvTransform.zw;
  let c = textureSample(baseColorTex, sampAniso, uv) + textureSample(normalTex, sampAniso, uv) + textureSample(ormTex, sampAniso, uv);
  return encodeResolve(c.rgb * 0.1);
}

@fragment
fn fsDiagInstance(in: VSOut) -> @location(0) vec4f {
  let inst = instances[in.slot];
  return encodeResolve(vec3f(inst.lmST.x * 0.1));
}

@fragment
fn fsDiagGrad(in: VSOut) -> @location(0) vec4f {
  let uv = in.uv0 * material.uvTransform.xy + material.uvTransform.zw;
  let dx = dpdx(uv); let dy = dpdy(uv);
  let c = textureSampleGrad(baseColorTex, sampAniso, uv, dx, dy) + textureSampleGrad(normalTex, sampAniso, uv, dx, dy) + textureSampleGrad(ormTex, sampAniso, uv, dx, dy);
  return encodeResolve(c.rgb * 0.1);
}

@fragment
fn fsDiagGradFront(in: VSOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  let uv = in.uv0 * material.uvTransform.xy + material.uvTransform.zw;
  let dx = dpdx(uv); let dy = dpdy(uv);
  var c = textureSampleGrad(baseColorTex, sampAniso, uv, dx, dy) + textureSampleGrad(normalTex, sampAniso, uv, dx, dy) + textureSampleGrad(ormTex, sampAniso, uv, dx, dy);
  if (!front) { c = -c; }
  return encodeResolve(c.rgb * 0.1);
}

@fragment
fn fsDiagShadeAlbedo(in: VSOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  // The real shade() path; the albedo debug view returns right after texturing.
  return finalize(shade(in, front));
}

// Same as fsDiagGrad plus a register-heavy path that never executes at runtime
// (uniform-controlled): tests whether compiled register pressure alone costs.
@fragment
fn fsDiagGradHeavyDead(in: VSOut) -> @location(0) vec4f {
  let uv = in.uv0 * material.uvTransform.xy + material.uvTransform.zw;
  let dx = dpdx(uv); let dy = dpdy(uv);
  var c = textureSampleGrad(baseColorTex, sampAniso, uv, dx, dy) + textureSampleGrad(normalTex, sampAniso, uv, dx, dy) + textureSampleGrad(ormTex, sampAniso, uv, dx, dy);
  if (frame.debug.x == 999u) {
    var acc: array<vec4f, 32>;
    for (var i = 0u; i < 32u; i++) { acc[i] = textureSampleLevel(macroTex, sampAniso, uv * f32(i + 1u), 0.0) * f32(i); }
    for (var j = 0u; j < 8u; j++) { for (var i = 0u; i < 31u; i++) { acc[i] = acc[i] * acc[i + 1u] + acc[(i * 7u) % 32u]; } }
    for (var i = 0u; i < 32u; i++) { c += acc[i]; }
  }
  return encodeResolve(c.rgb * 0.1);
}

// Cheap live path, but (dead) references to every frame/material resource so
// the pipeline's resource set matches the full shader.
@fragment
fn fsDiagAllResources(in: VSOut) -> @location(0) vec4f {
  let uv = in.uv0 * material.uvTransform.xy + material.uvTransform.zw;
  let dx = dpdx(uv); let dy = dpdy(uv);
  var c = textureSampleGrad(baseColorTex, sampAniso, uv, dx, dy) + textureSampleGrad(normalTex, sampAniso, uv, dx, dy) + textureSampleGrad(ormTex, sampAniso, uv, dx, dy);
  if (frame.debug.x == 999u) {
    let inst = instances[in.slot];
    c += textureSampleLevel(detailAlbedoTex, sampAniso, uv, 0.0) + textureSampleLevel(detailNormalTex, sampAniso, uv, 0.0) + textureSampleLevel(macroTex, sampAniso, uv, 0.0);
    c += vec4f(textureSampleCompareLevel(shadowMap, sampShadow, uv, 0, 0.5));
    c += textureSampleLevel(envSpecular, sampClamp, vec3f(uv, 1.0), 0.0) + shSky[1] + textureSampleLevel(brdfLut, sampClamp, uv, 0.0);
    c += textureSampleLevel(lightmaps, sampClamp, uv, 0, 0.0) + lights[0].color + textureSampleLevel(skyViewLut, sampClamp, uv, 0.0);
    c += textureSampleLevel(transmittanceLut, sampClamp, uv, 0.0) + decals[0].tint + f32(decalCells[0]) + textureSampleLevel(decalAtlas, sampClamp, uv, 0, 0.0);
    c += textureSampleLevel(debugGridTex, sampClamp, uv, 0.0) + textureSampleLevel(cloudNoise, sampClamp, uv, 0.0) + inst.lmST;
  }
  return encodeResolve(c.rgb * 0.1);
}

// Step-wise copies of the start of shade() for bisection.
@fragment
fn fsDiagS1(in: VSOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  let inst = instances[in.slot];
  let wp = in.worldPos;
  let dpx = dpdx(wp);
  let dpy = dpdy(wp);
  let uv = in.uv0 * material.uvTransform.xy + material.uvTransform.zw;
  let uvDx = dpdx(uv);
  let uvDy = dpdy(uv);
  var Ng = normalize(in.normal);
  if (!front) { Ng = -Ng; }
  let bc = texGrad(baseColorTex, uv, uvDx, uvDy);
  let nt = decodeNormal(texGrad(normalTex, uv, uvDx, uvDy));
  let orm = texGrad(ormTex, uv, uvDx, uvDy);
  return vec4f(bc.rgb * (nt.z + orm.g) + (dpx + dpy) * 1e-6 + Ng * 1e-6 + inst.lmST.xyz * 1e-6, -1.0);
}

@fragment
fn fsDiagS2(in: VSOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  let uv = in.uv0 * material.uvTransform.xy + material.uvTransform.zw;
  let uvDx = dpdx(uv);
  let uvDy = dpdy(uv);
  let bc = texGrad(baseColorTex, uv, uvDx, uvDy);
  let nt = texGrad(normalTex, uv, uvDx, uvDy);
  let orm = texGrad(ormTex, uv, uvDx, uvDy);
  return vec4f(bc.rgb * (nt.z + orm.g), -1.0);
}

@fragment
fn fsDiagS3(in: VSOut) -> @location(0) vec4f {
  let uv = in.uv0 * material.uvTransform.xy + material.uvTransform.zw;
  let uvDx = dpdx(uv);
  let uvDy = dpdy(uv);
  let bc = texGrad(baseColorTex, uv, uvDx, uvDy);
  let nt = texGrad(normalTex, uv, uvDx, uvDy);
  let orm = texGrad(ormTex, uv, uvDx, uvDy);
  return encodeResolve(bc.rgb * (nt.z + orm.g) * 0.1);
}

// Per-sample shading detector: the full shade() (keeps the compiled shader real)
// but outputs the distance of the fragment position from the pixel centre:
// black = pixel-rate execution, bright = sample-rate execution.
@fragment
fn fsDiagSampleRate(in: VSOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  let o = shade(in, front);
  let f = abs(fract(in.pos.xy) - 0.5);
  return vec4f(vec3f(f.x + f.y) * 100.0 + o.color.rgb * 1e-7, -1.0);
}

// Same detector on the cheap texturing path only.
@fragment
fn fsDiagSampleRateCheap(in: VSOut) -> @location(0) vec4f {
  let uv = in.uv0 * material.uvTransform.xy + material.uvTransform.zw;
  let c = textureSample(baseColorTex, sampAniso, uv);
  let f = abs(fract(in.pos.xy) - 0.5);
  return vec4f(vec3f(f.x + f.y) * 100.0 + c.rgb * 1e-7, -1.0);
}
