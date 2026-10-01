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
   ("pancaking") via `unclippedDepth`; then up to 2 dynamic spot-light layers (1024²) for
   gameplay lights (flashlight).
5. **Main forward pass** — 4× MSAA `rgba16float` + `depth32float` (transient attachments),
   reverse-Z infinite projection. Order: opaque → masked depth prepass → clutter prepass →
   masked colour (`depth == equal`) → clutter colour → sky (fullscreen at depth 0) →
   particles (alpha, then additive) → debug lines/wireframe. Hardware resolve.
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
| Ground clutter | `render/clutter.ts`, `vsClutter` in `standard.wgsl`, `tools/blender/clutter.py` |
| Action effects | `render/particles.ts` + `shaders/particles.wgsl`, `render/spotshadows.ts`, `shaders/lighting.wgsl`, `src/sandbox.ts` |
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
18. **Directional lightmaps as a ratio (HL2 RNM basis).** Besides the flat `sky` bake, the sky
    component is baked three more times with the shading normal tilted to the HL2 radiosity
    basis. Cycles' tilted-normal bakes measured biased low (0.88/0.63/0.38 vs analytic
    0.93/0.79/0.63 at 30/54.7/75°), so the runtime uses them only as a *direction ratio*:
    `sky · Σwᵢ·Lᵢ / mean(Lᵢ)` with `wᵢ = saturate(N·eᵢ)²` normalised. Flat energy stays exact;
    normal maps get directional shading in shade/overcast. Layers: sky, rnm0..2, sun.
19. **Probe volume = Source-1 ambient cubes**, baked in the same Cycles passes as the lightmaps
    (an invisible probe-cube mesh, camera-visible only), same sky/sunBounce decomposition, packed
    as slabs in one rgba16float 3D texture. Non-lightmapped objects (trees, props) blend
    `mix(skySH, probe, weight)`. **Validity:** a BVH over opaque static geometry raycasts 14
    directions per probe; ≥5 back-face hits = buried (20 % of the test-map volume), and buried
    probes are dilated from valid neighbours so nothing leaks dark.
20. **Reflection probes captured in-engine** (not baked): 6 × 90° faces rendered by the real
    renderer at a fixed pre-exposure, GGX-prefiltered with the sky pipelines, SH-projected for
    normalisation. Box-projected, top-2 blend + sky fallback. Re-captured whenever the
    environment changes (weather preset → wet tiles reflect the right sky).
21. **Blend materials (vertex-painted, height-blended).** A material may declare `blend` with a
    second material; vertex colour R is the layer-B weight, sharpened by the two layers' height
    maps (ORM alpha = normalised height) and broken up by macro noise. Used for lawn→forest floor,
    moss at wall bases, underpass grime, pine bark (grey plates → orange upper trunk) and birch
    bases. Faces of blend materials are subdivided to ≤0.4 m at build time so weights have
    vertices to live on. *Blender 5.2's glTF exporter writes white COLOR_0 for every material
    after the first in a multi-material mesh* (it maps them to an internal key instead of
    `COLOR_0`); `export_glb` exports such meshes as one part per material and the bake rejoins them.
22. **Offline BC7 texture compression.** `tools/textures/compress.ts` builds the mip chain exactly
    like the GPU mipgen (Lanczos-2 in linear light, vMF normal variance in alpha, 8-bit per level)
    and encodes BC7 (modes 6 / 5 with rotation / 1 with partition search; PCA + least squares +
    p-bit search; bit-exact against the GPU decoder) into KTX2. The kind (colour/normal/linear)
    comes from material usage; the loader only substitutes when the kind matches. **Quality gate:**
    per-texel-noise normal maps (gravel, grass, aggregate…) are 20–33 dB in BC7 and stay
    uncompressed until normals move to BC5. 318 → 129 MB texture memory at the time of the switch.
