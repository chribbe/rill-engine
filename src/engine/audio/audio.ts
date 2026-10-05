import { makeImpulseResponse, type AcousticEnv } from './reverb';

/**
 * Audio engine (Web Audio). Generic: games describe sounds as data
 * (public/audio/sounds.json) and trigger events by name.
 *
 * - Buses: master (gentle compressor/limiter) ← sfx, ambience, music, voice, ui.
 * - Acoustic environments: one convolution reverb per environment (synthesised
 *   IRs); voices send into them, weighted by the current environment mix.
 * - Events: several layers (sample variations, gain / pitch jitter, delay,
 *   per-environment layers, lowpass, chance), 2D or positional (distance
 *   model, air absorption lowpass, optional speed-of-sound delay), voice
 *   limits with oldest-voice stealing, per-event cooldown.
 * - Scheduling: `play(name, { at })` in AudioContext time, so a burst can keep
 *   an exact cadence independent of frame timing.
 */
export interface SoundLayer {
  samples: string[];
  /** dB. */
  gain?: number;
  /** Playback-rate range (pitch variation). */
  pitch?: [number, number];
  /** ± dB per play. */
  gainJitter?: number;
  /** Seconds after the event. */
  delay?: number;
  /** Reverb send (0..1). */
  send?: number;
  /** Only in this environment (its weight scales the layer). */
  env?: AcousticEnv;
  lowpass?: number;
  /** Probability (0..1) that the layer plays. */
  chance?: number;
}

export interface SoundEvent {
  bus?: 'sfx' | 'ambience' | 'music' | 'voice' | 'ui';
  layers: SoundLayer[];
  spatial?: boolean;
  /** Full level within `ref` metres, culled beyond `max`. */
  ref?: number;
  max?: number;
  rolloff?: number;
  /** Distance darkening (air absorption). */
  air?: boolean;
  maxVoices?: number;
  /** Seconds before the same event can retrigger. */
  cooldown?: number;
}

export interface SoundBank {
  events: Record<string, SoundEvent>;
  /** Sample paths are relative to this (default: the bank's folder). */
  base?: string;
}

export interface PlayOptions {
  pos?: ArrayLike<number>;
  /** AudioContext time to start (default: now). */
  at?: number;
  /** Extra gain (dB) and pitch multiplier. */
  gain?: number;
  pitch?: number;
}

/** One playing instance of an event (all its layers under one gain, so it can be faded out). */
interface Voice {
  gain: GainNode;
  srcs: AudioBufferSourceNode[];
  ends: number;
}

const BUSES = ['sfx', 'ambience', 'music', 'voice', 'ui'] as const;
const db = (x: number) => Math.pow(10, x / 20);

