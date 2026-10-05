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
  /** Enemy-specific impact feedback (the vegetable's juice, chunks, splats). */
  impact: {
    /** impacts.json entry for per-hit particles and sound. */
    surface: string;
    /** Splat decal on the world behind / below a hit: material, size range, reach (m), chance. */
    splat: { decal: string; size: [number, number]; reach: number; chance: number };
    /** Hard chunks per hit and their colour. */
    chunks: [number, number];
    chunkColor: [number, number, number];
    /** Juice colour (droplets, mist). */
    juice: [number, number, number];
    /** Death: extra droplets, chunks, a splat under the body as it lands. */
    deathBurst: number;
    deathChunks: number;
    landSplat: [number, number];
    /** A killing headshot pops the head off. */
    headPop: boolean;
  };
  /**
   * Death ragdoll (Verlet): joints in rest space (part they ride on, position,
   * mass, radius), links between joints ('eq' rigid, 'min' joint limits as a
   * fraction of the rest length), and bones (part ← pivot joint, axis joint,
   * twist reference joints).
   */
  ragdoll: {
    joints: { name: string; part: string; at: [number, number, number]; mass: number; radius: number }[];
    rigid: string[][];
    links: [string, string, 'eq' | 'min', number][];
    bones: { part: string; from: string; to: string; ref: [string, string] }[];
    /** The head stick (neck joint, head joint): its links to the body break when the head pops. */
    head: [string, string];
  };
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
  impact: {
    surface: 'flesh',
    splat: { decal: 'decal_beet_splat', size: [0.22, 0.5], reach: 2.4, chance: 0.55 },
    chunks: [1, 3],
    chunkColor: [0.22, 0.009, 0.055],
    juice: [0.085, 0.003, 0.025],
    deathBurst: 28,
    deathChunks: 10,
    landSplat: [0.7, 1.1],
    headPop: true,
  },
  ragdoll: {
    joints: [
      { name: 'pelvis', part: 'body', at: [0, 0.84, 0], mass: 8, radius: 0.2 },
      { name: 'chest', part: 'body', at: [0, 1.22, -0.01], mass: 10, radius: 0.22 },
      { name: 'neck', part: 'head', at: [0, 1.33, -0.02], mass: 1.5, radius: 0.08 },
      { name: 'head', part: 'head', at: [0, 1.58, -0.02], mass: 3, radius: 0.13 },
      { name: 'shoulder_l', part: 'arm_l', at: [-0.25, 1.2, 0], mass: 2, radius: 0.07 },
      { name: 'elbow_l', part: 'forearm_l', at: [-0.42, 0.94, -0.06], mass: 1.5, radius: 0.05 },
      { name: 'hand_l', part: 'forearm_l', at: [-0.46, 0.7, -0.2], mass: 1, radius: 0.045 },
      { name: 'shoulder_r', part: 'arm_r', at: [0.25, 1.2, 0], mass: 2, radius: 0.07 },
      { name: 'elbow_r', part: 'forearm_r', at: [0.42, 0.94, -0.06], mass: 1.5, radius: 0.05 },
      { name: 'hand_r', part: 'forearm_r', at: [0.46, 0.7, -0.2], mass: 1, radius: 0.045 },
      { name: 'hip_l', part: 'leg_l', at: [-0.12, 0.78, 0], mass: 3, radius: 0.09 },
      { name: 'knee_l', part: 'shin_l', at: [-0.15, 0.44, -0.04], mass: 2, radius: 0.07 },
      { name: 'foot_l', part: 'shin_l', at: [-0.16, 0.08, 0.01], mass: 1.5, radius: 0.06 },
      { name: 'hip_r', part: 'leg_r', at: [0.12, 0.78, 0], mass: 3, radius: 0.09 },
      { name: 'knee_r', part: 'shin_r', at: [0.15, 0.44, -0.04], mass: 2, radius: 0.07 },
      { name: 'foot_r', part: 'shin_r', at: [0.16, 0.08, 0.01], mass: 1.5, radius: 0.06 },
    ],
    rigid: [['pelvis', 'chest', 'shoulder_l', 'shoulder_r', 'hip_l', 'hip_r']],
    links: [
      ['neck', 'chest', 'eq', 1], ['neck', 'shoulder_l', 'eq', 0.9], ['neck', 'shoulder_r', 'eq', 0.9], ['neck', 'pelvis', 'eq', 0.9],
      ['head', 'neck', 'eq', 1], ['head', 'chest', 'min', 0.92], ['head', 'shoulder_l', 'eq', 0.35], ['head', 'shoulder_r', 'eq', 0.35],
      ['shoulder_l', 'elbow_l', 'eq', 1], ['elbow_l', 'hand_l', 'eq', 1], ['shoulder_l', 'hand_l', 'min', 0.55], ['chest', 'elbow_l', 'min', 0.6],
      ['shoulder_r', 'elbow_r', 'eq', 1], ['elbow_r', 'hand_r', 'eq', 1], ['shoulder_r', 'hand_r', 'min', 0.55], ['chest', 'elbow_r', 'min', 0.6],
      ['hip_l', 'knee_l', 'eq', 1], ['knee_l', 'foot_l', 'eq', 1], ['hip_l', 'foot_l', 'min', 0.62], ['pelvis', 'knee_l', 'min', 0.7],
      ['hip_r', 'knee_r', 'eq', 1], ['knee_r', 'foot_r', 'eq', 1], ['hip_r', 'foot_r', 'min', 0.62], ['pelvis', 'knee_r', 'min', 0.7],
    ],
    bones: [
      { part: 'body', from: 'pelvis', to: 'chest', ref: ['shoulder_l', 'shoulder_r'] },
      { part: 'head', from: 'neck', to: 'head', ref: ['shoulder_l', 'shoulder_r'] },
      { part: 'arm_l', from: 'shoulder_l', to: 'elbow_l', ref: ['shoulder_l', 'shoulder_r'] },
      { part: 'forearm_l', from: 'elbow_l', to: 'hand_l', ref: ['shoulder_l', 'shoulder_r'] },
      { part: 'arm_r', from: 'shoulder_r', to: 'elbow_r', ref: ['shoulder_l', 'shoulder_r'] },
      { part: 'forearm_r', from: 'elbow_r', to: 'hand_r', ref: ['shoulder_l', 'shoulder_r'] },
      { part: 'leg_l', from: 'hip_l', to: 'knee_l', ref: ['hip_l', 'hip_r'] },
      { part: 'shin_l', from: 'knee_l', to: 'foot_l', ref: ['hip_l', 'hip_r'] },
      { part: 'leg_r', from: 'hip_r', to: 'knee_r', ref: ['hip_l', 'hip_r'] },
      { part: 'shin_r', from: 'knee_r', to: 'foot_r', ref: ['hip_l', 'hip_r'] },
    ],
    head: ['neck', 'head'],
  },
};
