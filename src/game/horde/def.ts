/**
 * Horde enemy definition (public/game/enemies/<id>.json): body, movement, gait,
 * attacks, hit reactions and gore. Distances metres, angles degrees, times seconds.
 */
export interface TomatoDef {
  name: string;
  model: string;
  material: string;
  /** Uniform size × of the whole creature (model, physics, gait, reach). Other lengths here are at scale 1. */
  scale: number;
  /** Body sphere (crowd, hits, piling) and the body centre's height above the ground when standing. */
  radius: number;
  rideHeight: number;
  health: number;
  move: {
    /** Chase speed (m/s), a sprint burst further away, acceleration and turn rate. */
    speed: number;
    sprint: number;
    sprintDistance: number;
    accel: number;
    turnRate: number;
    /** Per-tomato speed variation (0..1). */
    speedJitter: number;
  };
  gait: {
    /** Foot travel per step (m, at scale 1), lift height, share of the cycle a foot is planted. */
    stride: number;
    lift: number;
    duty: number;
    /** Body bob (m), side sway as the tripods alternate (degrees), lean into acceleration (degrees per m/s²), roll in turns. */
    bob: number;
    sway: number;
    lean: number;
    roll: number;
  };
  crowd: {
    /** Bodies keep this share of their diameter apart (lower packs them tighter). */
    spacing: number;
    /** Stuck behind others this long (s), a tomato climbs over them at this speed (m/s up). */
    climbAfter: number;
    climbSpeed: number;
    /** Clambering up a ledge (turnstile, low wall) from the nav (m/s). */
    ledgeSpeed: number;
    /** Closer than this (m) it heads straight for the player instead of following the flow field. */
    direct: number;
  };
  attack: {
    /** Bite range (m from the body centre to the player's eye axis), windup, snap, recover, cooldown. */
    range: number;
    windup: number;
    bite: number;
    recover: number;
    cooldown: number;
    damage: number;
    /** Lunge: from this distance it leaps at the player (speed m/s, upward m/s, chance per second). */
    lungeRange: [number, number];
    lungeSpeed: number;
    lungeUp: number;
    lungeChance: number;
    /** Lid opening (degrees) when chasing close, winding up and lunging. */
    jawChase: number;
    jawOpen: number;
  };
  reactions: {
    /** Knockback per hit (m/s per N·s of impact), body squash, stagger meter, flinch slow-down. */
    knock: number;
    squash: number;
    springHz: number;
    springDamping: number;
    staggerThreshold: number;
    staggerTime: number;
    flinch: number;
  };
  gore: {
    /** Gibs thrown on death: skin shells, chunks, pulp lumps; speed range; spin. */
    shells: [number, number];
    chunks: [number, number];
    pulp: [number, number];
    gibSpeed: [number, number];
    gibSpin: number;
    /** Gibs size ×, seconds they stay, how many legs come off whole. */
    gibScale: [number, number];
    gibLife: number;
    legsOff: number;
    /** The pop: liquid burst sprites (count; size m at scale 1, start / end; life s). */
    pops: number;
    popSize: [number, number];
    popLife: [number, number];
    /** Sprays of liquid flung outward (count, length m at scale 1, life s). */
    sprays: number;
    sprayLength: [number, number];
    sprayLife: [number, number];
    /**
     * Directional liquid: thick jets blasted out along the killing shot (count, blobs each, cone
     * half-angle degrees, speed m/s, blob radius m at scale 1), jets gushing back out of the entry,
     * big glossy blobs bursting from the core (count, radius), and a fine all-round spray.
     */
    jets: number;
    jetBlobs: number;
    jetCone: number;
    jetSpeed: [number, number];
    jetSize: [number, number];
    backJets: number;
    coreBlobs: number;
    coreSize: [number, number];
    drops: number;
    dropSize: [number, number];
    dropSpeed: [number, number];
    blobs: number;
    blobSize: [number, number];
    seeds: number;
    /** Liquid red of drops and sprites (linear albedo). */
    red: [number, number, number];
    /** Splats painted around (count, size range, radius), streaks flung across the ground, on walls nearby. */
    splats: number;
    streaks: number;
    splatSize: [number, number];
    splatRadius: number;
    wallSplats: number;
    /** Big splat under the burst (size range). */
    poolSize: [number, number];
    /** Red mist puff (opacity). */
    mist: number;
    /** Juice (dark red), flesh (red-orange), seeds (pale): linear colours. */
    juice: [number, number, number];
    flesh: [number, number, number];
    seed: [number, number, number];
    /** Per bullet hit: droplets, a splat on the world behind (chance, reach). */
    hitSpray: number;
    hitSplatChance: number;
    hitSplatReach: number;
    /** Burst light (cd) and the camera shake when it bursts near the player (degrees at 1 m). */
    light: number;
    shake: number;
    /** Screen splatter when one bursts within this distance in front of the camera (m). */
    screenDistance: number;
  };
}

export const TOMATO_DEFAULTS: TomatoDef = {
  name: 'Tomato',
  model: '/assets/enemies/tomato.glb',
  material: 'veg_tomato',
  scale: 1.35,
  radius: 0.42,
  rideHeight: 0.56,
  health: 70,
  move: { speed: 3.0, sprint: 4.6, sprintDistance: 18, accel: 10, turnRate: 240, speedJitter: 0.2 },
  gait: { stride: 0.62, lift: 0.12, duty: 0.56, bob: 0.018, sway: 2.5, lean: 1.2, roll: 8 },
  crowd: { spacing: 0.9, climbAfter: 0.25, climbSpeed: 3.2, ledgeSpeed: 3.5, direct: 3.5 },
  attack: {
    range: 1.25, windup: 0.18, bite: 0.08, recover: 0.35, cooldown: 0.5, damage: 12,
    lungeRange: [2.4, 5.5], lungeSpeed: 6.5, lungeUp: 3.2, lungeChance: 1.0, jawChase: 14, jawOpen: 52,
  },
  reactions: { knock: 0.09, squash: 0.18, springHz: 5, springDamping: 0.32, staggerThreshold: 40, staggerTime: 0.35, flinch: 0.5 },
  gore: {
    shells: [6, 9], chunks: [2, 3], pulp: [5, 8], gibSpeed: [3.5, 10], gibSpin: 16, gibScale: [1.0, 1.6], gibLife: 60, legsOff: 3,
    pops: 2, popSize: [0.35, 1.2], popLife: [0.08, 0.14], sprays: 4, sprayLength: [1.2, 2.4], sprayLife: [0.07, 0.12],
    jets: 10, jetBlobs: 95, jetCone: 46, jetSpeed: [3, 14], jetSize: [0.018, 0.058], backJets: 4, coreBlobs: 100, coreSize: [0.04, 0.1],
    drops: 320, dropSize: [0.01, 0.028], dropSpeed: [2.5, 13], blobs: 80, blobSize: [0.03, 0.09], seeds: 40,
    red: [0.13, 0.004, 0.003],
    splats: 20, streaks: 14, splatSize: [0.8, 2.0], splatRadius: 6, wallSplats: 10, poolSize: [3.2, 4.6], mist: 0.3,
    juice: [0.045, 0.0015, 0.001], flesh: [0.32, 0.022, 0.009], seed: [0.42, 0.33, 0.15],
    hitSpray: 18, hitSplatChance: 0.6, hitSplatReach: 3, light: 0, shake: 3, screenDistance: 5,
  },
};
