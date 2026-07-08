const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ENTRIES = 50;

interface CacheEntry {
  value: unknown;
  ts: number;
}

const store = new Map<string, CacheEntry>();

export function aggCacheGet<T>(key: string): T | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    store.delete(key);
    return null;
  }
  return entry.value as T;
}

export function aggCacheSet(key: string, value: unknown): void {
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, { value, ts: Date.now() });
}

/** Called by createOrder after the transaction commits, so the next aggregates
 *  request recomputes rather than serving a stale result that excludes the new
 *  order. */
export function invalidateAggregatesCache(): void {
  store.clear();
}
