/** Token bucket: allows bursts up to `capacity`, refilling at `refillPerSecond`. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  take(cost = 1): boolean {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.refillPerSecond);
    this.last = t;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

/** Per-key token buckets (e.g. per client IP) with idle eviction. */
export class KeyedRateLimiter {
  private readonly buckets = new Map<string, { bucket: TokenBucket; lastUsed: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 100_000,
  ) {}

  take(key: string, cost = 1): boolean {
    let entry = this.buckets.get(key);
    if (!entry) {
      if (this.buckets.size >= this.maxKeys) this.evict(0);
      entry = { bucket: new TokenBucket(this.capacity, this.refillPerSecond, this.now), lastUsed: this.now() };
      this.buckets.set(key, entry);
    }
    entry.lastUsed = this.now();
    return entry.bucket.take(cost);
  }

  /** Drops buckets idle for longer than `idleMs` (a full bucket after refilling). */
  evict(idleMs = (this.capacity / this.refillPerSecond) * 1000): void {
    const cutoff = this.now() - idleMs;
    for (const [key, entry] of this.buckets) {
      if (entry.lastUsed <= cutoff) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}
