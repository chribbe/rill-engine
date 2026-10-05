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
  misc: vec4f,      // x rotation (tracer: streak half length), y opacity, z kind (0 smoke, 1 dust, 2 flash, 3 spark, 4 debris, 5 tracer, 6 drop, 7 splash), w seed
  color: vec4f,     // rgb albedo (lit kinds) or emission colour, w emissive (nits)
  vel: vec4f,       // xyz velocity (sparks stretch along it), w flags (1 viewmodel space, 2 stretch along velocity)
};

@group(1) @binding(0) var<storage, read> particles: array<Particle>;
// Effects sprite atlas, 4 x 4 tiles: row 0 = muzzle flash seen from behind, row 1 = muzzle flash
// plume from the side, root at the left (additive, premultiplied colour); row 2 = liquid bursts,
// row 3 = liquid sprays along +u (alpha-blended and lit: rgb shading, a coverage). 4 variants each.
@group(1) @binding(1) var fxAtlas: texture_2d<f32>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) nuv: vec2f,
  // Lit kinds: pre-exposed, fogged colour. Emissive kinds: pre-exposed emission.
  @location(2) color: vec3f,
  @location(3) inscatter: vec3f,
  @location(4) @interpolate(flat) params: vec4f,  // x opacity, y kind, z seed, w flags
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
  if (k == 5u) {
    // Tracer: a ribbon along the true 3D velocity (perspective foreshortens it like a real
    // segment, so a round flying away from the eye still reads as a line); width below.
    let speed = length(p.vel.xyz);
    if (speed > 1e-3) {
      ax = p.vel.xyz / speed;
      let side = cross(ax, toCam);
      if (length(side) > 1e-4) { ay = normalize(side); }
    }
    ext = vec2f(p.misc.x, p.posSize.w);
  } else if (k == 3u || (flags & 2u) != 0u) {
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
  // Soot billboards slide towards the eye by part of their radius so a big puff
  // next to a wall does not slice through it with a hard edge (no depth read here).
  let eyeDist = length(cam - p.posSize.xyz);
  let pull = select(0.0, min(p.posSize.w * 0.6, max(eyeDist - 0.4, 0.0)), (k <= 1u || k == 7u) && !vm);
  let along = p.posSize.xyz + toCam * pull + ax * corner.x * ext.x;
  // Tracers keep at least ~4 px of width at each end, however far away.
  let minHalf = select(0.0, length(along - cam) * 2.0 / (frame.proj[1][1] * frame.viewport.y), k == 5u);
  let wp = along + ay * corner.y * max(ext.y, minHalf);

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
  o.params = vec4f(p.misc.y * nearFade, f32(k), p.misc.w, f32(flags));
  var T = 1.0;
  o.inscatter = vec3f(0.0);
  if (hasFlag(F_FOG)) {
    let fog = computeFog(cam, (wp - cam) / max(dist, 1e-4), dist, false);
    T = fog.transmittance;
    o.inscatter = fog.inscatter * frame.exposure.x;
  }
  if (k <= 1u || k == 4u || k >= 6u) {
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

/** Hard, irregular chunk (debris): solid inside a noisy outline, darker towards the rim. */
fn chunkShape(in: VOut) -> vec2f {
  let r2 = dot(in.uv, in.uv);
  let n = textureSample(cloudNoise, sampAniso, in.nuv * 1.7).r;
  let edge = 0.42 + (n - 0.5) * 0.55;
  let w = fwidth(r2) * 1.5;
  return vec2f(1.0 - smoothstep(edge - w, edge + w, r2), 0.7 + 0.3 * (1.0 - r2 / max(edge, 0.05)));
}

/** Liquid droplet: a smooth ellipse, darker at the rim, a glossy highlight up-left. */
fn dropShape(in: VOut) -> vec2f {
  let r2 = dot(in.uv, in.uv);
  let w = fwidth(r2) * 1.5;
  let a = 1.0 - smoothstep(0.82 - w, 0.82 + w, r2);
  let hl = exp(-dot(in.uv - vec2f(-0.28, 0.32), in.uv - vec2f(-0.28, 0.32)) * 9.0);
  return vec2f(a, 0.7 + 0.25 * (1.0 - r2) + 1.6 * hl * hl);
}

/** Liquid sprite from atlas rows 2 (burst, rolled) / 3 (spray along the stretch axis). */
fn splashShape(in: VOut) -> vec2f {
  let variant = floor(fract(in.params.z * 7.13) * 4.0);
  let stretched = (u32(in.params.w + 0.5) & 2u) != 0u;
  let tuv = in.uv * 0.5 + 0.5;
  let row = select(2.0, 3.0, stretched);
  let suv = vec2f((variant + clamp(tuv.x, 0.002, 0.998)) * 0.25, (row + clamp(1.0 - tuv.y, 0.002, 0.998)) * 0.25);
  let c = textureSample(fxAtlas, sampClamp, suv);
  return vec2f(c.a, c.r);
}

@fragment
fn fsAlpha(in: VOut) -> @location(0) vec4f {
  // Every shape in uniform control flow (texture samples, derivatives), then pick by kind.
  let soot = sootShape(in);
  let chunk = chunkShape(in);
  let drop = dropShape(in);
  let splash = splashShape(in);
  let k = in.params.y;
  let isChunk = k > 3.5 && k < 4.5;
  let isDrop = k > 5.5 && k < 6.5;
  let isSplash = k > 6.5;
  var a = select(soot, chunk.x, isChunk);
  var shade = select(1.0, chunk.y, isChunk);
  a = select(a, drop.x, isDrop);
  shade = select(shade, drop.y, isDrop);
  a = select(a, splash.x, isSplash);
  shade = select(shade, splash.y, isSplash);
  a *= in.params.x;
  return vec4f((in.color * shade + in.inscatter) * a, a);
}

@fragment
fn fsAdditive(in: VOut) -> @location(0) vec4f {
  // Muzzle flash: a sprite from the atlas (sampled in uniform control flow, selected below).
  let variant = floor(fract(in.params.z * 7.13) * 4.0);
  let stretched = (u32(in.params.w + 0.5) & 2u) != 0u;
  let tuv = in.uv * 0.5 + 0.5;
  let auv = vec2f((variant + clamp(tuv.x, 0.002, 0.998)) * 0.25, (select(0.0, 1.0, stretched) + clamp(1.0 - tuv.y, 0.002, 0.998)) * 0.25);
  let flash = textureSample(fxAtlas, sampClamp, auv).rgb;
  // Spark streak: bright line fading towards both ends. Tracer: hot head (+x, the direction
  // of travel) with a rounded tip, fading along the tail.
  let across = exp(-in.uv.y * in.uv.y * 6.0);
  let along = saturate(1.0 - abs(in.uv.x));
  let head = smoothstep(-1.0, 0.7, in.uv.x) * (1.0 - smoothstep(0.82, 1.0, in.uv.x));
  let spark = vec3f(across * select(along, head * sqrt(head), in.params.y > 4.5));
  let m = select(spark, flash, in.params.y < 2.5);
  return vec4f(in.color * m * in.params.x, 0.0);
}
