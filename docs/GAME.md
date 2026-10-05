# Rill — game document

Living document for the gameplay phase. The renderer ([ENGINE.md](ENGINE.md)) and the editor
([EDITOR.md](EDITOR.md)) are stable subsystems; gameplay adds to them, it doesn't rewrite them.

**Current milestone: G1 — movement + one gun + one enemy that feel exceptional.**
Not in G1: subway, narration, radio, missions, inventory, more weapons or enemy types, hordes,
holes, bosses, cinematics, saves, destruction (see the brief; G2–G5 come later, in order).

---

## 1. What exists (inspection, 2026-10-05)

| Area | State | Gap for G1 |
|---|---|---|
| Player | `engine/player/controller.ts`: raw pointer-lock look (`unadjustedMovement`), velocity walk/run/fly, wall push by 3 stacked spheres, 5 ground rays, 0.45 m step, smoothed step camera | no capsule or velocity clipping (corner jitter, sticky walls), no slope limit, no crouch, variable-dt integration, no landing / footsteps |
| Collision | `scene/collision.ts`: static triangle soup, 4 m XZ grid. Hässelby: 350k tris, raycast ≈ 30 µs, sphere push ≈ 2.7 µs | 2 surface classes (Default / Metal from `metallic`); each ray allocates a `Set`; no dynamic shapes |
| Weapon | `src/sandbox.ts` test harness: box-built carbine, hitscan, flash sprites + point light, smoke, sparks / dust, 2 bullet decals, sway / bob / kick spring | it's a proof of rendering, not a weapon: fire timing is frame-quantised, no recoil model, no audio, no data |
| Particles | `render/particles.ts`: CPU, 4 kinds (smoke, dust, flash, spark), cap 4096, lit per vertex | allocates per particle and per frame; no hard-edged debris kind; muzzle sprite is occluded by the barrel (viewmodel depth range) |
| Decals | `render/decals.ts`: 192-entry ring of runtime decals sharing the static grid | grid rebuilt and uploaded on every `addDecal` (needs one flush per frame); only concrete and metal holes |
| Viewmodel | instance flag: same projection as the world, depth squeezed into [0.75, 1] | no own FOV, so the gun stretches when FOV changes |
| Audio | none | everything |
| Animation | none: no skinning, glTF loader flattens nodes; per-frame instance transforms work (viewmodel, turnstiles) | multi-part rigs from GLB nodes |
| Physics | none beyond collision queries | ragdoll / impulses |
| Debug | lil-gui playground, stats overlay, `rill.step` / `shot` / `bench`, internal line renderer | public debug-line API, gameplay panel |
| Editor | play mode shares the runtime (`rt.hooks.update`), markers `viewpoint` / `spawn` | an `enemy_spawn` marker |
| Blender | installed; assets go out as GLB (`tools/blender/`) | weapon + enemy build scripts |

**Test area:** the Hässelby station forecourt at `player_start` (−67, 0, 10). Within 35 m:
brick facade, concrete viaduct bents, the glass station front, parked cars (paint, chrome,
glass, tyres), lamp posts and railings, kiosk panels, wood doors, tree beds (dirt), granite kerbs,
open paving to move around on, and the walkable station stair (17 cm risers) up to the platform.
The only map changes are gameplay markers (no geometry, so the bake stays valid).

## 2. Engine vs game

```
src/engine/…   generic: clock, input, collision + surfaces, audio, rigs, ragdoll, particles,
               decals, debug draw. No game rules.
src/game/…     G1: Game (wires systems into the runtime hooks), player feel, firearm,
               recoil, viewmodel, impacts, enemy, tuning panel, crosshair.
public/game/   data: player.json, weapons/carbine.json, enemies/<type>.json, impacts.json
public/audio/  sounds.json (sound events) + samples
```

The game is plugged in from `play.html` and from the editor's play mode, using the same hooks.
`src/sandbox.ts` is retired once the carbine replaces it (the flashlight moves to the player).

