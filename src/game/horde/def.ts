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
    /** Foot travel per step (m), lift height, step time at full speed (s, shorter when fast). */
    stride: number;
    lift: number;
    stepTime: number;
    /** Body bob (m), lean into acceleration (degrees per m/s²), roll in turns. */
    bob: number;
    lean: number;
    roll: number;
    /** How far ahead (s of velocity) feet are placed. */
    lead: number;
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
    /** Droplets in the burst, splats painted around (count, size range, radius), on walls nearby. */
    spray: number;
    splats: number;
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
  move: { speed: 4.2, sprint: 6.5, sprintDistance: 14, accel: 14, turnRate: 300, speedJitter: 0.18 },
  gait: { stride: 0.42, lift: 0.14, stepTime: 0.13, bob: 0.035, lean: 1.4, roll: 10, lead: 0.12 },
  attack: {
    range: 1.25, windup: 0.18, bite: 0.08, recover: 0.35, cooldown: 0.5, damage: 12,
    lungeRange: [2.4, 5.5], lungeSpeed: 7.5, lungeUp: 3.4, lungeChance: 1.2, jawChase: 14, jawOpen: 52,
  },
  reactions: { knock: 0.09, squash: 0.18, springHz: 5, springDamping: 0.32, staggerThreshold: 40, staggerTime: 0.35, flinch: 0.5 },
  gore: {
    shells: [5, 7], chunks: [1, 2], pulp: [3, 5], gibSpeed: [2.5, 8], gibSpin: 16, gibScale: [1.0, 1.5], gibLife: 60, legsOff: 3,
    spray: 120, splats: 10, splatSize: [0.6, 1.4], splatRadius: 3.6, wallSplats: 5, poolSize: [2.2, 3.2], mist: 0.35,
    juice: [0.05, 0.0022, 0.0015], flesh: [0.2, 0.018, 0.007], seed: [0.42, 0.33, 0.15],
    hitSpray: 12, hitSplatChance: 0.45, hitSplatReach: 2.5, light: 120, shake: 2.2,
  },
};