export class AudioEngine {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly buses: Record<(typeof BUSES)[number], GainNode>;
  private compressor: DynamicsCompressorNode;
  private sends = new Map<AcousticEnv, { input: GainNode; out: GainNode }>();
  private envWeight: Record<AcousticEnv, number> = { outdoor: 1, room: 0, tunnel: 0 };
  private samples = new Map<string, AudioBuffer>();
  private bank: SoundBank = { events: {} };
  private base = '/audio/';
  private voices = new Map<string, Voice[]>();
  private lastPlay = new Map<string, number>();
  private listener: [number, number, number] = [0, 0, 0];
  private seed = 0x51ed;
  /** Speed of sound for positional delay (m/s; 0 = no delay), applied beyond `delayFrom` metres. */
  speedOfSound = 343;
  delayFrom = 12;
  /** Reverb level (multiplies every send). */
  reverbGain = 1;
  /** Cap on simultaneous voices (all events). */
  maxVoices = 64;
  activeVoices = 0;
  loaded = false;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
    const c = this.ctx;
    this.compressor = c.createDynamicsCompressor();
    this.compressor.threshold.value = -14;
    this.compressor.knee.value = 8;
    this.compressor.ratio.value = 4;
    this.compressor.attack.value = 0.002;
    this.compressor.release.value = 0.14;
    this.master = c.createGain();
    this.master.gain.value = db(-3);
    this.master.connect(this.compressor).connect(c.destination);
    this.buses = Object.fromEntries(BUSES.map((b) => {
      const g = c.createGain();
      g.connect(this.master);
      return [b, g];
    })) as AudioEngine['buses'];
    for (const env of ['outdoor', 'room', 'tunnel'] as AcousticEnv[]) {
      const input = c.createGain(), conv = c.createConvolver(), out = c.createGain();
      conv.buffer = makeImpulseResponse(c, env);
      input.connect(conv).connect(out).connect(this.master);
      out.gain.value = this.envWeight[env];
      this.sends.set(env, { input, out });
    }
  }

  /** Browsers start audio suspended until a user gesture: call from a click / key handler. */
  unlock() {
    if (this.ctx.state !== 'running') void this.ctx.resume();
  }

  get now() {
    return this.ctx.currentTime;
  }

  /** Output latency estimate (s): base + output. */
  get latency() {
    return (this.ctx.baseLatency ?? 0) + ((this.ctx as AudioContext & { outputLatency?: number }).outputLatency ?? 0);
  }

  /** Loads a bank and decodes every sample it references. */
  async load(url: string) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`sound bank ${url}: ${r.status}`);
    this.bank = (await r.json()) as SoundBank;
    this.base = this.bank.base ?? url.slice(0, url.lastIndexOf('/') + 1);
    const paths = new Set<string>();
    for (const e of Object.values(this.bank.events)) for (const l of e.layers) for (const s of l.samples) paths.add(s);
    await Promise.all([...paths].map((p) => this.sample(p).catch((err) => console.warn(`[audio] ${p}:`, err))));
    this.loaded = true;
    return paths.size;
  }

  private async sample(path: string): Promise<AudioBuffer> {
    const hit = this.samples.get(path);
    if (hit) return hit;
    const r = await fetch(this.base + path);
    if (!r.ok) throw new Error(`${r.status}`);
    const b = await this.ctx.decodeAudioData(await r.arrayBuffer());
    this.samples.set(path, b);
    return b;
  }

  event(name: string): SoundEvent | undefined {
    return this.bank.events[name];
  }

  private rand() {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  setListener(pos: ArrayLike<number>, forward: ArrayLike<number>, up: ArrayLike<number>) {
    const L = this.ctx.listener, t = this.ctx.currentTime;
    this.listener[0] = pos[0]; this.listener[1] = pos[1]; this.listener[2] = pos[2];
    if (L.positionX) {
      L.positionX.setValueAtTime(pos[0], t); L.positionY.setValueAtTime(pos[1], t); L.positionZ.setValueAtTime(pos[2], t);
      L.forwardX.setValueAtTime(forward[0], t); L.forwardY.setValueAtTime(forward[1], t); L.forwardZ.setValueAtTime(forward[2], t);
      L.upX.setValueAtTime(up[0], t); L.upY.setValueAtTime(up[1], t); L.upZ.setValueAtTime(up[2], t);
    } else {
      L.setPosition(pos[0], pos[1], pos[2]);
      L.setOrientation(forward[0], forward[1], forward[2], up[0], up[1], up[2]);
    }
  }

  /** Environment mix (weights 0..1, smoothed over ~0.3 s). */
  setEnvironment(w: Partial<Record<AcousticEnv, number>>) {
    const t = this.ctx.currentTime;
    for (const [k, s] of this.sends) {
      const v = w[k] ?? 0;
      this.envWeight[k] = v;
      s.out.gain.setTargetAtTime(v * this.reverbGain, t, 0.1);
    }
  }

  /**
   * Plays an event. Returns a handle (cancel() stops it, also before it starts:
   * scheduled sounds can be withdrawn), or null when it was culled (distance,
   * cooldown, unknown, audio locked).
   */
  play(name: string, o: PlayOptions = {}): { cancel(): void; at: number } | null {
    const e = this.bank.events[name];
    if (!e || this.ctx.state !== 'running') return null;
    const c = this.ctx;
    let at = Math.max(c.currentTime, o.at ?? c.currentTime);
    const last = this.lastPlay.get(name);
    if (e.cooldown && last !== undefined && at - last < e.cooldown) return null;
    let dist = 0;
    if (e.spatial && o.pos) {
      dist = Math.hypot(o.pos[0] - this.listener[0], o.pos[1] - this.listener[1], o.pos[2] - this.listener[2]);
      if (e.max && dist > e.max) return null;
      if (this.speedOfSound > 0 && dist > this.delayFrom) at += (dist - this.delayFrom) / this.speedOfSound;
    }
    this.lastPlay.set(name, at);
    // Voice limit per event: fade out the oldest instance (no clicks).
    let list = this.voices.get(name);
    if (!list) this.voices.set(name, (list = []));
    for (let i = list.length - 1; i >= 0; i--) if (list[i].ends < c.currentTime) list.splice(i, 1);
    const cap = e.maxVoices ?? 8;
    while (list.length >= cap) {
      const v = list.shift()!;
      v.gain.gain.setTargetAtTime(0, c.currentTime, 0.012);
      for (const src of v.srcs) { try { src.stop(c.currentTime + 0.08); } catch { /* stopped */ } }
    }
    const bus = this.buses[e.bus ?? 'sfx'];
    const voice: Voice = { gain: c.createGain(), srcs: [], ends: at };
    // Positional chain shared by the event's layers.
    let out: AudioNode = bus;
    if (e.spatial && o.pos) {
      const p = c.createPanner();
      p.panningModel = 'equalpower';
      p.distanceModel = 'inverse';
      p.refDistance = e.ref ?? 2;
      p.rolloffFactor = e.rolloff ?? 1;
      p.maxDistance = e.max ?? 200;
      p.positionX.value = o.pos[0]; p.positionY.value = o.pos[1]; p.positionZ.value = o.pos[2];
      p.connect(bus);
      out = p;
      if (e.air && dist > 4) {
        const f = c.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = Math.max(1200, 20000 * Math.exp(-dist / 70));
        f.connect(p);
        out = f;
      }
    }
    voice.gain.connect(out);
    for (const l of e.layers) {
      if (l.chance !== undefined && this.rand() > l.chance) continue;
      const envW = l.env ? this.envWeight[l.env] : 1;
      if (envW < 0.02) continue;
      const path = l.samples[Math.floor(this.rand() * l.samples.length)];
      const buf = this.samples.get(path);
      if (!buf) continue;
      const src = c.createBufferSource();
      src.buffer = buf;
      const pr = l.pitch ?? [1, 1];
      src.playbackRate.value = (pr[0] + (pr[1] - pr[0]) * this.rand()) * (o.pitch ?? 1);
      const g = c.createGain();
      g.gain.value = db((l.gain ?? 0) + (o.gain ?? 0) + (this.rand() * 2 - 1) * (l.gainJitter ?? 0)) * envW;
      let node: AudioNode = src;
      if (l.lowpass) {
        const f = c.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = l.lowpass;
        src.connect(f);
        node = f;
      }
      node.connect(g);
      g.connect(voice.gain);
      if (l.send) {
        const sg = c.createGain();
        sg.gain.value = l.send;
        g.connect(sg);
        for (const s of this.sends.values()) sg.connect(s.input);
      }
      const t0 = at + (l.delay ?? 0);
      src.start(t0);
      voice.ends = Math.max(voice.ends, t0 + buf.duration / src.playbackRate.value);
      voice.srcs.push(src);
      this.activeVoices++;
      src.onended = () => {
        this.activeVoices--;
        src.disconnect();
        g.disconnect();
      };
    }
    if (voice.srcs.length) list.push(voice);
    return {
      at,
      cancel: () => {
        const t = c.currentTime;
        voice.gain.gain.setTargetAtTime(0, t, 0.006);
        for (const src of voice.srcs) { try { src.stop(t + 0.04); } catch { /* stopped */ } }
        const i = list!.indexOf(voice);
        if (i >= 0) list!.splice(i, 1);
      },
    };
  }
}
