# Rill — editor document

Living document for the world-building phase: editor architecture, scene
format, command system, asset pipeline, Blender integration, known issues and
the plan towards AI tools. The renderer is documented in [ENGINE.md](ENGINE.md).

**Principle: the web scene is the authoritative map.** Maps
(`public/maps/<name>/map.json`) are authored in the web editor. Blender creates
and processes assets and bakes lighting; it no longer owns levels.

**Current milestone:** E2 world-building tools. Done: vegetation / rock scatter with a paint brush,
splines (paths, roads, kerbs, fences, walls, rail track), decal placement / painting, terrain
sculpting and ground painting, surface-aware light placement, bake export of generated geometry with
progress, map backups. E1 (editor foundation) is complete, see §11.

---

## 1. Architecture

```
public/maps/<map>/map.json  (MapDocument v2: authoritative, canonical JSON)
        │ load / save (dev server)
        ▼
SceneStore (src/engine/scene/scene.ts)        patches only; change notifications
   ▲ apply(patches)            │ subscribe
   │                           ├──► World (runtime, derived)  ── Renderer (unchanged pipeline)
EditorHistory ◄── exec(op) ◄──┤      flush() once per frame: in-place transform / flag updates,
(undo / redo / merge /         │      re-create on asset / material change, rebuild light /
 transactions)                 │      decal / sign / probe sets, lazy collision
   ▲                           └──► Editor UI (outliner, inspector, viewport overlays)
   │
operations (src/editor/commands.ts) ◄── viewport gizmos, inspector, outliner, asset drops,
   named + JSON params, self-describing      console, EditorTools (window.rill.editor.tools),
                                             later an MCP server / AI agent
```

* The **runtime** (`src/app/runtime.ts`) is shared by the editor (`index.html`)
  and the standalone game view (`play.html`): GPU context, renderer, World,
  Environment, player, sandbox, frame loop, automation API. The editor drives
  the same instance; play mode is not a separate build.
* **Nothing mutates the scene except operations.** UI code calls
  `editor.exec(op, params)`; operations compile to patches; the history applies
  them. A gizmo drag and an AI tool call go through the same operation.
* **Authoring state vs runtime state.** The document holds only authored data.
  Runtime state (instance slots, turnstile angles, bullet decals, collision,
  lightmap bindings, camera) lives in World / the runtime and is rebuilt from
  the document. Editor UI state (selection, camera, panel sizes, expanded
  outliner rows) is not saved in the map (localStorage).

## 2. Scene format (map.json v2)

```jsonc
{
  "format": "rill.map", "version": 2, "name": "testmap",
  "environment": { "preset": "november", "overrides": { "fog": { "density": 0.02 } } },
  "lightmaps": "lightmaps/lightmapset.json",
  "nextId": 10,                       // ID counter: generated IDs are never reused
  "entities": [
    { "id": "grp_architecture", "name": "Architecture", "type": "group" },
    {
      "id": "building_large", "name": "1960s slab block (lamellhus)", "type": "mesh",
      "semantic": "building", "tags": ["postwar"], "parent": "grp_architecture",
      "asset": "assets/testmap/building_large.glb",
      "transform": { "position": [27.5, 0, 26], "rotation": [0, 0.38, 0, 0.92], "scale": [1, 1, 1] },
      "static": true, "castShadow": true, "collision": true,
      "lightmap": { "resolution": [921, 1132] },
      "materialOverrides": { "plaster_ochre": "brick_red" }
    }
  ]
}
```

Entity types: `mesh`, `instances` (compact arrays), `light`, `decal`, `sign`,
`marker` (`viewpoint`, `spawn`), `reflectionProbe`, `probeVolume`, `group`, and
the procedural `scatter` and `spline` (§12). Types are in
`src/engine/scene/mapformat.ts`.

Common fields: `id` (stable, unique, never reused; lightmaps and tools key on
it), `name`, `semantic` (class for queries: building, streetlight, tree,
road...), `tags`, `parent`, `visible` (false: not rendered, no collision, not
baked; descendants inherit), `locked` (not pickable in the viewport; transform
and delete operations refuse it; other properties stay editable; descendants
inherit).

Rules:

