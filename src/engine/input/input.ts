/**
 * Keyboard / mouse input with one set of listeners for the whole app.
 *
 * - Held state (`down`) is live.
 * - Presses are edges kept until a simulation tick consumes them (`endTick`),
 *   so a tap shorter than a tick, or a frame with no tick at high refresh
 *   rates, is never lost. Each edge carries its event timestamp (latency
 *   measurement) and expires after `edgeLifetime` (stale presses from editor
 *   mode never fire in play).
 * - Mouse motion accumulates while the pointer is locked and is taken once
 *   per rendered frame (look is applied per frame, never per tick).
 * - Scripts can drive it (`setKey` / `setButton`) for replayable tests.
 */
export class Input {
  private held = new Set<string>();
  private edges = new Map<string, number>();
  private buttonsHeld = 0;
  private buttonEdges = new Map<number, number>();
  private dx = 0;
  private dy = 0;
  locked = false;
  /** Whether a click on the canvas may capture the mouse (the editor turns it off in edit mode). */
  canLock: () => boolean = () => true;
  edgeLifetime = 250;
  /** Ignore real devices (scripted tests). */
  scripted = false;

  constructor(private canvas: HTMLCanvasElement) {
    const typing = (e: Event) => {
      const t = (e.target as HTMLElement | null)?.tagName;
      return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT';
    };
    window.addEventListener('keydown', (e) => {
      if (this.scripted || typing(e)) return;
      if (!e.repeat) this.press(e.code, e.timeStamp);
    });
    window.addEventListener('keyup', (e) => {
      if (!this.scripted) this.held.delete(e.code);
    });
    window.addEventListener('blur', () => this.clear());
    canvas.addEventListener('click', () => {
      if (!this.locked && this.canLock()) this.requestLock();
    });
    canvas.addEventListener('contextmenu', (e) => {
      if (this.locked) e.preventDefault();
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) {
        this.buttonsHeld = 0;
        this.dx = this.dy = 0;
      }
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked || this.scripted) return;
      this.dx += e.movementX;
      this.dy += e.movementY;
    });
    // Capture phase on the document: nothing in between can delay or swallow a trigger pull.
    document.addEventListener('mousedown', (e) => {
      if (!this.locked || this.scripted) return;
      this.buttonsHeld |= 1 << e.button;
      this.buttonEdges.set(e.button, e.timeStamp);
    }, true);
    document.addEventListener('mouseup', (e) => {
      if (!this.scripted) this.buttonsHeld &= ~(1 << e.button);
    }, true);
  }

  requestLock() {
    const c = this.canvas;
    const req = c.requestPointerLock as (o?: { unadjustedMovement?: boolean }) => Promise<void> | void;
    try {
      // Raw device counts: no OS acceleration.
      const r = req.call(c, { unadjustedMovement: true });
      if (r && 'catch' in r) (r as Promise<void>).catch(() => c.requestPointerLock());
    } catch {
      c.requestPointerLock();
    }
  }

  private press(code: string, t: number) {
    this.held.add(code);
    this.edges.set(code, t);
  }

  down(code: string) {
    return this.held.has(code);
  }

  anyDown(...codes: string[]) {
    for (const c of codes) if (this.held.has(c)) return true;
    return false;
  }

  /** Pressed since the last tick (and not stale). */
  pressed(code: string) {
    const t = this.edges.get(code);
    return t !== undefined && performance.now() - t < this.edgeLifetime;
  }

  /** Event timestamp of a pending press (performance.now() clock), or -1. */
  pressTime(code: string) {
    return this.edges.get(code) ?? -1;
  }

  buttonDown(b = 0) {
    return (this.buttonsHeld & (1 << b)) !== 0;
  }

  buttonPressed(b = 0) {
    const t = this.buttonEdges.get(b);
    return t !== undefined && performance.now() - t < this.edgeLifetime;
  }

  buttonPressTime(b = 0) {
    return this.buttonEdges.get(b) ?? -1;
  }

  /** Marks a pending button press as handled (consumed before the ticks). */
  consumeButton(b = 0) {
    this.buttonEdges.delete(b);
  }

  /** Mouse counts since the last call (per rendered frame). */
  takeMouse(out: [number, number]) {
    out[0] = this.dx;
    out[1] = this.dy;
    this.dx = this.dy = 0;
    return out;
  }

  /** A tick consumed the pending edges. */
  endTick() {
    if (this.edges.size) this.edges.clear();
    if (this.buttonEdges.size) this.buttonEdges.clear();
  }

  clearEdges() {
    this.endTick();
  }

  clear() {
    this.held.clear();
    this.buttonsHeld = 0;
    this.endTick();
    this.dx = this.dy = 0;
  }

  // ---- scripted input (tests, replays)
  setKey(code: string, isDown: boolean) {
    if (isDown && !this.held.has(code)) this.press(code, performance.now());
    else if (!isDown) this.held.delete(code);
  }

  setButton(b: number, isDown: boolean) {
    if (isDown && !this.buttonDown(b)) this.buttonEdges.set(b, performance.now());
    if (isDown) this.buttonsHeld |= 1 << b;
    else this.buttonsHeld &= ~(1 << b);
  }

  addMouse(dx: number, dy: number) {
    this.dx += dx;
    this.dy += dy;
  }
}
