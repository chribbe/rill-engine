import type { TextureHandle, TextureManager } from './textures';
import type { ClutterDef } from './clutter';

/**
 * Runtime material model. Materials are JSON documents (public/materials/*.json)
 * with optional inheritance, so variants and per-object overrides stay small,
 * structured and editable (by people or tools) instead of being opaque images.
 */
export type Color = [number, number, number] | [number, number, number, number] | string;

export interface MaterialDef {
  name?: string;
  inherits?: string;
  shader?: 'standard' | 'foliage' | 'unlit';
  /** 'blend': transparent glass, drawn after opaque geometry (no shadows, no depth writes). */
  alphaMode?: 'opaque' | 'mask' | 'blend';
  alphaCutoff?: number;
  doubleSided?: boolean;
  /** Metres covered by one repeat of the base textures (UV0 is in metres). */
  physicalSize?: number | [number, number];
  mapping?: 'uv' | 'triplanar';
  triplanarSharpness?: number;
  baseColor?: string;
  baseColorFactor?: Color;
  normal?: string;
  normalStrength?: number;
  orm?: string;
  roughness?: number;
  roughnessRange?: [number, number];
  metallic?: number;
  aoStrength?: number;
  /** Dielectric specular level; 0.5 = 4% F0. */
  specular?: number;
  detail?: {
    albedo?: string;
    normal?: string;
    physicalSize: number;
    albedoStrength?: number;
    normalStrength?: number;
    fadeDistance?: number;
  };
  macro?: {
    texture: string;
    physicalSize: number;
    albedoStrength?: number;
    roughnessStrength?: number;
    stainStrength?: number;
  };
  emissive?: Color;
  emissiveIntensity?: number;
  /** Emission is tinted by the base colour texture (backlit signs, displays). */
  emissiveFromBaseColor?: boolean;
  /** Indoor fittings: emit in every mood (not only when the environment's lamps are on). */
  emissiveAlways?: boolean;
  /**
   * Fake rooms behind glazing (interior mapping). Needs room-space UVs on the
   * pane (u along the facade, v up from the storey floor, metres). The emissive
   * colour is the rooms' light (night; shops/offices also by day).
   */
  interior?: {
    style?: 'home' | 'shop' | 'office' | 'hall';
    /** Room width and storey height (m). */
    room?: [number, number];
    depth?: number;
    /** Fraction of rooms lit. */
    lit?: number;
    tint?: Color;
  };
  /** How strongly the surface darkens / smooths when wet (0 = sealed, 1 = porous). */
  porosity?: number;
  translucency?: number;
  /**
   * Second layer blended by vertex colour R (0 = this material, 1 = layer B),
   * sharpened by the layers' height maps (ORM alpha) and broken up by noise.
   */
  blend?: {
    material: string;
    /** Transition sharpness. */
    contrast?: number;
    /** How much height decides which layer wins (0 = pure vertex weight). */
    height?: number;
    /** Macro-noise perturbation of the weight. */
    noise?: number;
  };
  /** Alpha-masked coverage far away: 'boost' (dense foliage, default) or 'average' (sparse twigs fade to a haze). */
  alphaDistance?: 'boost' | 'average';
  /** Snow accumulation affinity on upward-facing surfaces (0 = never, 1 = full). Default by surface type. */
  snow?: number;
  /** Dormant-season albedo multiplier (dry grass, winter moss) and how strongly the season applies. */
  dryTint?: Color;
  dryStrength?: number;
  /** Local (box-projected) reflection probes; false = sky reflection only (cheap, for rough clutter). */
  reflections?: boolean;
  /** Ground clutter scattered over surfaces with this material (detail props). */
  clutter?: ClutterDef[];
  /** Offline bake hints (average albedo for bounce light). */
  bake?: { albedo?: Color; exclude?: boolean };
  /** Free-form notes for authors / tools. */
  notes?: string;
}

export const MF = {
  BASE_TEX: 1,
  NORMAL_TEX: 2,
  ORM_TEX: 4,
  DETAIL_ALBEDO: 8,
  DETAIL_NORMAL: 16,
  MACRO: 32,
  TRIPLANAR: 64,
  MASK: 128,
  FOLIAGE: 256,
  UNLIT: 1024,
  DOUBLE_SIDED: 2048,
  BLEND: 8192,
  EMISSIVE_TEX: 16384,
  INTERIOR: 32768,
  EMISSIVE_ALWAYS: 65536,
} as const;

export const MATERIAL_PARAM_BYTES = 240;

/** Snow affinity when a material doesn't say: none on foliage/emissive/metal, full on ground-like surfaces. */
function defaultSnow(d: MaterialDef): number {
  if (d.shader === 'unlit' || d.emissive) return 0;
  if (d.shader === 'foliage') return 0.6;
  if ((d.metallic ?? 0) > 0.5) return 0.3;
  return 0.8;
}