23. **Vegetation = skeleton → LODs → impostor.** `tools/blender/trees.py` grows a deterministic
    skeleton per species (whorled spruce with dead lower branches, umbrella-crowned Scots pine
    with clumped tufts, birch with pendulous twigs) and emits LOD0 (branch tubes + all spray
    cards), LOD1 (coarse trunk, main limbs, every 3rd card ×1.65) and LOD2 (three crossed planes
    cut into alpha-fitted bands, textured by an orthographic Cycles render of LOD0: albedo + crown
    AO). Foliage normals are bent from the crown centre; trunks keep real normals.
    **Model descriptors** (`*.model.json`, Source `vmdl` analogue) list LOD meshes + switch
    distances; any placement of the model gets LODs. Selection is by distance to the bounds
    centre × instance scale, normalised to a 60° FOV, with a user LOD bias. **Shadow casters use
    a per-cascade minimum LOD (0, 1, 2, 2)** — cut forest shadow triangles from 3.1 M to 0.75 M.
24. **Far scenery as a cheap backdrop (3D-skybox idea, real scale).** Beyond the playable area:
    graded far terrain with a field/forest mask (vertex blend to a canopy texture) and a
    **canopy shell** raised 15 m over forested ground (faded in from ~210 m), lakes in carved
    basins, 12 rings of **tree-line strips** (a tileable 64×26 m forest-edge silhouette rendered
    from the real tree models) placed where the mask is forest, and distant miljonprogram blocks
    on the hills with clearings around them. ~11 k triangles total; fog/aerial perspective does
    the rest.
