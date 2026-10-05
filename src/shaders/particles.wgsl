// Camera-facing particles (smoke, dust, muzzle flash, sparks) drawn inside the
// main MSAA pass after the sky. Lighting is evaluated per corner in the vertex
// stage: sun (cascade shadows) with a forward-scattering lobe, sky / probe-volume
// ambient, local lights with spot shadows, and fog.
//
// The colour target holds weighted HDR (rgb*w, w). Blend factors:
//   alpha (smoke, dust): colour = src * dstAlpha + dst * (1 - srcAlpha), alpha kept
//   additive (flash, sparks): colour = src * dstAlpha + dst, alpha kept
// so the resolved colour (rgb / w) is exactly standard over / additive blending.
#include "frame_bindings"
#include "brdf"
#include "shadows"
#include "fog"
#include "lighting"

struct Particle {
  posSize: vec4f,   // xyz centre, w half size (m)
  misc: vec4f,      // x rotation, y opacity, z kind (0 smoke, 1 dust, 2 flash, 3 spark), w seed
  color: vec4f,     // rgb albedo (lit kinds) or emission colour, w emissive (nits)
  vel: vec4f,       // xyz velocity (sparks stretch along it), w flags (1 viewmodel space, 2 stretch along velocity)
};

@group(1) @binding(0) var<storage, read> particles: array<Particle>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) nuv: vec2f,
  // Lit kinds: pre-exposed, fogged colour. Emissive kinds: pre-exposed emission.
  @location(2) color: vec3f,
  @location(3) inscatter: vec3f,
  @location(4) @interpolate(flat) params: vec4f,  // x opacity, y kind, z seed
};

const CORNERS = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));

/// Radiance reflected by a small cloud of scattering material (albedo 1), per unit albedo.
fn particleLight(wp: vec3f, n: vec3f, toCam: vec3f, viewDepth: f32) -> vec3f {
  var c = vec3f(0.0);
  let L = frame.sunDir.xyz;
  if (hasFlag(F_SUN)) {
    let sh = sunShadow(wp, L, 1.0, viewDepth).x;
    // Wrapped "sphere" term plus a forward lobe (normalised so isotropic = 1).
    let wrap = dot(n, L) * 0.5 + 0.5;
    let fwd = hgPhase(0.5, dot(-toCam, L)) * 4.0 * PI;
    c += frame.sunColor.rgb * sh * INV_PI * (wrap * 0.75 + fwd * 0.25);
  }
  if (hasFlag(F_SKY_AMBIENT)) {
    var irr = mix(shEval(n), shSky[9].rgb, 0.4);
    if (hasFlag(F_PROBE_VOLUME) && frame.pvOrigin.w > 0.5) {
      let pv = probeVolumeIrradiance(wp, n, skyUpRadiance());
      irr = mix(irr, pv.rgb, pv.a);
    }
    c += irr * frame.exposure.w;
  }
  if (hasFlag(F_LOCAL_LIGHTS)) {
    var local = vec3f(0.0);
    let lcBase = lightCellBase(wp);
    var lcCount = 0u;
    if (lcBase != 0xFFFFFFFFu) { lcCount = lightCells[lcBase]; }
    for (var k = 0u; k < lcCount; k++) {
      let l = lights[lightCells[lcBase + 1u + k]];
      let toL = l.posRange.xyz - wp;
      let d2 = dot(toL, toL);
      let r2 = l.posRange.w * l.posRange.w;
      if (d2 > r2) { continue; }
      let Ld = toL * inverseSqrt(d2);
      let win = saturate(1.0 - (d2 / r2) * (d2 / r2));
      var att = win * win / max(d2, max(l.params.z * l.params.z, 0.01));
      if (l.params.y > 0.5) {
        att *= smoothstep(l.dirCone.w, l.params.x, dot(-Ld, l.dirCone.xyz));
      }
      if (att <= 0.0) { continue; }
      if (l.params.w > 0.5) { att *= spotShadow(u32(l.params.w + 0.5) - 1u, wp, Ld, sqrt(d2)); }
      local += l.color.rgb * att * (dot(n, Ld) * 0.5 + 0.5) * INV_PI;
    }
    c += local;
  }
  return c;
}

