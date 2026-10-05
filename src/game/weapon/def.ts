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
    /** Sideways jitter per shot (metres) and how far the gun rides back / up during a long burst. */
    jitter: number;
    burstBack: number;
    burstRise: number;
    /** Shots for the burst pose to build up, and its settle rate (1/s). */
    burstBuild: number;
    burstSettle: number;
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
  /**
   * Shot presentation (how loud the shot looks; visual only): flash size and
   * light, tracers, a field-of-view punch, and how much smoke the gun leaves.
   */
  fx: {
    /** Muzzle flash size ×, its light's peak (cd) and range (m). */
    flashScale: number;
    flashLight: number;
    flashRange: number;
    /**
     * Flash and impact lights in the dark: below `flashRefEV` (the exposure they were tuned at) the camera
     * exposes up, so a physical flash would look up to 100× brighter against the scene and clip the gun to
     * white sparkle. `flashDark` is the share of that extra relative brightness kept (0 = looks as in the
     * reference light, 1 = physical).
     */
    flashRefEV: number;
    flashDark: number;
    /** A tracer every N rounds (0 = none): visual speed (m/s), streak length (m), half width (m), colour, brightness (nits). */
    tracerEvery: number;
    tracerSpeed: number;
    tracerLength: number;
    tracerWidth: number;
    tracerColor: [number, number, number];
    tracerEmissive: number;
    /** Field of view widened per shot (degrees, springs back). */
    fovPunch: number;
    /** Per-shot muzzle smoke opacity, and barrel smoke after sustained fire (0 = none). */
    shotSmoke: number;
    barrelSmoke: number;
    /** Camera punch on the reload beats (degrees): magazine seated, bolt slammed home. */
    reloadPunch: number;
    /**
     * Ejected brass: speed out of the port (m/s, gun space: right, up, forward), random
     * variation (0..1), tumble (rad/s), size × (readability), seconds a case stays on the ground.
     */
    ejectRight: number;
    ejectUp: number;
    ejectForward: number;
    ejectRandom: number;
    ejectSpin: number;
    brassScale: number;
    brassLife: number;
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
    pitch: 0.8,
    yaw: 0.27,
    roll: 0.75,
    hz: 9,
    damping: 0.56,
  },
  kick: {
    back: 0.048,
    up: 0.007,
    pitch: 4.6,
    yaw: 1.2,
    roll: 2.4,
    random: 0.3,
    posHz: 11,
    posDamping: 0.5,
    rotHz: 8.5,
    rotDamping: 0.42,
    jitter: 0.0016,
    burstBack: 0.022,
    burstRise: 2.4,
    burstBuild: 6,
    burstSettle: 5,
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
    reloadOffset: [-0.045, 0.04, 0.035],
    reloadRot: [20, -7, 48],
    breathe: 0.0012,
    breathePitch: 0.12,
    breatheRate: 0.22,
  },
  reload: {
    tactical: 1.15,
    empty: 1.5,
    magOut: 0.16,
    magIn: 0.56,
    rackStart: 0.84,
    rackEnd: 0.96,
    chamberPlusOne: true,
    auto: true,
  },
  fx: {
    flashScale: 1.35,
    flashLight: 900,
    flashRange: 16,
    flashRefEV: 8.5,
    flashDark: 0.35,
    tracerEvery: 1,
    tracerSpeed: 140,
    tracerLength: 10,
    tracerWidth: 0.008,
    tracerColor: [1.0, 0.48, 0.14],
    tracerEmissive: 14000,
    fovPunch: 0.65,
    shotSmoke: 0.2,
    barrelSmoke: 0.25,
    reloadPunch: 1.4,
    ejectRight: 1.15,
    ejectUp: 1.75,
    ejectForward: 0.55,
    ejectRandom: 0.25,
    ejectSpin: 28,
    brassScale: 1.3,
    brassLife: 40,
  },
  mechanics: {
    boltTravel: 0.065,
    boltBack: 0.42,
    triggerPull: 12,
  },
};
