type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
const errorBackoff = new Map<string, number>(); // key -> backoff expiry timestamp

const stats = {
  hits: 0,
  misses: 0,
  inflightJoins: 0
};

function is429(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof Error && error.message.includes("429")) return true;
  if (typeof error === "object") {
    const e = error as Record<string, unknown>;
    if (e.status === 429) return true;
    if (
      typeof e.response === "object" &&
      e.response !== null &&
      (e.response as Record<string, unknown>).status === 429
    )
      return true;
  }
  return false;
}

export function getRpcCacheStats() {
  return { ...stats };
}

export function clearRpcCache() {
  cache.clear();
  inflight.clear();
  errorBackoff.clear();
}

export function invalidateRpcKey(key: string) {
  cache.delete(key);
  inflight.delete(key);
  errorBackoff.delete(key);
}

export function invalidateRpcPrefix(prefix: string) {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
  for (const key of inflight.keys()) {
    if (key.startsWith(prefix)) inflight.delete(key);
  }
  for (const key of errorBackoff.keys()) {
    if (key.startsWith(prefix)) errorBackoff.delete(key);
  }
}

export async function getOrFetchRpc<T>(
  key: string,
  fetcher: () => Promise<T>,
  opts: { ttlMs: number; force?: boolean }
): Promise<T> {
  const { ttlMs, force = false } = opts;
  const now = Date.now();

  if (!force) {
    const cached = cache.get(key) as CacheEntry<T> | undefined;
    if (cached && cached.expiresAt > now) {
      stats.hits += 1;
      return cached.value;
    }
    const pending = inflight.get(key) as Promise<T> | undefined;
    if (pending) {
      stats.inflightJoins += 1;
      return pending;
    }
    const backoffExpiry = errorBackoff.get(key);
    if (backoffExpiry && backoffExpiry > now) {
      return Promise.reject(new Error("RPC rate limited, backing off"));
    }
  }

  stats.misses += 1;
  const request = fetcher()
    .then((value) => {
      cache.set(key, { value, expiresAt: Date.now() + ttlMs });
      errorBackoff.delete(key);
      return value;
    })
    .catch((error) => {
      if (is429(error)) {
        errorBackoff.set(key, Date.now() + 15_000);
      }
      throw error;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, request);
  return request;
}
