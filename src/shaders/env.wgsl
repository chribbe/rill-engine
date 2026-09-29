// Environment lighting generation: procedural sky -> cubemap -> GGX-prefiltered
// specular cube + L2 spherical harmonics irradiance. Also the split-sum BRDF LUT.
#include "common"

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var sampClamp: sampler;
@group(0) @binding(2) var sampAniso: sampler;
@group(0) @binding(3) var skyViewLut: texture_2d<f32>;
@group(0) @binding(4) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(5) var cloudNoise: texture_2d<f32>;

#include "sky_eval"

fn cubeDir(face: u32, uv: vec2f) -> vec3f {
  let u = uv.x * 2.0 - 1.0;
  let v = uv.y * 2.0 - 1.0;
  var d: vec3f;
  switch (face) {
    case 0u: { d = vec3f(1.0, -v, -u); }
    case 1u: { d = vec3f(-1.0, -v, u); }
    case 2u: { d = vec3f(u, 1.0, v); }
    case 3u: { d = vec3f(u, -1.0, -v); }
    case 4u: { d = vec3f(u, -v, 1.0); }
    default: { d = vec3f(-u, -v, -1.0); }
  }
  return normalize(d);
}

// ---------------------------------------------------------------- sky -> cube
@group(1) @binding(0) var skyOut: texture_storage_2d_array<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn skyCubeMain(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(skyOut).x;
  if (id.x >= size || id.y >= size) { return; }
  let d = cubeDir(id.z, (vec2f(id.xy) + 0.5) / f32(size));
  let pixelAngle = 2.0 / f32(size);
  var L = skyRadiance(normalize(vec3f(d.x, max(d.y, 0.0), d.z)), false, pixelAngle);
  // Lower hemisphere: diffuse ground lit by sun and sky, fading from the horizon haze.
  if (d.y < 0.0) {
    let sunE = frame.sunColor.rgb * max(frame.sunDir.y, 0.0);
    let skyE = skyAtmosphere(vec3f(0.0, 1.0, 0.0)) * PI * 0.8;
    let cover = frame.clouds.x;
    let overcastE = frame.overcast.rgb * frame.exposure.z * PI * 0.78;
    let groundL = frame.ground.rgb * (sunE + mix(skyE, overcastE, smoothstep(0.75, 1.0, cover))) / PI;
    L = mix(L, groundL, smoothstep(0.0, 0.08, -d.y));
  }
  textureStore(skyOut, vec2u(id.xy), id.z, vec4f(L, 1.0));
}

// ---------------------------------------------------------------- downsample
@group(1) @binding(1) var downSrc: texture_2d_array<f32>;
@group(1) @binding(2) var downDst: texture_storage_2d_array<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn downsampleMain(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(downDst).x;
  if (id.x >= size || id.y >= size) { return; }
  let p = vec2i(id.xy) * 2;
  let f = i32(id.z);
  let c = textureLoad(downSrc, p, f, 0) + textureLoad(downSrc, p + vec2i(1, 0), f, 0)
        + textureLoad(downSrc, p + vec2i(0, 1), f, 0) + textureLoad(downSrc, p + vec2i(1, 1), f, 0);
  textureStore(downDst, vec2u(id.xy), id.z, c * 0.25);
}

// ---------------------------------------------------------------- GGX prefilter
struct PrefilterParams { roughness: f32, srcSize: f32, sampleCount: u32, pad: u32 };
@group(1) @binding(3) var<uniform> P: PrefilterParams;
@group(1) @binding(4) var srcCube: texture_cube<f32>;
@group(1) @binding(5) var prefOut: texture_storage_2d_array<rgba16float, write>;

fn radicalInverse(bitsIn: u32) -> f32 {
  var bits = bitsIn;
  bits = (bits << 16u) | (bits >> 16u);
  bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
  bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
  bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
  bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
  return f32(bits) * 2.3283064365386963e-10;
}

fn importanceSampleGGX(xi: vec2f, N: vec3f, a: f32) -> vec3f {
  let phi = 2.0 * PI * xi.x;
  let cosT = sqrt((1.0 - xi.y) / (1.0 + (a * a - 1.0) * xi.y));
  let sinT = sqrt(1.0 - cosT * cosT);
  let H = vec3f(sinT * cos(phi), sinT * sin(phi), cosT);
  let up = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(N.z) < 0.999);
  let T = normalize(cross(up, N));
  let B = cross(N, T);
  return normalize(T * H.x + B * H.y + N * H.z);
}

@compute @workgroup_size(8, 8, 1)
fn prefilterMain(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(prefOut).x;
  if (id.x >= size || id.y >= size) { return; }
  let N = cubeDir(id.z, (vec2f(id.xy) + 0.5) / f32(size));
  let a = P.roughness * P.roughness;
  var acc = vec3f(0.0);
  var wsum = 0.0;
  let texelSolid = 4.0 * PI / (6.0 * P.srcSize * P.srcSize);
  for (var i = 0u; i < P.sampleCount; i++) {
    let xi = vec2f(f32(i) / f32(P.sampleCount), radicalInverse(i));
    let H = importanceSampleGGX(xi, N, a);
    let L = normalize(2.0 * dot(N, H) * H - N);
    let NoL = dot(N, L);
    if (NoL > 0.0) {
      // Filtered importance sampling (Krivanek & Colbert).
      let NoH = saturate(dot(N, H));
      let a2 = a * a;
      let dd = (NoH * a2 - NoH) * NoH + 1.0;
      let D = a2 / (PI * dd * dd);
      let pdf = D * 0.25;
      let sampleSolid = 1.0 / (f32(P.sampleCount) * pdf + 1e-4);
      let lod = clamp(0.5 * log2(sampleSolid / texelSolid) + 1.0, 0.0, 7.0);
      acc += textureSampleLevel(srcCube, sampClamp, L, lod).rgb * NoL;
      wsum += NoL;
    }
  }
  textureStore(prefOut, vec2u(id.xy), id.z, vec4f(acc / max(wsum, 1e-4), 1.0));
}

