// Compute passes that build the atmosphere LUTs. Run whenever the sun or the
// atmosphere parameters change (cheap: ~0.1 ms total).
#include "atmosphere"

struct AtmoUniform {
  bottom: f32,
  top: f32,
  mieScale: f32,
  cameraAltitude: f32,
  sunDir: vec4f,       // world space, toward sun
  groundAlbedo: vec4f,
};

@group(0) @binding(0) var<uniform> U: AtmoUniform;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var transLut: texture_2d<f32>;
@group(0) @binding(3) var msLut: texture_2d<f32>;
@group(1) @binding(0) var outTex: texture_storage_2d<rgba16float, write>;

fn getTransmittance(viewHeight: f32, cosZ: f32) -> vec3f {
  let uv = transmittanceUv(U.bottom, U.top, viewHeight, cosZ);
  return textureSampleLevel(transLut, samp, uv, 0.0).rgb;
}

fn getMultiScattering(viewHeight: f32, cosSunZ: f32) -> vec3f {
  var uv = vec2f(saturate(cosSunZ * 0.5 + 0.5), saturate((viewHeight - U.bottom) / (U.top - U.bottom)));
  uv = unitToSubUvs(uv, vec2f(MULTISCAT_RES));
  return textureSampleLevel(msLut, samp, uv, 0.0).rgb;
}

@compute @workgroup_size(8, 8)
fn transmittanceMain(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= u32(TRANSMITTANCE_W) || id.y >= u32(TRANSMITTANCE_H)) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(TRANSMITTANCE_W, TRANSMITTANCE_H);
  let p = transmittanceParams(U.bottom, U.top, uv);
  let ro = vec3f(0.0, p.x, 0.0);
  let rd = vec3f(sqrt(max(0.0, 1.0 - p.y * p.y)), p.y, 0.0);
  let tTop = raySphere(ro, rd, U.top);
  let steps = 40;
  let dt = max(tTop, 0.0) / f32(steps);
  var od = vec3f(0.0);
  for (var i = 0; i < steps; i++) {
    let t = (f32(i) + 0.5) * dt;
    let h = length(ro + rd * t) - U.bottom;
    od += sampleMedium(h, U.mieScale).extinction * dt;
  }
  textureStore(outTex, id.xy, vec4f(exp(-od), 1.0));
}

struct ScatterResult { L: vec3f, fms: vec3f };

// Integrates single scattering (+ optional multiple scattering term) along a ray.
fn integrate(ro: vec3f, rd: vec3f, sunDir: vec3f, steps: i32, uniformPhase: bool, useMs: bool, addGround: bool) -> ScatterResult {
  var res: ScatterResult;
  res.L = vec3f(0.0);
  res.fms = vec3f(0.0);
  let tBottom = raySphere(ro, rd, U.bottom);
  let tTop = raySphere(ro, rd, U.top);
  var tMax = tTop;
  if (tBottom > 0.0) { tMax = tBottom; }
  if (tMax <= 0.0) { return res; }
  tMax = min(tMax, 9000.0);
  let cosTheta = dot(rd, sunDir);
  let phR = rayleighPhase(cosTheta);
  let phM = miePhase(MIE_G, cosTheta);
  let iso = 1.0 / (4.0 * PI);
  var throughput = vec3f(1.0);
  var tPrev = 0.0;
  for (var i = 0; i < steps; i++) {
    // Quadratic step distribution: denser near the viewer.
    let s0 = (f32(i) + 0.3) / f32(steps);
    let t = tMax * s0 * s0;
    let dt = t - tPrev;
    tPrev = t;
    let p = ro + rd * t;
    let r = length(p);
    let up = p / r;
    let h = r - U.bottom;
    let m = sampleMedium(h, U.mieScale);
    let sunCos = dot(sunDir, up);
    let tSun = getTransmittance(r, sunCos);
    // Earth shadow.
    let shadowed = raySphere(p + up * 1e-3, sunDir, U.bottom) > 0.0;
    let vis = select(1.0, 0.0, shadowed);
    var phaseScat: vec3f;
    if (uniformPhase) {
      phaseScat = m.scattering * iso;
    } else {
      phaseScat = m.rayleighScat * phR + vec3f(m.mieScat * phM);
    }
    var ms = vec3f(0.0);
    if (useMs) { ms = getMultiScattering(r, sunCos) * m.scattering; }
    let S = vis * tSun * phaseScat + ms;
    let stepT = exp(-m.extinction * dt);
    let ext = max(m.extinction, vec3f(1e-7));
    res.L += throughput * (S - S * stepT) / ext;
    res.fms += throughput * (m.scattering - m.scattering * stepT) / ext;
    throughput *= stepT;
  }
  if (addGround && tBottom > 0.0) {
    let p = ro + rd * tBottom;
    let up = normalize(p);
    let sunCos = dot(sunDir, up);
    let tSun = getTransmittance(U.bottom, sunCos);
    res.L += throughput * tSun * saturate(sunCos) * U.groundAlbedo.rgb / PI;
  }
  return res;
}

