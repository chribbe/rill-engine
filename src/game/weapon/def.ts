/**
 * Firearm definition: everything that shapes how the gun feels, as data
 * (public/game/weapons/<id>.json). Angles are degrees, distances metres,
 * times seconds unless a name says otherwise.
 */
export interface WeaponDef {
  name: string;
  fire: {
    /** Rounds per minute (cyclic rate). */
    rpm: number;
    mode: 'auto' | 'semi';
    magazine: number;
    infiniteAmmo: boolean;
    damage: number;
    range: number;
    /** Damage falloff: full until `falloffStart`, `falloffMin` × damage beyond `falloffEnd`. */
    falloffStart: number;
    falloffEnd: number;
    falloffMin: number;
    /** Impulse given to what is hit (N·s; enemy reactions, ragdolls). */
    impactForce: number;
    /** Bullets continue through glass. */
    pierceGlass: boolean;
    /** Firing blocks sprint for this long after a shot. */
    sprintBlock: number;
  };
  spread: {
    /** Cone half-angle of a rested first shot. */
    base: number;
    /** Added per shot (bloom), capped at `max`; recovers at `recovery` °/s after `recoveryDelay`. */
    perShot: number;
    max: number;
    recovery: number;
    recoveryDelay: number;
    /** Added at run speed (scaled by speed), in the air, and the multiplier while crouched. */
    moving: number;
    air: number;
    crouch: number;
  };
  /**
   * Aim displacement (moves where bullets go). Each shot kicks up by `pitch` and sideways along a
   * learnable pattern, `yaw * sin(i * patternFreq + patternPhase)`, plus a little noise. The kick is
   * applied over `kickTime` (a physical rise, not a jump). `permanent` of it stays until the player
   * corrects it; the rest returns after `recoverDelay` at `recoverRate` (1/s). Pulling against it
   * uses it up, so recovery never overshoots the player's own correction.
   */
  recoil: {
    pitch: number;
    yaw: number;
    patternFreq: number;
    patternPhase: number;
    randomPitch: number;
    randomYaw: number;
    /** Kick multiplier of the first shot of a pull, ramping to 1 over `ramp` shots. */
    firstShot: number;
    ramp: number;
    maxPitch: number;
    maxYaw: number;
    kickTime: number;
    permanent: number;
    recoverDelay: number;
    recoverRate: number;
  };
  /** View punch: visual-only camera rotation per shot (degrees), a damped spring. */
  punch: {
    pitch: number;
    yaw: number;
    roll: number;
    hz: number;
    damping: number;
  };
  /** Weapon model kick per shot (weapon space): metres back / up, degrees of rise / yaw / roll. */
  kick: {
    back: number;
    up: number;
    pitch: number;
    yaw: number;
    roll: number;
    /** Per-shot variation (0..1). */
    random: number;
    posHz: number;
    posDamping: number;
    rotHz: number;
    rotDamping: number;
  };
  /** First-person presentation. Offsets in camera space (x right, y up, z back), angles in degrees. */
  viewmodel: {
    /** Vertical field of view of the weapon (degrees). */
    fov: number;
    offset: [number, number, number];
    /** Base rotation (pitch, yaw, roll degrees; yaw + = muzzle right, roll + = right side down). */
    rotation: [number, number, number];
    /** Rotation pivot in weapon space (near the grip). */
    pivot: [number, number, number];
    /** Look inertia: degrees of lag per rad/s of turning, cap, spring. */
    sway: number;
    swayMax: number;
    swayHz: number;
    swayDamping: number;
    /** Walk cycle at run speed: metres side / up, degrees roll. */
    bobSide: number;
    bobUp: number;
    bobRoll: number;
    /** Strafe roll (degrees per m/s) and forward-acceleration lag (metres per m/s²). */
    strafeRoll: number;
    accelLag: number;
    /** Vertical velocity response (metres and degrees per m/s), landing kick (per m/s of impact). */
    airLift: number;
    airPitch: number;
    landDrop: number;
    landPitch: number;
    /** Crouched offset (added) and cant (degrees roll). */
    crouchOffset: [number, number, number];
    crouchRoll: number;
    /** Sprint pose (offset, pitch / yaw / roll degrees) and blend rate (1/s). */
    sprintOffset: [number, number, number];
    sprintRot: [number, number, number];
    sprintRate: number;
    /** Reload pose (added at full blend): offset and pitch / yaw / roll degrees (magazine well towards the eye). */
    reloadOffset: [number, number, number];
    reloadRot: [number, number, number];
    /** Idle breathing: metres, degrees, cycles per second. */
    breathe: number;
    breathePitch: number;
    breatheRate: number;
  };
  /**
   * Reload timeline (seconds from the start): magazine out, new magazine seated,
   * and on an empty gun the charging handle racked. A tactical reload keeps the
   * chambered round (+1).
   */
  reload: {
    tactical: number;
    empty: number;
    magOut: number;
    magIn: number;
    rackStart: number;
    rackEnd: number;
    chamberPlusOne: boolean;
    /** Start reloading by itself when the trigger is pulled on an empty gun. */
    auto: boolean;
  };
  /** Mechanical animation. */
  mechanics: {
    /** Bolt / charging-handle travel (m) and the fraction of the cycle spent moving back. */
    boltTravel: number;
    boltBack: number;
    /** Trigger rotation when pulled (degrees). */
    triggerPull: number;
  };
}