25. **Scanned CC0 materials, imported into engine conventions.** 15 Poly Haven sets (road
    asphalt with sealed cracks, board-formed and brushed concrete, exposed aggregate, plaster,
    brick, slabs, lawn, pine-forest floor, gravel, lichen granite bedrock, clean granite kerbs,
    pine bark, moss, dirt) are fetched at 2K by `tools/textures/scanned.ts` into a gitignored
    cache (~175 MB, JPG only) and written
    as 1K PNGs: albedo averaged in linear light and **recalibrated to a target mean luminance**
    (scans range 0.09–0.41; e.g. asphalt 0.10, concrete 0.26, lawn 0.12), optional linear tint
    (every grass scan was dry-season brown → summer green), OpenGL normals renormalised with
    the downsampling variance in alpha, AO/rough/metal + normalised height packed into ORM.
    Real-world sizes come from Poly Haven's metadata and are written into the materials'
    `physicalSize` (`assign` also switches a material's maps to the set). The procedural
    generator skips scanned names (`--procedural` to force). Repo cost ≈ 7 MB per set (1K
    PNGs; photographic detail compresses worse than procedural noise). Credits in
    `public/textures/CREDITS.md`.
26. **Dithered LOD crossfade.** Within ±10 % of each switch distance both neighbouring LODs are
    drawn with complementary screen-space masks (IGN dither vs fade t), so every pixel shows
    exactly one LOD and nothing pops. The fade rides in the visible-list entry
    (slot 24 bits | t 6 bits | in/out 2 bits) — no per-frame instance writes — and only draws
    inside a band use the `USE_LOD_FADE` pipeline variant (discard in the opaque pass and in the
    masked prepass; the equal-depth colour pass inherits the coverage). Costs 0.4–1.1 ms at
    1080p (double drawing inside the bands); shadows keep a single LOD.

27. **Generic baked vertex AO + crown visibility.** Vertex colour G is AO for every mesh (default 1).
    `trees.py` bakes each crown vertex's sky visibility by casting rays through the tree's own
    cards with transmittance (1 − texture coverage) per card, so dense spruce interiors darken
    and sparse twigs don't. It feeds indirect light (and part of the sun on foliage), the
    impostors and the snow layer's sky exposure. Mask coverage is per material: dense sprays
    keep the distance coverage boost, sparse twigs (`alphaDistance: "average"`) fade to haze.
28. **Season layer in world space, not per material.** Snow, melt water and a dormant tint are
    one shader block driven by the environment's `weather` (`snow`, `melt`, `dry`): cover from
    sky exposure (lightmap sky layer, or vertex AO), slope and world noise; per-material
    affinity (`snow`), dormant tint (`dryTint`). One global scanned snow set (2 fetches; shader
    size, not fetch count, was the MSAA cost). Melt water reuses the wetness path.
29. **Ground clutter as a renderer system, scattered at load.** Materials list clutter types;
    the world scatters them on surfaces using that material (blend weight picks lawn vs forest
    floor), rejects points under other geometry via the collision world, and the renderer
    draws 8 m cells as one instanced draw per visible cell row (`vsClutter`, compact 32-byte
    instances). Tufts are lit by the ground's lightmap at their root and sink under snow. No
    shadows; fade with the LOD dither.
30. **Grade after tone mapping, matched by numbers.** ASC-CDL + saturation + split tint on
    display values (Source 2 colour-correction style), per environment `post.grade`, neutral by
    default. Presets are tuned with `tools/grade_compare.mjs` (luma percentiles, chroma, casts
    per tonal band) against the Insertion 2 references instead of by eye alone.
31. **BC5 normals with variance in roughness; trimmed cards.** Every normal map is BC5
    (z rebuilt in the shader) and its mip variance is folded into the paired ORM roughness
    offline (r′ = (r⁴ + v)^¼, Source 2 style). Foliage/clutter cards are emitted as conservative
    8-sided outlines of their opaque texels, because the masked depth prepass under MSAA
    (per-sample depth on overdrawn cards) is the forest's dominant cost, not bandwidth.
32. **Action rendering stays in the forward pass.**
    - *Dynamic lights* (`renderer.dynamicLights`) are merged with the map's lights each frame;
      shadowed spots get a 1024² depth layer each (≤ 2, casters culled against the light
      frustum, 3×3 PCF), static lamps stay unshadowed (their occlusion is baked).
    - *Particles* are camera-facing quads lit once per corner in the vertex stage (cascade sun
      shadow + forward lobe, sky/probe-volume ambient, local lights with spot shadows, fog).
      They blend straight into the weighted MSAA target: colour = src·dstα + dst·(1 − srcα)
      (or + dst for additive) with the weight left untouched, which is exactly "over"/"add" in
      the resolved rgb/w — no separate transparent target or resolve. CPU sim, sorted back to
      front, one draw per blend mode. No soft-particle depth fade yet.
    - *Runtime decals* (bullet holes) share the static decal buffer, grid and per-pixel loop: a
      192-entry ring appended to the map's decals, grid rebuilt on the CPU when one is added.
      Hits come from `CollisionWorld.raycast` (grid DDA + Möller–Trumbore, per-triangle surface
      class: default → dust, metal → sparks). Crater relief is an analytic normal profile.
    - *Viewmodel* uses the world projection (muzzle effects line up in world space) with clip
      depth remapped into [0.75, 1] of reverse-Z (`I_VIEWMODEL` instance flag), so it never
      clips into walls; no shadow casting, no decals, excluded from probe capture.

## 5. Content pipeline

```
npm run textures   # tools/textures/generate.ts   → public/textures (+ manifest.json avg albedo)
npm run map        # Blender: build_testmap.py    → public/assets/testmap/*.glb, *.model.json, impostor +
                   #   tree-line textures, maps/testmap/map.json  (~25 s)
npm run bake       # Blender/Cycles: bake_lightmaps.py -- [--samples 256] [--size 2048] [--no-denoise]
                   #   → maps/testmap/lightmaps/{lm_0_{sky,rnm0,rnm1,rnm2,sun}.hdr, probes_*.bin, lightmapset.json}
npm run scanned    # tools/textures/scanned.ts  → Poly Haven 2K maps (.texture-cache) → 1K PNGs + manifest + material sizes
npm run compress   # tools/textures/compress.ts → public/textures/bc7/*.ktx2 + index.json (incremental, ~30 s full)
```
Order after content changes: `textures` / `scanned` → `map` → `bake` → `compress`. The BC7 folder is a
build output (gitignored); without it the engine loads PNGs and builds mips on the GPU.
`?bc=0` in the URL forces the PNG path for comparisons.

**BakeScene → BakeBackend → LightmapSet.** The bake reconstructs the scene from `map.json` + GLBs
(not from the authoring .blend), uses per-material bounce albedo (texture manifest × factor),
alpha-cutout foliage with partial transmission, packs object rectangles into 2048² pages,
bakes position/normal guides + the two components, runs a guided à-trous denoise, and writes
RGBE `.hdr`. Current bake: 34 lightmapped objects (1 010 scene objects incl. 900 LOD0 trees as
occluders), flat sky + 3 RNM + sunBounce + probe volume (28 611 probes), 256 spp, **~6 min** on
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

**Current (after items 1–6: directional lightmaps, probes, blend materials, BC7, LOD vegetation,
far scenery)** — 1920×1080, MSAA 4×, aniso 16×, GPU frame span (first pass begin → last pass end;
see the measurement note below):

| View | GPU span | Main tris | Draws | LOD0/1/2 trees |
|---|---|---|---|---|
| Road grazing | 7.2 ms | 0.25 M | 143 | 2 / 68 / 589 |
| Retaining wall | 7.2 ms | 0.36 M | 87 | 17 / 164 / 165 |
| Underpass | 6.3 ms | 0.31 M | 91 | 0 / 169 / 272 |
| Forest path | 10.6 ms | 0.43 M | 47 | 31 / 187 / 9 |
| Overview | 9.4 ms | 0.23 M | 138 | 0 / 45 / 616 |

CPU 0.3 ms/frame. Vegetation dominates: the forest path is 2.6 ms with trees hidden. MSAA
costs ~2× on the forest (5.6 ms without). Impostors are ~2.2× cheaper than LOD1 at the same
placement (overview: +3.3 ms vs +7.2 ms). Texture memory 156 MB (85 of 109 textures BC7).

**After the Nordic/season/clutter/grade/performance items** (1080p, MSAA 4×, overcast, GPU span):
road 8.2, retaining wall 9.2, underpass 7.5, forest path 10.7, overview 10.0 ms; *winter* adds
≈ 1 ms (snow layer). Ground clutter 0.4–1.1 ms with 5–8 k tufts in view. Texture memory 137 MB
(117/130 BC7/BC5) vs 520 MB uncompressed. **Action features** (road view): weapon + shadowed
flashlight + ~70 live particles + bullet decals add ≈ 0.5 ms (8.7 → 9.2 ms).

**Measurement note:** in the desktop app's browser pane, a hidden pane throttles presentation,
so wall-clock frame time is meaningless there, and per-pass timestamps overlap on TBDR (their
sum double-counts). `rill.bench()` now warms up, resets the timer and reports `gpuSpanMs`.

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
- Vegetation: impostors are a single side view on three planes (star-shaped from above); spruce
  sprays seen from directly below read as flat fronds; no wind. The crossfade dither is a static
  screen-space pattern (visible as stipple while a tree is inside a band; no TAA to hide it).
- Large scanned surfaces (2–3 m repeats over a 200 m road / lawns) show tiling at grazing
  angles; the macro layer helps but texture bombing / blend variety would be better.
- Far scenery is a ground-level illusion: from well above the map edge the tree-line strips and
  the flat canopy band between 145–210 m are visible as such.
- Lightmap bounce is baked for the reference sun direction (clear preset); other sun angles keep
  realtime direct light but approximate bounce.
- Hidden browser pane → presentation throttled (use `rill.shot` / `rill.bench`, read `gpuSpanMs`).
- Particles have no soft (depth) fade: smoke quads cut sharply where they intersect walls or
  the ground. The muzzle flash sprite sits behind the viewmodel's depth range (the barrel
  occludes its centre).