* **Transforms are world space** on every entity. `parent` is the outliner
  hierarchy only. Editor transforms carry descendants along (the same world
  delta is applied to them), so the runtime never resolves a hierarchy and
  every entity's data says where it is. Groups have no transform.
* Rotation is a quaternion `[x, y, z, w]` in the file. Tools and the inspector
  use Euler degrees applied Y, then X, then Z (`src/editor/xform.ts`).
* Entity-local behaviour data (turnstile pivot / lane) is stored in the
  entity's local space, so it moves with the entity.
* **Canonical text** (`src/engine/scene/mapjson.ts`): numbers rounded to 6
  decimals, canonical entity key order, short objects on one line. One edited
  entity changes a few lines, so map diffs stay reviewable in git.
* Material semantics: materials may carry an optional `semantic` (concrete,
  plaster, asphalt...); the editor lists it. Entity `semantic` / `tags` are
  free-form, and the migration filled them where the generators knew them.

### Migration from the Blender-generated maps (v1)

`node tools/scene/migrate.ts <map> [--in v1.json]` (done for testmap, hasselby
and sandbox):

* Standalone unique world-space assets (buildings, walls, stairs, railings,
  props) got real pivots: the GLB vertex positions were shifted so the origin
  is the bottom centre of the bounds, and the offset moved into the entity
  transform. UVs are untouched, so the existing bakes stayed valid.
* Tiled world surfaces (terrain, roads, streets, paths) stay world-anchored.
  Their chunks share seam vertices bit-exactly, which per-chunk offsets would
  break. The editor pivots them about their bounds instead.
* `instances` groups (1,328 trees and rocks in the testmap; 1,252 lamps, cars
  and trees in Hässelby) became one mesh entity per instance under a group
  keeping the old ID.
* Outliner groups by category. Lamp lights are children of their posts, and
  facade signs, grime decals and interior lights are children of their building.
* The document-level spawn became the `player_start` marker.
* The world-surface groups (terrain, streets, distant scenery) are locked.

Render check, wind off, every viewpoint: at most 0.004% (testmap) and 0.011%
(Hässelby) of pixels differ by more than 8/255 (`node tools/regress.mjs`).

## 3. Operations and history

`src/editor/commands.ts`. Each operation is `{ name, description, params, run(ctx, params) → patches }`.
`listOps()` returns the schemas (the future MCP tool list).

