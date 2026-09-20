import type { Clock } from '../../infra/retry.js';

export interface LimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

/**
 * Per-caller request limiter (sliding window). It protects the shared server and, indirectly, the
 * shared Figma budget from one noisy user or a runaway agent loop.
 */
export class SlidingWindowLimiter {
  private readonly hitsByKey = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly clock: Clock = Date.now,
  ) {}

  hit(key: string): LimitDecision {
    const now = this.clock();
    const recent = (this.hitsByKey.get(key) ?? []).filter((time) => now - time < this.windowMs);

    if (recent.length >= this.limit) {
      this.hitsByKey.set(key, recent);
      const oldest = recent[0] as number;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)) };
    }

    recent.push(now);
    this.hitsByKey.set(key, recent);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Drops keys with no recent activity so the map cannot grow without bound. */
  sweep(): void {
    const now = this.clock();
    for (const [key, hits] of this.hitsByKey) {
      if (hits.every((time) => now - time >= this.windowMs)) {
        this.hitsByKey.delete(key);
      }
    }
  }
}
