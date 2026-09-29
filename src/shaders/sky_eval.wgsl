// Sky radiance evaluation shared by the sky pass and environment map generation.
// Requires these bindings in the including shader: frame, sampClamp, sampAniso,
// skyViewLut, transmittanceLut, cloudNoise.
#include "atmosphere"

fn viewHeightKm() -> f32 { return frame.atmo.x + frame.atmo.z; }

fn sunTransmittance(cosZ: f32) -> vec3f {
  let uv = transmittanceUv(frame.atmo.x, frame.atmo.y, viewHeightKm(), cosZ);
  return textureSampleLevel(transmittanceLut, sampClamp, uv, 0.0).rgb;
}

// Clear-sky atmosphere radiance (nits) for a world-space direction.
fn skyAtmosphere(d: vec3f) -> vec3f {
  let vh = viewHeightKm();
  let dh = vec2f(d.x, d.z);
  let sh = vec2f(frame.sunDir.x, frame.sunDir.z);
  let ld = length(dh);
  let ls = length(sh);
  var lightViewCos = 1.0;
  if (ld > 1e-5 && ls > 1e-5) { lightViewCos = dot(dh, sh) / (ld * ls); }
  // Never look into the planet: the world geometry provides the ground.
  let cosZ = max(d.y, -0.004);
  let hitGround = raySphere(vec3f(0.0, vh, 0.0), normalize(vec3f(ld, cosZ, 0.0)), frame.atmo.x) >= 0.0;
  let uv = skyViewUv(frame.atmo.x, vh, cosZ, lightViewCos, hitGround);
  return textureSampleLevel(skyViewLut, sampClamp, uv, 0.0).rgb * frame.sky.x * frame.exposure.z;
}

fn sunIlluminanceAtCloud() -> vec3f {
  return frame.sky.x * sunTransmittance(frame.sunDir.y) * frame.exposure.z;
}

fn cloudBase(p: vec2f, lod: f32) -> f32 {
  let a = textureSampleLevel(cloudNoise, sampAniso, p * (1.0 / 9000.0), lod).r;
  let b = textureSampleLevel(cloudNoise, sampAniso, p * (1.0 / 2600.0) + vec2f(0.37, 0.71), lod).g;
  let c = textureSampleLevel(cloudNoise, sampAniso, p * (1.0 / 900.0) + vec2f(0.13, 0.29), lod).b;
  return a * 0.6 + b * 0.3 + c * 0.1;
}

// Returns premultiplied cloud radiance (rgb) and opacity (a) for direction d.
// `pixelAngle` is the angular size of the pixel (rad) for mip selection.
fn cloudLayer(d: vec3f, pixelAngle: f32) -> vec4f {
  let cover = frame.clouds.x;
  if (cover <= 0.001) { return vec4f(0.0); }
  let overcastW = smoothstep(0.75, 1.0, cover);
  let up = max(d.y, 0.0);
  let altitude = frame.clouds.y;
  // Intersect a flat cloud plane; clamp the grazing distance to keep it finite.
  let dist = altitude / max(up, 0.035);
  let p = d.xz * dist + frame.clouds.zw;
  let footprint = dist * pixelAngle / max(up, 0.035);
  let lod = clamp(log2(max(footprint / (9000.0 / 256.0), 1.0)), 0.0, 8.0);
  let base = cloudBase(p, lod);
  let sharp = max(frame.sky.w, 0.05);
  let density = saturate((base - (1.0 - cover)) / sharp + cover * cover * 0.35);
  // One light-march step toward the sun for self shadowing.
  let lp = p + normalize(frame.sunDir.xz + vec2f(1e-4)) * 350.0;
  let ld = saturate((cloudBase(lp, lod) - (1.0 - cover)) / sharp + cover * cover * 0.35);
  let selfShadow = exp(-ld * 2.2 * frame.overcast.w);
  let cosT = dot(d, frame.sunDir.xyz);
  let phase = mix(1.0 / (4.0 * PI), hgPhase(0.55, cosT), 0.6);
  let sunL = sunIlluminanceAtCloud() * phase * selfShadow * 0.9;
  let zenith = skyAtmosphere(vec3f(0.0, 1.0, 0.0));
  let horizon = skyAtmosphere(normalize(vec3f(frame.sunDir.x, 0.05, frame.sunDir.z)));
  let ambient = (zenith * 0.7 + horizon * 0.3) * (1.1 - 0.5 * density);
  var cloudL = sunL * (1.0 - 0.4 * density) + ambient;
  // Fully overcast: CIE overcast luminance distribution with texture variation.
  let variation = 0.72 + 0.56 * base;
  let overcastL = frame.overcast.rgb * (1.0 + 2.0 * up) / 3.0 * variation * frame.exposure.z;
  cloudL = mix(cloudL, overcastL, overcastW);
  let horizonFade = mix(smoothstep(0.0, 0.12, up), 1.0, overcastW);
  let alpha = saturate(density * horizonFade);
  return vec4f(cloudL * alpha, alpha);
}

fn sunDiskRadiance(d: vec3f, pixelAngle: f32) -> vec3f {
  let cosR = frame.sunDir.w;
  let c = dot(d, frame.sunDir.xyz);
  let edge = smoothstep(cosR - pixelAngle * 0.5 * sqrt(1.0 - cosR * cosR), cosR, c);
  if (edge <= 0.0) { return vec3f(0.0); }
  let sinR = sqrt(max(1.0 - cosR * cosR, 1e-8));
  let r = saturate(sqrt(max(0.0, 1.0 - c * c)) / sinR);
  let mu = sqrt(max(0.0, 1.0 - r * r));
  let limb = 1.0 - 0.6 * (1.0 - mu);
  let solidAngle = 2.0 * PI * (1.0 - cosR);
  return frame.sunColor.rgb / solidAngle * limb * edge * frame.sunColor.w;
}

// Full sky radiance (nits, not pre-exposed). Sun disk optional (excluded from
// environment maps since direct sun is evaluated analytically).
fn skyRadiance(d: vec3f, withSun: bool, pixelAngle: f32) -> vec3f {
  var L = skyAtmosphere(d);
  if (withSun) { L += sunDiskRadiance(d, pixelAngle); }
  let cl = cloudLayer(d, pixelAngle);
  L = L * (1.0 - cl.a) + cl.rgb;
  return L;
}