@compute @workgroup_size(8, 8)
fn multiScatMain(@builtin(global_invocation_id) id: vec3u) {
  let res = u32(MULTISCAT_RES);
  if (id.x >= res || id.y >= res) { return; }
  var uv = (vec2f(id.xy) + 0.5) / MULTISCAT_RES;
  uv = subUvsToUnit(uv, vec2f(MULTISCAT_RES));
  let cosSunZ = uv.x * 2.0 - 1.0;
  let viewHeight = U.bottom + saturate(uv.y + 1e-3) * (U.top - U.bottom - 0.01);
  let sunDir = vec3f(0.0, cosSunZ, sqrt(max(0.0, 1.0 - cosSunZ * cosSunZ)));
  let ro = vec3f(0.0, viewHeight, 0.0);
  var L2 = vec3f(0.0);
  var fms = vec3f(0.0);
  let N = 64;
  for (var i = 0; i < N; i++) {
    // Fibonacci sphere directions.
    let fi = f32(i) + 0.5;
    let z = 1.0 - 2.0 * fi / f32(N);
    let rxy = sqrt(max(0.0, 1.0 - z * z));
    let phi = fi * 2.39996323;
    let rd = vec3f(rxy * cos(phi), z, rxy * sin(phi));
    let r = integrate(ro, rd, sunDir, 20, true, false, true);
    L2 += r.L;
    fms += r.fms;
  }
  L2 /= f32(N);
  fms /= f32(N);
  // fms was integrated with unit scattering; the isotropic phase is 1/(4pi) but the
  // sphere integral multiplies by 4pi, cancelling out.
  let psi = L2 / (1.0 - min(fms, vec3f(0.99)));
  textureStore(outTex, id.xy, vec4f(psi, 1.0));
}

@compute @workgroup_size(8, 8)
fn skyViewMain(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= u32(SKYVIEW_W) || id.y >= u32(SKYVIEW_H)) { return; }
  var uv = (vec2f(id.xy) + 0.5) / vec2f(SKYVIEW_W, SKYVIEW_H);
  uv = subUvsToUnit(uv, vec2f(SKYVIEW_W, SKYVIEW_H));
  let viewHeight = U.bottom + U.cameraAltitude;
  let vHorizon = sqrt(max(0.0, viewHeight * viewHeight - U.bottom * U.bottom));
  let cosBeta = vHorizon / viewHeight;
  let beta = acos(cosBeta);
  let zha = PI - beta;
  var viewZenithCos: f32;
  if (uv.y < 0.5) {
    var c = 2.0 * uv.y;
    c = 1.0 - c;
    c = c * c;
    c = 1.0 - c;
    viewZenithCos = cos(zha * c);
  } else {
    var c = uv.y * 2.0 - 1.0;
    c = c * c;
    viewZenithCos = cos(zha + beta * c);
  }
  let cx = uv.x * uv.x;
  let lightViewCos = -(cx * 2.0 - 1.0);
  let sunCosZ = U.sunDir.y;
  let sunDir = vec3f(0.0, sunCosZ, sqrt(max(0.0, 1.0 - sunCosZ * sunCosZ)));
  let sinV = sqrt(max(0.0, 1.0 - viewZenithCos * viewZenithCos));
  let sinA = sqrt(max(0.0, 1.0 - lightViewCos * lightViewCos));
  let rd = vec3f(sinV * sinA, viewZenithCos, sinV * lightViewCos);
  let ro = vec3f(0.0, viewHeight, 0.0);
  let r = integrate(ro, rd, sunDir, 32, false, true, false);
  textureStore(outTex, id.xy, vec4f(r.L, 1.0));
}