## 3. Missing generic capabilities (minimum for G1)

1. **Game clock:** fixed 120 Hz tick for movement, weapon and enemies, interpolated camera
   position, time scale (slow motion) and a debug FPS cap. Mouse look stays per frame: it is
   never ticked or smoothed.
2. **Character collision:** capsule-vs-triangle depenetration with velocity clipping, a slope
   limit, ground normal, ceiling test (uncrouch / jump). Allocation-free raycasts that can pierce
   (bullets through glass).
3. **Physical surfaces:** `"surface"` in material JSON (inherited; a name-based fallback for the
   162 existing materials): concrete, brick, stone, asphalt, plaster, metal, wood, glass, soil,
   grass, flesh. Stored per triangle and returned by every query, like Source's surfaceprop.
4. **Audio (Web Audio):** buses (master → sfx / ambience / music / voice), sound events in
   JSON (layers, variations, pitch / gain jitter, per-layer delay, 2D or positional, distance
   low-pass), voice limits and priorities, environment reverb sends (impulse responses generated
   for outdoor / room / tunnel), sample-accurate scheduling.
5. **Rigs:** a GLB loaded as named parts with a transform hierarchy, posed per frame into
   instance slots. Used by the gun (bolt, magazine, trigger) and the enemy (body parts).
6. **Ragdoll:** Verlet particles with distance constraints, colliding through `pushSphere` and
   ground queries. Roughly 300 lines; cheap enough for hordes later.
7. **Small renderer additions, each regression-tested** (`rill.shotViews` + `tools/regress.mjs`):
   viewmodel projection with its own FOV, viewmodel-space particles (fixes the flash occlusion),
   a debug-line API with lifetimes, a `debris` particle kind, pooled particles, and decal
   uploads batched once per frame.

## 4. Decisions

- **No physics library in G1.** Rapier would bring a character controller and ragdolls, but it
  duplicates the 350k-triangle world in WASM (~2–3 MB), and that copy must be rebuilt in step
  with editor edits. G1 needs one capsule, rays and one ragdoll, all of which the existing
  collision handles. Evaluate Rapier against Jolt at G2/G3, when physics props and many ragdolls
  matter.
- **Procedural rigid-part animation in G1.** The bolt cycle is derived from the fire rate, so it
  always matches the tuned RPM. Hit reactions are springs per joint, which respond faster and
  more directly than canned clips. Skinned meshes and clips (and GPU skinning or vertex-animation
  textures for hordes) are G2's first engine item.
- **Hands:** rigid gloved hands only if they look right. Otherwise the gun stays alone for now.
- **Firing:** hitscan from the eye. Shots fire at exact sub-tick times (accumulator), so 700 RPM
  stays 700 RPM at 30 or 240 fps. Audio is scheduled with a constant offset, which keeps the
  full-auto rhythm even. Nothing waits for an animation.
- **Recoil in three channels:**
  - **Aim kick:** moves where bullets go. It follows a learnable per-shot pattern plus a little
    noise, and recovers, but never undoes the player's own pull-down.
  - **View punch:** a visual-only camera spring.
  - **Weapon kick:** springs in weapon space (kickback, muzzle rise, roll).
  All channels use exact damped-spring steps, so they behave the same at any frame rate.
- **Camera:** no head bob by default (the gun carries the walk cycle), a landing dip, a smooth
  crouch transition, separate world and viewmodel FOVs.
- **Weapon:** a compact 5.56 carbine with a Swedish flavour (Ak 5-like, which fits 1993
  Stockholm). Full auto at ~700 RPM, 30-round magazine. Reload comes after firing feels right.
  ADS is postponed.
- **Enemy:** one root-vegetable walker (bulb body, head with leaf tuft, root arms and legs),
  built in Blender. Each part has a capsule hitbox, giving head / torso / arm / leg regions. It
  pursues in a straight line (navigation is G2). Impact feedback is a per-enemy profile:
  particles, colours, sounds and splat decals.
