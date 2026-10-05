/**
 * Player health: damage, a slow regeneration after a quiet spell, death.
 * Tuning is plain fields (the panel binds them); no armour or healing items yet.
 */
export class Vitals {
  max = 100;
  hp = 100;
  /** Seconds without damage before health starts coming back, and how fast (hp/s). */
  regenDelay = 5;
  regenRate = 8;
  /** Take no damage (testing). */
  god = false;
  dead = false;
  /** Seconds since the last hit, since death. */
  sinceHit = 99;
  deadT = 0;

  reset() {
    this.hp = this.max;
    this.dead = false;
    this.sinceHit = 99;
    this.deadT = 0;
  }

  /** Applies damage; true when this hit killed. */
  damage(n: number): boolean {
    if (this.dead || this.god) return false;
    this.hp = Math.max(0, this.hp - n);
    this.sinceHit = 0;
    if (this.hp > 0) return false;
    this.dead = true;
    this.deadT = 0;
    return true;
  }

  tick(h: number) {
    if (this.dead) { this.deadT += h; return; }
    this.sinceHit += h;
    if (this.sinceHit > this.regenDelay && this.hp < this.max) this.hp = Math.min(this.max, this.hp + this.regenRate * h);
  }
}