- The flashlight shadow uses a 1024² perspective map: fine at room scale, soft/aliased on far
  walls; no caster LOD selection beyond the camera's.
- The sandbox viewmodel is a placeholder (flat boxes/cylinders, no hands, no animation set).

## 9. Technical debt

- Lightmap atlas waste: ring-shaped charts (parapet caps) and curved path ribbons pack into
  their bounding boxes (building charts ~40 % empty, forest path 93 %). Split islands or use a
  better packer.
- Decal textures stay RGBA8 PNG (the decal atlas copies rgba8 layers); a BC7 atlas would need
  the layers compressed with matching formats.
- BC7 encoder is single-pass PCA + LS (no exhaustive mode 7/4, no perceptual weighting) — fine
  for these textures, worth revisiting for scanned content. Impostor/tree-line textures are
  re-rendered (and so re-compressed) on every map build.
- Tiling-wrap mip filtering is also applied to non-tiling textures (impostors, tree line).
- LOD selection has no hysteresis/crossfade; shadow LOD minimum is per cascade, not per texel size.
- Lightmaps are rgb9e5 raw (32 MB for one page with two components) — consider BC6H.
- Brute-force local light loop (fine for ~20 lights); clustered lighting when needed.
- CPU culling is flat (no BVH / sectors); no GPU-driven path yet.
- Pipelines are created synchronously on first use (hitch when toggling features) → use
  `createRenderPipelineAsync` + warm-up.
