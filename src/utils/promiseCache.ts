/**
 * Short-lived cache for async results. Concurrent calls for the same key share
 * one in-flight promise, and a resolved result is reused for `ttlMs`.
 * Rejections are never cached. An entry cleared while in flight is not
 * re-added when it resolves, so a clear() guarantees the next get() refetches.
 */
export class PromiseCache<K, V> {
  private entries = new Map<K, { promise: Promise<V>; expiresAt: number }>();

  constructor(private readonly ttlMs: number) {}

  get(key: K, load: () => Promise<V>): Promise<V> {
    const now = Date.now();
    const existing = this.entries.get(key);
    if (existing && now < existing.expiresAt) return existing.promise;

    // Drop expired entries so distinct keys (e.g. paging offsets) don't pile up
    for (const [k, entry] of this.entries) {
      if (now >= entry.expiresAt) this.entries.delete(k);
    }

    const entry = { promise: load(), expiresAt: Infinity };
    this.entries.set(key, entry);
    entry.promise.then(
      () => {
        if (this.entries.get(key) === entry) {
          entry.expiresAt = Date.now() + this.ttlMs;
        }
      },
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      }
    );
    return entry.promise;
  }

  clear(): void {
    this.entries.clear();
  }
}
