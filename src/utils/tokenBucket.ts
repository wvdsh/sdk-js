/**
 * Client-side token bucket mirroring @convex-dev/rate-limiter's
 * `kind: 'token bucket'`: starts full, holds at most `capacity` tokens
 * (defaults to `rate`), and refills continuously at `rate` per `periodMs`.
 */
export class TokenBucket {
  private tokens: number;
  private updatedAt = Date.now();

  constructor(
    private readonly rate: number,
    private readonly periodMs: number,
    private readonly capacity: number = rate
  ) {
    this.tokens = capacity;
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((now - this.updatedAt) * this.rate) / this.periodMs
    );
    this.updatedAt = now;
  }

  // Milliseconds until a token is available (0 if one is available now)
  msUntilAvailable(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) * this.periodMs) / this.rate);
  }

  take(): void {
    this.refill();
    this.tokens -= 1;
  }

  // Empty the bucket so no token is available for `ms` (e.g. the server
  // reported a retryAfter we didn't predict — another tab, a page reload)
  drainFor(ms: number): void {
    this.refill();
    this.tokens = Math.min(this.tokens, 1 - (ms * this.rate) / this.periodMs);
  }
}

/**
 * FIFO gate over one or more token buckets: each acquire() waits its turn,
 * then waits until every bucket has a token and takes one from each.
 */
export class RateLimitGate {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly buckets: TokenBucket[],
    private readonly onWait?: (ms: number) => void
  ) {}

  acquire(): Promise<void> {
    const turn = this.tail.then(() => this.waitForTokens());
    this.tail = turn;
    return turn;
  }

  drainFor(ms: number): void {
    for (const bucket of this.buckets) bucket.drainFor(ms);
  }

  private async waitForTokens(): Promise<void> {
    let waitMs: number;
    while (
      (waitMs = Math.max(...this.buckets.map((b) => b.msUntilAvailable()))) > 0
    ) {
      this.onWait?.(waitMs);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    for (const bucket of this.buckets) bucket.take();
  }
}
