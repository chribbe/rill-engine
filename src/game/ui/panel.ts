import GUI, { type Controller } from 'lil-gui';
import type { Game } from '../game';
import type { ConfigFile } from '../config';
import type { WeaponDef } from '../weapon/def';

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
    this.buildEnemy();
    this.buildAudio();
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
    const table = (title: string, group: keyof WeaponDef, rows: [string, string, number, number, number][], open = false) => {
      const folder = f.addFolder(title);
      const obj = d[group] as unknown as Record<string, unknown>;
      for (const [key, label, min, max, step] of rows) this.bind(folder, cfg, obj, key, `${group}.${key}`, label, min, max, step);
      if (!open) folder.close();
      return folder;
    };
    table('Recoil (aim, °)', 'recoil', [
      ['pitch', 'Vertical per shot', 0, 2, 0.01], ['yaw', 'Horizontal pattern', 0, 1.5, 0.01],
      ['patternFreq', 'Pattern frequency', 0, 2, 0.01], ['patternPhase', 'Pattern phase', -3.2, 3.2, 0.05],
      ['randomPitch', 'Random vertical ±', 0, 0.5, 0.005], ['randomYaw', 'Random horizontal ±', 0, 0.5, 0.005],
      ['firstShot', 'First shot ×', 0, 1.5, 0.01], ['ramp', 'Ramp (shots)', 0, 15, 1],
      ['maxPitch', 'Max vertical', 0, 15, 0.1], ['maxYaw', 'Max horizontal', 0, 8, 0.1],
      ['kickTime', 'Kick time (s)', 0.005, 0.2, 0.001], ['permanent', 'Permanent share', 0, 1, 0.01],
      ['recoverDelay', 'Recovery delay (s)', 0, 0.5, 0.005], ['recoverRate', 'Recovery rate (1/s)', 0, 30, 0.1],
    ], true);
    table('View punch (visual, °)', 'punch', [
      ['pitch', 'Pitch', 0, 3, 0.01], ['yaw', 'Yaw', 0, 2, 0.01], ['roll', 'Roll', 0, 3, 0.01],
      ['hz', 'Spring (Hz)', 1, 25, 0.1], ['damping', 'Damping', 0.1, 1.5, 0.01],
    ]);
    table('Weapon kick (model)', 'kick', [
      ['back', 'Back (m)', 0, 0.1, 0.001], ['up', 'Up (m)', 0, 0.03, 0.0005], ['pitch', 'Muzzle rise (°)', 0, 10, 0.05],
      ['yaw', 'Yaw (°)', 0, 5, 0.05], ['roll', 'Roll (°)', 0, 6, 0.05], ['random', 'Variation', 0, 1, 0.01],
      ['posHz', 'Position spring (Hz)', 1, 25, 0.1], ['posDamping', 'Position damping', 0.1, 1.5, 0.01],
      ['rotHz', 'Rotation spring (Hz)', 1, 25, 0.1], ['rotDamping', 'Rotation damping', 0.1, 1.5, 0.01],
      ['jitter', 'Side jitter (m)', 0, 0.01, 0.0001], ['burstBack', 'Burst ride back (m)', 0, 0.06, 0.0005],
      ['burstRise', 'Burst ride up (°)', 0, 6, 0.05], ['burstBuild', 'Burst build (shots)', 1, 20, 0.5], ['burstSettle', 'Burst settle (1/s)', 0.5, 20, 0.1],
    ]);
    table('Shot effects (visual)', 'fx', [
      ['flashScale', 'Flash size ×', 0, 3, 0.05], ['flashLight', 'Flash light (cd)', 0, 3000, 10], ['flashRange', 'Flash light range (m)', 1, 40, 0.5],
      ['flashRefEV', 'Flash light tuned at (EV)', 0, 16, 0.1], ['flashDark', 'Flash light in the dark (0 tame, 1 physical)', 0, 1, 0.01],
      ['tracerEvery', 'Tracer every N rounds (0 = off)', 0, 10, 1], ['tracerSpeed', 'Tracer speed (m/s)', 50, 600, 5], ['tracerLength', 'Tracer length (m)', 0.2, 12, 0.1],
      ['tracerWidth', 'Tracer half width (m)', 0.002, 0.05, 0.0005], ['tracerEmissive', 'Tracer brightness (nits)', 0, 100000, 500],
      ['fovPunch', 'FOV punch per shot (°)', 0, 4, 0.05], ['shotSmoke', 'Muzzle smoke per shot', 0, 1, 0.01],
      ['barrelSmoke', 'Barrel smoke after firing', 0, 1, 0.01], ['reloadPunch', 'Reload view jolt (°)', 0, 5, 0.05],
      ['ejectRight', 'Brass out right (m/s)', 0, 5, 0.05], ['ejectUp', 'Brass out up (m/s)', 0, 5, 0.05],
      ['ejectForward', 'Brass out forward (m/s)', -3, 3, 0.05], ['ejectRandom', 'Brass variation', 0, 1, 0.01],
      ['ejectSpin', 'Brass tumble (rad/s)', 0, 80, 1], ['brassScale', 'Brass size ×', 0.5, 3, 0.05], ['brassLife', 'Brass stays (s)', 1, 120, 1],
    ], true);
    const vm = table('Viewmodel motion', 'viewmodel', [
      ['fov', 'Weapon FOV (vertical °)', 30, 90, 0.5],
      ['sway', 'Look lag (° per rad/s)', 0, 4, 0.01], ['swayMax', 'Look lag max (°)', 0, 10, 0.1],
      ['swayHz', 'Look spring (Hz)', 0.5, 12, 0.1], ['swayDamping', 'Look damping', 0.1, 1.5, 0.01],
      ['bobSide', 'Bob side (m)', 0, 0.03, 0.0005], ['bobUp', 'Bob up (m)', 0, 0.03, 0.0005], ['bobRoll', 'Bob roll (°)', 0, 4, 0.05],
      ['strafeRoll', 'Strafe roll (° per m/s)', 0, 3, 0.01], ['accelLag', 'Accel lag (m per m/s²)', 0, 0.006, 0.0001],
      ['airLift', 'Air lift (m per m/s)', 0, 0.02, 0.0005], ['airPitch', 'Air pitch (° per m/s)', 0, 3, 0.05],
      ['landDrop', 'Landing drop (m)', 0, 0.03, 0.0005], ['landPitch', 'Landing pitch (°)', 0, 4, 0.05],
      ['crouchRoll', 'Crouch cant (°)', -20, 20, 0.5], ['sprintRate', 'Sprint blend (1/s)', 1, 30, 0.5],
      ['breathe', 'Breathing (m)', 0, 0.005, 0.0001], ['breathePitch', 'Breathing pitch (°)', 0, 1, 0.01], ['breatheRate', 'Breathing (Hz)', 0, 1, 0.01],
    ]);
    const vmo = d.viewmodel;
    const vec = (label: string, arr: [number, number, number], path: string, lim: number) => {
      const folder = vm.addFolder(label);
      ['x', 'y', 'z'].forEach((axis, i) => this.bind(folder, cfg, arr, String(i), `${path}.${i}`, axis, -lim, lim, lim / 200));
      folder.close();
    };
    vec('Offset (m)', vmo.offset, 'viewmodel.offset', 0.5);
    vec('Rotation (pitch, yaw, roll °)', vmo.rotation, 'viewmodel.rotation', 30);
    vec('Pivot (m)', vmo.pivot, 'viewmodel.pivot', 0.3);
    vec('Crouch offset (m)', vmo.crouchOffset, 'viewmodel.crouchOffset', 0.1);
    vec('Sprint offset (m)', vmo.sprintOffset, 'viewmodel.sprintOffset', 0.2);
    vec('Sprint rotation (°)', vmo.sprintRot, 'viewmodel.sprintRot', 60);
    vec('Reload offset (m)', vmo.reloadOffset, 'viewmodel.reloadOffset', 0.2);
    vec('Reload rotation (°)', vmo.reloadRot, 'viewmodel.reloadRot', 60);
    const rl = table('Reload (s)', 'reload', [
      ['tactical', 'Tactical reload', 0.3, 5, 0.05], ['empty', 'Empty reload', 0.3, 6, 0.05],
      ['magOut', 'Magazine out at', 0, 3, 0.01], ['magIn', 'Magazine in at', 0, 4, 0.01],
      ['rackStart', 'Rack at (empty)', 0, 5, 0.01], ['rackEnd', 'Release at (empty)', 0, 5, 0.01],
    ]);
    this.bind(rl, cfg, d.reload, 'chamberPlusOne', 'reload.chamberPlusOne', 'Chambered round +1');
    this.bind(rl, cfg, d.reload, 'auto', 'reload.auto', 'Auto reload when empty');
    table('Mechanics', 'mechanics', [
      ['boltTravel', 'Bolt travel (m)', 0, 0.15, 0.001], ['boltBack', 'Bolt back share', 0.05, 0.95, 0.01], ['triggerPull', 'Trigger pull (°)', 0, 30, 0.5],
    ]);
    this.fileButtons(f, cfg);
  }

  private buildEnemy() {
    const g = this.game, cfg = g.hordeConfig, d = cfg.data;
    const f = this.gui.addFolder('Horde (tomato)');
    const b = <O extends object>(folder: GUI, obj: O, path: string, key: keyof O & string, label: string, min?: number, max?: number, step?: number) =>
      this.bind(folder, cfg, obj, key, path ? `${path}.${key}` : key, label, min, max, step);
    const act = {
      spawn: () => {
        const p = g.rt.player, a = g.rt.camera.yaw;
        g.spawnTomato([p.feet[0] + Math.sin(a) * 10, p.feet[1], p.feet[2] - Math.cos(a) * 10]);
      },
      spawn5: () => { for (let i = 0; i < 5; i++) g.spawnTomato(); },
      clear: () => g.horde.clear(),
      get ai() { return g.horde.enabled; },
      set ai(v: boolean) { g.horde.enabled = v; },
      get max() { return g.horde.maxAlive; },
      set max(v: number) { g.horde.maxAlive = v; },
      get boxes() { return g.showHitboxes; },
      set boxes(v: boolean) { g.showHitboxes = v; },
    };
    f.add(act, 'ai').name('Horde on (spawns, AI)');
    f.add(act, 'max', 0, 160, 1).name('Alive at once');
    f.add(act, 'spawn').name('Spawn one in front');
    f.add(act, 'spawn5').name('Spawn 5 (spawn points)');
    f.add(act, 'clear').name('Remove all');
    f.add(act, 'boxes').name('Show hit shapes');
    const dir = {
      get packMin() { return g.packSize[0]; }, set packMin(v: number) { g.packSize[0] = v; g.packSize[1] = Math.max(v, g.packSize[1]); },
      get packMax() { return g.packSize[1]; }, set packMax(v: number) { g.packSize[1] = v; g.packSize[0] = Math.min(v, g.packSize[0]); },
      get near() { return g.spawnPath[0]; }, set near(v: number) { g.spawnPath[0] = v; g.spawnPath[1] = Math.max(v + 2, g.spawnPath[1]); },
      get far() { return g.spawnPath[1]; }, set far(v: number) { g.spawnPath[1] = Math.max(g.spawnPath[0] + 2, v); },
    };
    f.add(dir, 'packMin', 1, 20, 1).name('Pack size from');
    f.add(dir, 'packMax', 1, 30, 1).name('Pack size to');
    f.add(dir, 'near', 5, 80, 1).name('Spawn path from (m)');
    f.add(dir, 'far', 7, 110, 1).name('Spawn path to (m)');
    const pl = f.addFolder('Player health');
    pl.add(g.vitals, 'god').name('Invulnerable');
    pl.add(g.vitals, 'max', 10, 500, 5).name('Health');
    pl.add(g.vitals, 'regenDelay', 0, 20, 0.5).name('Regen after (s)');
    pl.add(g.vitals, 'regenRate', 0, 100, 1).name('Regen (hp/s)');
    pl.close();
    b(f, d, '', 'health', 'Tomato health', 1, 500, 1);
    const mv = f.addFolder('Movement');
    b(mv, d.move, 'move', 'speed', 'Chase (m/s)', 0, 12, 0.05);
    b(mv, d.move, 'move', 'sprint', 'Sprint far away (m/s)', 0, 16, 0.05);
    b(mv, d.move, 'move', 'sprintDistance', 'Sprint beyond (m)', 0, 60, 0.5);
    b(mv, d.move, 'move', 'accel', 'Accel (m/s²)', 1, 60, 0.5);
    b(mv, d.move, 'move', 'turnRate', 'Turn rate (°/s)', 30, 1080, 5);
    b(mv, d.move, 'move', 'speedJitter', 'Speed variation', 0, 0.6, 0.01);
    mv.close();
    const ga = f.addFolder('Gait');
    b(ga, d.gait, 'gait', 'stride', 'Stride (m)', 0.1, 1.5, 0.01);
    b(ga, d.gait, 'gait', 'lift', 'Foot lift (m)', 0, 0.4, 0.005);
    b(ga, d.gait, 'gait', 'duty', 'Planted share of cycle', 0.3, 0.85, 0.01);
    b(ga, d.gait, 'gait', 'bob', 'Body bob (m)', 0, 0.1, 0.001);
    b(ga, d.gait, 'gait', 'sway', 'Body sway (°)', 0, 12, 0.1);
    b(ga, d.gait, 'gait', 'lean', 'Lean (° per m/s²)', 0, 6, 0.05);
    b(ga, d.gait, 'gait', 'roll', 'Roll in turns (°)', 0, 40, 0.5);
    ga.close();
    const cr = f.addFolder('Crowd');
    b(cr, d.crowd, 'crowd', 'spacing', 'Body spacing ×', 0.5, 1.2, 0.01);
    b(cr, d.crowd, 'crowd', 'climbAfter', 'Climb over others after (s)', 0, 2, 0.05);
    b(cr, d.crowd, 'crowd', 'climbSpeed', 'Climb speed (m/s)', 0, 8, 0.1);
    b(cr, d.crowd, 'crowd', 'ledgeSpeed', 'Ledge clamber (m/s)', 0.5, 10, 0.1);
    b(cr, d.crowd, 'crowd', 'direct', 'Straight at player within (m)', 0, 10, 0.1);
    cr.close();
    const at = f.addFolder('Attack');
    b(at, d.attack, 'attack', 'range', 'Bite range (m)', 0.5, 3, 0.05);
    b(at, d.attack, 'attack', 'windup', 'Wind-up (s)', 0.02, 1, 0.01);
    b(at, d.attack, 'attack', 'recover', 'Recover (s)', 0, 2, 0.01);
    b(at, d.attack, 'attack', 'cooldown', 'Cooldown (s)', 0, 3, 0.05);
    b(at, d.attack, 'attack', 'damage', 'Damage', 0, 100, 1);
    b(at, d.attack, 'attack', 'lungeSpeed', 'Lunge speed (m/s)', 0, 20, 0.1);
    b(at, d.attack, 'attack', 'lungeUp', 'Lunge up (m/s)', 0, 10, 0.1);
    b(at, d.attack, 'attack', 'lungeChance', 'Lunge chance (/s)', 0, 5, 0.05);
    b(at, d.attack, 'attack', 'jawOpen', 'Jaw open (°)', 0, 80, 1);
    at.close();
    const re = f.addFolder('Hit reactions');
    b(re, d.reactions, 'reactions', 'knock', 'Knockback ×', 0, 1, 0.005);
    b(re, d.reactions, 'reactions', 'squash', 'Squash ×', 0, 1, 0.01);
    b(re, d.reactions, 'reactions', 'springHz', 'Spring (Hz)', 0.5, 15, 0.1);
    b(re, d.reactions, 'reactions', 'springDamping', 'Spring damping', 0.05, 1.5, 0.01);
    b(re, d.reactions, 'reactions', 'staggerThreshold', 'Stagger threshold', 1, 300, 1);
    b(re, d.reactions, 'reactions', 'staggerTime', 'Stagger time (s)', 0, 2, 0.01);
    b(re, d.reactions, 'reactions', 'flinch', 'Flinch speed ×', 0, 1, 0.01);
    re.close();
    const go = f.addFolder('Gore');
    b(go, d.gore, 'gore', 'jets', 'Jets along the shot', 0, 12, 1);
    b(go, d.gore, 'gore', 'jetBlobs', 'Blobs per jet', 0, 120, 1);
    b(go, d.gore, 'gore', 'jetCone', 'Jet cone (°)', 0, 90, 1);
    b(go, d.gore, 'gore', 'backJets', 'Jets back out of the entry', 0, 6, 1);
    b(go, d.gore, 'gore', 'coreBlobs', 'Core blobs', 0, 120, 1);
    b(go, d.gore, 'gore', 'drops', 'Fine spray', 0, 600, 5);
    b(go, d.gore, 'gore', 'pops', 'Flat burst sprites', 0, 20, 1);
    b(go, d.gore, 'gore', 'sprays', 'Flat sprays', 0, 30, 1);
    b(go, d.gore, 'gore', 'blobs', 'Pulp blobs', 0, 200, 1);
    b(go, d.gore, 'gore', 'splats', 'Splats around', 0, 30, 1);
    b(go, d.gore, 'gore', 'streaks', 'Streaks on the ground', 0, 30, 1);
    b(go, d.gore, 'gore', 'screenDistance', 'Screen splatter within (m)', 0, 8, 0.1);
    b(go, d.gore, 'gore', 'splatRadius', 'Splat radius (m)', 0, 8, 0.1);
    b(go, d.gore, 'gore', 'wallSplats', 'Wall splat rays', 0, 16, 1);
    b(go, d.gore, 'gore', 'mist', 'Mist', 0, 1, 0.01);
    b(go, d.gore, 'gore', 'gibSpin', 'Gib spin (rad/s)', 0, 60, 0.5);
    b(go, d.gore, 'gore', 'gibLife', 'Gibs stay (s)', 1, 300, 1);
    b(go, d.gore, 'gore', 'hitSpray', 'Hit droplets', 0, 60, 1);
    b(go, d.gore, 'gore', 'hitSplatChance', 'Hit splat chance', 0, 1, 0.01);
    b(go, d.gore, 'gore', 'shake', 'Burst shake (° at 1 m)', 0, 10, 0.1);
    go.close();
    this.fileButtons(f, cfg);
  }

  private buildAudio() {
    const A = this.game.audio, E = A.engine;
    const f = this.gui.addFolder('Audio');
    const o = {
      get master() { return Math.round(20 * Math.log10(Math.max(1e-4, E.master.gain.value)) * 10) / 10; },
      set master(v: number) { E.master.gain.value = Math.pow(10, v / 20); },
      get reverb() { return E.reverbGain; },
      set reverb(v: number) { E.reverbGain = v; },
      get sound() { return E.speedOfSound; },
      set sound(v: number) { E.speedOfSound = v; },
      get on() { return A.enabled; },
      set on(v: boolean) { A.enabled = v; },
    };
    f.add(o, 'on').name('Sound on');
    f.add(o, 'master', -40, 6, 0.5).name('Master (dB)');
    f.add(o, 'reverb', 0, 2, 0.01).name('Reverb ×');
    f.add(o, 'sound', 0, 400, 1).name('Speed of sound (m/s, 0 off)');
    f.close();
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
      get plot() { return g.recoilPlot?.visible ?? false; },
      set plot(v: boolean) { if (g.recoilPlot) g.recoilPlot.visible = v; },
    };
    f.add(dbg, 'plot').name('Recoil pattern plot');
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