@vertex
fn vsMain(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let p = particles[ii];
  let k = u32(p.misc.z + 0.5);
  let cam = frame.cameraPos.xyz;
  let right = vec3f(frame.view[0].x, frame.view[1].x, frame.view[2].x);
  let up = vec3f(frame.view[0].y, frame.view[1].y, frame.view[2].y);
  let toCam = normalize(cam - p.posSize.xyz);
  let corner = CORNERS[vi];
  var ax = right;
  var ay = up;
  var ext = vec2f(p.posSize.w);
  let flags = u32(p.vel.w + 0.5);
  let vm = (flags & 1u) != 0u;
  if (k == 3u || (flags & 2u) != 0u) {
    // Sparks (and stretched flashes): a streak along the screen-plane velocity.
    let v = p.vel.xyz - toCam * dot(p.vel.xyz, toCam);
    let speed = length(v);
    if (speed > 1e-3) {
      ax = v / speed;
      ay = normalize(cross(ax, toCam));
    }
    ext = vec2f(p.posSize.w + speed * 0.012, p.posSize.w);
  } else {
    let cr = cos(p.misc.x);
    let sr = sin(p.misc.x);
    ax = right * cr + up * sr;
    ay = up * cr - right * sr;
  }
  let wp = p.posSize.xyz + ax * corner.x * ext.x + ay * corner.y * ext.y;

  var o: VOut;
  if (vm) {
    // Attached to the first-person weapon: its projection and depth range.
    o.pos = frame.vmViewProj * vec4f(wp, 1.0);
    o.pos.z = o.pos.z * 0.25 + o.pos.w * 0.75;
  } else {
    o.pos = frame.viewProj * vec4f(wp, 1.0);
  }
  o.uv = corner;
  o.nuv = corner * 0.18 + vec2f(p.misc.w * 7.31, p.misc.w * 3.17) + p.misc.x * 0.02;
  let dist = length(wp - cam);
  // Fade particles that reach the eye instead of clipping them at the near plane.
  let nearFade = select(saturate((dist - 0.15) / 0.6), 1.0, vm);
  o.params = vec4f(p.misc.y * nearFade, f32(k), p.misc.w, 0.0);
  var T = 1.0;
  o.inscatter = vec3f(0.0);
  if (hasFlag(F_FOG)) {
    let fog = computeFog(cam, (wp - cam) / max(dist, 1e-4), dist, false);
    T = fog.transmittance;
    o.inscatter = fog.inscatter * frame.exposure.x;
  }
  if (k <= 1u) {
    // Fake sphere normal across the puff for some volume in the shading.
    let n = normalize(toCam + (ax * corner.x + ay * corner.y) * 0.8);
    let viewDepth = -(frame.view * vec4f(wp, 1.0)).z;
    o.color = p.color.rgb * particleLight(wp, n, toCam, viewDepth) * T * frame.exposure.x;
  } else {
    o.color = p.color.rgb * p.color.w * T * frame.exposure.x;
  }
  return o;
}

fn sootShape(in: VOut) -> f32 {
  let r2 = dot(in.uv, in.uv);
  let n0 = textureSample(cloudNoise, sampAniso, in.nuv).r;
  let n1 = textureSample(cloudNoise, sampAniso, in.nuv * 2.7 + 0.5).g;
  let n = n0 * 0.65 + n1 * 0.35;
  let falloff = saturate(1.0 - r2);
  // Billowy edge: noise eats the rim first, the core stays dense.
  return saturate((n - 0.5) * 2.2 + falloff * 1.6 - 0.55) * falloff;
}

@fragment
fn fsAlpha(in: VOut) -> @location(0) vec4f {
  let a = sootShape(in) * in.params.x;
  return vec4f((in.color + in.inscatter) * a, a);
}

@fragment
fn fsAdditive(in: VOut) -> @location(0) vec4f {
  let r2 = dot(in.uv, in.uv);
  let n = textureSample(cloudNoise, sampAniso, in.nuv * 0.6).r;
  var m = 0.0;
  if (in.params.y < 2.5) {
    // Muzzle flash: hot core + uneven petals.
    let ang = atan2(in.uv.y, in.uv.x);
    let petals = 0.55 + 0.45 * cos(ang * 5.0 + in.params.z * 20.0);
    let r = sqrt(r2);
    let core = exp(-r2 * 9.0);
    let body = saturate(1.0 - r / (0.35 + 0.65 * petals * (0.6 + n * 0.8)));
    m = core + body * body * 0.6;
  } else {
    // Spark streak: bright line fading towards the tail.
    let across = exp(-in.uv.y * in.uv.y * 6.0);
    let along = saturate(1.0 - abs(in.uv.x));
    m = across * along;
  }
  return vec4f(in.color * m * in.params.x, 0.0);
}
