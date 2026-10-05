import GUI, { type Controller } from 'lil-gui';
import type { Game } from '../game';
import type { ConfigFile } from '../config';

/**
 * Gameplay tuning panel (lil-gui). Every control edits the live config object
 * the game reads each tick, so changes apply immediately. Values that differ
 * from the file are marked with •; each config has Save / Revert / Defaults.
 */
export class TuningPanel {
  readonly gui: GUI;
  private bound: { c: Controller; cfg: ConfigFile<object>; path: string; label: string }[] = [];

  constructor(private game: Game, container: HTMLElement) {
    this.gui = new GUI({ title: 'Gameplay tuning', width: 300, container });
    this.buildPlayer();
    this.buildWeapon();
    this.buildDebug();
  }

  /** Binds `obj[key]` (inside `cfg`, at `path`) with change marking. */
  private bind<T extends object>(folder: GUI, cfg: ConfigFile<T>, obj: object, key: string, path: string, label: string, min?: number, max?: number, step?: number) {
    const o = obj as Record<string, unknown>;
    const c = min !== undefined ? folder.add(o, key, min, max, step) : folder.add(o, key);
    c.name(label);
    const entry = { c, cfg: cfg as unknown as ConfigFile<object>, path, label };
    this.bound.push(entry);
    c.onChange(() => this.mark(entry));
    return c;
  }

  private mark(e: { c: Controller; cfg: ConfigFile<object>; path: string; label: string }) {
    e.c.name(e.cfg.changed(e.path) ? `• ${e.label}` : e.label);
  }

  private refresh() {
    for (const e of this.bound) {
      e.c.updateDisplay();
      this.mark(e);
    }
  }

  private fileButtons<T extends object>(folder: GUI, cfg: ConfigFile<T>) {
    cfg.onReplace.push(() => this.refresh());
    const actions = {
      save: async () => {
        try {
          const f = await cfg.save();
          console.info(`[game] saved ${f}`);
          this.refresh();
        } catch (e) {
          console.error('[game] save failed', e);
          alert(`Save failed: ${e}`);
        }
      },
      revert: () => cfg.revert(),
      factory: () => cfg.factory(),
    };
    folder.add(actions, 'save').name(`Save ${cfg.name}.json`);
    folder.add(actions, 'revert').name('Revert to file');
    folder.add(actions, 'factory').name('Code defaults');
  }

  private buildPlayer() {
    const cfg = this.game.playerConfig, t = cfg.data;
    const f = this.gui.addFolder('Player');
    const b = (folder: GUI, key: keyof typeof t, label: string, min?: number, max?: number, step?: number) => this.bind(folder, cfg, t, key, key, label, min, max, step);
    const look = f.addFolder('Look');
    b(look, 'sensitivity', 'Sensitivity (0.022°/count ×)', 0.2, 20, 0.05);
    b(look, 'invertY', 'Invert Y');
    b(look, 'fov', 'FOV (horizontal 16:9, °)', 70, 120, 1);
    const move = f.addFolder('Movement');
    b(move, 'runSpeed', 'Run (m/s)', 1, 10, 0.05);
    b(move, 'sprintSpeed', 'Sprint (m/s)', 1, 12, 0.05);
    b(move, 'walkSpeed', 'Walk, Alt (m/s)', 0.5, 6, 0.05);
    b(move, 'crouchSpeed', 'Crouch (m/s)', 0.5, 6, 0.05);
    b(move, 'groundAccel', 'Ground accel (m/s²)', 5, 150, 1);
    b(move, 'groundDecel', 'Ground brake (m/s²)', 5, 150, 1);
    b(move, 'airAccel', 'Air steering (m/s²)', 0, 40, 0.5);
    const jump = f.addFolder('Jump / crouch');
    b(jump, 'jumpHeight', 'Jump height (m)', 0, 2, 0.01);
    b(jump, 'gravity', 'Gravity (m/s²)', 5, 40, 0.1);
    b(jump, 'coyoteTime', 'Coyote time (s)', 0, 0.3, 0.005);
    b(jump, 'jumpBuffer', 'Jump buffer (s)', 0, 0.3, 0.005);
    b(jump, 'crouchToggle', 'Crouch toggles');
    b(jump, 'crouchRate', 'Crouch eye rate (1/s)', 2, 40, 0.5);
    jump.close();
    const cam = f.addFolder('Camera feel');
    b(cam, 'landDip', 'Landing dip (m per m/s)', 0, 0.05, 0.001);
    b(cam, 'landDipMax', 'Landing dip max (m)', 0, 0.3, 0.005);
    b(cam, 'landHz', 'Landing spring (Hz)', 0.5, 10, 0.1);
    b(cam, 'landDamping', 'Landing damping', 0.1, 1.5, 0.01);
    b(cam, 'stepSmoothing', 'Step smoothing (1/s)', 2, 60, 0.5);
    b(cam, 'bobAmount', 'Head bob (m)', 0, 0.05, 0.001);
    b(cam, 'strafeRoll', 'Strafe roll (°)', 0, 4, 0.05);
    cam.close();
    const body = f.addFolder('Body');
    b(body, 'eyeStand', 'Eye height (m)', 1.2, 1.9, 0.01);
    b(body, 'eyeCrouch', 'Crouched eye (m)', 0.6, 1.4, 0.01);
    b(body, 'standHeight', 'Capsule height (m)', 1.4, 2.1, 0.01);
    b(body, 'crouchHeight', 'Crouched capsule (m)', 0.8, 1.6, 0.01);
    b(body, 'radius', 'Radius (m)', 0.15, 0.5, 0.005);
    b(body, 'stepHeight', 'Step height (m)', 0.1, 0.6, 0.01);
    b(body, 'maxSlope', 'Max slope (°)', 20, 70, 0.5);
    b(body, 'strideWalk', 'Stride at walk (m)', 0.3, 1.5, 0.01);
    b(body, 'strideSprint', 'Stride at sprint (m)', 0.3, 2, 0.01);
    body.close();
    this.fileButtons(f, cfg);
  }

