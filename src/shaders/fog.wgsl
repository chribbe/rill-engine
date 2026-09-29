// Analytic exponential height fog + atmospheric haze.
//
// Two participating media are integrated along the view ray:
//  * height fog: density(h) = d0 * exp(-falloff * (h - h0)); lit by the sky
//    ambient (SH average) and the sun through a Henyey-Greenstein phase lobe.
//  * haze (aerial perspective): thin, slowly decaying with height. Its
//    in-scattered colour is the horizon sky itself, so distant geometry fades
//    exactly into the sky behind it.
// Both are combined into one transmittance + in-scatter pair.
#include "atmosphere"

struct FogResult {
  transmittance: f32,
  inscatter: vec3f,
};

fn fogOpticalDepth(camY: f32, dirY: f32, dist: f32, density: f32, h0: f32, falloff: f32) -> f32 {
  let k = falloff * dirY;
  let base = density * exp(-falloff * (camY - h0));
  if (abs(k) < 1e-5) { return base * dist; }
  return base * (1.0 - exp(-k * dist)) / k;
}

fn hazeColor(d: vec3f) -> vec3f {
  let hd = normalize(vec3f(d.x, max(d.y, 0.0) * 0.5 + 0.02, d.z));
  // Prefiltered env at a blurry level: includes clouds/overcast, sky intensity.
  return textureSampleLevel(envSpecular, sampClamp, hd, 3.0).rgb;
}

// `dist` may be very large for the sky (use isSky = true).
fn computeFog(camPos: vec3f, dir: vec3f, distIn: f32, isSky: bool) -> FogResult {
  var r: FogResult;
  r.transmittance = 1.0;
  r.inscatter = vec3f(0.0);
  if (!hasFlag(F_FOG)) { return r; }
  let start = frame.fog1.y;
  let dist = max(distIn - start, 0.0);
  let camY = camPos.y + dir.y * min(start, distIn);
  var odFog = 0.0;
  if (frame.fog0.x > 0.0) {
    if (isSky) {
      // Integral to infinity converges only for rays going up.
      let k = frame.fog0.z * dir.y;
      let base = frame.fog0.x * exp(-frame.fog0.z * (camY - frame.fog0.y));
      odFog = select(1e4, base / k, k > 1e-4);
      // Keep the zenith from being fully fogged for thin fog layers.
      odFog = min(odFog, 1e4);
    } else {
      odFog = fogOpticalDepth(camY, dir.y, dist, frame.fog0.x, frame.fog0.y, frame.fog0.z);
    }
  }
  var odHaze = 0.0;
  if (!isSky && frame.fog0.w > 0.0) {
    odHaze = fogOpticalDepth(camY, dir.y, dist, frame.fog0.w, 0.0, 1.0 / 1200.0);
  }
  let total = odFog + odHaze;
  if (total <= 0.0) { return r; }
  var T = exp(-total);
  T = max(T, 1.0 - frame.fog1.z);
  let cosT = dot(dir, frame.sunDir.xyz);
  let g = frame.fog1.x;
  let phase = hgPhase(g, cosT) * 0.7 + 0.3 / (4.0 * PI);
  // Fog lit by the whole sky (sphere-average radiance) and the sun.
  let ambient = shSky[9].rgb * 1.15;
  let fogIn = frame.fogColor.rgb * (ambient + frame.sunColor.rgb * phase * frame.fogColor.w);
  let hazeIn = hazeColor(dir) + frame.sunColor.rgb * phase * 0.02;
  let inC = (odFog * fogIn + odHaze * hazeIn) / total;
  r.transmittance = T;
  r.inscatter = inC * (1.0 - T);
  return r;
}

// Analytic single scattering of point lights along the view segment in a
// homogeneous medium ("airlight"): integral of 1/(h^2 + t^2) = atan/h.
fn fogLightScatter(camPos: vec3f, dir: vec3f, dist: f32) -> vec3f {
  if (!hasFlag(F_FOG) || !hasFlag(F_LOCAL_LIGHTS) || frame.fog0.x <= 0.0) { return vec3f(0.0); }
  var acc = vec3f(0.0);
  let n = frame.debug.z;
  let sigma = frame.fog0.x * exp(-frame.fog0.z * max(camPos.y - frame.fog0.y, -20.0));
  for (var i = 0u; i < n; i++) {
    let l = lights[i];
    if (l.color.w <= 0.0) { continue; }
    let toL = l.posRange.xyz - camPos;
    let tc = dot(toL, dir);
    let h2 = max(dot(toL, toL) - tc * tc, 0.04);
    let h = sqrt(h2);
    let t1 = dist;
    let integ = (atan((t1 - tc) / h) - atan(-tc / h)) / h;
    // Spot lights only light the medium inside their cone: evaluate the cone at
    // the point of the (clamped) ray segment closest to the light.
    var cone = 1.0;
    if (l.params.y > 0.5) {
      let pc = camPos + dir * clamp(tc, 0.0, dist);
      let toP = normalize(pc - l.posRange.xyz);
      cone = smoothstep(l.dirCone.w - 0.15, l.params.x, dot(toP, l.dirCone.xyz));
    }
    acc += l.color.rgb * l.color.w * integ * cone * (1.0 / (4.0 * PI));
  }
  return acc * sigma * frame.fogColor.rgb;
}