export const CARBINE_DEFAULTS: WeaponDef = {
  name: 'Carbine',
  fire: {
    rpm: 700,
    mode: 'auto',
    magazine: 30,
    infiniteAmmo: false,
    damage: 24,
    range: 300,
    falloffStart: 40,
    falloffEnd: 120,
    falloffMin: 0.6,
    impactForce: 8,
    pierceGlass: true,
    sprintBlock: 0.35,
  },
  spread: {
    base: 0.1,
    perShot: 0.07,
    max: 1.4,
    recovery: 4,
    recoveryDelay: 0.08,
    moving: 0.6,
    air: 2.5,
    crouch: 0.75,
  },
  recoil: {
    pitch: 0.42,
    yaw: 0.16,
    patternFreq: 0.42,
    patternPhase: 0.9,
    randomPitch: 0.06,
    randomYaw: 0.07,
    firstShot: 0.55,
    ramp: 4,
    maxPitch: 5.5,
    maxYaw: 2.2,
    kickTime: 0.045,
    permanent: 0.25,
    recoverDelay: 0.12,
    recoverRate: 7,
  },
  punch: {
    pitch: 0.55,
    yaw: 0.18,
    roll: 0.45,
    hz: 7.5,
    damping: 0.5,
  },
  kick: {
    back: 0.028,
    up: 0.004,
    pitch: 2.4,
    yaw: 0.5,
    roll: 1.1,
    random: 0.25,
    posHz: 9,
    posDamping: 0.55,
    rotHz: 7,
    rotDamping: 0.45,
  },
  viewmodel: {
    fov: 52,
    offset: [0.13, -0.122, -0.22],
    rotation: [1.5, -3.5, -8],
    pivot: [0, -0.06, 0.06],
    sway: 0.9,
    swayMax: 3.5,
    swayHz: 3.2,
    swayDamping: 0.62,
    bobSide: 0.007,
    bobUp: 0.005,
    bobRoll: 0.7,
    strafeRoll: 0.55,
    accelLag: 0.0012,
    airLift: 0.004,
    airPitch: 0.5,
    landDrop: 0.006,
    landPitch: 0.9,
    crouchOffset: [-0.02, 0.012, 0.015],
    crouchRoll: -4,
    sprintOffset: [0.03, -0.045, 0.03],
    sprintRot: [-14, 28, -6],
    sprintRate: 9,
    reloadOffset: [-0.02, -0.01, 0],
    reloadRot: [30, -6, -40],
    breathe: 0.0012,
    breathePitch: 0.12,
    breatheRate: 0.22,
  },
  reload: {
    tactical: 1.75,
    empty: 2.3,
    magOut: 0.3,
    magIn: 1.08,
    rackStart: 1.45,
    rackEnd: 1.72,
    chamberPlusOne: true,
    auto: true,
  },
  mechanics: {
    boltTravel: 0.065,
    boltBack: 0.42,
    triggerPull: 12,
  },
};
