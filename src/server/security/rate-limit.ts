export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface Counter {
  attempts: number;
  resetAt: number;
}

export class LoginRateLimiter {
  private readonly counters = new Map<string, Counter>();

  constructor(
    private readonly maxAttempts = 5,
    private readonly windowMs = 15 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  check(key: string): RateLimitDecision {
    const current = this.getCounter(key);
    if (current.attempts < this.maxAttempts) {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - this.now()) / 1000)),
    };
  }

  recordFailure(key: string): void {
    const current = this.getCounter(key);
    current.attempts += 1;
    this.counters.set(key, current);
  }

  reset(key: string): void {
    this.counters.delete(key);
  }

  private getCounter(key: string): Counter {
    const now = this.now();
    const current = this.counters.get(key);
    if (!current || current.resetAt <= now) {
      return { attempts: 0, resetAt: now + this.windowMs };
    }
    return current;
  }
}
