# Rill — engine document

Living document: architecture, decisions, measurements, image-quality notes,
known issues, technical debt and milestone status. Update it whenever a system
changes or a measurement is taken.

**Current milestone:** M0/M1 foundation (renderer fundamentals + engine test map) — functional, see status below.
**Next milestone:** M1 completion — surface quality (real materials, directional lightmaps, reflection probes), then M2.

---

## 1. Goals and principles (short)

Crisp, stable, grounded, fast. Native resolution, MSAA instead of temporal
reconstruction, baked indirect + dynamic direct light, authored multi-scale
materials, restrained post. Simple techniques, measured, executed well.

## 2. Architecture overview

```
map.json (MapDocument, source of truth)          environments/*.json (EnvironmentState)
   │ objects: mesh | instances | light | decal | marker       │ sun, sky, fog, exposure, weather
   ▼                                                           ▼
World (runtime, derived) ───────────────┐               Environment ──► derive(): sun dir/lux, pre-exposure
   │ GLB assets → GeometryArena          │
   │ materials/*.json → MaterialLibrary  │
   │ LightmapSet → rgb9e5 texture array  │
   │ decals → world-grid clustered list  │
   │ CollisionWorld (walk controller)    ▼
   └──► Renderable[] ──► Renderer.render(camera, env, renderables)
```

### Frame (per `Renderer.render`)

1. **Uniforms** — one `Frame` uniform (camera, cascades, sun, fog, flags…), `src/engine/render/frame.ts` ⇄ `src/shaders/common.wgsl`.
2. **CPU culling + render lists** — AABB vs frustum planes for the camera and each cascade.
   Visible instances are bucketed by (primitive, material) → **one instanced draw per bucket**.
   All lists are concatenated into one `visibleList` storage buffer; `firstInstance` indexes it.
3. **Sky/env update** (compute, only when the environment changes) — atmosphere LUTs
   (transmittance, multi-scattering, sky-view), sky → cube (128²), mip chain, GGX prefilter
   (6 mips), L2 SH irradiance, BRDF LUT (once).
4. **Shadow passes** — 4 cascades into a `depth32float` 2D array (default 2048²), depth clamp
   ("pancaking") via `unclippedDepth`.
5. **Main forward pass** — 4× MSAA `rgba16float` + `depth32float` (transient attachments),
   reverse-Z infinite projection. Order: opaque → masked depth prepass → masked colour
   (`depth == equal`) → sky (fullscreen at depth 0) → debug lines/wireframe. Hardware resolve.
6. **Post** — weighted-resolve decode, tone mapping (AgX default; PBR Neutral, ACES, Reinhard),
   restrained grading (contrast/saturation/white balance, all neutral by default), sRGB encode, IGN dither.

### Key files

| Area | Files |
|---|---|
| GPU setup | `src/engine/gpu/context.ts` |
| Renderer / passes / pipelines | `src/engine/render/renderer.ts` |
| Shaders | `src/shaders/*.wgsl` (`#include` via `render/shaderlib.ts`) |
| Materials | `render/materials.ts`, `public/materials/*.json` |
| Textures + mips | `render/textures.ts`, `shaders/mipgen.wgsl` |
| Geometry | `render/geometry.ts`, `assets/gltf.ts`, `assets/primitives.ts` |
| Sky / env | `render/sky.ts`, `shaders/atmosphere*.wgsl`, `sky_eval.wgsl`, `env.wgsl` |
| Shadows | `render/shadows.ts`, `shaders/shadows.wgsl`, `shadow_depth.wgsl` |
| Lightmaps | `render/lightmaps.ts`, `tools/blender/bake_lightmaps.py` |
| Decals | `render/decals.ts` (+ `applyDecals` in `standard.wgsl`) |
| Map / world | `scene/mapformat.ts`, `scene/world.ts`, `scene/environment.ts` |
| Player | `player/controller.ts`, `scene/collision.ts` |
| UI | `ui/stats.ts`, `ui/playground.ts` |
| Content tools | `tools/textures/generate.ts`, `tools/blender/build_testmap.py`, `tools/blender/common.py` |

## 3. Conventions

- **Units/axes:** metres. Engine: right-handed, Y up, −Z north, +X east. Blender: Z up, +Y north.
  glTF export converts (x, y, z)ᴮ → (x, z, −y)ᴱ. Compass yaw: 0 = north, clockwise.
