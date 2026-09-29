// Cascaded sun shadow sampling. Cascades are stabilised on the CPU (bounding
// sphere fit + texel snapping); here we pick a cascade, apply normal-offset
// bias and filter with Castano's optimised PCF (smooth, deterministic, no noise).

fn shadowTap(uv: vec2f, off: vec2f, invSize: f32, depth: f32, layer: i32) -> f32 {
  return textureSampleCompareLevel(shadowMap, sampShadow, uv + off * invSize, layer, depth);
}

// 5x5 PCF footprint with 9 bilinear-compare taps.
fn pcf5(coord: vec2f, depth: f32, layer: i32, size: f32, spread: f32) -> f32 {
  let invSize = 1.0 / size;
  let uv = coord * size;
  var base = floor(uv + 0.5);
  let s = uv.x + 0.5 - base.x;
  let t = uv.y + 0.5 - base.y;
  base = (base - 0.5) * invSize;
  let uw0 = 4.0 - 3.0 * s; let uw1 = 7.0; let uw2 = 1.0 + 3.0 * s;
  let u0 = ((3.0 - 2.0 * s) / uw0 - 2.0) * spread;
  let u1 = ((3.0 + s) / uw1) * spread;
  let u2 = (s / uw2 + 2.0) * spread;
  let vw0 = 4.0 - 3.0 * t; let vw1 = 7.0; let vw2 = 1.0 + 3.0 * t;
  let v0 = ((3.0 - 2.0 * t) / vw0 - 2.0) * spread;
  let v1 = ((3.0 + t) / vw1) * spread;
  let v2 = (t / vw2 + 2.0) * spread;
  var sum = 0.0;
  sum += uw0 * vw0 * shadowTap(base, vec2f(u0, v0), invSize, depth, layer);
  sum += uw1 * vw0 * shadowTap(base, vec2f(u1, v0), invSize, depth, layer);
  sum += uw2 * vw0 * shadowTap(base, vec2f(u2, v0), invSize, depth, layer);
  sum += uw0 * vw1 * shadowTap(base, vec2f(u0, v1), invSize, depth, layer);
  sum += uw1 * vw1 * shadowTap(base, vec2f(u1, v1), invSize, depth, layer);
  sum += uw2 * vw1 * shadowTap(base, vec2f(u2, v1), invSize, depth, layer);
  sum += uw0 * vw2 * shadowTap(base, vec2f(u0, v2), invSize, depth, layer);
  sum += uw1 * vw2 * shadowTap(base, vec2f(u1, v2), invSize, depth, layer);
  sum += uw2 * vw2 * shadowTap(base, vec2f(u2, v2), invSize, depth, layer);
  return sum / 144.0;
}

// 7x7 PCF footprint with 16 taps (higher quality setting).
fn pcf7(coord: vec2f, depth: f32, layer: i32, size: f32, spread: f32) -> f32 {
  let invSize = 1.0 / size;
  let uv = coord * size;
  var base = floor(uv + 0.5);
  let s = uv.x + 0.5 - base.x;
  let t = uv.y + 0.5 - base.y;
  base = (base - 0.5) * invSize;
  let uw = vec4f(5.0 * s - 6.0, 11.0 * s - 28.0, -(11.0 * s + 17.0), -(5.0 * s + 1.0));
  let uo = vec4f((4.0 * s - 5.0) / uw.x - 3.0, (4.0 * s - 16.0) / uw.y - 1.0,
                 -(7.0 * s + 5.0) / uw.z + 1.0, -s / uw.w + 3.0) * spread;
  let vw = vec4f(5.0 * t - 6.0, 11.0 * t - 28.0, -(11.0 * t + 17.0), -(5.0 * t + 1.0));
  let vo = vec4f((4.0 * t - 5.0) / vw.x - 3.0, (4.0 * t - 16.0) / vw.y - 1.0,
                 -(7.0 * t + 5.0) / vw.z + 1.0, -t / vw.w + 3.0) * spread;
  var sum = 0.0;
  for (var j = 0; j < 4; j++) {
    for (var i = 0; i < 4; i++) {
      sum += uw[i] * vw[j] * shadowTap(base, vec2f(uo[i], vo[j]), invSize, depth, layer);
    }
  }
  return sum / 2704.0;
}

fn sampleCascade(c: i32, worldPos: vec3f, Ng: vec3f, NoL: f32) -> f32 {
  let texel = frame.cascadeTexel[c];
  // Normal offset grows at grazing light angles, where acne is worst.
  let offs = Ng * texel * frame.shadow0.x * (0.35 + saturate(1.0 - NoL));
  let sp = frame.cascadeViewProj[c] * vec4f(worldPos + offs, 1.0);
  let uv = vec2f(sp.x * 0.5 + 0.5, 0.5 - sp.y * 0.5);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return 1.0; }
  let depth = sp.z - frame.shadow0.y;
  let size = f32(textureDimensions(shadowMap).x);
  // Softness is expressed in world metres, converted to texels per cascade so
  // penumbrae stay consistent across cascade transitions.
  let spread = max(1.0, frame.shadow0.z / texel);
  if ((frame.debug.y & 0x10000u) != 0u) {
    return pcf7(uv, depth, c, size, min(spread, 6.0));
  }
  return pcf5(uv, depth, c, size, min(spread, 8.0));
}

// Returns (shadow, cascade index as f32 for debug views).
fn sunShadow(worldPos: vec3f, Ng: vec3f, NoL: f32, viewDepth: f32) -> vec2f {
  if (!hasFlag(F_SHADOWS)) { return vec2f(1.0, -1.0); }
  let dist = frame.shadow0.w;
  if (viewDepth >= dist) { return vec2f(1.0, 4.0); }
  var c = 3;
  for (var i = 0; i < 4; i++) {
    if (viewDepth < frame.cascadeSplits[i]) { c = i; break; }
  }
  var s = sampleCascade(c, worldPos, Ng, NoL);
  // Blend into the next cascade over the last 12% of this one.
  if (hasFlag(F_CASCADE_BLEND) && c < 3) {
    let far = frame.cascadeSplits[c];
    var near = 0.0;
    if (c > 0) { near = frame.cascadeSplits[c - 1]; }
    let range = (far - near) * 0.12;
    let b = saturate((viewDepth - (far - range)) / range);
    if (b > 0.0) {
      s = mix(s, sampleCascade(c + 1, worldPos, Ng, NoL), b);
    }
  }
  // Fade out at the shadow distance.
  let fade = saturate((dist - viewDepth) / (dist * 0.1));
  return vec2f(mix(1.0, s, fade), f32(c));
}
