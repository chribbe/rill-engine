// Exposure metering: centre-weighted log-luminance histogram of the resolved
// (pre-exposed, weighted-resolve encoded) HDR image. The CPU reads the
// histogram back asynchronously, trims percentiles and adapts EV100 slowly
// (Source-style tone-map controller: min/max EV, compensation, adaptation rate).
#include "common"

struct MeterParams {
  minLog: f32,       // log2 luminance at bin 0 (pre-exposed space)
  invRange: f32,     // 1 / (maxLog - minLog)
  stride: u32,       // sample every Nth pixel
  pad: u32,
};

const BINS: u32 = 128u;

@group(0) @binding(0) var<uniform> M: MeterParams;
@group(0) @binding(1) var hdr: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> histogram: array<atomic<u32>, 128>;

var<workgroup> local: array<atomic<u32>, 128>;

@compute @workgroup_size(16, 16)
fn meter(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) li: u32) {
  if (li < BINS) { atomicStore(&local[li], 0u); }
  workgroupBarrier();
  let size = textureDimensions(hdr);
  let p = gid.xy * M.stride + M.stride / 2u;
  if (p.x < size.x && p.y < size.y) {
    let s = textureLoad(hdr, vec2i(p), 0);
    if (s.a > 0.0) {
      let c = s.rgb / s.a;
      let l = max(luminance(c), 1e-7);
      let t = saturate((log2(l) - M.minLog) * M.invRange);
      let bin = min(u32(t * f32(BINS - 1u)), BINS - 1u);
      // Centre weighting (0.25 at the corners .. 1 in the middle), fixed-point.
      let uv = vec2f(p) / vec2f(size) * 2.0 - 1.0;
      let w = u32(mix(16.0, 64.0, saturate(1.0 - dot(uv, uv) * 0.5)));
      atomicAdd(&local[bin], w);
    }
  }
  workgroupBarrier();
  if (li < BINS) {
    let v = atomicLoad(&local[li]);
    if (v > 0u) { atomicAdd(&histogram[li], v); }
  }
}