- **UV0 = world metres** (box-projected in the tools). Materials declare `physicalSize` (metres per
  texture repeat). Texel density is therefore a material property, never an asset accident.
  Base textures are authored at 512 px/m (1024² over 2 m); detail maps ~2000 px/m.
- **UV1 = lightmap charts** in [0,1] over a W×H texel rectangle stored per object in `map.json`
  (`lightmap.resolution`). The bake places rectangles into atlas pages; the runtime applies a
  per-instance scale/offset. Chart packing is texel-exact with 2 texels padding per side.
- **Normal maps:** OpenGL convention (+Y = image up), glTF tangents (MikkTSpace from Blender;
  runtime fallback in `computeTangents`).
- **Light units:** physical. Sun in lux (TOA 120 000 lx × atmosphere transmittance × cloud
  attenuation), sky in nits, local lights in candela, emissive in nits. Camera EV100 →
  pre-exposure applied in shaders so fp16 targets hold everything.
- **Stable IDs:** every map object has an `id` that is never reused; lightmap bindings and
  future tools reference objects only by ID.

## 4. Important technical decisions

1. **Forward + MSAA 4×, no TAA.** Deferred makes MSAA and material variety harder; TAA softens.
   HDR-correct MSAA resolve: the shader writes `(rgb·w, w)` with `w = 1/(1+luma)` and the
   hardware averages — the post pass divides (Karis-style tonemap-weighted resolve without a
   custom resolve pass, keeping MSAA in tile memory on TBDR GPUs). Debug "raw" views flag
   themselves with negative alpha.
2. **Reverse-Z, infinite far plane**, `depth32float`.
3. **Physically based atmosphere** (Hillaire 2020 LUTs) + procedural 2D cloud layer blending into
   a CIE-overcast distribution for full cover. Sky, fog, env reflections and SH ambient are all
   derived from the same model → coherent. `sky.tint` exists for art direction (used at dusk:
   the physical twilight leans purple because ozone removes green).
4. **Fog** = analytic exponential height fog (lit by SH sphere-average sky + HG sun lobe) +
   thin height-decaying haze whose colour is the horizon sky from the env map, combined in one
   optical depth. Local lights add analytic single-scattering airlight, attenuated by spot
   cones. Fog is evaluated per pixel in the forward and sky passes (no post fog).
5. **Lightmap decomposition (the key static-lighting decision).** Each page stores two linear
   components baked in Cycles' diffuse *light* pass units (= irradiance/π):
   - `sky`: uniform white upper-hemisphere sky of radiance 1 (+0.1 below horizon), direct + indirect;
   - `sunBounce`: sun of irradiance 1 from the reference direction, **indirect only**.

   Runtime: `irr = lmSky · L_skyUp(SH) + lmSun · E_sun(lux)`. Weather, sky intensity and sun
   intensity change without rebaking; direct sun and its shadows are fully realtime. Only the
   bounce *direction* is tied to the reference sun (rebake for large sun moves).
   **Calibrated:** a unit sun gives 0.3183 (1/π) and a unit sky 1.0 in the light pass (measured).
6. **Normal-map detail in non-directional lightmaps:** the lightmap is multiplied by
   `SH(N_mapped)/SH(N_geom)` of the live sky (clamped 0.4–1.8). Cheap stand-in until directional
   lightmaps exist.
7. **Reflection normalisation (Source-2 style):** env specular is scaled by
   `luma(local baked irradiance) / luma(probe irradiance at N)` for lightmapped surfaces, plus
   horizon occlusion. Keeps tunnels/arcades from glowing with sky reflections.
8. **Specular anti-aliasing at two levels:** normal-map mips store lost variance in the alpha
   channel (vMF fit, added to GGX α²), and geometric specular AA (Tokuyoshi–Kaplanyan) widens
   the NDF from screen-space normal derivatives.
9. **Mips:** generated on the GPU — colour filtered in linear space with a 6-tap Lanczos-2
   (slightly crisper distance than box), wrap-aware for tiling textures; normals averaged with
   variance kept. Alpha-tested textures get coverage-preserving alpha scaling in the shader
   (Golus) and ~1 px sharpened edges.
10. **Masked geometry (foliage/fences):** alpha-tested **depth prepass** (hardware
    alpha-to-coverage under MSAA) followed by an `equal`-depth lit pass without discard.