- **Sound assets:** none exist. Placeholder layers are synthesised offline (a node script writes
  WAVs to `public/audio`; they are ours and committed). The repo is public, so licensed libraries
  go into a gitignored `public/audio/local/` that overrides placeholders by name.

## 5. Plan (each step ends with: run it, test it, look at it, fix the obvious)

| Step | Deliverable | Checks |
|---|---|---|
| 1 Player | game clock; capsule controller with run / sprint / crouch / jump, slope and stair handling; landing response; FOV and sensitivity settings; gameplay panel skeleton + `player.json` | scripted inputs replayed at 30 / 60 / 120 / 240 fps give matching paths; corners, kerbs, station stair, slopes, ceilings |
| 2 Fire | carbine state machine (semi / auto, sub-tick timing, spread); surfaces in materials; per-surface decals; trace debug lines; hit readout (object, point, normal, surface, region, damage); input→fire latency readout | shot count and spacing identical across frame rates; every surface class hit on the forecourt |
| 3 Gun | Blender carbine with moving parts; viewmodel FOV; motion layers (look inertia, move sway, bob, landing, sprint pose, idle breathing); the recoil model | frame-stepped captures of a burst; recoil pattern plot |
| 4 Feedback | audio engine; layered gun sound (mechanics, blast, tail, distant) with reverb sends; muzzle flash (viewmodel-space sprite, light, smoke); impacts per surface; shell casings; footsteps per surface | flash on the exact shot frame; audio vs frame timestamps logged |
| 5 Enemy | Blender model, rig, pursuit, part hitboxes, health, `enemy_spawn` marker at the forecourt, respawn | hits register on every part; collides with player and world |
| 6 Reactions | directional per-part flinch, stagger meter, squash, juice / chunk particles and splat decals; Verlet ragdoll death carrying the killing impulse | slow-motion review; reactions never stop pursuit for long |
| 7 Tuning | panel complete: live values, reset to defaults, save to `public/game/*.json`, slow motion, FPS cap, debug toggles | save round-trip |
| 8 Iterate | playtest passes with you, then a basic reload; list of G2 engine gaps | the brief's 18 success criteria |

Throughout: the editor's play mode keeps working, renderer regression shots stay unchanged
except for the viewmodel, and performance is benched before and after (no per-shot or
per-frame allocations, bounded effects).

## 6. Status

