import type { Entity, MeshObject } from '../engine/scene/mapformat';

/**
 * Asset registry (public/assets/registry.json): the placeable content the
 * asset browser lists and `place_asset` instantiates. An asset is a mesh or
 * model reference plus metadata, entity defaults and optional prefab children
 * (e.g. a streetlight's lamp light), whose transforms are local to the asset.
 */

export interface AssetEntry {
  /** Stable identifier, e.g. "testmap/streetlight". */
  id: string;
  name: string;
  category: string;
  /** Mesh (.glb), model descriptor (.model.json) or builtin: primitive. */
  path: string;
  semantic?: string;
  tags?: string[];
  /** Map-specific geometry (terrain chunks, building shells): listed, but filtered out by default. */
  unique?: boolean;
  /** Entity fields for new placements (castShadow, collision, receiveDecals, lightmap...). */
  defaults?: Partial<Pick<MeshObject, 'castShadow' | 'collision' | 'receiveDecals' | 'static' | 'lightmap' | 'materialOverrides'>>;
  /** Prefab children, transforms local to the asset origin. */
  children?: Omit<Entity, 'id' | 'parent'>[];
  /** Local bounds (metres) when known: placement and thumbnails. */
  bounds?: { min: [number, number, number]; max: [number, number, number] };
}

export interface AssetRegistryDocument {
  format: 'rill.assets';
  version: 1;
  categories: string[];
  assets: AssetEntry[];
}

export class AssetRegistry {
  private byId = new Map<string, AssetEntry>();
  private byPath = new Map<string, AssetEntry>();
  constructor(readonly doc: AssetRegistryDocument) {
    for (const a of doc.assets) {
      this.byId.set(a.id, a);
      this.byPath.set(a.path, a);
    }
  }

  static async load(url = '/assets/registry.json'): Promise<AssetRegistry> {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (r.ok) return new AssetRegistry((await r.json()) as AssetRegistryDocument);
    } catch {
      /* fall through */
    }
    console.warn('[assets] no registry at', url);
    return new AssetRegistry({ format: 'rill.assets', version: 1, categories: [], assets: [] });
  }

  get all(): readonly AssetEntry[] {
    return this.doc.assets;
  }

  get(idOrPath: string): AssetEntry | undefined {
    return this.byId.get(idOrPath) ?? this.byPath.get(idOrPath);
  }

  /** Case-insensitive search over id, name, category, semantic and tags (all words must match). */
  search(query: string, opts: { category?: string; includeUnique?: boolean; limit?: number } = {}): AssetEntry[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const out: AssetEntry[] = [];
    for (const a of this.doc.assets) {
      if (opts.category && a.category !== opts.category) continue;
      if (a.unique && !opts.includeUnique) continue;
      const hay = `${a.id} ${a.name} ${a.category} ${a.semantic ?? ''} ${(a.tags ?? []).join(' ')}`.toLowerCase();
      if (words.every((w) => hay.includes(w))) out.push(a);
      if (opts.limit && out.length >= opts.limit) break;
    }
    return out;
  }
}