export function parseColor(c: Color | undefined, fallback: [number, number, number, number]): [number, number, number, number] {
  if (c === undefined) return fallback;
  if (typeof c === 'string') {
    const hex = c.replace('#', '');
    const v = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const lin = v.map((x) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
    return [lin[0], lin[1], lin[2], 1];
  }
  return [c[0], c[1], c[2], c.length > 3 ? (c as number[])[3] : 1];
}

export class Material {
  readonly params: GPUBuffer;
  bindGroup!: GPUBindGroup;
  textures: {
    baseColor: TextureHandle;
    normal: TextureHandle;
    orm: TextureHandle;
    detailAlbedo: TextureHandle;
    detailNormal: TextureHandle;
    macro: TextureHandle;
    bBaseColor: TextureHandle;
    bNormal: TextureHandle;
    bOrm: TextureHandle;
  };
  /** Resolved definition of blend layer B (if any). */
  blendDef: MaterialDef | null = null;

  constructor(
    readonly id: number,
    readonly name: string,
    public def: MaterialDef,
    private device: GPUDevice,
    private layout: GPUBindGroupLayout,
    textures: Material['textures'],
    blendDef: MaterialDef | null = null,
  ) {
    this.textures = textures;
    this.blendDef = blendDef;
    this.params = device.createBuffer({
      label: `material:${name}`,
      size: MATERIAL_PARAM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.writeParams();
    this.rebuildBindGroup();
  }

  get masked() {
    return this.def.alphaMode === 'mask';
  }
  get blended() {
    return this.def.alphaMode === 'blend';
  }
  get doubleSided() {
    return !!this.def.doubleSided || this.def.shader === 'foliage';
  }

  rebuildBindGroup() {
    const t = this.textures;
    this.bindGroup = this.device.createBindGroup({
      label: `material:${this.name}`,
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.params } },
        { binding: 1, resource: t.baseColor.view },
        { binding: 2, resource: t.normal.view },
        { binding: 3, resource: t.orm.view },
        { binding: 4, resource: t.detailAlbedo.view },
        { binding: 5, resource: t.detailNormal.view },
        { binding: 6, resource: t.macro.view },
        { binding: 7, resource: t.bBaseColor.view },
        { binding: 8, resource: t.bNormal.view },
        { binding: 9, resource: t.bOrm.view },
      ],
    });
  }

  writeParams() {
    const d = this.def;
    const f = new Float32Array(MATERIAL_PARAM_BYTES / 4);
    const u = new Uint32Array(f.buffer);
    const bc = parseColor(d.baseColorFactor, [1, 1, 1, 1]);
    f.set(bc, 0);
    const ps = Array.isArray(d.physicalSize) ? d.physicalSize : [d.physicalSize ?? 1, d.physicalSize ?? 1];
    // glTF-style UVs are V-down; world-metre UVs from our tools already are.
    f.set([1 / ps[0], 1 / ps[1], 0, 0], 4);
    const det = d.detail;
    if (det) f.set([1 / det.physicalSize, 1 / det.physicalSize, det.albedoStrength ?? 0.5, det.normalStrength ?? 0.5], 8);
    const mac = d.macro;
    if (mac) f.set([1 / mac.physicalSize, 1 / mac.physicalSize, mac.albedoStrength ?? 0.15, mac.roughnessStrength ?? 0.1], 12);
    f.set([d.roughness ?? 1, d.metallic ?? 0, d.normalStrength ?? 1, d.aoStrength ?? 1], 16);
    f.set([d.specular ?? 0.5, d.alphaCutoff ?? 0.5, d.porosity ?? 0.5, d.translucency ?? 0], 20);
    const em = parseColor(d.emissive, [0, 0, 0, 1]);
    const ei = d.emissiveIntensity ?? (d.emissive ? 1 : 0);
    f.set([em[0] * ei, em[1] * ei, em[2] * ei, det?.fadeDistance ?? 40], 24);
    let flags = 0;
    if (d.baseColor) flags |= MF.BASE_TEX;
    if (d.normal) flags |= MF.NORMAL_TEX;
    if (d.orm) flags |= MF.ORM_TEX;
    if (det?.albedo) flags |= MF.DETAIL_ALBEDO;
    if (det?.normal) flags |= MF.DETAIL_NORMAL;
    if (mac) flags |= MF.MACRO;
    if (d.mapping === 'triplanar') flags |= MF.TRIPLANAR;
    if (d.alphaMode === 'mask') flags |= MF.MASK;
    if (d.shader === 'foliage') flags |= MF.FOLIAGE;
    if (d.shader === 'unlit') flags |= MF.UNLIT;
    if (this.doubleSided) flags |= MF.DOUBLE_SIDED;
    if (this.blendDef) flags |= MF.BLEND;
    if (d.emissiveFromBaseColor) flags |= MF.EMISSIVE_TEX;
    if (d.interior) flags |= MF.INTERIOR;
    if (d.emissiveAlways) flags |= MF.EMISSIVE_ALWAYS;
    u[28] = flags;
    const rr = d.roughnessRange ?? [0, 1];
    f.set([rr[0], rr[1], d.triplanarSharpness ?? 4, mac?.stainStrength ?? 0], 32);
    const b = this.blendDef;
    if (b) {
      f.set(parseColor(b.baseColorFactor, [1, 1, 1, 1]), 36);
      const bps = Array.isArray(b.physicalSize) ? b.physicalSize : [b.physicalSize ?? 1, b.physicalSize ?? 1];
      f.set([1 / bps[0], 1 / bps[1], 0, 0], 40);
      const brr = b.roughnessRange ?? [0, 1];
      f.set([b.roughness ?? 1, b.metallic ?? 0, b.normalStrength ?? 1, b.aoStrength ?? 1], 44);
      f.set([d.blend?.contrast ?? 6, d.blend?.height ?? 0.6, d.blend?.noise ?? 0.3, brr[1] - brr[0]], 48);
    }
    const it = d.interior;
    if (it && !b) {
      // Interior mapping reuses the (unused) blend-layer slots.
      const tint = parseColor(it.tint, [1, 1, 1, 1]);
      f.set([tint[0], tint[1], tint[2], it.lit ?? 0.3], 36);
      const style = { home: 0, shop: 1, office: 2, hall: 3 }[it.style ?? 'home'];
      f.set([it.room?.[0] ?? 3.6, it.room?.[1] ?? 2.8, it.depth ?? 4, style], 40);
    }
    const dry = parseColor(d.dryTint, [1, 1, 1, 1]);
    f.set([d.alphaDistance === 'average' ? 1 : 0, d.snow ?? defaultSnow(d), d.dryStrength ?? (d.dryTint ? 1 : 0), 0], 52);
    f.set([dry[0], dry[1], dry[2], 1], 56);
    this.device.queue.writeBuffer(this.params, 0, f);
  }

  /** Live parameter edit (debug UI / future editor tools). Texture changes need a reload. */
  update(patch: Partial<MaterialDef>) {
    this.def = { ...this.def, ...patch };
    this.writeParams();
  }
}