| Operation | Purpose |
|---|---|
| `create_entity` | any entity from a partial definition (ID generated when missing) |
| `delete_entity` | entities + descendants |
| `duplicate_entity` | subtree copies with new IDs, optional offset |
| `set_transform` | absolute transforms `{ id: transform }`; descendants follow (gizmos, inspector) |
| `move_entity` / `rotate_entity` / `scale_entity` | deltas: world vector, Euler / axis-angle / quaternion, factors; pivot `median` / `individual` / point; world or local axes |
| `set_property` | whitelisted fields incl. nested (`light.intensity`, `decal.size`, `sign.text`...) |
| `set_visibility`, `set_locked`, `set_static_state`, `rename_entity` | conveniences over `set_property` |
| `reparent_entity`, `create_group` | hierarchy |
| `assign_material` | per-slot material override (`null` restores the asset's material) |
| `set_material_parameter` | per-entity inline material `{ inherits: current, param: value }` |
| `set_environment` | preset and / or overrides (document field) |
| `place_asset` | registry asset (+ prefab children) at a position / yaw |

Patches are `{ entity id, before, after, index }` or `{ doc key, before, after }`.
Undo applies `before` values in reverse order; removal indices restore
the document order. Patches compile from immutable entity snapshots, so every
operation is reversible without hand-written `undo` code.

`EditorHistory.exec(op, params, { merge })`: executions with the same merge key
fold into one entry until `seal()`. Used by gizmo drags, scrubbing a field and
arrow-key nudges. `begin(label)` / `commit()` / `rollback()` group operations
into one entry: the unit a future **AI changeset** will be accepted or reverted
as (each entry keeps its operation list, e.g. "placed 20 trees, moved 3 lamps").
`dirty` tracks unsaved changes; undoing back to the saved state counts as clean.

**Adding an operation:** `op({ name, description, params, run })` in
commands.ts. Stage changes with `PatchSet.set / remove / doc` and return
`ps.patches()`. Don't mutate entities: build new objects.

## 4. Runtime sync (World)

`World.flush()` runs once per frame before rendering:

* mesh, transform / flag / visibility change: instance model + flags + bounds +
  LOD scale + reflection-probe bits updated in place (a gizmo drag costs
  microseconds per entity);
* mesh, asset or material change: renderables re-created (async load; the
  latest document is applied when it lands);
* lights, reflection probes: sets rebuilt (probes are re-captured);
* decals: static decal list re-packed (atlas rebuilt only for new materials);
* signs: sign atlas + mesh rebuilt (coalesced; ~tens of ms);
* collision: marked dirty and rebuilt before play (`ensureCollision`, ~100 ms on
  the testmap). Editor picking doesn't use it.
* Instance slots of deleted renderables are recycled (`InstanceStore.free`).

**Baked lighting** stays valid only for unchanged static geometry. Moving
static meshes marks lighting stale (toolbar, inspector, `get_scene_summary`);
the old bake keeps rendering until **Bake lighting** runs. New lightmapped
entities (duplicates, placements) are probe-lit until the next bake (they keep
their `lightmap.resolution`, so the bake includes them).

## 5. Editor UI

Layout: toolbar · scene outliner | viewport | inspector · bottom tabs (Assets,
Materials, Environment, Debug, Console) · status bar. Panel sizes are draggable
and remembered.

| Input | Action |
|---|---|
| LMB | select (Shift add, Cmd/Ctrl toggle); locked geometry occludes but deselects |
| B / N / T / G | paint scatter / draw spline / place decals / sculpt terrain (§12) |
| RMB drag + WASD / Q E | fly (Shift fast, Alt slow, wheel while held = fly speed) |
| MMB drag | pan · **wheel** dolly to the point under the cursor · **Alt+LMB** orbit |
| Double-click / F | frame selection |
| Q / W / E / R | select / move / rotate / scale; **X** world / local axes |
| Snap toggle, grid select, `[` `]` | grid 1/64 m … 16 m; angle 1°–90°; Cmd/Ctrl while dragging inverts snap |
| Arrows / PgUp / PgDn | nudge one grid step (camera-aligned; Shift ×10) |
| Cmd+D / Del / Cmd+G / H | duplicate / delete / group / hide |
| Cmd+Z / Cmd+Shift+Z / Cmd+S | undo / redo / save |
| F5 (Shift+F5 from player start) | play / stop; in play: click to capture the mouse, Esc to release, L flashlight, X weapon |

* **Gizmos** are drawn on a 2D overlay and hit-tested in screen space:
  axis arrows, plane squares and a screen-plane centre for moving; rings for
  rotating (drag along the ring's tangent); axis boxes and a uniform centre for
  scaling (always local axes). A drag records one undo entry.
* **Picking** is a CPU ray cast over LOD0 triangles in each entity's local
  space, plus helper shapes: lights, markers and probes are screen-sized
  spheres, decals and signs are boxes. Debug tab toggles what is pickable
  (decals are off by default: they sit on every wall).
* **Selection outline:** the renderer's depth-tested wireframe, limited to the
  selected objects (`Renderer.highlight`), the only renderer addition the
  editor needed.
* **Assets tab:** registry assets by category with search, plus entity
  templates (point / spot light, decal, sign, viewpoint, reflection probe,
  group). Click then click in the view to place (Shift keeps placing), or drag
  into the view. Placement lands on the surface under the cursor (snapped to
  the grid in X/Z).
* **Materials tab:** drag a material onto a surface to assign it to that slot.
  The inspector lists every slot with a searchable material field and a
  per-object tint.
* **Environment tab:** the renderer playground (sun, sky, fog, exposure,
  weather, wind, grading, rendering, shadows, debug views). Slider edits
  preview live; when one ends, the map's overrides are recomputed and recorded
  as `set_environment` (undoable, saved with the map).
* **Console:** log of operations, warnings and Blender job output, plus a
  command line: `move_entity {"ids": ["bench_0"], "delta": [1, 0, 0]}`, `help`.

## 6. Play mode

**Play** hands the same world to the first-person controller. The world is
flushed, collision rebuilt if stale and turnstiles reset. The player drops to
the ground under the editor camera, or starts at `player_start`. **Stop**
restores the editor camera and clears runtime state (bullet decals, flashlight,
weapon, turnstile angles). Edits made in the editor are live in play
immediately, with no export step.

## 7. Assets

`public/assets/registry.json` (`src/editor/assets.ts`): `{ id, name, category,
path, semantic, tags, unique, defaults, children, bounds }`.
`node tools/scene/registry.ts` scans `public/assets`, keeps existing entries
(hand edits survive) and adds new ones: a category from the file name, entity
defaults and **prefab children** taken from how the maps use the asset (e.g.
the streetlight's spot light, stored in asset-local space), and bounds from the
GLB. `unique` marks map-specific pieces (terrain chunks, street surfaces,
building shells). They're hidden in the browser unless "Map-specific pieces" is
on. Categories: buildings, structural, props, vegetation, roads, lighting,
vehicles, terrain, environment, reference. Thumbnails are a later addition.

Entities reference assets by path (`asset`), so a registry entry is optional
metadata, not a dependency.

## 8. Blender integration

Blender is a companion tool for assets and bakes:

* **Bridge** (`tools/dev/editor_server.ts`, dev server): `POST /__blender/jobs
  { task, params }` starts a child process, `GET /__blender/jobs/<id>?from=n`
  streams log lines and the result, `DELETE` cancels, `GET /__blender/tasks`
  lists tasks. `bake_lightmaps` is implemented. `create_asset`,
  `modify_asset`, `generate_uvs`, `generate_lightmap_uvs` and `generate_lods`
  are declared and answer 501 until they exist.
* **Bake lighting** (toolbar / `bake_lighting` tool): saves the map if needed,
  runs `tools/blender/run.ts bake --map <map>` (Cycles; the bake reconstructs
  the scene from the saved map.json + GLBs, honours entity transforms and skips
  hidden entities), streams the log into the console and reloads the lightmap
  set in place (cache-busted) when it finishes.
* `npm run bake -- --out <dir>` writes a test bake elsewhere.
* The legacy whole-map generators (`npm run map`, `npm run map:hasselby`)
  refuse to run on an editor-owned map. `-- --regenerate` writes their v1
  output to `build/<map>.generated.json` (to re-import with migrate.ts) but
  overwrites their assets.

## 9. Tools API (towards AI)

`window.rill.editor.tools` (`src/editor/api.ts`): `call(name, params)`,
`list()`. These are structured operations, not mouse simulation, and they act
on the same objects as the UI.

| Tool | |
|---|---|
| `get_scene_summary` | counts by type / semantic, top-level groups, bounds, environment, lighting / save state |
| `get_selection`, `set_selection` | |
| `get_entity` | document + bounds, pivot, Euler, children, material slots, lightmap state |
| `query_entities` | by type, semantic, tag, text, parent subtree, world box, radius |
| `search_assets`, `list_materials` | |
| `capture_view` | renders an exact-size frame (no editor overlays) from `editor`, `spawn`, a viewpoint ID or an explicit camera; returns a PNG data URL + the camera; `save` writes `screenshots/<name>.png` |
| `get_camera`, `set_camera` | |
| `begin_transaction`, `commit_transaction`, `rollback_transaction` | changesets |
| `undo`, `redo`, `save_map`, `reload_map`, `bake_lighting`, `get_job`, `play`, `stop`, `list_operations` | |
| every operation of §3 | |

MCP later: a small server that forwards tool calls to the running editor (e.g.
over a dev-server WebSocket) can expose `list()` as its tool list unchanged.
Scoping ("selected area only", "keep building transforms") maps onto what
exists. Queries take a parent subtree or a world box. `locked` protects
transforms. A transaction is the reviewable change set. A future per-call scope
(IDs / categories the agent may modify) belongs in `EditorHistory.exec`.

## 10. Known issues / limitations

* Scatter and spline instances (trees, fence segments, sleepers) are probe-lit and
  have no collision; spline meshes are lightmapped only after a bake that
  includes them (Bake lighting does this).
* Editing the terrain under existing scatters re-drops them (500 ms after the
  edit); splines re-drape when edited (not when the ground under them moves).
* Gizmo: no view-axis rotation ring, no box (marquee) selection, no surface
  snapping while dragging (placement snaps to surfaces; dragging snaps to the
  grid).
* Inspector edits multi-selections per field (same type); numeric transform
  edits apply to the primary only.
* Moving world-anchored chunks (terrain, streets) works, but numeric rotation
  in the inspector turns them about the map origin (the gizmo pivots about
  their bounds).
* Lightmapped objects keep their old bake when moved (stale until a re-bake).
  Duplicates are probe-lit until a bake.
* Clutter (parked feature) is built once and does not follow edits.
* Signs are rebuilt as one atlas on any sign edit (fine for hundreds of signs).
* Asset browser has no thumbnails yet.
* Maps load whole. Very large maps would need streaming and outliner paging
  (the outliner is virtualised already).
* The production build (`npm run build`) has no dev server: saving and the
  Blender bridge need `npm run dev`.

## 11. Milestone E1 status

1. Current Blender test map represented in the scene format: done (testmap, Hässelby, sandbox; v2).
2. Same environment, no visual regression: done (≤ 0.004% / 0.011% pixels > 8/255).
3. Select / 4. move / 5. rotate / 6. scale: done (viewport picking, gizmos, inspector, operations).
7. Inspect properties: done (inspector).
8. Duplicate / delete: done (Cmd+D / Del, `duplicate_entity` / `delete_entity`).
9. Browse assets / 10. place assets: done (registry browser, click or drag to place, prefabs).
11. Change a material assignment: done (inspector slots, drag a material onto a surface, tint).
12. Save / 13. reload with the same result: done (round trip identical up to 6-decimal rounding).
14. Undo / redo: done (every edit; merged gestures; transactions).
15. Play / 16. stop: done (F5, same world, edits live).
17. Structured command layer: done (operations → patches → history).
18. Stable IDs: done (never-reused counter).
19. Programmatic viewport capture: done (`capture_view`).
20. Architecture for procedural and AI tools: operation registry, queries,
    transactions, entity types beyond meshes (groups, markers, probes; splines
    and scatter systems slot in as new entity types with their own runtime
    builders).

## 12. World-building tools (E2)

### Vegetation / rock scatter

A `scatter` entity holds a preset (`public/scatter/*.json`: species assets with
weights, scale ranges and sink depths, density per 100 m², clumping, species
patches, soft edges, allowed ground semantics, steepest slope), a seed and its
shape in local XZ: an `area` polygon plus an ordered `brush` list of circles
`[x, z, r, mode]` (paint / erase; the last circle containing a point decides,
so painting over an erased patch restores it).

`src/engine/scene/scatter.ts` evaluates it **deterministically and cell-locally**:
local space is cut into cells of one candidate each (cell size from the
density), and every cell hashes (seed, cell) into its jitter, acceptance,
species, yaw and scale. Painting, erasing or removing one tree changes only
those cells; the same document always gives the same forest; moving the entity
moves the trees rigidly. Instances drop onto the topmost collision surface,
which must have an allowed semantic (default `terrain`: trees keep off roads,
paths, roofs) and a slope under the limit. Measured: 423 trees evaluated and
instanced in 8.7 ms; a mixed forest over 12,000 m² reproduces the 40 / 30 / 15
/ 15 % pine / birch / spruce / undergrowth mix within 2 %.

Presets: `stockholm_mixed_forest`, `pine_heath`, `spruce_forest`, `birch_grove`,
`shrubs`, `park_trees`, `rock_outcrops`.

Editor: **Paint** tool (B, or click a preset in Assets › scatter): drag on the
ground to paint into the selected scatter (or start a new one with the chosen
preset), Shift erases, `[` `]` brush radius; one drag = one undo entry. Clicking
a tree selects its scatter with that instance: Del removes just that tree,
**Detach** turns it into an ordinary entity, **Convert to entities** replaces the
whole scatter by mesh entities. Inspector: preset, density, seed (Reroll),
slope, surfaces.

Operations: `scatter_vegetation { preset, area | center + radius, density?,
seed? }`, `paint_scatter { id, strokes: [[x, z, r]], erase? }`, `scatter_remove
{ id, keys }`, `scatter_detach { id, keys? }`.

### Splines

A `spline` entity: control points (local; their heights are references the
curve drapes under, so paths stay under bridges and off roofs), a preset
(`public/splines/*.json`), optional width, closed, drape.
`src/engine/scene/splines.ts` samples a centripetal Catmull-Rom curve by arc
length and builds the preset's parts:

* `ribbon`: a strip subdivided across so it hugs the ground (paths, roads);
* `profile`: a swept cross-section (kerbs, rails, low walls, ballast beds),
  flat-shaded, faces oriented outward automatically;
* `wall`: a vertical strip;
* `repeat`: an asset every N m, optionally chord-aligned and stretched so
  segments join (fence segments, sleepers, posts).

Output is world-space geometry with UV0 in metres and **one lightmap chart**
(UV1 rows for every ribbon / profile part), so splines bake like any static
mesh. Their geometry is in the collision (walkable, and scatters avoid it).
Presets: `path_asphalt`, `path_gravel`, `road_kerbed` (asphalt + granite kerbs),
`kerb_granite`, `fence_chainlink`, `low_wall`, `rail_track`. A 120 m rail track
with 200 sleepers builds in about 40 ms; paths take about 5 ms.

Editor: **Spline** tool (N, or a preset in Assets › splines): click points on
the ground, Enter / Esc finishes, Backspace removes the last point (one undo
entry for the whole drawing). A selected spline shows its centreline and
control points: drag a point (one undo entry), click to select it (inspector
X / Z, Remove, Del); with the Spline tool, clicks extend it from the nearest end.

Operations: `create_spline { preset, points, closed?, width?, drape? }`,
`modify_spline { id, points? | insert? | move? | remove?, closed?, width?, preset? }`.

### Decals

**Decal** tool (T, or a decal material in Assets › decals): click a surface to
place a decal aligned to it (+Z = surface normal; on walls +Y stays up so
streaks hang down), drag to paint a trail (spacing 1.2 m, random roll and ±30 %
size), `[` `]` size. Decals on an unlocked object become its children (they
move with the building); on locked world geometry they go to the Decals group.
Operation: `place_decal { material, position, normal?, size?, depth?, roll?,
opacity?, parent? }`.

### Baking generated geometry

**Bake lighting** first exports what map.json alone can't describe:
`exportBakeExtras` writes each spline mesh as GLB (`src/engine/assets/glbwrite.ts`)
with its lightmap chart, plus every scatter and spline-repeat instance (as an
occluder), to `build/bake/<map>/` via `POST /__editor/bake-extra`. The bake
(`bake_lightmaps.py --extra`) adds them to the Cycles scene; spline lightmaps are
keyed by entity ID like any other object. Verified with a test bake: two splines
lightmapped (34 → 36 objects) plus the scatter trees as occluders.

### Terrain sculpting and ground painting

A map's `terrainLayer` entity (one per map, "Terrain edits" under Terrain) holds an
ordered list of strokes `[op, x, z, radius, strength, value?]` in world XZ:
`raise` / `lower` (metres per dab), `smooth` / `flatten` (0..1; flatten to a
target height), `paint` / `unpaint` (the ground material's vertex-colour blend
layer: lawn → forest floor on the testmap, lawn → worn earth in Hässelby).
`src/engine/scene/terrainedit.ts` replays them into a height-offset field and a
blend field (0.5 m cells) over the original terrain; terrain meshes (semantic
`terrain`) move by the field at every vertex, normals tilt by its gradient
(unchanged where it is flat), blend weights shift by the paint field. Because
the fields are functions of world XZ, chunks sharing seam vertices stay
watertight; the terrain assets and their lightmap UVs are untouched (hide the
layer to compare with the original; undo restores it exactly). Appended strokes
update incrementally (only chunks under the new dabs are re-deformed); splines
re-drape and scatters re-drop on the new ground; lighting is marked stale and the
bake receives the sculpted chunks in place of the originals.

Editor: **Sculpt** tool (G): Raise / Lower / Smooth / Flatten / Paint ground /
Unpaint in the tool panel (top right of the view), radius (`[` `]`), strength;
Shift inverts raise / lower and paint / unpaint; flatten levels to the height
where the drag starts; one drag = one undo entry. Operation: `modify_terrain {
op, points | center, radius, strength?, value? }`.

Limits: the deformation is sampled at the existing terrain vertices (the testmap
terrain has ~2.5 m spacing, Hässelby ~1 m), so features smaller than that don't
appear; a remeshed heightfield terrain is the next step for fine sculpting.

### Dev sandbox (`?map=sandbox`)

The simplest test level, for trying tools without a heavy map: a 200 × 200 m
floor of 25 terrain tiles (`builtin:grid?x=40&z=40&seg=80&material=dev_ground`:
shared vertices every 0.5 m, vertex colours for ground paint), an empty terrain
layer, and a blockout set: orange walls, a tall block, 1 m and 2 m cubes, a
17 cm stair to a 1.7 m landing, a 12° ramp and a 1.8 m human reference.
Materials are Hammer-style measured dev textures (`dev_grey`, `dev_orange`,
`dev_dark`, `dev_blue`, `dev_green`: 25 cm / 1 m / 4 m lines;
`npm run textures -- dev_grey ...` regenerates them); `dev_ground` blends in
grass where the ground is painted. Viewpoints: Overview, Stairs and ramp, Open
field. No baked lighting (sky + sun only); 1.9 ms GPU.

### Lights and probes

Light templates (Assets › entities) placed on a wall stand 0.4 m off it, on a
ceiling hang just below it (spots point down), on the ground stand 2.5 m above
it. A selected point light shows its range, a spot its cone, a reflection probe
its box.

### Map backups

Every save copies the previous `map.json` to `backups/maps/<map>/` (local,
gitignored, newest 50 kept). **Backups…** loads one into the editor (unsaved
until you save); **Save as…** writes a new map that uses the source's lightmaps
until it is baked itself. Pristine copies of the three maps as migrated:
`backups/maps/*/original-2026-10-02.json` and git tag `maps-v2-original`.

### Bake flow

**Bake lighting**: saves, exports generated geometry (splines, scatters,
sculpted terrain), runs Cycles in the background and shows passes done / total
in the toolbar (7 passes per atlas page), then reloads the lightmaps in place.

### Remaining E2 / next

1. **Heightfield terrain** (remeshed, map-owned) for sculpting below the current
   vertex spacing; terrain material layers beyond one blend.
2. **Probe tools**: drag handles for reflection-probe boxes and the probe volume.
3. **Bake**: a quick preview-quality preset, per-map bake settings, highlighting
   objects whose bake is stale.
4. **Hot reload** of assets / materials / shaders from disk.
5. Then the AI milestone: MCP server, scope / lock enforcement per call,
   changeset review UI.

## 13. Files

| Area | Files |
|---|---|
| Scene format / store | `src/engine/scene/mapformat.ts`, `scene.ts`, `mapjson.ts` |
| Runtime world sync | `src/engine/scene/world.ts` |
| Shared runtime | `src/app/runtime.ts`; entries `src/editor/main.ts` (index.html), `src/main.ts` (play.html) |
| Operations / history | `src/editor/commands.ts`, `xform.ts` |
| Editor state | `src/editor/editor.ts` |
| Viewport / gizmo / picking | `src/editor/viewport.ts`, `gizmo.ts`, `picking.ts` |
| UI | `src/editor/ui/*.ts`, `src/editor/editor.css` |
| Tools API / bridge client | `src/editor/api.ts`, `bridge.ts` |
| Assets | `src/editor/assets.ts`, `public/assets/registry.json`, `tools/scene/registry.ts` |
| Dev server | `tools/dev/editor_server.ts` (+ `/__capture` in `vite.config.ts`) |
| Migration / regression | `tools/scene/migrate.ts`, `tools/regress.mjs` |
| Scatter / splines / terrain | `src/engine/scene/scatter.ts`, `splines.ts`, `terrainedit.ts`, `public/scatter/*.json`, `public/splines/*.json` |
| Tool options panel | `src/editor/ui/tooloptions.ts` |
| GLB export (bake extras) | `src/engine/assets/glbwrite.ts`, `src/editor/bridge.ts` |
