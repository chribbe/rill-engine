/**
 * Enemy definition (public/game/enemies/<id>.json): body, locomotion, combat,
 * hitboxes per rig part, reactions and impact feedback. Distances metres,
 * angles degrees, times seconds.
 */
export interface Hitbox {
  part: string;
  /** Capsule segment in the part's frame, radius. */
  a: [number, number, number];
  b: [number, number, number];
  r: number;
  region: string;
}

export interface EnemyDef {
  name: string;
  model: string;
  /** Collision capsule and step height. */
  radius: number;
  height: number;
  stepHeight: number;
  health: number;
  /** Damage multipliers and stagger weight per body region. */
  regions: Record<string, { damage: number; stagger: number }>;
  hitboxes: Hitbox[];
  move: {
    walkSpeed: number;
    chaseSpeed: number;
    /** Distance beyond which it hurries (chase speed). */
    chaseDistance: number;
    accel: number;
    turnRate: number;
    sightRange: number;
  };
  gait: {
    /** Metres per step. */
    stride: number;
    legSwing: number;
    kneeBend: number;
    armSwing: number;
    bob: number;
    roll: number;
    lean: number;
  };
  attack: {
    range: number;
    windup: number;
    strike: number;
    recover: number;
    cooldown: number;
  };
  /** Hit reactions (step 6): per-part angular kick per N·s, body knockback, stagger meter. */
  reactions: {
    partKick: number;
    bodyKick: number;
    knockback: number;
    staggerThreshold: number;
    staggerDecay: number;
    staggerTime: number;
    flinchSlow: number;
    springHz: number;
    springDamping: number;
    squash: number;
  };
  /** Seconds before a new one rises after death; corpse lifetime. */
  respawn: number;
  corpseTime: number;
}

const L = (part: string, a: [number, number, number], b: [number, number, number], r: number, region: string): Hitbox => ({ part, a, b, r, region });

export const BEET_DEFAULTS: EnemyDef = {
  name: 'Rödbeta',
  model: '/assets/enemies/beet.glb',
  radius: 0.34,
  height: 1.7,
  stepHeight: 0.35,
  health: 180,
  regions: {
    head: { damage: 2.6, stagger: 1.6 },
    torso: { damage: 1, stagger: 1 },
    arm: { damage: 0.65, stagger: 0.5 },
    leg: { damage: 0.75, stagger: 1.3 },
  },
  hitboxes: [
    L('body', [0, -0.06, 0], [0, 0.33, 0.01], 0.29, 'torso'),
    L('head', [0, 0.07, -0.01], [0, 0.2, -0.01], 0.145, 'head'),
    L('arm_l', [0, 0, 0], [-0.17, -0.26, -0.06], 0.065, 'arm'),
    L('arm_r', [0, 0, 0], [0.17, -0.26, -0.06], 0.065, 'arm'),
    L('forearm_l', [0, 0, 0], [-0.04, -0.27, -0.16], 0.05, 'arm'),
    L('forearm_r', [0, 0, 0], [0.04, -0.27, -0.16], 0.05, 'arm'),
    L('leg_l', [0, 0, 0], [-0.03, -0.34, -0.04], 0.088, 'leg'),
    L('leg_r', [0, 0, 0], [0.03, -0.34, -0.04], 0.088, 'leg'),
    L('shin_l', [0, 0, 0], [-0.01, -0.36, 0.05], 0.062, 'leg'),
    L('shin_r', [0, 0, 0], [0.01, -0.36, 0.05], 0.062, 'leg'),
  ],
  move: { walkSpeed: 1.6, chaseSpeed: 2.6, chaseDistance: 9, accel: 6, turnRate: 220, sightRange: 45 },
  gait: { stride: 0.55, legSwing: 32, kneeBend: 38, armSwing: 22, bob: 0.035, roll: 4, lean: 7 },
  attack: { range: 1.45, windup: 0.38, strike: 0.12, recover: 0.45, cooldown: 0.6 },
  reactions: {
    partKick: 2.2, bodyKick: 0.9, knockback: 0.35, staggerThreshold: 60, staggerDecay: 40, staggerTime: 0.55,
    flinchSlow: 0.6, springHz: 3.2, springDamping: 0.38, squash: 0.12,
  },
  respawn: 4,
  corpseTime: 20,
};
