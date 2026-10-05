import type { Renderer, Renderable } from '../../engine/render/renderer';
import type { World } from '../../engine/scene/world';
import type { FirstPersonController } from '../../engine/player/controller';
import type { MarkerObject } from '../../engine/scene/mapformat';
import type { RigPartSource } from '../../engine/scene/rig';
import { loadGlbParts } from '../../engine/assets/gltf';
import type { Hitscan } from '../combat/hitscan';
import type { EnemyDef } from './def';
import { Enemy } from './enemy';

/**
 * Spawns and runs enemies. Spawn points are map markers with semantic
 * `enemy_spawn` (editor / AI placeable); with none, one point ahead of the
 * player start is used. G1 keeps one enemy alive at a time (`maxAlive`): when
 * it dies a new one rises after `respawn` seconds; corpses stay for
 * `corpseTime`.
 */
export class Enemies {
  readonly list: Enemy[] = [];
  maxAlive = 1;
  /** Off while the gun is being tuned on its own (panel: "Enemy on (spawns, AI)"). */
  enabled = false;
  private parts: RigPartSource[] | null = null;
  private respawnT = 0;
  private serial = 0;
  onSpawn: ((e: Enemy) => void)[] = [];

  constructor(private renderer: Renderer, private world: World, private hitscan: Hitscan, public def: EnemyDef) {}

  async load() {
    const R = this.renderer;
    const parts = await loadGlbParts(this.def.model);
    this.parts = await Promise.all(parts.filter((p) => p.mesh.primitives.length).map(async (p) => {
      const mesh = R.arena.upload(p.mesh);
      const materials = await Promise.all(mesh.primitives.map((q) => R.materials.get(q.material)));
      return { name: p.name, parent: p.parent, rest: p.rest, mesh, materials };
    }));
  }

  spawnPoints(): { position: [number, number, number]; yaw: number }[] {
    const m = this.world.doc.entities.filter((e): e is MarkerObject => e.type === 'marker' && e.semantic === 'enemy_spawn');
    if (m.length) return m.map((e) => ({ position: [...e.transform.position] as [number, number, number], yaw: e.yaw ?? 0 }));
    const s = this.world.spawn(), a = (s.yaw * Math.PI) / 180;
    return [{ position: [s.position[0] + Math.sin(a) * 14, s.position[1], s.position[2] - Math.cos(a) * 14], yaw: s.yaw + 180 }];
  }

  /** Spawns at the spawn point farthest from the player (or `at`). */
  spawn(player: FirstPersonController, at?: [number, number, number]) {
    if (!this.parts) return null;
    const pts = this.spawnPoints();
    let best = pts[0];
    if (!at) {
      let bd = -1;
      for (const p of pts) {
        const d = Math.hypot(p.position[0] - player.feet[0], p.position[2] - player.feet[2]);
        if (d > bd) { bd = d; best = p; }
      }
    }
    const pos = at ?? best.position;
    const e = new Enemy(`enemy${this.serial++}`, this.def, this.renderer, this.world.collision, this.parts, this.world.renderables as Renderable[], pos, best.yaw);
    this.list.push(e);
    this.hitscan.targets.push(e);
    for (const f of this.onSpawn) f(e);
    return e;
  }

  remove(e: Enemy) {
    e.destroy(this.world.renderables as Renderable[]);
    this.list.splice(this.list.indexOf(e), 1);
    const i = this.hitscan.targets.indexOf(e);
    if (i >= 0) this.hitscan.targets.splice(i, 1);
  }

  clear() {
    while (this.list.length) this.remove(this.list[0]);
  }

  tick(h: number, player: FirstPersonController) {
    if (!this.enabled) return;
    for (const e of this.list) e.tick(h, player);
    // Corpses fade out of the hitscan once they settle, and go after a while.
    for (const e of [...this.list]) if (!e.alive && e.deadT > this.def.corpseTime) this.remove(e);
    const alive = this.list.filter((e) => e.alive).length;
    if (alive < this.maxAlive) {
      this.respawnT += h;
      if (this.respawnT >= this.def.respawn) {
        this.respawnT = 0;
        this.spawn(player);
      }
    } else {
      this.respawnT = 0;
    }
  }

  pose(dt: number, alpha: number, player: FirstPersonController) {
    for (const e of this.list) e.pose(dt, alpha, player);
  }
}
