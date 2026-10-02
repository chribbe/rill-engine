import type { MaterialDef } from '../render/materials';

/**
 * Map document format (public/maps/<name>/map.json), version 2. The map
 * document is the authoritative world: the web editor owns it (Blender only
 * produces assets and bakes), renderer state is always derived from it, and
 * every edit goes through editor commands (src/editor/commands.ts) that patch
 * it. See docs/EDITOR.md.
 *
 * Every entity stores its own world transform; `parent` is the outliner
 * hierarchy (editor transforms carry descendants along), never a transform
 * inheritance the runtime has to resolve.
 */

export interface MapDocument {
  format: 'rill.map';
  version: 2;
  name: string;
  description?: string;
  environment: { preset: string; overrides?: Record<string, unknown> };
  /** LightmapSet manifest, relative to the map directory. */
  lightmaps?: string;
  /** Counter for generated entity IDs: IDs are never reused (lightmaps and tools key on them). */
  nextId?: number;
  entities: Entity[];
}

/** Version 1 (Blender-generated maps before the editor): `objects`, a document-level spawn, world-space turnstiles. */
export interface MapDocumentV1 {
  format: 'rill.map';
  version: 1;
  name: string;
  description?: string;
  environment: { preset: string; overrides?: Record<string, unknown> };
  lightmaps?: string;
  spawn: { position: [number, number, number]; yaw: number; pitch: number };
  objects: Entity[];
}

export interface Transform {
  position: [number, number, number];
  /** Quaternion [x, y, z, w]. */
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
}

interface EntityCommon {
  /** Stable identifier: never reused, survives renames and edits. */
  id: string;
  name?: string;
  /** Semantic class for tools and queries ("building", "road", "tree", "streetlight", ...). */
  semantic?: string;
  tags?: string[];
  /** Outliner parent (a group or any entity). Organisational only: transforms are stored in world space. */
  parent?: string;
  /** false: not rendered, not collided (editor and play). */
  visible?: boolean;
  /** Not pickable in the viewport; transform / delete commands refuse it (other properties stay editable). */
  locked?: boolean;
}

interface MapObjectBase extends EntityCommon {
  transform: Transform;
}

/** Outliner folder. No transform: moving a group moves its descendants. */
export interface GroupObject extends EntityCommon {
  type: 'group';
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
  /**
   * Turnstile rotor (tripod arms): turns 120° about `axis` through `pivot` when the
   * player walks through the lane (centre `lane`, passing direction `dir`). Entity-local
   * space (so the turnstile moves with its entity).
   */
  turnstile?: { pivot: [number, number, number]; axis: [number, number, number]; lane: [number, number, number]; dir: [number, number, number] };
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
    /** Indoor light: on in every mood (station halls, stairwells). */
    always?: boolean;
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

/** Non-rendered marker: semantic 'viewpoint' (camera bookmarks) or 'spawn' (player start). */
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

/**
 * Text sign (shop fascia, station name band, street sign), rasterised at load
 * with the bundled fonts. Face in the local XY plane facing +Z, centred.
 */
export interface SignObject extends MapObjectBase {
  type: 'sign';
  sign: {
    text: string;
    /** Face size in metres [width, height]. */
    size: [number, number];
    font?: 'Barlow Condensed' | 'Jost' | 'Archivo Black' | 'Pacifico' | 'Inter';
    weight?: number;
    italic?: boolean;
    color?: string;
    background?: string;
    border?: string;
    align?: 'left' | 'center' | 'right';
    /** Cap height share of the face height (all lines). */
    textHeight?: number;
    letterSpacing?: number;
    padding?: number;
    uppercase?: boolean;
    /** Backlit sign (emissive face). */
    backlit?: number;
    /** Lightbox depth in metres (0 = flat panel on a wall). */
    depth?: number;
    doubleSided?: boolean;
  };
}

/**
 * Procedural scatter (vegetation, rocks): a species preset distributed over an area
 * by a deterministic, cell-local rule, so painting or erasing only changes the
 * instances where the brush was. Shapes are in the entity's local XZ plane (the
 * transform moves / turns the whole scatter); instances are dropped to the ground.
 */
export interface ScatterObject extends MapObjectBase {
  type: 'scatter';
  scatter: {
    /** Preset name (public/scatter/<name>.json). */
    preset: string;
    /** Instances per 100 m² (default: the preset's). */
    density?: number;
    seed: number;
    /** Closed polygon [x, z][] (local). */
    area?: [number, number][];
    /**
     * Brush circles [x, z, radius, mode] (local; mode 1 = paint, 0 = erase), in the
     * order painted: the last circle containing a point decides; outside every
     * circle the area polygon does.
     */
    brush?: [number, number, number, 0 | 1][];
    /** Removed instances (cell keys "ix,iz"). */
    exclude?: string[];
    /** Ground semantics instances may stand on (default: the preset's, else ['terrain']). */
    surfaces?: string[];
    /** Steepest ground (degrees). */
    slopeMax?: number;
  };
}

/**
 * Spline-based geometry (paths, roads, kerbs, fences, rail tracks): control points
 * in local space, a preset describing the cross-section / repeated parts, built
 * into meshes at runtime (and exported for the lightmap bake).
 */
export interface SplineObject extends MapObjectBase {
  type: 'spline';
  spline: {
    /**
     * Control points (local). With `drape` the curve follows the ground found within a
     * window just below the points' heights (so paths stay under bridges, off roofs).
     */
    points: [number, number, number][];
    closed?: boolean;
    /** Preset name (built-in, see render/splines.ts). */
    preset: string;
    /** Width override (m) for ribbon presets. */
    width?: number;
    /** Follow the ground under each point (default true). */
    drape?: boolean;
    /** Lightmap texel density override (texels / m). */
    texelDensity?: number;
  };
  /** Lightmap chart of the generated mesh (written by the editor before a bake). */
  lightmap?: { resolution: [number, number] };
  castShadow?: boolean;
  collision?: boolean;
}

export type Entity = MeshObject | InstancesObject | LightObject | DecalObject | MarkerObject | ProbeVolumeObject | ReflectionProbeObject | SignObject | GroupObject | ScatterObject | SplineObject;
export type EntityType = Entity['type'];
/** Entities with a transform (everything but groups). */
export type SpatialEntity = Exclude<Entity, GroupObject>;
/** @deprecated name from format v1. */
export type MapObject = Entity;

export function isSpatial(e: Entity): e is SpatialEntity {
  return e.type !== 'group';
}

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
