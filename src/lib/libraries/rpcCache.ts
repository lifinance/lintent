type CacheEntry<T> = {
	value: T;
	expiresAt: number;
};

const cache = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

const stats = {
	hits: 0,
	misses: 0,
	inflightJoins: 0
};

export function getRpcCacheStats() {
	return { ...stats };
}

export function clearRpcCache() {
	cache.clear();
	inflight.clear();
}

export function invalidateRpcKey(key: string) {
	cache.delete(key);
	inflight.delete(key);
}

export function invalidateRpcPrefix(prefix: string) {
	for (const key of cache.keys()) {
		if (key.startsWith(prefix)) cache.delete(key);
	}
	for (const key of inflight.keys()) {
		if (key.startsWith(prefix)) inflight.delete(key);
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
	}

	stats.misses += 1;
	const request = fetcher()
		.then((value) => {
			cache.set(key, { value, expiresAt: Date.now() + ttlMs });
			return value;
		})
		.finally(() => {
			inflight.delete(key);
		});

	inflight.set(key, request);
	return request;
}
