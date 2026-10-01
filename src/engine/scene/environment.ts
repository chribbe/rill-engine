import { atmosphereTransmittance, AEROSOL_BASE } from '../render/sky';
import { parseColor, type Color } from '../render/materials';

/**
 * Environment / weather state. Serializable, preset-driven (public/environments),
 * and the single source of truth for sun, sky, fog, exposure and wetness.
 */
export interface EnvironmentState {
  name: string;
  sun: {
    /** Compass azimuth in degrees (0 = north, 90 = east, 180 = south). */
    azimuth: number;
    /** Elevation above the horizon in degrees. */
    elevation: number;
    /** Multiplier on the physically derived sun illuminance. */
    intensity: number;
    angularDiameter: number;
  };
  sky: {
    intensity: number;
    /** Aerosol load: 1 = typical clear day (AOD ~0.1), 0.5 = very clean air, 2-3 = hazy. */
    turbidity: number;
    cloudCover: number;
    cloudAltitude: number;
    cloudSharpness: number;
    cloudDensity: number;
    /** Zenith luminance of a fully overcast sky (nits). */
    overcastLuminance: number;
    overcastTint: Color;
    /** Art-direction multiplier on the clear-sky radiance (also feeds ambient + reflections). */
    tint?: Color;
    wind: [number, number];
  };
  fog: {
    enabled: boolean;
    /** Extinction (1/m) at the reference height. */
    density: number;
    height: number;
    /** Height falloff (1/m): larger = thinner layer hugging the ground. */
    falloff: number;
    /** Meteorological visibility of the haze in km (Koschmieder: 3.912 / range). 0 = off. */
    hazeVisibilityKm: number;
    anisotropy: number;
    albedo: Color;
    sunScatter: number;
    startDistance: number;
    maxOpacity: number;
  };
  /** Manual EV100 (also the auto-exposure start point), compensation in stops, auto limits. */
  exposure: { ev100: number; compensation: number; auto?: boolean; min?: number; max?: number };
  ambient: {
    groundAlbedo: Color;
    lightmapSky: number;
    lightmapSun: number;
    indirect: number;
    envSpecular: number;
  };
  lights: { intensity: number };
  /**
   * Surface weather. snow: cover on upward-facing, sky-exposed surfaces (0..1);
   * melt: wet dark edges around the snow; dry: dormant-season tint (winter grass).
   */
  weather: { wetness: number; puddles: number; snow?: number; melt?: number; dry?: number };
  post: { tonemapper: string; contrast: number; saturation: number; temperature: number };
}

export const SUN_TOA_LUX = 120000;

export interface DerivedEnvironment {
  sunDir: [number, number, number];
  sunIlluminance: [number, number, number];
  preExposure: number;
  cloudOffset: [number, number];
}

export function sunDirection(azDeg: number, elDeg: number): [number, number, number] {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
}

export class Environment {
  state: EnvironmentState;
  /** Increments whenever state changes that invalidate the sky/env maps. */
  version = 0;
  private cloudTime = 0;

  constructor(initial: EnvironmentState) {
    this.state = Environment.normalize(structuredClone(initial));
  }

  set(next: EnvironmentState) {
    this.state = Environment.normalize(structuredClone(next));
    this.version++;
  }

  /** Fills optional fields so every preset exposes the same controls. */
  static normalize(s: EnvironmentState): EnvironmentState {
    s.weather.snow ??= 0;
    s.weather.melt ??= 0;
    s.weather.dry ??= 0;
    return s;
  }

  touch() {
    this.version++;
  }

  advance(dt: number) {
    const w = this.state.sky.wind;
    if (w[0] !== 0 || w[1] !== 0) this.cloudTime += dt;
  }

  derive(): DerivedEnvironment {
    const s = this.state;
    const sunDir = sunDirection(s.sun.azimuth, s.sun.elevation);
    const T = atmosphereTransmittance(sunDir[1], 0.1, s.sky.turbidity * AEROSOL_BASE);
    // Direct sun through clouds: thick cover blocks most of it (diffuse light
    // then arrives through the overcast sky term instead).
    const cover = s.sky.cloudCover;
    const cloudT = Math.max(0.02, 1 - Math.pow(cover, 1.6) * 0.96);
    const k = SUN_TOA_LUX * s.sun.intensity * cloudT;
    const sunIlluminance: [number, number, number] = [T[0] * k, T[1] * k, T[2] * k];
    const preExposure = 1 / (1.2 * Math.pow(2, s.exposure.ev100 - s.exposure.compensation));
    return {
      sunDir,
      sunIlluminance,
      preExposure,
      cloudOffset: [s.sky.wind[0] * this.cloudTime, s.sky.wind[1] * this.cloudTime],
    };
  }

  overcastRadiance(): [number, number, number] {
    const t = parseColor(this.state.sky.overcastTint, [1, 1, 1, 1]);
    const L = this.state.sky.overcastLuminance;
    return [t[0] * L, t[1] * L, t[2] * L];
  }
}
