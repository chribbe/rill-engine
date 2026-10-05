import { AudioEngine } from '../../engine/audio/audio';
import type { Camera } from '../../engine/scene/camera';
import type { CollisionWorld, RayHit } from '../../engine/scene/collision';
import { surfaceName } from '../../engine/scene/surfaces';
import type { ImpactTable } from '../fx/impacts';

/**
 * Game-side audio: maps gameplay events to sound events and keeps the
 * listener and acoustic environment current.
 *
 * Shot timing: the first shot of a trigger pull plays immediately; later
 * shots are scheduled at `first + (simTime - firstSimTime) + margin`, so a
 * full-auto burst keeps the weapon's exact cadence even though frames
 * process shots in batches (the margin covers the recent worst frame time).
 *
 * Environment: every 0.2 s a few rays from the listener measure enclosure
 * (ceiling + walls within reach); that blends the outdoor and room reverbs.
 */
export class GameAudio {
  readonly engine = new AudioEngine();
  private burstSim = -Infinity;
  /** Audio time corresponding to `burstSim` for the rest of the burst (first shot + margin). */
  private burstAudio = 0;
  private lastShotSim = -Infinity;
  private probeT = 0;
  private room = 0;
  private ray: RayHit = { t: 0, point: [0, 0, 0], normal: [0, 0, 0], surface: 0, owner: '', tri: -1 };
  private up: [number, number, number] = [0, 1, 0];
  /** Recent worst frame time (s, decaying max): the scheduling margin of a burst. */
  private frameMax = 1 / 60;
  enabled = true;

  constructor(private table: () => ImpactTable) {}

  async init(canvas: HTMLCanvasElement) {
    const unlock = () => this.engine.unlock();
    canvas.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    try {
      const n = await this.engine.load('/audio/sounds.json');
      console.info(`[audio] ${n} samples, latency ${(this.engine.latency * 1000).toFixed(1)} ms`);
    } catch (e) {
      console.warn('[audio] bank unavailable', e);
    }
  }

  /** The next shot of a held burst, already scheduled (sim time and audio time). */
  private ahead: { sim: number; at: number; handle: { cancel(): void } | null } | null = null;

  /**
   * Per frame while firing: when the next shot of a held burst falls within
   * about a frame, schedule its sound at the exact cadence slot now and tell the
   * caller to commit it (so sound and shot can't disagree). Returns the
   * committed sim time, or null.
   */
  scheduleAhead(continuing: boolean, nextShotSim: number, simNow: number): number | null {
    if (!continuing || this.ahead || this.burstSim === -Infinity) return null;
    const look = Math.min(0.045, this.frameMax + 0.004);
    if (nextShotSim - simNow > look || nextShotSim <= this.lastShotSim) return null;
    const at = this.burstAudio + (nextShotSim - this.burstSim);
    if (at < this.engine.now) return null;
    this.ahead = { sim: nextShotSim, at, handle: this.enabled ? this.engine.play('carbine_shot', { at }) : null };
    return nextShotSim;
  }

  /**
   * Audio time for a shot at simulated time `t` (`interval`: the weapon's shot
   * interval), and whether its sound was already scheduled ahead.
   */
  shotTime(t: number, interval: number): { at: number; scheduled: boolean } {
    const a = this.ahead;
    if (a && Math.abs(a.sim - t) < 1e-6) {
      this.ahead = null;
      this.lastShotSim = t;
      return { at: a.at, scheduled: true };
    }
    if (a) {
      a.handle?.cancel();
      this.ahead = null;
    }
    return { at: this.shotAudio(t, interval), scheduled: false };
  }

  private shotAudio(t: number, interval: number): number {
    const E = this.engine;
    if (t - this.lastShotSim > interval * 1.6) {
      // New pull: first shot now; later shots keep the exact cadence from it (scheduled ahead).
      this.burstSim = t;
      this.burstAudio = E.now;
      this.lastShotSim = t;
      return E.now;
    }
    this.lastShotSim = t;
    let at = this.burstAudio + (t - this.burstSim);
    // Arrived too late (a long frame): re-anchor once instead of jittering every shot.
    if (at < E.now) {
      this.burstAudio += E.now - at + 0.004;
      at = this.burstAudio + (t - this.burstSim);
    }
    return at;
  }

  play(name: string, o: { pos?: ArrayLike<number>; at?: number; gain?: number; pitch?: number } = {}) {
    if (this.enabled) this.engine.play(name, o);
  }

  private entry(surface: number) {
    const T = this.table();
    return T.surfaces[surfaceName(surface)] ?? T.surfaces[T.fallback];
  }

  impact(surface: number, pos: ArrayLike<number>, at: number) {
    const e = this.entry(surface) as { sound?: string } | undefined;
    if (e?.sound) this.play(e.sound, { pos, at });
  }

  step(surface: number, pos: ArrayLike<number>, speed: number, run: number, crouched: boolean) {
    const e = this.entry(surface) as { step?: string } | undefined;
    const k = Math.max(0.35, Math.min(1.4, speed / run));
    this.play(`step_${e?.step ?? 'hard'}`, { pos, gain: 20 * Math.log10(k) - (crouched ? 6 : 0) });
  }

  land(surface: number, pos: ArrayLike<number>, speed: number) {
    const e = this.entry(surface) as { step?: string } | undefined;
    const k = Math.max(0.4, Math.min(1.6, speed / 5));
    this.play(`land_${e?.step ?? 'hard'}`, { pos, gain: 20 * Math.log10(k) });
  }

  brass(surface: number, pos: ArrayLike<number>, speed: number, bounce: number) {
    const e = this.entry(surface) as { step?: string } | undefined;
    const hard = e?.step === 'hard' || e?.step === 'metal';
    this.play(hard ? 'brass_hard' : 'brass_soft', { pos, gain: 20 * Math.log10(Math.min(1, speed / 2.5)) - (bounce - 1) * 3 });
  }

  /** Per frame: listener, environment probe. */
  frame(dt: number, camera: Camera, collision: CollisionWorld) {
    this.frameMax = Math.max(dt, this.frameMax * 0.985);
    const f = camera.forward, r = camera.right;
    this.up[0] = r[1] * f[2] - r[2] * f[1]; this.up[1] = r[2] * f[0] - r[0] * f[2]; this.up[2] = r[0] * f[1] - r[1] * f[0];
    this.engine.setListener(camera.position, f, this.up);
    this.probeT -= dt;
    if (this.probeT > 0) return;
    this.probeT = 0.2;
    const p = camera.position;
    const ceiling = collision.raycast(p, [0, 1, 0], 14, undefined, this.ray) ? 1 : 0;
    let walls = 0, n = 0;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      for (const el of [0, 0.5]) {
        const c = Math.cos(el);
        if (collision.raycast(p, [Math.cos(a) * c, Math.sin(el), Math.sin(a) * c], 16, undefined, this.ray)) walls++;
        n++;
      }
    }
    const enclosure = walls / n;
    const target = ceiling ? Math.max(0, Math.min(1, (enclosure - 0.35) / 0.45)) : enclosure * 0.15;
    this.room += (target - this.room) * 0.35;
    this.engine.setEnvironment({ outdoor: 1 - this.room * 0.85, room: this.room });
  }

  get environment() {
    return { room: this.room };
  }
}