- `standard.wgsl` is still one large source; variants are specialised but the source should be
  split into smaller chunks as features grow.
- Collision is a simple sphere/ray controller over a uniform grid (no proper capsule sweep).
- Runtime decals share the static 8 m decal grid: a dense cluster of holes in one cell raises
  the per-pixel loop for that whole cell, and far hits stretch the grid extent. A separate
  fine-grained dynamic grid (or clustered decals) is the fix when it matters.
- Particles are simulated on the CPU and lit per vertex (fine for hundreds; thousands of
  large smoke quads would want GPU sim and per-pixel noise lighting).
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

Done: directional lightmaps, reflection probes, probe volume, blend materials, BC7, LOD
vegetation with impostors, far scenery, scanned materials, LOD crossfade, Nordic conifers,
season layer, ground clutter, graded mood presets, BC5 + card trimming, action rendering
(decisions 18–32).

1. **GPU-driven culling + Hi-Z occlusion** and cached far shadow cascades (the forest and the
   overview are the budget limits).
2. **Soft particles** (depth fade; needs a depth copy or a resolved depth before the particle
   draw) and a smoke texture atlas with lit normals.
3. **Anti-tiling for large scanned surfaces** (stochastic/texture-bombing or a second scan blended
   by macro noise).
4. **Vegetation polish:** wind (trunk sway + spray flutter, shared by prepass/shadow/lit vertex
   stages), octahedral impostors.
5. **Signage**: a text/logo atlas helper (store fronts, street and traffic signs) when real
   levels are built.
6. **Exposure**: optional local exposure for sun-vs-shade scenes.

## 12. Automation API (precursor of future editor/AI tools)

`window.rill` in the running app: `getScene()`, `setPreset(name)`, `setView(name)`,
`setCamera(pos, yawDeg, pitchDeg)`, `getCamera()`, `stats()`, `shot(name, w, h)` (writes
`screenshots/<name>.png` via the dev server), `shotViews(prefix, w, h)`, `bench(frames)`,
`stress(kind, n)`, `clearStress()`, `setSize(w, h)` (render-size override for benchmarks),
`step(n)` (advance n manual 1/60 s frames), plus the live `renderer`, `world`, `env` and
`sandbox` objects (`sandbox.toggleWeapon()`, `toggleFlashlight()`, `trigger = true` fires).
In the app: **L** flashlight, **X** weapon, left click fires while the mouse is captured. `bench()` reports `gpuSpanMs`; the stats overlay
shows per-LOD object counts and the BC7 share of texture memory.
