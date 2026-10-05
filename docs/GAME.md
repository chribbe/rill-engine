# Rill — game document

Living document for the gameplay phase. The renderer ([ENGINE.md](ENGINE.md)) and the editor
([EDITOR.md](EDITOR.md)) are stable subsystems; gameplay adds to them, it doesn't rewrite them.

**Current milestone: G2 — the tomato horde** (plan in §8). G1 (movement, the gun, one enemy) is
done; the gun was signed off on 2026-10-05 ("it looks juicy").
Not yet: subway, narration, radio, missions, inventory, more weapons, holes in the ground (later in
G2's direction, not in its first steps), bosses, cinematics, saves.

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

**Step 8 — reload, verification (done, 2026-10-05; playtesting with you is next).**
- Reload (`WeaponDef.reload`, a timeline in data):
  - Tactical reload 1.75 s and keeps the chambered round (31). Empty reload 2.3 s: magazine out, in, then the charging handle racked.
  - Auto reload after the dry click on an empty pull. The magazine is finite by default now.
  - The viewmodel cants (pose in data), the magazine drops and seats, the handle racks and slams home. Each beat jolts the gun.
  - Synthesised foley: magazine out / in, rack, release.
  - Minimal ammo readout: only when low or reloading.
- Verification on Hässelby at 1280×720:
  - GPU 4.52 ms with the gun and the enemy on screen, identical without them; CPU about 1.1 ms per frame (simulation 0.1–0.3 ms).
  - Renderer regression (`?game=0`, FOV matched) against `e3b`: every view at baseline noise.
  - The frame-rate test is identical at 30–240 fps.
  - The editor's play mode works and leaves the map clean.

**Polish pass 1 — gun and shooting (2026-10-05, after your first playtest).**
Your notes: the gun feel is not there yet; smoke dies too fast when you wait and looks odd while running; the front sight floats; the gun looks plastic; more and better effects, "AAA but Source". The enemy is parked (off by default: the panel toggle "Enemy on (spawns, AI)") so the pass is only about the gun.
- Model (`npm run weapon`, 20.6k triangles):
  - Front sight: gas block → sight tower → post and protective ears are one connected piece (the post no longer floats). The rear sight drum sits on a base block with swept wings.
  - New parts: a pressed spine on the receiver cover, rivets, takedown pins, magazine release, selector, brass deflector, vented handguard (2 × 5 vents per side), finger-grooved pistol grip, trigger-guard band, barrel cap ring, bayonet lug, sling swivel, seams.
- Material: a generated normal map (orange peel, parkerised grain, stippling, scratch grooves); matte olive enamel (roughness ≈ 0.74). Chips go through to dark steel only on exposed edges and deep scratches. Light scuffs just dull the paint; grime sits in creases, dust over it.
- Muzzle flash: a sprite atlas (`npm run textures -- fx`, `public/textures/fx/muzzle_flash.png`): 4 star variants seen from behind, 4 side plumes rooted at the muzzle.
  - Layered as an orange star, a white-hot inner star and a stretched forward plume.
  - A flickering light pulse per shot.
- Smoke:
  - Per-shot smoke inherits the shooter's velocity, so running doesn't leave a trail behind the gun.
  - An ejection-port puff with every casing.
  - After sustained fire, barrel smoke curls up from the muzzle for 2–4 s. It is attached to the gun and leans back against your movement.
  - Soot now holds its body and thins over the back of its life instead of popping out.
  - Gun smoke and dust follow only 15% of the map wind (`impacts.json` `wind`). At full strength the forecourt breeze (≈2.4 m/s) blew it away in a second: the "goes out too fast" you saw.
- Impacts (`public/game/impacts.json`):
  - Concrete: a fast stretched jet of dust, a billowing puff, a lingering haze (3–4 s), falling fines, chips that land and bounce, a few sparks.
  - Metal: a flash sprite, a spark shower, smoke and flecks, a brighter light pulse.
  - Wood splinters, glass shards and glitter, soil clods; brick / stone / plaster / tile / asphalt inherit concrete with a tint.
  - Repeated hits on one spot add less haze (crowding), so a burst into a wall thickens the air gradually instead of making a fog wall.
  - Big puffs slide towards the eye by part of their radius, so they no longer cut into the wall with a hard edge. That's a cheap stand-in for soft particles.
- Recoil: a burst builds a ride-back pose (the gun settles back and up under sustained fire, `kick.burst*`). The first shot is 15% stronger, plus a small sideways jitter per shot.
- Verification: typecheck clean; the frame-rate test is identical at 30–240 fps. Renderer regression (`?game=0`) against the step-8 shots is unchanged except the hall views' run-to-run exposure noise. The editor's play mode works and restores the wind scale on stop.

**Polish pass 2 — arcade push (2026-10-05).**
Your notes: much better. Smoke is far too visible after shooting (fine while shooting). The reload should be snappier, harder, more decisive, cartoon action hero. Exaggerate the shooting: the game is more Helldivers / Starship Troopers than realistic.
- New `fx` block in the weapon data (panel: "Shot effects (visual)"):
  - flash size and light;
  - tracers (every N rounds, speed, length, width, colour, brightness);
  - a field-of-view punch per shot;
  - muzzle smoke per shot, barrel smoke after firing;
  - a view jolt on the reload beats.
- Smoke after firing:
  - Barrel smoke is a faint hint: only after long fire (heat > 8 rounds), cooling faster the hotter it is. A short burst leaves nothing; a full magazine leaves a few seconds of faint wisps.
  - Per-shot muzzle smoke lives 0.7–1.4 s (was 1.6–3 s). The impact haze is a little shorter.
- Shooting, exaggerated:
  - Flash ×1.35 with a much brighter light (900 cd, 16 m).
  - View punch about ×1.6 (pitch 1.05°, roll 1.1°), a 0.9° FOV kick per shot.
  - Weapon kick about ×1.4 (back 4.8 cm, rise 4.6°), a stronger burst ride.
  - Concrete hits: a hit-flash sprite and light, 8 sparks, a bigger dust jet, more chips. Metal: a bigger flash and 26 sparks.
  - Aim recoil (where bullets go) is unchanged, so control stays where it was.
- Tracers: a new engine particle kind `tracer`, a ribbon along the true 3D velocity at constant brightness, at least about 4 px wide at any distance.
  - From behind the gun, a round flying where you aim projects to a dot. The visible part is the muzzle end of its path, which the moving streak has already left when first drawn. So each tracer is one frame of beam leaving the muzzle plus a 10 m streak flying on at 140 m/s (visual speed; hits stay hitscan).
- Reload (tactical 1.15 s, empty 1.5 s; was 1.75 / 2.3):
  - The pose is a spring: the gun whips into the cant within about 60 ms, holds, and snaps back to ready with a small overshoot 0.2 s before the end.
  - It now rolls the other way, so the magazine well comes towards the middle of the screen.
  - The magazine is ripped out and tumbles away; the new one is driven up, accelerating, and slammed home.
  - Every beat jolts the gun hard: rip out, slam (up-left, 5°), handle yank, bolt slam, ready pop. The slams also knock the view.
  - Reload foley is louder and a little higher-pitched. The magazine seat and the bolt slam have a low thump.
- Verification:
  - Typecheck clean.
  - Renderer regression (`?game=0`) is pixel-identical to the step-8 shots in all 10 views.
  - The frame-rate test is identical at 30–240 fps with every new feature on.
  - Known quirk: the first frame-rate test after a page load can show about 3e-5 m drift in the reference run, with or without these features; repeat runs are exact.

**Brass (2026-10-05).** You asked whether the empty shells were missing. They were ejected sideways at about 3 m/s, 0.4 m from the eye, so each was on screen for about 2 frames, pale and thin.
- Cases now leave the port up and a little forward (gun space: right 1.15, up 1.75, forward 0.55 m/s, ±25%) and arc through the upper right of the view for about 0.35 s, tumbling.
- They're drawn 1.3× (collision stays the real case) in a saturated brass gold.
- They litter the ground: a pool of 160, each staying 40 s.
- All of it is tunable in the panel ("Brass …" under Shot effects).
- The frame-rate test quirk above is not only a first-run effect: an occasional test call's reference run lands 2.71e-5 m off (always that value, with or without these features). Back-to-back runs in any rate order are exact. It's a state carried into the test call, still to be found.

**Flash light in the dark (2026-10-05).** You noticed the gun's normal map going very visible when shooting at dusk.
- Cause: the flash light sat 0.3 m ahead of the muzzle, raking along the gun at a grazing angle.
  - Dusk exposes about 6 stops higher than the daytime look the flash was tuned in (EV 2.6 vs about 8.8).
  - So it was about 100× the ambient on the gun and clipped. Every bit of relief (per-texel grain in the normal map, worn chips) became hard white sparkle.
- Fixes, all outside the renderer:
  1. The flash light sits 0.9 m ahead of the muzzle (larger source radius), so it lights the world and the front of the gun rather than skimming the receiver.
  2. Calmer normal map (`npm run weapon`): no per-texel white-noise grain in the height, softer orange peel and stippling, strength 2.2 → 1.6. Scratches and chipped edges keep their relief.
  3. `LightPulses.gain` (engine, one multiplier) is set by the game each frame from exposure. Below `fx.flashRefEV` (8.5), flash and impact lights keep only `fx.flashDark` (0.35) of the extra relative brightness the higher exposure would give them.
     - Dusk: gain 0.07. The flash still lights the scene noticeably more than in daylight, without clipping.
     - Daytime presets: gain 1, unchanged.
     - The flash sprites themselves are not scaled.

### How to play / test
- `npm run dev`, open `http://127.0.0.1:5173/play.html?map=hasselby`, click to capture the mouse.
- Controls: WASD, Shift sprint, Alt walk, C / Ctrl crouch, Space jump, LMB fire, R reload, L flashlight, F fly, H hides the panels.
- Tuning panel: right column on the play page, the Gameplay tab in the editor. Save writes `public/game/*.json`.
- `rill.game` in the console: `testFrameRates()`, `enemies.spawn(rill.player)`, `showTraces`, `showHitboxes`, `clock.timeScale`.
- Rebuild assets: `npm run weapon`, `npm run enemy` (`-- --preview` renders studio shots to `screenshots/`). Sounds: `node tools/audio/generate.ts`. Splat texture: `npm run textures -- splats`.
- Real recordings can replace any `public/audio/**/*.wav` by name, or a sound event's `samples` can point at your own files (`public/audio/sounds.json`). Keep licensed libraries out of the public repo: put them under a gitignored folder.

### Success criteria (self-assessment; feel needs your hands on it)

| # | Criterion | Status |
|---|---|---|
| 1 | Enter Hässelby, control at once | ✅ play page starts at the player start; editor F5 |
| 2 | Movement responsive, grounded, stable | ✅ capsule motor, clipping, stairs, slopes, landing dip — needs your playtest |
| 3 | Mouse look | ✅ raw pointer lock, applied per frame before the simulation, no smoothing — needs your mouse |
| 4 | One functioning firearm | ✅ carbine, semi / auto, magazine, reload |
| 5 | Immediate trigger | ✅ the press fires at frame start (shot on the first frame after it); readout shows trigger→shot ms |
| 6 | Recoil physical and controllable | ✅ layered (aim kick pattern + view punch + model kick), compensation-aware recovery, plot for tuning |
| 7 | Weapon model motion | ✅ ten layers, bolt cycle, trigger, reload; modelled gun with baked wear (no hands yet) |
| 8 | Flash and effects in sync | ✅ atlas flash (star + plume) in the weapon's projection on the shot frame, light pulse, shot / port / barrel smoke, sub-frame kicks |
| 9 | Audio sells the shot | ⚠️ the layer architecture is complete (exact cadence, reverbs, distance), but the samples are synthesised placeholders: the biggest quality gap |
| 10 | Surface impacts | ✅ 16 surface classes: decals, particles, sounds, sparks / dust / splinters / glass |
| 11 | Enemy moves / reacts / is damaged / dies | ✅ |
| 12 | Hit feedback | ✅ per-part springs, squash, stagger, juice, chunks, splats, flesh sound, hit tick |
| 13 | Satisfying death | ✅ Verlet ragdoll from the pose, killing impulse, head pop, landing splat |
| 14 | Easily tunable | ✅ panel, save / revert / defaults, slow motion, FPS cap |
| 15 | Stable across frame rates | ✅ bit-identical simulation, exact audio cadence (tested 30–240 fps and jittery frames) |
| 16 | Rendering and editor intact | ✅ regression at noise; editor play mode extended, not broken |
| 17 | Engine / game separation | ✅ `src/engine` (clock, input, motor, verlet, shapes, rig, audio, surfaces, decals, particles, debug draw) vs `src/game` |
| 18 | Gaps for G2 identified | ✅ below |

The one criterion that matters most, "I want to keep shooting the gun", can only be judged by you. The first tuning passes to try are listed at the end of the status.

## 7. Known limits to carry into G2

Engine capabilities the next milestone (several enemies, navigation, animation scaling, combat
performance) will need:

1. **Skinned animation.** Rigid-part rigs were right for one gun and one creature, but hordes of soft creatures need skinning (glTF skins, a joint palette in a storage buffer) and clip playback / blending. Later, vertex-animation textures or GPU skinning for crowds. The procedural layer (reaction springs, look-at) should become an additive layer on top of clips.
2. **Navigation.** Enemies walk straight at the player and slide along walls. G2 needs a navmesh (baked from the collision soup in the editor, stored with the map), path following, local avoidance between enemies, and the station stairs and doors as links.
3. **Broadphase for dynamic actors.** Hitscan tests every enemy (sphere, then capsules) and the player push is pairwise. Fine for one enemy; G2 needs a spatial hash for enemies (hitscan, separation, splash) and the same for ragdoll bodies.
4. **Physics choice.** The Verlet ragdoll is cheap (≈0.15 ms per active body per frame at 120 Hz, sleeps when settled) and good enough for G1. With many simultaneous corpses, props to knock over and ragdoll-on-ragdoll contact, evaluate Rapier (WASM, character controller, joints) against Jolt. The cost is mirroring the 350k-triangle world, which must stay in sync with editor edits.
5. **Collision queries.** Triangle tests per cell have no per-triangle bounds or BVH. Raycasts cost ~8–30 µs on Hässelby, and shell-casing / ragdoll sphere pushes loop over whole 4 m cells. A BVH per cell (or a two-level BVH) is needed before many enemies cast rays (sight lines) every tick.
6. **Particles.** CPU simulation, lit per vertex, pooled. Fine for hundreds; hordes with juice everywhere want GPU simulation. Particles still have no depth-based soft fade (ENGINE.md §11): soot billboards are pulled towards the eye instead, which hides most wall intersections. No wind sheltering (gun smoke takes a fixed share of the map wind indoors too).
7. **Decals.** Runtime decals are bounded (256-entry ring, 16 per 1 m cell, newest win) and cheap to add. Re-centring the runtime grid costs ~1.7 ms every 24 m of travel. The static grid still uses one `maxPer` for every cell (13 MB on Hässelby).
8. **Audio.** Real recordings (blast close / mid / far, mechanism, tails per environment, impacts, enemy vocals). A distant gun layer for other shooters, occlusion (ray to the listener), a voice budget for crowds, and a mix with ducking. The `tunnel` reverb exists for the subway later.
9. **Player.** No health, damage or death yet (strikes only shove and kick the view). Air crouch (feet tuck) and ledge handling are basic. ADS is postponed by decision.
10. **Viewmodel.** No hands or arms: needs a skinned arms rig with clips (reload, inspect) and IK onto the gun.
11. **Data / editor.** Spawns are map markers (`enemy_spawn`); G2 wants encounter entities (spawn groups, triggers, combat areas, patrol routes) as editor entities the AI layer can place.

### First tuning passes to try (in the panel)
- Mouse sensitivity / FOV to your taste first; then run speed (4.6), acceleration (50) and braking (40).
- Recoil: vertical per shot 0.42°, permanent share 0.25, recovery rate 7. Watch the plot while you pull down.
- View punch pitch 0.55° and weapon kick back / rise (2.8 cm / 2.4°): the "weight" of each shot.
- Look lag (0.9) and bob: how glued the gun feels.
- Enemy part kick (2.2), stagger threshold (60), health (180): how hits read and how long a fight lasts.

---

## 8. G2 — the tomato horde (plan, 2026-10-05)

**Direction (yours):**
- Scrap the beetroot.
- Go for a Starship Troopers / Helldivers 2 / Warhammer 40k vibe, starting with a tomato enemy that explodes into a gory mess when it dies: big chunky splats with great feel.
- They come in hordes that climb on top of each other and chase you up the subway platform.
- The key contrast: the level stays real, grey, overcast suburbia, and the enemies are ridiculous and over the top.
- Later they flow up out of holes in the ground; start without. AAA, massively juicy, gore welcome.

**The tomato (design proposal):** a tomato *bug*.
- A bloated, glossy beefsteak-tomato body about 0.8 m across, standing about 1 m tall on six thorny green vine legs (insect-like, two segments each).
- A green sepal crown and stem on top.
- A horizontal maw splitting the fruit that gapes open on pale gel, seeds for teeth and wet red pulp.
- It skitters fast, rears up and lunges. At a distance it reads as a red blob against the grey city.
- Hits: juice spurts, the skin dents (squash) and seeds spray.
- Death: it bursts.
  - 8–12 chunk meshes (skin shells, pulp lumps, the crown, leg pieces) are thrown spinning; they bounce, slide and settle.
  - Juice, pulp and seed spray paints splats where the drops land.
  - A red mist puff, one big splat on the ground (and the wall behind, if close).
  - A heavy wet squelch and a bass thump.
  - Chunks and splats persist (within budgets), so a fight leaves the square painted.

**Architecture (new, data-oriented; the G1 `Enemy` is one heavy object with a capsule motor and a ragdoll, fine for one, not for 200):**
1. **Agents:** a struct-of-arrays `Horde` (position, velocity, heading, state, health, gait phase...), ticked at a fixed rate.
2. **Nav grid (engine):** a layered 0.5 m grid of walkable heights baked from the collision mesh. Several levels per column: square, hall, stair flights, platform at +8.25 m.
   - A flow field (Dijkstra from the player) refreshed a few times a second.
   - Ground and walls come from the grid (O(1)) instead of triangle tests.
3. **Crowd physics (engine):** spheres in a spatial hash that push apart.
   - A tomato blocked by others on the way to its goal climbs onto them and stands on their tops.
   - So they pile up at chokepoints (doors, the 2 m stair flights, around you) and pour over each other. Ones that lose their footing tumble off.
4. **Attacks:** a bite or slam up close, a lunge from a few metres.
   - The player gets minimal health, damage feedback (red edge, view knock, sound), death and restart.
5. **Rendering:** rigid parts (body, maw, crown, 6 × 2 legs) on the existing instancing.
   - Draws are batched per mesh, so 200 tomatoes ≈ 3,000 instances but about 15 draws.
   - Procedural animation: tripod gait with planted feet, body bob and lean, maw chomp, crown wobble, squash on landing and hits; distance LOD.
6. **Hitscan against the horde** through the spatial hash (sphere per tomato in the ray's cells, then part capsules). G1 tested every enemy.
7. **Gore budgets:** an instanced pool of rigid chunks; a larger runtime decal budget for splats (oldest fade first); particles.
8. **Spawning:** spawn markers (editor operations, markers only) around the square and the shop street; waves with a maximum alive. Holes later.

**Steps** (each ends with: run it, test it, look at it, fix the obvious):
1. Scrap the beet (assets, code, data). Build the tomato in Blender (parts, gib meshes, glossy skin) with preview renders for you.
2. One tomato, perfected: gait, chase on open ground, hit reactions, the burst death with gibs, splats and sound. One kill must feel amazing before there are many.
3. Nav grid and flow field for Hässelby (square, hall, stairs, platform), with a debug view.
4. The horde: agents, crowd physics, climbing and piling, attacks, player health.
5. Scale: 200 alive at 60 fps; animation LOD, gore budgets, timings.
6. Waves and the platform-chase scenario; a Horde folder in the tuning panel.
7. Verification (frame-rate test, renderer regression, editor play mode), docs.

**Success criteria:**
- Killing one tomato is the most satisfying thing in the game.
- About 200 tomatoes chase you from the square into the hall and up the stairs, piling over each other on the flights, at 60 fps.
- Gore accumulates: the grey station ends up red.
- Nav grid, crowd physics and debris stay generic engine pieces; the tomato is data and game code.

### G2 status

**Steps 1–2: the tomato, and one kill (done, 2026-10-05).**
- **Beetroot scrapped:** code (`src/game/enemy/`), model, textures, materials, data, Blender builder and splat texture.
- **Tomato bug** (`npm run enemy`, `tools/blender/build_tomato.py`):
  - A lobed beefsteak body split into a jaw and a lid hinged at the back.
  - Cross-section mouth: pericarp ring, gel chambers, seeds, dark throat, seed teeth on both rims.
  - Sepal crown, six fluted thorny vine legs (thigh and shin, IK tips in node extras).
  - 15 rig parts, 15.9k triangles (LODs come in the scale step).
  - Gibs: skin shells, a wall chunk, pulp lumps, plus centred copies of the lid, crown and leg segments.
  - 2048 atlas: glossy deep-red skin with gold shoulders and growth cracks, gel, seeds, hairy vine.
- **Agent** (`src/game/horde/tomato.ts`; data in `public/game/enemies/tomato.json`, scale 1.35):
  - States: chase (sprints when far), windup → bite, lunge (leaps from 2.4–5.5 m, bites in the air), recover, stagger.
  - Ground and walls still come from collision queries (the nav grid replaces them in step 3).
- **Animation:**
  - Alternating-tripod gait with planted feet, a stepping arc and lead, two-bone IK (knees up and out).
  - Body bob, lean into acceleration, roll in turns.
  - Jaw chatter while chasing, a gape on the windup and lunge, a snap on the bite; crown wobble.
  - Hits: squash, a tilt away from the hit, knockback, flinch, stagger.
- **Hits:**
  - One Hittable for the whole horde (bounding sphere, then the body sphere and twelve leg capsules).
  - Leg hits do 0.6× damage, and enough of them tears the leg off (it flies, the stump gushes, the tomato slows).
  - Shots into the open maw do 1.8×.
- **Gore** (`src/game/horde/gore.ts`, engine `Debris` pool of 360 instanced rigid pieces):
  - On death, the lid, crown and twelve leg pieces fly whole with 5–7 skin shells, a chunk and 3–5 pulp lumps.
    - Pieces bounce wet, can stick to walls and slide down, then settle flat (shells) or lie along the ground (legs).
    - Each paints a splat where it lands.
  - A dark juice spray, pulp and seed debris, a short dark mist.
  - A 2.2–3.2 m pool under it, ten satellite splats timed to the drops' flight, upright drip splats on walls in reach.
  - Burst sound and a shake when close.
  - Bullet hits spurt from the entry and exit wounds and paint what's behind.
- **Splat textures** (`npm run textures -- gore`): three full-colour floor splats and a wall splat with drips.
  - Very dark reds: the paving's albedo is low and brightly lit, so mid reds read pink.
  - Roughness 0.42: glossier ones mirror the overcast sky and wash out.
- **Engine:**
  - `Debris`.
  - Runtime decals take an angle, and their projection box deepens with size. At a fixed 6 cm, big splats on uneven paving were clipped to fragments.
  - `ShotHit.index`.
- **Sounds** (synthesised placeholders): burst, hit, bite, hiss, gib splat, foot tick, leg snap.
- **Player:** a bite knocks the view, shoves you and flashes red at the screen edge. No health yet (step 4).
- **Panel:** Horde folder (on/off, alive at once, spawn, movement, gait, attack, reactions, gore).
- **Cost:** about 10 µs simulation and 7 µs posing per tomato per frame (8 alive).

