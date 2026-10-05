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
    /** Seconds from reload start until the magazine is usable. */
    reloadTime: number;
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
}

export const CARBINE_DEFAULTS: WeaponDef = {
  name: 'Carbine',
  fire: {
    rpm: 700,
    mode: 'auto',
    magazine: 30,
    reloadTime: 2.1,
    infiniteAmmo: true,
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
};