11. **Pipeline specialisation via WGSL `override` constants** (debug views, triplanar, detail,
    macro, decals, wetness, shadows, lightmaps, local lights, fog, foliage, spec AA). One source
    uber-shader, compiled into per (material × active global feature) variants. See §6 for why.
12. **Decals** are evaluated in the material shader before lighting (they modify albedo/roughness/AO),
    binned into a static world-space XZ grid (8 m cells). Road markings, cracks, stains, oil,
    manholes, water streaks and grime in the test map.
13. **One render-list path for everything**: static objects, props and instanced vegetation are
    all instances in one table; automatic instancing by (primitive, material). Maps directly
    onto GPU culling + indirect draws later.
14. **Realistic aerosols.** The Bruneton/Hillaire default Mie coefficient integrates to an aerosol
    optical depth of ~0.005 — an almost aerosol-free sky that rendered dark, over-saturated and
    with ~9:1 sun:sky contrast (measured: 6.3 klx sky vs 55 klx sun, skylight R/B 0.26).
    `turbidity` is now relative to AOD ≈ 0.1 (`AEROSOL_BASE = 20`): clear preset measures
    ~11–12 klx sky vs ~48 klx sun (≈4:1) and R/B ≈ 0.6, matching real clear days.
15. **Auto exposure (Source-style tone-map controller).** GPU centre-weighted log-luminance
    histogram of the resolved HDR image → async readback → mean between the 35th and 92nd
    percentiles → EV100 with a mid-grey key, adapted asymmetrically (brighten 1.3/s, darken
    3/s) and clamped to per-environment `exposure.min/max`. Manual EV is the start point and
    fallback. Screenshots converge/snap before capture.
16. **Veiling-glare bloom**, energy-conserving mix (default 4 %), 13-tap/tent pyramid with a
    Karis-weighted first downsample (no glint flicker). Off in debug views.
17. **Assets are GLB; the runtime never depends on Blender.** Blender is the authoring and baking
    tool (headless scripts); the map document and LightmapSet are engine formats.

## 5. Content pipeline

```
npm run textures   # tools/textures/generate.ts   → public/textures (+ manifest.json avg albedo)
npm run map        # Blender: build_testmap.py    → public/assets/testmap/*.glb + maps/testmap/map.json
npm run bake       # Blender/Cycles: bake_lightmaps.py -- [--samples 256] [--size 2048] [--no-denoise]
                   #   → maps/testmap/lightmaps/{lm_0_sky.hdr, lm_0_sun.hdr, lightmapset.json}
```

**BakeScene → BakeBackend → LightmapSet.** The bake reconstructs the scene from `map.json` + GLBs
(not from the authoring .blend), uses per-material bounce albedo (texture manifest × factor),
alpha-cutout foliage with partial transmission, packs object rectangles into 2048² pages,
bakes position/normal guides + the two components, runs a guided à-trous denoise, and writes
RGBE `.hdr`. Current bake: 34 objects, 2.62 Mtexels (63 % of one page), 256 spp, **~115 s** on
an M5 Pro (≈15 s per bake call is Cycles scene sync/BVH).

Texel densities: terrain 4 t/m, ground surfaces 5 t/m, architecture 12 t/m, stairs 16 t/m.

## 6. Performance measurements

Hardware: Apple M5 Pro (20-core GPU), macOS 26.6, Chrome 152 WebGPU/Metal. Measured with
`rill.bench()` (back-to-back frames, wall time incl. GPU completion — pass timestamps overlap on
TBDR and are only indicative). Clear preset, test map, MSAA 4×, aniso 16× unless noted.

| Resolution | Setting | Road view | Forest view |
|---|---|---|---|
| 1920×1080 | MSAA 4×, aniso 16× | 5.9 ms | 6.6 ms |
| 1920×1080 | MSAA 4×, aniso 8× | 5.0 ms | 6.6 ms |
| 1920×1080 | no MSAA, aniso 16× | 3.0 ms | 3.8 ms |
| 3440×1440 | MSAA 4×, aniso 16× | 10.9 ms | 12.0 ms |
| 3440×1440 | MSAA 4×, aniso 8× | 9.4 ms | 11.0 ms |
| 3440×1440 | no MSAA, aniso 16× | 4.8 ms | 5.4 ms |

Base map: ~120 main + ~240 shadow draws, 0.21 M main triangles, ~1 500 instances, CPU 0.3–0.5 ms/frame.

