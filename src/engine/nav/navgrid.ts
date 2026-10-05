/**
 * Layered navigation grid: a simplified Recast-style heightfield baked from the
 * collision soup. Columns of `cell` metres hold up to MAXL walkable floor
 * layers (square, hall, stair flights, a platform above), each with enough
 * clearance and no blocking geometry in it. Layers link to the neighbouring
 * column's layer within `step` height (8-connected, no corner cutting). A flow
 * field (Dijkstra from a target) then tells any number of agents which way to
 * go for the cost of one lookup each, and the same layers give them ground
 * height without triangle tests.
 */
export interface NavGridOptions {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /** Column size (m). */
  cell?: number;
  /** Free height needed above a floor (m). */
  clearance?: number;
  /** Largest height change walked between neighbouring columns (m): kerbs, stair risers. */
  step?: number;
  /** Steepest walkable floor (degrees). */
  maxSlope?: number;
  /** Blocking geometry lower than this above a floor is stepped over (m). */
  kerb?: number;
  /** Highest ledge an agent climbs up onto from a neighbouring column (m); 0 = none. */
  climb?: number;
  /** Deepest drop an agent takes to a neighbouring column (m). */
  drop?: number;
}

const MAXL = 4;
const CAND = 8;
const SPANS = 12;
const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
/** Opposite of each direction index. */
const OPP = [1, 0, 3, 2, 7, 6, 5, 4];
const UNREACHED = 0xffffffff;

/** Link kinds (per node and direction). */
export const NAV_WALK = 0;
export const NAV_CLIMB = 1;
export const NAV_DROP = 2;

export class NavGrid {
  readonly nx: number;
  readonly nz: number;
  readonly cell: number;
  readonly x0: number;
  readonly z0: number;
  readonly step: number;
  readonly climb: number;
  readonly drop: number;
  readonly clearance: number;
  /** Per column: walkable layer count, heights and the free height above each (MAXL slots). */
  readonly layerN: Uint8Array;
  readonly layerH: Float32Array;
  readonly layerTop: Float32Array;
  /** Per node (column × MAXL + layer) and direction: the layer moved onto, -1 = no way. */
  readonly link: Int8Array;
  /** Per node and direction: NAV_WALK / NAV_CLIMB / NAV_DROP. */
  readonly linkKind: Uint8Array;
  /** Per node: distance in cells to the nearest edge of the walkable area (capped at 3). */
  readonly edge: Uint8Array;
  /** Flow field: path cost from each node to the target (UNREACHED = none). */
  dist: Uint32Array;
  /** Node the flow field leads to (-1 = none yet). */
  target = -1;
  /** Build and flow timings (ms) for the debug readout. */
  buildMs = 0;
  flowMs = 0;
  /** Walkable nodes. */
  nodes = 0;

  // Flow computation in progress: the back buffer and a bucket queue (costs mod 64; the largest
  // single link cost is under 64, so each bucket only ever holds one cost).
  private back: Uint32Array;
  private bucket = new Int32Array(64);
  private qNode: Uint32Array;
  private qNext: Int32Array;
  private qFree = -1;
  private qTop = 0;
  private pending = 0;
  private fCost = 0;
  private fMax = 0;
  private fTarget = -1;
  private fMs = 0;
  private busy = false;

  private constructor(o: Required<NavGridOptions>) {
    this.cell = o.cell;
    this.step = o.step;
    this.climb = Math.max(o.climb, o.step);
    this.drop = Math.max(o.drop, o.step);
    this.clearance = o.clearance;
    this.x0 = o.minX;
    this.z0 = o.minZ;
    this.nx = Math.ceil((o.maxX - o.minX) / o.cell);
    this.nz = Math.ceil((o.maxZ - o.minZ) / o.cell);
    const cols = this.nx * this.nz;
    this.layerN = new Uint8Array(cols);
    this.layerH = new Float32Array(cols * MAXL);
    this.layerTop = new Float32Array(cols * MAXL);
    this.link = new Int8Array(cols * MAXL * 8).fill(-1);
    this.linkKind = new Uint8Array(cols * MAXL * 8);
    this.edge = new Uint8Array(cols * MAXL);
    this.dist = new Uint32Array(cols * MAXL).fill(UNREACHED);
    this.back = new Uint32Array(cols * MAXL).fill(UNREACHED);
    this.qNode = new Uint32Array(1 << 14);
    this.qNext = new Int32Array(1 << 14);
  }

