import type { Renderer } from '../render/renderer';
import type { World } from '../scene/world';

/** Live performance overlay: frame/CPU/GPU timings, draw statistics, memory. */
export class StatsOverlay {
  private el: HTMLDivElement;
  private text: HTMLPreElement;
  private graph: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private frameTimes: number[] = [];
  private cpuTimes: number[] = [];
  private lastUpdate = 0;
  private samples: number[] = [];
  visible = true;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.id = 'stats';
    this.text = document.createElement('pre');
    this.graph = document.createElement('canvas');
    this.graph.width = 240;
    this.graph.height = 48;
    this.g = this.graph.getContext('2d')!;
    this.el.append(this.graph, this.text);
    parent.append(this.el);
  }

  toggle() {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? '' : 'none';
  }

  update(now: number, frameMs: number, cpuMs: number, r: Renderer, world: World | null, extra: string) {
    this.frameTimes.push(frameMs);
    this.cpuTimes.push(cpuMs);
    this.samples.push(frameMs);
    if (this.frameTimes.length > 240) {
      this.frameTimes.shift();
      this.cpuTimes.shift();
    }
    if (!this.visible || now - this.lastUpdate < 250) return;
    this.lastUpdate = now;
    const s = this.samples;
    const avg = s.reduce((a, b) => a + b, 0) / Math.max(1, s.length);
    const max = Math.max(...s);
    this.samples = [];
    const st = r.stats;
    const gpu = r.timer;
    const gpuLine = gpu.enabled
      ? `GPU    ${gpu.total.toFixed(2)} ms  [` + [...gpu.results.entries()].map(([k, v]) => `${k} ${v.toFixed(2)}`).join(' | ') + ']'
      : 'GPU    (timestamp-query unavailable)';
    const mb = (b: number) => (b / 1048576).toFixed(1);
    const lm = world?.lightmaps ? world.lightmaps.bytes : 0;
    const texMem = r.textures.totalBytes + lm + (world?.decalBytes ?? 0);
    const shadowMem = r.shadows.resolution ** 2 * 4 * 4;
    const lines = [
      `FPS    ${(1000 / avg).toFixed(0).padStart(4)}   frame ${avg.toFixed(2)} ms (max ${max.toFixed(1)})`,
      `CPU    ${cpuMs.toFixed(2)} ms  (cull ${st.cpuCullMs.toFixed(2)}, encode ${st.cpuEncodeMs.toFixed(2)})`,
      gpuLine,
      `Draws  ${st.drawCalls} main + ${st.shadowDrawCalls} shadow`,
      `Tris   ${(st.triangles / 1e6).toFixed(2)}M main + ${(st.shadowTriangles / 1e6).toFixed(2)}M shadow`,
      `Objs   ${st.visibleObjects} visible / ${st.culledObjects} culled / ${st.totalObjects} total   inst ${st.instances}`,
      `Mem    tex ${mb(texMem)} MB  geo ${mb(r.arena.bytes)} MB  shadow ${mb(shadowMem)} MB  targets ${mb(r.targetBytes)} MB`,
      `Res    ${r.renderWidth}x${r.renderHeight} ${r.settings.msaa ? 'MSAA 4x' : 'no MSAA'}  aniso ${r.settings.anisotropy}x`,
      extra,
    ];
    this.text.textContent = lines.join('\n');
    this.drawGraph();
  }

  private drawGraph() {
    const g = this.g;
    const w = this.graph.width, h = this.graph.height;
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(0, 0, w, h);
    const scale = h / 33.3; // 0..33 ms
    g.strokeStyle = 'rgba(255,255,255,0.25)';
    for (const ms of [8.33, 16.67]) {
      g.beginPath();
      g.moveTo(0, h - ms * scale);
      g.lineTo(w, h - ms * scale);
      g.stroke();
    }
    const plot = (arr: number[], col: string) => {
      g.strokeStyle = col;
      g.beginPath();
      arr.forEach((v, i) => {
        const x = (i / 240) * w;
        const y = h - Math.min(v, 33.3) * scale;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      });
      g.stroke();
    };
    plot(this.frameTimes, '#7fdc6a');
    plot(this.cpuTimes, '#e0b44c');
  }
}