Stress (1080p, MSAA 4×, road / overview):

| Added | Frame | Draws | CPU | Notes |
|---|---|---|---|---|
| — | 6.1 / 6.7 ms | 119+241 | 0.5 ms | |
| +5 000 trees | 8.3 / 10.1 ms | 121+249 | 0.8 ms | foliage = masked prepass + lit |
| +5 000 streetlights | 8.6 / 11.4 ms | 124+261 | 1.3 ms | |
| +400 buildings | 7.9 / 10.5 ms | 125+265 | 1.2 ms | |
| +20 000 dense spheres | 21.8 / 31 ms | 126+269 | 3.8 ms | 37 M visible tris; pure triangle load |

Findings:
- **Draw calls are flat** with instance count (auto-instancing). CPU culling is linear (~22 ns
  per AABB test × 5 lists); ~100 k objects would need hierarchical culling or GPU culling.
- **The runtime uber-shader was ~3–4× more expensive with MSAA than without** on this GPU, even
  for early-out paths, while tiny shaders showed no MSAA penalty (isolated microbenchmark:
  `public/bench/msaa.html`, and bisection entry points in `src/shaders/standard_diag.wgsl`).
  Target formats, transient attachments and timestamps were ruled out. Specialising pipelines
  with `override` constants cut the road view from 11.9 → 5.6 ms (MSAA) at 1080p.
  Remaining MSAA premium ≈ 2× and scales with shader weight → keep shaders lean.
- **Alpha-tested foliage** was the single biggest cost (26 ms → 12 ms with the prepass, before
  specialisation). Coverage-modifying fragments are expensive under MSAA regardless of
  discard vs sample-mask vs hardware A2C.
- **Auto exposure + bloom** cost ≈ 0.5 ms at 3440×1440 (11.4 → 11.9 ms, measured after a cooldown).
- **Thermal note:** long back-to-back benchmark runs throttle the GPU by up to ~30 % (14 ms vs 11 ms
  at native); let the machine cool ~30 s before comparing numbers.
- **16× anisotropic filtering** costs ~1–1.5 ms at 3440×1440 over 8× — kept as default (visible
  gain on long roads; see §7).
- Load time: ~0.2–0.25 s for the whole map (54 GLBs, ~45 MB PNG textures, 2 lightmap pages).

## 7. Image-quality observations

- **Grazing-angle texture clarity:** with 16× aniso and Lanczos mips the world-scale grid stays
  readable (10 cm lines + labels) far down the 200 m road; 4× visibly blurs the mid distance and
  1× loses the grid beyond ~10 m. Slab joints and kerbs remain crisp. (`scaleGrid` view.)
- **Shadows:** stable sphere-fit cascades with texel snapping; no acne on long walls at 7° sun,
  no visible peter-panning at contact (bollards, stairs); 5×5 optimised PCF, 12 % cascade blend.
- **MSAA edges** are clean; the weighted resolve avoids dark/bright edge halos against the sky.
- **Lightmaps:** 12 t/m gives contact occlusion under the arcade, at wall bases, in the underpass;
  bicubic filtering hides texel structure. Density debug view confirms uniform texel size.
- **Presets:** *overcast* is the most convincing (soft, readable, close to the references);
  *foggy* hides distance coherently (fog colour follows sky); *dusk* (blue hour, −7° sun) shows
  lamp pools and cone glow in haze; *clear* is crisp, with very deep shade in sun (physically
  consistent: arcades/forest floor at 1/50–1/100 of sunlit radiance).
- **Without fog** the wet grey setting still reads well (porosity-based darkening, grime decals).

## 8. Known issues

- ~~Deep shade under clear sun reads near-black~~ — fixed by realistic aerosols (sky 2× brighter,
  whiter) + auto exposure. Remaining: no *local* exposure, so a bright exterior seen from deep
  shade still clips (as a camera would).
- Placeholder vegetation: crossed cards read as "cardboard" up close; no LOD/impostors; forest
  floor under dense cards is dark.
- Distant landscape is a smooth green mesh (no forest silhouette) — placeholder.
- Puddle/wet reflections are subtle: only the global sky probe exists (no local probes, no SSR by design).
- Lightmap bounce is baked for the reference sun direction (clear preset); other sun angles keep
  realtime direct light but approximate bounce.
