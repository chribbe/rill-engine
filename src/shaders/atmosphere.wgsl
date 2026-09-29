// Physically based atmosphere (after Hillaire 2020, "A Scalable and Production Ready
// Sky and Atmosphere Rendering Technique"). Distances in km. LUT values are
// relative to unit sun illuminance; callers multiply by the TOA sun illuminance.
#include "common"

struct AtmosphereParams {
  bottom: f32,
  top: f32,
  mieScale: f32,
  pad: f32,
};

const RAYLEIGH_SCATTERING: vec3f = vec3f(5.802e-3, 13.558e-3, 33.1e-3);
const MIE_SCATTERING: f32 = 3.996e-3;
const MIE_EXTINCTION: f32 = 4.44e-3;
const OZONE_ABSORPTION: vec3f = vec3f(0.650e-3, 1.881e-3, 0.085e-3);
const MIE_G: f32 = 0.8;

const TRANSMITTANCE_W: f32 = 256.0;
const TRANSMITTANCE_H: f32 = 64.0;
const MULTISCAT_RES: f32 = 32.0;
const SKYVIEW_W: f32 = 192.0;
const SKYVIEW_H: f32 = 108.0;

struct Medium {
  scattering: vec3f,
  extinction: vec3f,
  rayleighScat: vec3f,
  mieScat: f32,
};

fn sampleMedium(h: f32, mieScale: f32) -> Medium {
  let dR = exp(-h / 8.0);
  let dM = exp(-h / 1.2) * mieScale;
  let dO = max(0.0, 1.0 - abs(h - 25.0) / 15.0);
  var m: Medium;
  m.rayleighScat = RAYLEIGH_SCATTERING * dR;
  m.mieScat = MIE_SCATTERING * dM;
  m.scattering = m.rayleighScat + vec3f(m.mieScat);
  m.extinction = m.rayleighScat + vec3f(MIE_EXTINCTION * dM) + OZONE_ABSORPTION * dO;
  return m;
}

fn rayleighPhase(c: f32) -> f32 { return 3.0 / (16.0 * PI) * (1.0 + c * c); }

fn hgPhase(g: f32, c: f32) -> f32 {
  let g2 = g * g;
  let d = 1.0 + g2 - 2.0 * g * c;
  return (1.0 - g2) / (4.0 * PI * d * sqrt(max(d, 1e-5)));
}

// Cornette-Shanks, better forward lobe for Mie.
fn miePhase(g: f32, c: f32) -> f32 {
  let g2 = g * g;
  let k = 3.0 / (8.0 * PI) * (1.0 - g2) / (2.0 + g2);
  return k * (1.0 + c * c) / pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5);
}

// Returns distance to the nearest intersection with a sphere at the origin, or -1.
fn raySphere(ro: vec3f, rd: vec3f, r: f32) -> f32 {
  let b = dot(ro, rd);
  let c = dot(ro, ro) - r * r;
  let d = b * b - c;
  if (d < 0.0) { return -1.0; }
  let s = sqrt(d);
  let t0 = -b - s;
  let t1 = -b + s;
  if (t0 > 0.0) { return t0; }
  if (t1 > 0.0) { return t1; }
  return -1.0;
}

fn transmittanceUv(bottom: f32, top: f32, viewHeight: f32, viewZenithCos: f32) -> vec2f {
  let H = sqrt(max(0.0, top * top - bottom * bottom));
  let rho = sqrt(max(0.0, viewHeight * viewHeight - bottom * bottom));
  let disc = viewHeight * viewHeight * (viewZenithCos * viewZenithCos - 1.0) + top * top;
  let d = max(0.0, -viewHeight * viewZenithCos + sqrt(max(disc, 0.0)));
  let dMin = top - viewHeight;
  let dMax = rho + H;
  let xMu = (d - dMin) / (dMax - dMin);
  let xR = rho / H;
  return vec2f(xMu, xR);
}

fn transmittanceParams(bottom: f32, top: f32, uv: vec2f) -> vec2f {
  let H = sqrt(max(0.0, top * top - bottom * bottom));
  let rho = H * uv.y;
  let viewHeight = sqrt(rho * rho + bottom * bottom);
  let dMin = top - viewHeight;
  let dMax = rho + H;
  let d = dMin + uv.x * (dMax - dMin);
  var cosZ = 1.0;
  if (d > 0.0) { cosZ = (H * H - rho * rho - d * d) / (2.0 * viewHeight * d); }
  return vec2f(viewHeight, clamp(cosZ, -1.0, 1.0));
}

fn subUvsToUnit(uv: vec2f, res: vec2f) -> vec2f { return (uv - 0.5 / res) * (res / (res - 1.0)); }
fn unitToSubUvs(uv: vec2f, res: vec2f) -> vec2f { return (uv + 0.5 / res) * (res / (res + 1.0)); }

// Sky-view LUT parameterisation: x = azimuth relative to sun, y = zenith angle with
// extra resolution at the horizon.
fn skyViewUv(bottom: f32, viewHeight: f32, viewZenithCos: f32, lightViewCos: f32, intersectGround: bool) -> vec2f {
  let vHorizon = sqrt(max(0.0, viewHeight * viewHeight - bottom * bottom));
  let cosBeta = vHorizon / viewHeight;
  let beta = acos(clamp(cosBeta, -1.0, 1.0));
  let zenithHorizonAngle = PI - beta;
  var uv: vec2f;
  if (!intersectGround) {
    var coord = acos(clamp(viewZenithCos, -1.0, 1.0)) / zenithHorizonAngle;
    coord = 1.0 - coord;
    coord = sqrt(max(coord, 0.0));
    coord = 1.0 - coord;
    uv.y = coord * 0.5;
  } else {
    var coord = (acos(clamp(viewZenithCos, -1.0, 1.0)) - zenithHorizonAngle) / beta;
    coord = sqrt(max(coord, 0.0));
    uv.y = coord * 0.5 + 0.5;
  }
  var cx = -lightViewCos * 0.5 + 0.5;
  cx = sqrt(max(cx, 0.0));
  uv.x = cx;
  return unitToSubUvs(uv, vec2f(SKYVIEW_W, SKYVIEW_H));
}