// ---------------------------------------------------------------- SH projection
// Single workgroup; reads a 16x16 mip of the sky cube. Output coefficients are
// pre-convolved with the clamped cosine lobe and divided by PI, so evaluating
// them yields irradiance / PI (i.e. outgoing radiance of a white Lambertian).
@group(1) @binding(6) var shSrc: texture_2d_array<f32>;
@group(1) @binding(7) var<storage, read_write> shOut: array<vec4f, 12>;

var<workgroup> shAcc: array<array<vec3f, 9>, 64>;
var<workgroup> avgAcc: array<vec4f, 64>;

@compute @workgroup_size(64)
fn shMain(@builtin(local_invocation_index) li: u32) {
  let size = textureDimensions(shSrc).x;
  let total = size * size * 6u;
  var c: array<vec3f, 9>;
  for (var k = 0u; k < 9u; k++) { c[k] = vec3f(0.0); }
  var avg = vec4f(0.0);
  for (var i = li; i < total; i += 64u) {
    let face = i / (size * size);
    let rem = i % (size * size);
    let x = rem % size;
    let y = rem / size;
    let uv = (vec2f(f32(x), f32(y)) + 0.5) / f32(size);
    let d = cubeDir(face, uv);
    let u = uv * 2.0 - 1.0;
    let dw = 4.0 / (f32(size * size) * pow(1.0 + dot(u, u), 1.5));
    let L = textureLoad(shSrc, vec2i(i32(x), i32(y)), i32(face), 0).rgb * dw;
    c[0] += L * 0.282095;
    c[1] += L * 0.488603 * d.y;
    c[2] += L * 0.488603 * d.z;
    c[3] += L * 0.488603 * d.x;
    c[4] += L * 1.092548 * d.x * d.y;
    c[5] += L * 1.092548 * d.y * d.z;
    c[6] += L * 0.315392 * (3.0 * d.z * d.z - 1.0);
    c[7] += L * 1.092548 * d.x * d.z;
    c[8] += L * 0.546274 * (d.x * d.x - d.y * d.y);
    // Horizon band average (|y| < 0.15), used as fog/haze colour reference.
    if (abs(d.y) < 0.15 && d.y >= -0.02) { avg += vec4f(L, dw); }
  }
  for (var k = 0u; k < 9u; k++) { shAcc[li][k] = c[k]; }
  avgAcc[li] = avg;
  workgroupBarrier();
  var stride = 32u;
  loop {
    if (li < stride) {
      for (var k = 0u; k < 9u; k++) { shAcc[li][k] += shAcc[li + stride][k]; }
      avgAcc[li] += avgAcc[li + stride];
    }
    workgroupBarrier();
    if (stride == 1u) { break; }
    stride = stride / 2u;
  }
  if (li == 0u) {
    // Cosine-lobe convolution / PI: band factors 1, 2/3, 1/4.
    let band = array<f32, 9>(1.0, 0.666667, 0.666667, 0.666667, 0.25, 0.25, 0.25, 0.25, 0.25);
    for (var k = 0u; k < 9u; k++) { shOut[k] = vec4f(shAcc[0][k] * band[k], 0.0); }
    // [9] = average radiance over the sphere (4pi): L00 * Y00 * 4pi / (4pi) ...
    shOut[9] = vec4f(shAcc[0][0] * 0.282095, 0.0);
    // [10] = horizon band average radiance
    let a = avgAcc[0];
    shOut[10] = vec4f(a.rgb / max(a.w, 1e-6), 0.0);
    shOut[11] = vec4f(0.0);
  }
}

// ---------------------------------------------------------------- BRDF LUT
@group(1) @binding(8) var brdfOut: texture_storage_2d<rgba16float, write>;

fn vSmithCorrelated(NoV: f32, NoL: f32, a: f32) -> f32 {
  let a2 = a * a;
  let gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  let gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / (gv + gl);
}

@compute @workgroup_size(8, 8)
fn brdfLutMain(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(brdfOut);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let NoV = max((f32(id.x) + 0.5) / f32(size.x), 1e-3);
  let rough = (f32(id.y) + 0.5) / f32(size.y);
  let a = rough * rough;
  let V = vec3f(sqrt(1.0 - NoV * NoV), 0.0, NoV);
  var A = 0.0;
  var B = 0.0;
  let n = 512u;
  for (var i = 0u; i < n; i++) {
    let xi = vec2f(f32(i) / f32(n), radicalInverse(i));
    let H = importanceSampleGGX(xi, vec3f(0.0, 0.0, 1.0), a);
    let L = normalize(2.0 * dot(V, H) * H - V);
    let NoL = saturate(L.z);
    let NoH = saturate(H.z);
    let VoH = saturate(dot(V, H));
    if (NoL > 0.0) {
      let Vis = vSmithCorrelated(NoV, NoL, a) * 4.0 * NoL * VoH / max(NoH, 1e-5);
      let Fc = pow(1.0 - VoH, 5.0);
      A += (1.0 - Fc) * Vis;
      B += Fc * Vis;
    }
  }
  textureStore(brdfOut, vec2u(id.xy), vec4f(A / f32(n), B / f32(n), 0.0, 1.0));
}