  /** Bakes the grid from world triangles (9 floats each) inside the options' XZ bounds. */
  static build(tris: readonly number[], opts: NavGridOptions): NavGrid {
    const t0 = performance.now();
    const o: Required<NavGridOptions> = { cell: 0.5, clearance: 1.1, step: 0.5, maxSlope: 46, kerb: 0.3, climb: 1.3, drop: 2.5, ...opts };
    const g = new NavGrid(o);
    const { nx, nz, cell, x0, z0 } = g;
    const cols = nx * nz;
    const fN = new Uint8Array(cols), fH = new Float32Array(cols * CAND);
    const bN = new Uint8Array(cols), bS = new Float32Array(cols * SPANS * 2);
    const cosMax = Math.cos((o.maxSlope * Math.PI) / 180);
    const addFloor = (c: number, h: number) => {
      const n = fN[c], b = c * CAND;
      for (let i = 0; i < n; i++) if (Math.abs(fH[b + i] - h) < 0.15) { if (h > fH[b + i]) fH[b + i] = h; return; }
      if (n < CAND) { fH[b + n] = h; fN[c] = n + 1; }
    };
    const addSpan = (c: number, y0: number, y1: number) => {
      const n = bN[c], b = c * SPANS * 2;
      for (let i = 0; i < n; i++) {
        const a0 = bS[b + i * 2], a1 = bS[b + i * 2 + 1];
        if (y0 <= a1 + 0.05 && y1 >= a0 - 0.05) { bS[b + i * 2] = Math.min(a0, y0); bS[b + i * 2 + 1] = Math.max(a1, y1); return; }
      }
      if (n < SPANS) { bS[b + n * 2] = y0; bS[b + n * 2 + 1] = y1; bN[c] = n + 1; }
      else { bS[b + (n - 1) * 2] = Math.min(bS[b + (n - 1) * 2], y0); bS[b + (n - 1) * 2 + 1] = Math.max(bS[b + (n - 1) * 2 + 1], y1); }
    };
    // ---- rasterise: floors as heights at cell centres, everything else as blocking spans
    // (the triangle's height range inside the cell, so a stair soffit only blocks under itself).
    const clip = new Clipper();
    for (let t = 0; t < tris.length; t += 9) {
      const ax = tris[t], ay = tris[t + 1], az = tris[t + 2];
      const bx = tris[t + 3], by = tris[t + 4], bz = tris[t + 5];
      const cx = tris[t + 6], cy = tris[t + 7], cz = tris[t + 8];
      const minX = Math.min(ax, bx, cx), maxX = Math.max(ax, bx, cx), minZ = Math.min(az, bz, cz), maxZ = Math.max(az, bz, cz);
      if (maxX < x0 || minX > x0 + nx * cell || maxZ < z0 || minZ > z0 + nz * cell) continue;
      const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nX = uy * vz - uz * vy, nY = uz * vx - ux * vz, nZ = ux * vy - uy * vx;
      const nl = Math.hypot(nX, nY, nZ) || 1;
      const floor = nY / nl > cosMax;
      const ix0 = Math.max(0, Math.floor((minX - x0) / cell)), ix1 = Math.min(nx - 1, Math.floor((maxX - x0) / cell));
      const iz0 = Math.max(0, Math.floor((minZ - z0) / cell)), iz1 = Math.min(nz - 1, Math.floor((maxZ - z0) / cell));
      const den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      for (let iz = iz0; iz <= iz1; iz++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const qx0 = x0 + ix * cell, qz0 = z0 + iz * cell;
          if (!clip.run(tris, t, qx0, qz0, qx0 + cell, qz0 + cell)) continue;
          const c = iz * nx + ix;
          if (floor && Math.abs(den) > 1e-9) {
            // Height at the cell centre (barycentric, clamped into the triangle).
            const px = qx0 + cell * 0.5, pz = qz0 + cell * 0.5;
            let w0 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / den;
            let w1 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / den;
            let w2 = 1 - w0 - w1;
            w0 = Math.max(0, w0); w1 = Math.max(0, w1); w2 = Math.max(0, w2);
            const ws = w0 + w1 + w2 || 1;
            addFloor(c, (w0 * ay + w1 * by + w2 * cy) / ws);
          } else if (!floor) {
            addSpan(c, clip.y0, clip.y1);
          }
        }
      }
    }
    // ---- walkable layers: clear of ceilings and blocking spans; `top` = the free height above
    for (let c = 0; c < cols; c++) {
      const n = fN[c], b = c * CAND;
      if (!n) continue;
      const hs = Array.from(fH.subarray(b, b + n)).sort((p, q) => p - q);
      let k = 0;
      for (let i = 0; i < hs.length && k < MAXL; i++) {
        const h = hs[i];
        let top = i + 1 < hs.length ? hs[i + 1] : Infinity;
        if (top < h + o.clearance) continue;
        let blocked = false;
        const sb = c * SPANS * 2;
        for (let s = 0; s < bN[c]; s++) {
          const s0 = bS[sb + s * 2], s1 = bS[sb + s * 2 + 1];
          if (s1 <= h + o.kerb) continue;
          if (s0 < h + o.clearance) { blocked = true; break; }
          if (s0 < top) top = s0;
        }
        if (blocked) continue;
        g.layerH[c * MAXL + k] = h;
        g.layerTop[c * MAXL + k] = Math.min(top, 1e6);
        k++;
      }
      g.layerN[c] = k;
      g.nodes += k;
    }
    // ---- links (8-connected, no corner cutting): walk within `step`, climb up to `climb`, drop down to `drop`
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const c = iz * nx + ix;
        for (let l = 0; l < g.layerN[c]; l++) {
          const node = c * MAXL + l;
          for (let d = 0; d < 4; d++) g.setLink(node, d, g.wayTo(node, ix + DIRS[d][0], iz + DIRS[d][1]));
          for (let d = 4; d < 8; d++) {
            const [dx, dz] = DIRS[d];
            // Diagonals only across open corners, and only walking.
            const a = g.wayTo(node, ix + dx, iz), b2 = g.wayTo(node, ix, iz + dz);
            const w = a >= 0 && b2 >= 0 && a >> 3 === NAV_WALK && b2 >> 3 === NAV_WALK ? g.wayTo(node, ix + dx, iz + dz) : -1;
            g.setLink(node, d, w >= 0 && w >> 3 === NAV_WALK ? w : -1);
          }
        }
      }
    }
    // ---- distance to the walkable area's edge (cells, capped), so paths keep off walls
    const edgeQ: number[] = [];
    g.edge.fill(255);
    for (let c = 0; c < cols; c++) {
      for (let l = 0; l < g.layerN[c]; l++) {
        const node = c * MAXL + l;
        let full = true;
        for (let d = 0; d < 4; d++) if (g.link[node * 8 + d] < 0 || g.linkKind[node * 8 + d] !== NAV_WALK) { full = false; break; }
        if (!full) { g.edge[node] = 0; edgeQ.push(node); }
      }
    }
    for (let qi = 0; qi < edgeQ.length; qi++) {
      const node = edgeQ[qi], e = g.edge[node];
      if (e >= 3) continue;
      for (let d = 0; d < 4; d++) {
        const nb = g.neighbour(node, d);
        if (nb >= 0 && g.edge[nb] > e + 1) { g.edge[nb] = e + 1; edgeQ.push(nb); }
      }
    }
    for (let i = 0; i < g.edge.length; i++) if (g.edge[i] === 255) g.edge[i] = 3;
    g.buildMs = performance.now() - t0;
    return g;
  }

  private setLink(node: number, d: number, way: number) {
    this.link[node * 8 + d] = way < 0 ? -1 : way & 7;
    this.linkKind[node * 8 + d] = way < 0 ? 0 : way >> 3;
  }

  /**
   * How an agent on `node` gets onto column (ix, iz): the best layer (closest in height) whose free
   * space overlaps ours by the clearance, as `layer | kind << 3`, or -1.
   */
  private wayTo(node: number, ix: number, iz: number): number {
    if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return -1;
    const h = this.layerH[node], top = this.layerTop[node];
    const c = iz * this.nx + ix;
    let best = -1, bd = Infinity;
    for (let l = 0; l < this.layerN[c]; l++) {
      const h2 = this.layerH[c * MAXL + l], t2 = this.layerTop[c * MAXL + l];
      const dh = h2 - h;
      if (dh > this.climb || dh < -this.drop) continue;
      if (Math.min(top, t2) - Math.max(h, h2) < this.clearance) continue;
      const kind = dh > this.step ? NAV_CLIMB : dh < -this.step ? NAV_DROP : NAV_WALK;
      const score = Math.abs(dh) + (kind === NAV_WALK ? 0 : 10);
      if (score < bd) { bd = score; best = l | (kind << 3); }
    }
    return best;
  }

  /** Neighbour node of `node` in direction d (0..7), or -1. */
  neighbour(node: number, d: number): number {
    const l = this.link[node * 8 + d];
    if (l < 0) return -1;
    const c = (node / MAXL) | 0, ix = c % this.nx, iz = (c / this.nx) | 0;
    return ((iz + DIRS[d][1]) * this.nx + ix + DIRS[d][0]) * MAXL + l;
  }

  /** The floor node an agent at (x, y, z) stands on (the highest layer at or below y + step), or -1. */
  nodeAt(x: number, y: number, z: number): number {
    const ix = Math.floor((x - this.x0) / this.cell), iz = Math.floor((z - this.z0) / this.cell);
    if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return -1;
    const c = iz * this.nx + ix;
    let best = -1, bh = -Infinity;
    for (let l = 0; l < this.layerN[c]; l++) {
      const h = this.layerH[c * MAXL + l];
      if (h <= y + this.step && h > bh) { bh = h; best = l; }
    }
    return best < 0 ? -1 : c * MAXL + best;
  }

  /** Floor height under (x, y, z), or -Infinity off the walkable area. */
  groundAt(x: number, y: number, z: number): number {
    const n = this.nodeAt(x, y, z);
    return n < 0 ? -Infinity : this.layerH[n];
  }

  /** Centre of a node (x, height, z). */
  nodeCentre(node: number, out: [number, number, number]) {
    const c = (node / MAXL) | 0;
    out[0] = this.x0 + ((c % this.nx) + 0.5) * this.cell;
    out[1] = this.layerH[node];
    out[2] = this.z0 + (((c / this.nx) | 0) + 0.5) * this.cell;
    return out;
  }

  /** The walkable node nearest to (x, y, z) within `r` cells (for a target standing just off the grid). */
  nearestNode(x: number, y: number, z: number, r = 3): number {
    const n = this.nodeAt(x, y, z);
    if (n >= 0) return n;
    const ix = Math.floor((x - this.x0) / this.cell), iz = Math.floor((z - this.z0) / this.cell);
    let best = -1, bd = Infinity;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const jx = ix + dx, jz = iz + dz;
        if (jx < 0 || jz < 0 || jx >= this.nx || jz >= this.nz) continue;
        const c = jz * this.nx + jx;
        for (let l = 0; l < this.layerN[c]; l++) {
          const h = this.layerH[c * MAXL + l];
          const d = dx * dx + dz * dz + ((h - y) / this.cell) ** 2;
          if (d < bd && h <= y + this.step * 2) { bd = d; best = c * MAXL + l; }
        }
      }
    }
    return best;
  }

  /** Flow field towards (x, y, z), computed in one go (see `beginFlow`). */
  computeFlow(x: number, y: number, z: number, maxCost = 6000) {
    this.beginFlow(x, y, z, maxCost);
    this.stepFlow(Infinity);
  }

  /**
   * Starts a flow field towards (x, y, z): Dijkstra backwards over the links (straight 10,
   * diagonal 14, climbs and drops extra, plus a penalty next to edges so paths keep off walls), out
   * to `maxCost`. It fills a back buffer over `stepFlow` calls; agents keep reading the previous
   * field until it swaps in. Costs are small integers, so the queue is a ring of buckets.
   */
  beginFlow(x: number, y: number, z: number, maxCost = 6000) {
    const t0 = performance.now();
    const target = this.nearestNode(x, y, z);
    this.back.fill(UNREACHED);
    this.bucket.fill(-1);
    this.qFree = -1;
    this.qTop = 0;
    this.pending = 0;
    this.fCost = 0;
    this.fMax = maxCost;
    this.fTarget = target;
    this.fMs = 0;
    this.busy = true;
    if (target >= 0) { this.back[target] = 0; this.qPush(target, 0); }
    this.fMs += performance.now() - t0;
  }

  /** Is a flow field being computed? */
  get flowBusy() {
    return this.busy;
  }

  /** Settles up to `budget` nodes of the pending flow field; true once it has swapped in. */
  stepFlow(budget: number): boolean {
    if (!this.busy) return true;
    const t0 = performance.now();
    const D = this.back, B = this.bucket, QN = this.qNode, QX = this.qNext;
    let left = budget;
    while (this.pending > 0 && this.fCost <= this.fMax && left > 0) {
      const b = this.fCost & 63;
      const e = B[b];
      if (e < 0) { this.fCost++; continue; }
      B[b] = QX[e];
      const node = QN[e];
      QX[e] = this.qFree; this.qFree = e; this.pending--;
      const cost = this.fCost;
      if (D[node] !== cost) continue;
      left--;
      // Backwards along the links: every node in a neighbouring column that leads onto this one.
      const c = (node / MAXL) | 0, ix = c % this.nx, iz = (c / this.nx) | 0, l = node - c * MAXL;
      for (let d = 0; d < 8; d++) {
        const jx = ix + DIRS[d][0], jz = iz + DIRS[d][1];
        if (jx < 0 || jz < 0 || jx >= this.nx || jz >= this.nz) continue;
        const cj = jz * this.nx + jx, back = OPP[d];
        for (let lj = 0; lj < this.layerN[cj]; lj++) {
          const nb = cj * MAXL + lj, li = nb * 8 + back;
          if (this.link[li] !== l) continue;
          const ed = this.edge[nb], kind = this.linkKind[li];
          const c2 = cost + (d < 4 ? 10 : 14) + (ed === 0 ? 14 : ed === 1 ? 6 : 0) + (kind === NAV_CLIMB ? 30 : kind === NAV_DROP ? 6 : 0);
          if (c2 < D[nb]) { D[nb] = c2; this.qPush(nb, c2); }
        }
      }
    }
    this.fMs += performance.now() - t0;
    if (this.pending > 0 && this.fCost <= this.fMax) return false;
    // Done: swap the buffers.
    const front = this.dist;
    this.dist = this.back;
    this.back = front;
    this.target = this.fTarget;
    this.flowMs = this.fMs;
    this.busy = false;
    return true;
  }

  private qPush(node: number, cost: number) {
    let e = this.qFree;
    if (e >= 0) this.qFree = this.qNext[e];
    else {
      if (this.qTop >= this.qNode.length) {
        const n = this.qNode.length * 2;
        const qn = new Uint32Array(n), qx = new Int32Array(n);
        qn.set(this.qNode); qx.set(this.qNext);
        this.qNode = qn; this.qNext = qx;
      }
      e = this.qTop++;
    }
    const b = cost & 63;
    this.qNode[e] = node;
    this.qNext[e] = this.bucket[b];
    this.bucket[b] = e;
    this.pending++;
  }

  /**
   * Direction (unit XZ) down the flow field from (x, y, z): towards the cheapest neighbours,
   * blended for smooth paths. Returns false off the grid or where the field does not reach.
   */
  flowDir(x: number, y: number, z: number, out: [number, number]): boolean {
    return this.flowDirAt(this.nodeAt(x, y, z), x, z, out);
  }

  /** `flowDir` for an agent known to be on `node` at (x, z). */
  flowDirAt(node: number, x: number, z: number, out: [number, number]): boolean {
    if (node < 0) return false;
    const D = this.dist, here = D[node];
    if (here === UNREACHED) return false;
    let gx = 0, gz = 0;
    const cx = this.x0 + ((((node / MAXL) | 0) % this.nx) + 0.5) * this.cell;
    const cz = this.z0 + (((((node / MAXL) | 0) / this.nx) | 0) + 0.5) * this.cell;
    for (let d = 0; d < 8; d++) {
      const nb = this.neighbour(node, d);
      if (nb < 0) continue;
      const dn = D[nb];
      if (dn === UNREACHED || dn >= here) continue;
      // Weight by how much cheaper, along the direction to that neighbour's centre from where we are.
      const tx = cx + DIRS[d][0] * this.cell - x, tz = cz + DIRS[d][1] * this.cell - z;
      const tl = Math.hypot(tx, tz) || 1;
      const w = (here - dn) / (d < 4 ? 10 : 14);
      gx += (tx / tl) * w * w; gz += (tz / tl) * w * w;
    }
    const l = Math.hypot(gx, gz);
    if (l < 1e-6) {
      if (here === 0) { out[0] = 0; out[1] = 0; return true; }
      return false;
    }
    out[0] = gx / l; out[1] = gz / l;
    return true;
  }

  /**
   * Moves an agent standing on `node` from (x, z) towards (tx, tz) (a short step): across a column
   * border it follows the link that way (climbing only when `canClimb`), into a wall it slides along
   * it. An agent lifted above its floor (on a pile of others, feet at `feet`) can also step onto any
   * ledge within `step` of its feet. While on the flow field it never drops or steps off it.
   * Returns the node it ends on; `out` gets the position.
   */
  move(node: number, x: number, z: number, tx: number, tz: number, feet: number, canClimb: boolean, out: [number, number]): number {
    const cell = this.cell, c = (node / MAXL) | 0, cix = c % this.nx, ciz = (c / this.nx) | 0;
    const tix = Math.floor((tx - this.x0) / cell), tiz = Math.floor((tz - this.z0) / cell);
    if (tix === cix && tiz === ciz) { out[0] = tx; out[1] = tz; return node; }
    if (Math.abs(tix - cix) > 1 || Math.abs(tiz - ciz) > 1) {
      // Too long for one column: two halves.
      const n1 = this.move(node, x, z, (x + tx) * 0.5, (z + tz) * 0.5, feet, canClimb, out);
      return this.move(n1, out[0], out[1], tx, tz, feet, canClimb, out);
    }
    const dx = tix - cix, dz = tiz - ciz;
    const n1 = this.cross(node, dx, dz, feet, canClimb);
    if (n1 >= 0) { out[0] = tx; out[1] = tz; return n1; }
    const bx0 = this.x0 + cix * cell + 1e-4, bx1 = bx0 + cell - 2e-4, bz0 = this.z0 + ciz * cell + 1e-4, bz1 = bz0 + cell - 2e-4;
    if (dx !== 0 && dz !== 0) {
      // Diagonal: slide along whichever side is open.
      const nxo = this.cross(node, dx, 0, feet, canClimb);
      if (nxo >= 0) { out[0] = tx; out[1] = Math.min(bz1, Math.max(bz0, tz)); return nxo; }
      const nzo = this.cross(node, 0, dz, feet, canClimb);
      if (nzo >= 0) { out[0] = Math.min(bx1, Math.max(bx0, tx)); out[1] = tz; return nzo; }
    }
    out[0] = Math.min(bx1, Math.max(bx0, tx));
    out[1] = Math.min(bz1, Math.max(bz0, tz));
    return node;
  }

  /** The node reached stepping from `node` one column (dx, dz), or -1. */
  private cross(node: number, dx: number, dz: number, feet: number, canClimb: boolean): number {
    let d = 0;
    while (DIRS[d][0] !== dx || DIRS[d][1] !== dz) d++;
    const l = this.link[node * 8 + d], kind = this.linkKind[node * 8 + d], reached = this.dist[node] !== UNREACHED;
    if (l >= 0 && (canClimb || kind !== NAV_CLIMB)) {
      const nb = this.neighbour(node, d);
      // Never down into somewhere the flow field can't lead back out of (off the platform onto the tracks).
      if (kind !== NAV_DROP || !reached || this.dist[nb] !== UNREACHED) return nb;
    }
    if (feet <= this.layerH[node] + this.step) return -1;
    // Lifted: any ledge near the feet with room above it.
    const c = (node / MAXL) | 0, jx = (c % this.nx) + dx, jz = ((c / this.nx) | 0) + dz;
    if (jx < 0 || jz < 0 || jx >= this.nx || jz >= this.nz) return -1;
    const cj = jz * this.nx + jx;
    let best = -1, bh = -Infinity;
    for (let lj = 0; lj < this.layerN[cj]; lj++) {
      const h = this.layerH[cj * MAXL + lj];
      if (reached && this.dist[cj * MAXL + lj] === UNREACHED) continue;
      if (h <= feet + this.step && h >= feet - this.drop && this.layerTop[cj * MAXL + lj] >= feet + this.clearance * 0.5 && h > bh) { bh = h; best = cj * MAXL + lj; }
    }
    return best;
  }

  /** Keeps (x, z) at least `margin` from the sides of `node`'s column that have no way through. */
  keepOff(node: number, margin: number, p: [number, number]) {
    const c = (node / MAXL) | 0, L = this.link, b = node * 8;
    const bx0 = this.x0 + (c % this.nx) * this.cell, bz0 = this.z0 + ((c / this.nx) | 0) * this.cell;
    if (L[b] < 0 && p[0] > bx0 + this.cell - margin) p[0] = bx0 + this.cell - margin;
    if (L[b + 1] < 0 && p[0] < bx0 + margin) p[0] = bx0 + margin;
    if (L[b + 2] < 0 && p[1] > bz0 + this.cell - margin) p[1] = bz0 + this.cell - margin;
    if (L[b + 3] < 0 && p[1] < bz0 + margin) p[1] = bz0 + margin;
  }

  /** Path cost (≈ metres × 20) from (x, y, z) to the target, or Infinity. */
  costAt(x: number, y: number, z: number) {
    const node = this.nodeAt(x, y, z);
    if (node < 0 || this.dist[node] === UNREACHED) return Infinity;
    return this.dist[node];
  }
}