  private buildWeapon() {
    const cfg = this.game.weaponConfig, d = cfg.data;
    const f = this.gui.addFolder('Weapon');
    const fire = f.addFolder('Fire');
    const b = <O extends object>(folder: GUI, obj: O, group: string, key: keyof O & string, label: string, min?: number, max?: number, step?: number) =>
      this.bind(folder, cfg, obj, key, `${group}.${key}`, label, min, max, step);
    fire.add(d.fire, 'mode', ['auto', 'semi']).name('Mode');
    b(fire, d.fire, 'fire', 'rpm', 'Rate of fire (RPM)', 200, 1200, 10);
    b(fire, d.fire, 'fire', 'damage', 'Damage', 1, 100, 0.5);
    b(fire, d.fire, 'fire', 'impactForce', 'Impact force (N·s)', 0, 40, 0.1);
    b(fire, d.fire, 'fire', 'range', 'Range (m)', 20, 500, 5);
    b(fire, d.fire, 'fire', 'falloffStart', 'Falloff start (m)', 0, 200, 1);
    b(fire, d.fire, 'fire', 'falloffEnd', 'Falloff end (m)', 0, 400, 1);
    b(fire, d.fire, 'fire', 'falloffMin', 'Falloff min ×', 0, 1, 0.01);
    b(fire, d.fire, 'fire', 'magazine', 'Magazine', 1, 100, 1);
    b(fire, d.fire, 'fire', 'reloadTime', 'Reload (s)', 0.3, 5, 0.05);
    b(fire, d.fire, 'fire', 'infiniteAmmo', 'Infinite ammo');
    b(fire, d.fire, 'fire', 'pierceGlass', 'Bullets pierce glass');
    b(fire, d.fire, 'fire', 'sprintBlock', 'Sprint blocked after shot (s)', 0, 1, 0.01);
    const sp = f.addFolder('Spread (cone half-angle °)');
    b(sp, d.spread, 'spread', 'base', 'First shot', 0, 2, 0.01);
    b(sp, d.spread, 'spread', 'perShot', 'Bloom per shot', 0, 1, 0.005);
    b(sp, d.spread, 'spread', 'max', 'Bloom max', 0, 5, 0.05);
    b(sp, d.spread, 'spread', 'recovery', 'Recovery (°/s)', 0, 20, 0.1);
    b(sp, d.spread, 'spread', 'recoveryDelay', 'Recovery delay (s)', 0, 0.5, 0.005);
    b(sp, d.spread, 'spread', 'moving', 'Moving (at run speed)', 0, 4, 0.05);
    b(sp, d.spread, 'spread', 'air', 'In the air', 0, 8, 0.1);
    b(sp, d.spread, 'spread', 'crouch', 'Crouched ×', 0.2, 1.5, 0.01);
    sp.close();
    this.fileButtons(f, cfg);
  }

  private buildDebug() {
    const g = this.game, rt = g.rt;
    const f = this.gui.addFolder('Debug');
    const dbg = {
      get timeScale() { return g.clock.timeScale; },
      set timeScale(v: number) { g.clock.timeScale = v; },
      get fpsCap() { return rt.fpsCap; },
      set fpsCap(v: number) { rt.fpsCap = v; },
      get hud() { return g.hud?.visible ?? false; },
      set hud(v: boolean) { if (g.hud) g.hud.visible = v; },
      fly: () => rt.player.toggleFly(),
      spawn: () => { const s = rt.world.spawn(); rt.player.fly = false; rt.player.teleport(s.position, s.yaw, s.pitch); },
      frameTest: async () => console.table((await g.testFrameRates()).maxDeviation),
      get traces() { return g.showTraces; },
      set traces(v: boolean) { g.showTraces = v; if (!v) g.debug.clear(); },
      get decals() { return g.impacts.decals; },
      set decals(v: boolean) { g.impacts.decals = v; },
      get spreadTicks() { return g.crosshair?.showSpread ?? false; },
      set spreadTicks(v: boolean) { if (g.crosshair) g.crosshair.showSpread = v; },
      get hitMarker() { return g.crosshair?.hitMarker ?? false; },
      set hitMarker(v: boolean) { if (g.crosshair) g.crosshair.hitMarker = v; },
      clear: () => g.resetEffects(),
    };
    f.add(dbg, 'traces').name('Shot traces');
    f.add(dbg, 'decals').name('Bullet decals');
    f.add(dbg, 'spreadTicks').name('Crosshair spread');
    f.add(dbg, 'hitMarker').name('Hit marker');
    f.add(dbg, 'clear').name('Clear decals / traces');
    f.add(dbg, 'timeScale', [0.05, 0.1, 0.25, 0.5, 1]).name('Time scale');
    f.add(dbg, 'fpsCap', { off: 0, '20': 20, '30': 30, '60': 60, '90': 90, '120': 120 }).name('FPS cap');
    f.add(dbg, 'hud').name('Readout');
    f.add(dbg, 'spawn').name('Back to spawn');
    f.add(dbg, 'fly').name('Toggle fly (F)');
    f.add(dbg, 'frameTest').name('Frame-rate test (console)');
    f.close();
  }
}
