/**
 * Physical surface classes (Source's "surfaceprop"): what a triangle is made
 * of, for impacts, footsteps and later penetration / acoustics. Materials
 * declare `"surface"` in their JSON (inherited); names without one are guessed
 * from the material name. Ids are stable small integers stored per collision
 * triangle; ids 0 and 1 keep their original meaning (default, metal).
 */
export const SURFACE_NAMES = [
  'default', 'metal', 'concrete', 'brick', 'stone', 'asphalt', 'plaster', 'tile', 'wood', 'glass',
  'soil', 'grass', 'gravel', 'rubber', 'plastic', 'snow', 'foliage', 'flesh',
] as const;
export type SurfaceName = (typeof SURFACE_NAMES)[number];

const ID = new Map<string, number>(SURFACE_NAMES.map((n, i) => [n, i]));

export function surfaceId(name: string | undefined): number {
  return (name ? ID.get(name) : undefined) ?? 0;
}

export function surfaceName(id: number): SurfaceName {
  return SURFACE_NAMES[id] ?? 'default';
}

const GUESS: [RegExp, SurfaceName][] = [
  [/(foliage|twigs|tuft)/, 'foliage'],
  [/(glass|window|_interior$|lamp_|light)/, 'glass'],
  [/(tyre|rubber)/, 'rubber'],
  [/(wood|teak|plank|bark)/, 'wood'],
  [/(metal|steel|chrome|rail|galvan|car_|fence|bronze|sign)/, 'metal'],
  [/brick/, 'brick'],
  [/(plaster|render)/, 'plaster'],
  [/tile/, 'tile'],
  [/asphalt/, 'asphalt'],
  [/(granite|rock|stone|paving|terrazzo|kerb|curb)/, 'stone'],
  [/(gravel|ballast)/, 'gravel'],
  [/(grass|lawn|moss)/, 'grass'],
  [/(dirt|ground|soil|mud)/, 'soil'],
  [/snow/, 'snow'],
  [/(plastic|polymer)/, 'plastic'],
];

/** Surface of a material: its declared `surface`, else a guess from the name, else concrete-like default. */
export function surfaceOfMaterial(name: string, def: { surface?: string; metallic?: number }): number {
  if (def.surface && ID.has(def.surface)) return ID.get(def.surface)!;
  for (const [re, s] of GUESS) if (re.test(name)) return ID.get(s)!;
  return (def.metallic ?? 0) > 0.5 ? ID.get('metal')! : ID.get('concrete')!;
}