/**
 * Clips a triangle to an XZ rectangle (Sutherland–Hodgman); `run` says whether anything is left
 * and leaves its height range in y0..y1.
 */
class Clipper {
  y0 = 0;
  y1 = 0;
  private a = new Float64Array(8 * 3);
  private b = new Float64Array(8 * 3);

  run(tris: readonly number[], t: number, x0: number, z0: number, x1: number, z1: number): boolean {
    let src = this.a, dst = this.b;
    for (let i = 0; i < 9; i++) src[i] = tris[t + i];
    let n = 3;
    // Planes: x >= x0, x <= x1, z >= z0, z <= z1 (axis 0 = x, 2 = z; sign of the inside).
    for (let p = 0; p < 4 && n > 0; p++) {
      const ax = p < 2 ? 0 : 2, lim = p === 0 ? x0 : p === 1 ? x1 : p === 2 ? z0 : z1, sg = p % 2 === 0 ? 1 : -1;
      let m = 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const di = (src[i * 3 + ax] - lim) * sg, dj = (src[j * 3 + ax] - lim) * sg;
        if (di >= 0) { dst[m * 3] = src[i * 3]; dst[m * 3 + 1] = src[i * 3 + 1]; dst[m * 3 + 2] = src[i * 3 + 2]; m++; }
        if ((di >= 0) !== (dj >= 0)) {
          const k = di / (di - dj);
          for (let q = 0; q < 3; q++) dst[m * 3 + q] = src[i * 3 + q] + (src[j * 3 + q] - src[i * 3 + q]) * k;
          m++;
        }
      }
      n = m;
      const s = src; src = dst; dst = s;
    }
    if (n === 0) return false;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { const y = src[i * 3 + 1]; if (y < lo) lo = y; if (y > hi) hi = y; }
    this.y0 = lo;
    this.y1 = hi;
    return true;
  }
}

export const NAV_MAXL = MAXL;
