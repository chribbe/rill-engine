// Microfacet BRDF (GGX / height-correlated Smith / Schlick) + SH irradiance.

fn D_GGX(NoH: f32, a: f32) -> f32 {
  let a2 = a * a;
  let f = (NoH * a2 - NoH) * NoH + 1.0;
  return a2 / (PI * f * f);
}

fn V_SmithGGX(NoV: f32, NoL: f32, a: f32) -> f32 {
  let a2 = a * a;
  let gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  let gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-6);
}

fn F_Schlick(f0: vec3f, VoH: f32) -> vec3f {
  let f = pow(1.0 - VoH, 5.0);
  return f0 + (vec3f(1.0) - f0) * f;
}

// Evaluates the sky SH stored as irradiance/PI (radiance of a white Lambertian).
fn shEval(n: vec3f) -> vec3f {
  var r = shSky[0].rgb * 0.282095;
  r += shSky[1].rgb * 0.488603 * n.y;
  r += shSky[2].rgb * 0.488603 * n.z;
  r += shSky[3].rgb * 0.488603 * n.x;
  r += shSky[4].rgb * 1.092548 * n.x * n.y;
  r += shSky[5].rgb * 1.092548 * n.y * n.z;
  r += shSky[6].rgb * 0.315392 * (3.0 * n.z * n.z - 1.0);
  r += shSky[7].rgb * 1.092548 * n.x * n.z;
  r += shSky[8].rgb * 0.546274 * (n.x * n.x - n.y * n.y);
  return max(r, vec3f(0.0));
}

// Stable geometric specular anti-aliasing (Tokuyoshi & Kaplanyan 2019).
// Widens the NDF where the shading normal varies quickly across a pixel.
fn specularAA(N: vec3f, a: f32, strength: f32) -> f32 {
  let du = dpdx(N);
  let dv = dpdy(N);
  let variance = 0.25 * (dot(du, du) + dot(dv, dv)) * strength;
  let kernel = min(2.0 * variance, 0.18);
  return sqrt(saturate(a * a + kernel));
}

// Specular occlusion from ambient occlusion (Lagarde & de Rousiers 2014).
fn specOcclusionFromAO(NoV: f32, ao: f32, a: f32) -> f32 {
  return saturate(pow(NoV + ao, exp2(-16.0 * a - 1.0)) - 1.0 + ao);
}