**Step 1 — player (done, 2026-10-05).**
- `engine/core/clock.ts`: fixed 120 Hz clock with exact tick times.
- `engine/core/spring.ts`: closed-form damped springs.
- `engine/input/input.ts`: one listener set, tick-consumed press edges with timestamps, per-frame mouse counts, scriptable.
- `engine/physics/character.ts`: floating-capsule motor. Exact capsule-vs-triangle contacts (`CollisionWorld.pushCapsule`), velocity clipping, skin contacts, 9-point walkable ground probe, step reporting.
- `engine/player/controller.ts`: rewritten on top of the motor.
- Game layer: `src/game/game.ts` (clock owner, frame-rate test), `config.ts` (public/game/*.json, save through `/__game/save`), `ui/panel.ts` (tuning panel with changed-value marks), `ui/hud.ts` (readout).

Measured on Hässelby:
- The scripted input run gives bit-identical positions at 30 / 60 / 120 / 144 / 240 fps (`rill.game.testFrameRates()`).
- The station stair climbs at a constant 4.6 m/s.
- Wall slides run at the exact projected speed (2.96 m/s at 40°) with no grinding. The player stops dead in corners, with no jitter.
- Jump peak 0.58 m (target 0.6). Crouch speed reached within 0.1 s.
- One tick costs ≈ 0.05 ms.

Raycasts no longer allocate (per-triangle stamps instead of a Set). The editor's play mode uses the same controller through `update(dt)`, which runs its own clock.

**Step 2 — firing (done, 2026-10-05).**

Generic engine pieces:
- `scene/surfaces.ts`: surface classes. Materials declare `"surface"` (written into 72 material files, inherited by the rest; a name-based guess covers new ones), stored per collision triangle.
- `debug/draw.ts`: timed debug lines through `Renderer.debugLines`.
- `render/lightpulses.ts`: pooled flash lights, each shown for at least one frame.
- Runtime decal grid: the ENGINE.md §9 item.

Game:
- `combat/hitscan.ts`: world + target hitscan with glass piercing. Pooled results, 8 µs per trace on Hässelby.
- `weapon/def.ts`: data in `public/game/weapons/carbine.json`.
- `weapon/firearm.ts`: trigger with semi / auto, exact sub-tick cadence, magazine and reload timer, bloom spread with movement / air / crouch terms, deterministic RNG, trigger→shot latency.
- `fx/impacts.ts`: `public/game/impacts.json`, a per-surface decal, particles and flash, with `like` + tint inheritance.
- `weapon/viewmodel.ts`: the box carbine, still a placeholder.
- `ui/crosshair.ts`: spread ticks and an optional hit tick.
- Panel: weapon folder and debug toggles (traces, decals, crosshair).

Measured:
- Held fire gives the same shot count and shot times at 30–240 fps (85.7 ms apart at 700 RPM).
- Forecourt hits resolve to brick, concrete, metal, stone, tile, grass, asphalt and plaster; glass is pierced.
- Renderer regression against `e3b`: views 0 and 4–9 sit at baseline noise. Hall views 1–3 vary as much between two runs of the same build.

Note: the controller now sets the camera FOV from tuning (95° horizontal = 63.1° vertical). Captures that must match older baselines set `rill.player.tuning.fov = 93.78` (62° vertical).

**Step 3 — gun, motion, recoil (done, 2026-10-05).**

Engine:
- `scene/rig.ts`: rigid-part rig, allocation-free posing into instance slots.
- `assets/gltf.ts` `loadGlbParts`: top-level nodes become parts around their pivots, with `extras.parent` for hierarchy.
- Viewmodel projection with its own FOV: `Frame.vmViewProj`, used by the standard vertex path and by particles flagged `viewmodel`. This fixes the old flash-behind-the-barrel issue.
- Particle `stretch` flag and anchors (a flash follows the moving muzzle).
- `Camera.viewmodelFovY`.

The gun:
- `tools/blender/build_carbine.py` (`npm run weapon [-- --preview]`): Ak 5-flavoured carbine with olive paint, black steel and green polymer. Parts: receiver, bolt (carrier + reciprocating charging handle), trigger, magazine, plus `muzzle` / `eject` markers. 9k triangles.
- One 2048² atlas from Cycles bakes: AO, an edge mask from a bevel-normal difference, and material ids, composed into worn paint / polished steel edges / cavity grime.
- `public/materials/weapon_carbine.json`.

Recoil (`weapon/recoil.ts`):
- Aim kick, applied in ticks over `kickTime`, follows a learnable sin pattern plus noise.
- First-shot scale and ramp.
- A permanent share goes into the player's angles. The recoverable share returns after a delay that is longer than the shot interval.
- `absorb`: pulling against the kick consumes it, so recovery never overshoots.
- View punch is a visual-only spring. The crosshair counters it so it marks where bullets go.

Viewmodel (`weapon/viewmodel.ts`):
- Layers: base pose, crouch, sprint pose, look inertia springs, figure-eight bob on the footstep phase, strafe roll, acceleration lag, air lift/pitch, landing kick, breathing, shot kick springs.
- Kick impulses are applied at their exact shot times (segmented closed-form steps).
- The bolt cycles over exactly one shot interval. The trigger follows the finger.

Latency: a trigger press is fired at frame start (`Firearm.pressNow`) instead of waiting for the next tick. The shot lands on the first frame after the press at 60 and 240 fps. Held fire keeps the exact tick cadence, and the frame-rate test stays identical (≤ 14 µm).

**Step 4 — sound, brass, impacts (done, 2026-10-05).**

Engine:
- `audio/audio.ts`:
  - Web Audio buses into a master compressor.
  - Convolution reverbs per acoustic environment, with synthesised IRs (`audio/reverb.ts`: outdoor / room / tunnel).
  - Layered events from `public/audio/sounds.json`: variations, gain / pitch jitter, delay, per-environment layers, lowpass, chance.
  - Positional voices with distance rolloff, air-absorption lowpass and speed-of-sound delay (beyond 12 m).
  - Per-event voice caps that fade out the oldest instance.
  - Sample-accurate `at` scheduling; cancellable handles.
- Runtime decal materials can be registered (`World.addRuntimeDecalMaterials`).
- The particle system no longer allocates per particle or per frame: pooled records, in-place compaction, reused upload arrays.

Game:
- `tools/audio/generate.ts` synthesises 58 placeholder WAVs (`npm`-free: `node tools/audio/generate.ts`):
  - carbine blast ×4, mechanism ×3, outdoor tails ×2, room tail, dry fire;
  - brass;
  - impacts for concrete, metal (+ ricochet), wood, glass, soil, flesh;
  - hard / soft / gravel / metal footsteps and landings.
- `audio/gameaudio.ts`:
  - The first shot of a pull plays immediately.
  - While the trigger is held, the next shot's sound is scheduled about a frame ahead at its exact cadence slot, and the shot is committed (`Firearm.committedUntil`). Measured gaps are exactly 85.7 ms at a steady 60 fps, at 4–24 ms random frame times and at 30 fps. A tap gives one shot and one sound.
  - An acoustic probe (13 rays every 0.2 s) blends outdoor / room reverb.
  - Footsteps and landings per surface (`impacts.json` `step`), impacts per surface (`sound`, delayed by bullet flight), brass per surface.
- `fx/shells.ts`: pooled casings ejected from the rendered port (world-equivalent point, the gun's axes, plus the player's velocity). They spin, bounce with restitution and friction, settle flat and play tinkles.
- Barrel smoke wisps after sustained fire.
- Tinted per-surface bullet holes: brick, wood, plaster, and a dark one for soil / asphalt.
- Panel Audio folder; audio readout (state, output latency, voices, room share).

**Step 5 — the enemy (done, 2026-10-05).**
- `tools/blender/kit.py`: the modelling and bake helpers, now shared by the carbine and the creature.
- `tools/blender/build_beet.py` (`npm run enemy [-- --preview]`): the beetroot walker *Rödbetan*.
  - 10 rig parts parented through GLB extras: body bulb, head with slit mouth, sunken eyes and leaf crown, root arms with root fingers, legs with splayed root toes. 3.7k triangles.
  - 1024² atlas baked from AO, ids and a height pass: waxy skin with pores and bloom, soil low down.
- `Rig.add` orders parts parents-first. `physics/shapes.ts` adds ray–capsule, ray–sphere and closest-on-segment tests.
- `enemy/def.ts`, data in `public/game/enemies/beet.json`: capsule hitboxes per part, damage / stagger per region (head ×2.6), movement, gait, attack timing, reactions.
- `enemy/enemy.ts`:
  - Ticked on the game clock: the character motor (same as the player's), and a state machine idle → chase (walk / hurry beyond 9 m) → attack (wind-up, strike, recover) / stagger / dead.
  - It turns before it strides. It pushes the player aside (it is heavier).
  - Per frame: interpolated root; procedural gait (leg swing, knee bend on the swing leg, opposite arm swing, bob, roll, lean); a head that tracks the player; attack swing with body twist.
  - Per-part reaction springs (the hit part and its parents get angular kicks along the shot, plus squash), body kick, knockback.
  - Hit capsules in world space.
- `enemy/manager.ts`: spawns at `enemy_spawn` markers (farthest from the player). One alive at a time; respawn after 4 s; corpses stay 20 s.
- Hässelby map: `grp_gameplay` + `enemy_spawn_station` at the station doors, added through the editor's `create_entity` / `save_map`. The diff is only those entries. The creature walks out of the T-bana entrance.
- Shots on enemies: region damage, the flesh impact profile (magenta juice droplets and mist), a flesh sound, the crosshair hit / kill tick.
- A connected strike kicks the player's view, shoves the player and plays a thud.
- Panel Enemy folder (health, movement, reactions, region damage, attack, AI on/off, hitboxes, spawn / remove); readout line.

**Step 6 — reactions and death (done, 2026-10-05).**

Engine:
- `physics/verlet.ts`: Jakobsen Verlet body.
  - Equality and `min` (joint-limit) links, sphere collision against the world through `CollisionWorld.pushSphereOut` (full push, allocation-free).
  - Contact friction, contact events with the pre-step impact speed, sleeping.
- `Rig.commit` writes externally simulated worlds; `Rig.restOrigin`.
- Particle kind `debris`: hard, lit, irregular chunks that keep their opacity. A per-particle `floor` makes chunks land and bounce.
- `splat` decal texture recipe (`npm run textures -- splats`).

Game:
- `enemy/ragdoll.ts`, data-driven from `EnemyDef.ragdoll`:
  - 16 joints, a rigid torso, neck and head stick, arm and leg chains with `min` limits.
  - Built from the posed rig at the moment of death (body velocity, the killing impulse plus a shove at the hips). Parts are oriented from particle frames.
  - A killing headshot pops the head off (its links to the body break) with a neck spray.
  - Shooting the corpse pushes it.
  - Corpses sink into the ground over their last 1.5 s.
- Stagger: when the stagger meter trips, the creature stumbles back along the shot, rocks back and throws its arms up, then recovers.
- `EnemyDef.impact` profile, so later enemies (tomato, cucumber, onion) bring their own:
  - juice colour, chunk count and colour;
  - a splat sprayed onto a wall within reach, else onto the ground behind (decal `decal_beet_splat`);
  - a death burst and extra chunks;
  - a landing splat and wet thud when the body comes down (contact event, with a time fallback).
- Colours were tuned under the November exposure: juice is nearly black-purple, chunks vivid; the splat is semi-gloss (a glossy stain mirrored the bright sky and read pink).

Measured: about 0.27 ms of simulation per frame with an active ragdoll; it sleeps once it settles. The frame-rate test stays identical with the enemy present.

**Step 7 — tuning tools and editor play (done, 2026-10-05).**
- Recoil pattern plot (`ui/recoilplot.ts`, Debug › Recoil pattern plot): every round of the current pull, in degrees from the aim at the first shot. It shows pattern, spread and the player's compensation.
- `Game` has `init` (load), `begin` (session: optional teleport to the player start, an enemy at a spawn marker, the gun shown) and `end` (enemies, casings, decals, traces and lights cleared, the gun hidden).
- The editor's play mode (F5) now runs the game layer:
  - it is loaded in the background at editor start; a session begins on Play and ends on Stop, and the map stays clean;
  - a Gameplay tab holds the same tuning panel;
  - the crosshair, readout and plot overlay the viewport only.
- Controls hints updated (play page and editor).

Panel summary (play page right column, editor Gameplay tab):
- Player: look, movement, jump / crouch, camera feel, body.
- Weapon: fire, spread, recoil, view punch, weapon kick, viewmodel motion (offset / rotation / pivot / crouch / sprint vectors), mechanics.
- Enemy: health, movement, hit reactions, region damage, attack; AI on/off, hitboxes, spawn / remove.
- Audio.
- Debug: time scale, FPS cap, readout, traces, decals, crosshair spread, hit marker, recoil plot, spawn, fly, frame-rate test.

Every config folder has Save (writes `public/game/*.json`), Revert to file and Code defaults. Values that differ from the file are marked •.

## 7. Known limits to carry into G2

Written up as G1 progresses: skinning and clips, navigation, enemy broadphase (spatial hash),
physics library choice, particle GPU simulation, the decal grid under many impacts.
