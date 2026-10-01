import type { MaterialDef } from '../render/materials';

/**
 * Map document format (public/maps/<name>/map.json). This is the single source
 * of truth for world content: renderer state is always derived from it, so a
 * future editor (or an AI tool) can inspect and modify the world by editing
 * this structure and re-applying it.
 */

export interface MapDocument {
  format: 'rill.map';
  version: 1;
  name: string;
  description?: string;
  environment: { preset: string; overrides?: Record<string, unknown> };
  /** LightmapSet manifest, relative to the map directory. */
  lightmaps?: string;
  spawn: { position: [number, number, number]; yaw: number; pitch: number };
  objects: MapObject[];
}

export interface Transform {
  position: [number, number, number];
  /** Quaternion [x, y, z, w]. */
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
}

interface MapObjectBase {
  /** Stable identifier: never reused, survives renames and edits. */
  id: string;
  name?: string;
  /** Semantic tag for tools ("building", "road", "tree", "streetlight", ...). */
  semantic?: string;
  transform: Transform;
  tags?: string[];
}

export interface MeshObject extends MapObjectBase {
  type: 'mesh';
  asset: string;
  static?: boolean;
  castShadow?: boolean;
  collision?: boolean;
  /** Lightmap chart resolution in texels (from the asset build). Omit = not lightmapped. */
  lightmap?: { resolution: [number, number] };
  /** Material slot overrides: slot name -> material name or inline definition. */
  materialOverrides?: Record<string, string | MaterialDef>;
  receiveDecals?: boolean;
}

export interface InstancesObject extends MapObjectBase {
  type: 'instances';
  asset: string;
  castShadow?: boolean;
  collision?: boolean;
  /** Compact per-instance transforms: [x, y, z, yawDegrees, uniformScale]. */
  instances: [number, number, number, number, number][];
  materialOverrides?: Record<string, string | MaterialDef>;
}

export interface LightObject extends MapObjectBase {
  type: 'light';
  light: {
    kind: 'point' | 'spot';
    color: [number, number, number];
    /** Luminous intensity in candela. */
    intensity: number;
    range: number;
    innerAngle?: number;
    outerAngle?: number;
    sourceRadius?: number;
    fogScatter?: number;
  };
}

export interface DecalObject extends MapObjectBase {
  type: 'decal';
  decal: {
    material: string;
    /** Box size in metres: width (u), height (v), projection depth. */
    size: [number, number, number];
    opacity?: number;
    /** Texture repeats along the width (e.g. long road markings). */
    repeat?: number;
  };
}

/** Non-rendered marker (viewpoints, spawn candidates, probe placement later). */
export interface MarkerObject extends MapObjectBase {
  type: 'marker';
  yaw?: number;
  pitch?: number;
}

/** Grid of baked ambient-cube irradiance probes (lighting for dynamic / instanced objects). */
export interface ProbeVolumeObject extends MapObjectBase {
  type: 'probeVolume';
  /** transform.position = centre. */
  volume: { size: [number, number, number]; spacing: [number, number, number] };
}

/** Box-projected reflection probe, captured in-engine. */
export interface ReflectionProbeObject extends MapObjectBase {
  type: 'reflectionProbe';
  /** transform.position = capture point; box in world space (parallax + influence). */
  probe: { boxMin: [number, number, number]; boxMax: [number, number, number]; blend?: number; priority?: number };
}

export type MapObject = MeshObject | InstancesObject | LightObject | DecalObject | MarkerObject | ProbeVolumeObject | ReflectionProbeObject;

export interface LightmapSetDocument {
  format: 'rill.lightmapset';
  version: 1;
  backend: string;
  bakedAt?: string;
  atlasSize: [number, number];
  /** Component order per page; runtime layer = page * components.length + index. */
  components: ('sky' | 'skyRnm0' | 'skyRnm1' | 'skyRnm2' | 'sunBounce')[];
  referenceSun?: { azimuth: number; elevation: number };
  pages: Record<string, string>[];
  objects: Record<string, { page: number; scaleOffset: [number, number, number, number] }>;
  probeVolumes?: {
    id: string;
    origin: [number, number, number];
    spacing: [number, number, number];
    dims: [number, number, number];
    file: string;
    layout: string;
    validFraction?: number;
  }[];
  stats?: Record<string, unknown>;
}