export class MaterialLibrary {
  private defs = new Map<string, Promise<MaterialDef>>();
  private materials = new Map<string, Promise<Material>>();
  readonly all: Material[] = [];
  private nextId = 0;

  constructor(
    private device: GPUDevice,
    private textures: TextureManager,
    readonly layout: GPUBindGroupLayout,
    private baseUrl = '/materials/',
    private textureBase = '/textures/',
  ) {}

  private fetchDef(name: string): Promise<MaterialDef> {
    let p = this.defs.get(name);
    if (!p) {
      p = (async () => {
        const res = await fetch(`${this.baseUrl}${name}.json`);
        if (!res.ok) {
          console.warn(`[materials] missing material '${name}', using fallback`);
          return { name, baseColorFactor: [0.8, 0.1, 0.8], roughness: 0.6 } as MaterialDef;
        }
        return (await res.json()) as MaterialDef;
      })();
      this.defs.set(name, p);
    }
    return p;
  }

  /** Resolves `inherits` chains; child fields override parent fields (shallow per key, deep for detail/macro). */
  async resolve(def: MaterialDef, depth = 0): Promise<MaterialDef> {
    if (!def.inherits || depth > 8) return def;
    const parent = await this.resolve(await this.fetchDef(def.inherits), depth + 1);
    const merged: MaterialDef = { ...parent, ...def };
    if (parent.detail && def.detail) merged.detail = { ...parent.detail, ...def.detail };
    if (parent.macro && def.macro) merged.macro = { ...parent.macro, ...def.macro };
    delete merged.inherits;
    return merged;
  }

  get(name: string): Promise<Material> {
    let p = this.materials.get(name);
    if (!p) {
      p = this.fetchDef(name).then((d) => this.create(name, d));
      this.materials.set(name, p);
    }
    return p;
  }

  /** Creates a material from an inline definition (e.g. a per-object override). */
  async create(name: string, rawDef: MaterialDef): Promise<Material> {
    const def = await this.resolve(rawDef);
    const T = this.textures;
    const tex = (path: string | undefined, kind: 'color' | 'linear' | 'normal', fallback: TextureHandle) =>
      path ? T.load(this.textureBase + path, kind).catch((e) => (console.warn(e), fallback)) : Promise.resolve(fallback);
    const blendDef = def.blend ? await this.resolve(await this.fetchDef(def.blend.material)) : null;
    const [baseColor, normal, orm, detailAlbedo, detailNormal, macro, bBaseColor, bNormal, bOrm] = await Promise.all([
      tex(def.baseColor, 'color', T.white),
      tex(def.normal, 'normal', T.flatNormal),
      tex(def.orm, 'linear', T.defaultOrm),
      tex(def.detail?.albedo, 'linear', T.gray),
      tex(def.detail?.normal, 'normal', T.flatNormal),
      tex(def.macro?.texture, 'linear', T.gray),
      tex(blendDef?.baseColor, 'color', T.white),
      tex(blendDef?.normal, 'normal', T.flatNormal),
      tex(blendDef?.orm, 'linear', T.defaultOrm),
    ]);
    const m = new Material(this.nextId++, name, def, this.device, this.layout, {
      baseColor, normal, orm, detailAlbedo, detailNormal, macro, bBaseColor, bNormal, bOrm,
    }, blendDef);
    this.all.push(m);
    return m;
  }

  byName(name: string): Material | undefined {
    return this.all.find((m) => m.name === name);
  }
}