- Dynamic objects (trees, props, gallery spheres) use sky SH × crude AO — no probe volume yet,
  so they can look too bright in occluded areas.
- `rill.bench` numbers include ~0.5 ms of frame-pacing overhead; timestamp queries overlap on TBDR.
- When the browser pane/tab is hidden, rAF drops to 1 Hz (use `rill.shot`/`rill.bench`).

## 9. Technical debt

- Lightmap atlas waste: ring-shaped charts (parapet caps) and curved path ribbons pack into
  their bounding boxes (building charts ~40 % empty, forest path 93 %). Split islands or use a
  better packer.
- No texture compression yet (all RGBA8 PNG + GPU mips, ~300 MB GPU texture memory incl. mips).
  Plan: offline KTX2 with BC7 (albedo/ORM) and BC5 (normals; variance → ORM roughness mips).
- Lightmaps are rgb9e5 raw (32 MB for one page with two components) — consider BC6H.
- Brute-force local light loop (fine for ~20 lights); clustered lighting when needed.
- CPU culling is flat (no BVH / sectors); no GPU-driven path yet.
- Pipelines are created synchronously on first use (hitch when toggling features) → use
  `createRenderPipelineAsync` + warm-up.
- `standard.wgsl` is still one large source; variants are specialised but the source should be
  split into smaller chunks as features grow.
- Collision is a simple sphere/ray controller over a uniform grid (no proper capsule sweep).
- Env/sky regeneration runs synchronously on any environment change (~<1 ms, fine for now).

## 10. Status against milestone 1 criteria

| # | Criterion | Status |
|---|---|---|
| 1 | Open in browser → first-person environment | ✅ `npm run dev` |
| 2 | Walk smoothly | ✅ walk (steps, collision) + fly |
| 3 | Real-world scale | ✅ metres everywhere; scale references, doors, 167 mm stairs |
| 4 | Physical-scale debug textures | ✅ 4 m grid (10 cm/50 cm/1 m), checker, `scaleGrid` view |
| 5 | Crisp texture sampling | ✅ aniso 16×, Lanczos mips, explicit-gradient sampling |
| 6 | Grazing-angle readability | ✅ 200 m road / long walls tested |
| 7 | Clean stable sun shadows | ✅ stabilised CSM, PCF, cascade blend, debug view |
| 8 | Clear / overcast / foggy (/dusk) | ✅ presets + live controls |
| 9 | Fog fully off still looks good | ✅ |
| 10 | Baked indirect lighting | ✅ Cycles bake, two-component LightmapSet |
| 11 | Normal/roughness/material response | ✅ PBR + detail + macro + wetness + spec AA (content still procedural) |
| 12 | Debug views | ✅ 21 views + wireframe, bounds, frozen culling, overdraw |
| 13 | Live performance stats | ✅ FPS/frame/CPU/GPU passes/draws/tris/objects/memory |
| 14 | Stress tests | ✅ trees/props/buildings/spheres spawner |
| 15 | Clear path to the larger engine | ✅ map document, stable IDs, automation API, specialised materials |

## 11. Next steps (proposed order)

1. **Directional lightmaps** (L1 SH or 3-basis RNM via three Cycles bakes with fixed normals) —
   biggest remaining gain for normal-mapped surfaces in shade/overcast.
2. **Local reflection probes** (box-projected, captured in-engine at load/bake) → wet surfaces, glass, tiles.
3. **Irradiance probe volume** baked alongside lightmaps (same sky/sunBounce decomposition) for
   dynamic objects and vegetation.
4. **Real materials** (scanned CC0 sets through the same JSON model) and texture compression (KTX2/BC).
5. **Vegetation**: better pine/spruce/birch assets, LOD + impostors, wind.
6. **Exposure**: optional eye adaptation / local exposure for sun-vs-shade scenes.
7. GPU culling + indirect draws once CPU culling shows up in profiles; hierarchical sectors.

## 12. Automation API (precursor of future editor/AI tools)

`window.rill` in the running app: `getScene()`, `setPreset(name)`, `setView(name)`,
`setCamera(pos, yawDeg, pitchDeg)`, `getCamera()`, `stats()`, `shot(name, w, h)` (writes
`screenshots/<name>.png` via the dev server), `shotViews(prefix, w, h)`, `bench(frames)`,
`stress(kind, n)`, `clearStress()`, plus the live `renderer`, `world`, `env` objects.
