import type { CachePort } from './cache.js';

export interface Loaded<T> {
  readonly value: T;
  /** True when served from cache (no Figma quota spent). */
  readonly cached: boolean;
  /** When the underlying data was fetched from Figma (ISO 8601). */
  readonly fetchedAt: string;
}

export interface LoadOptions {
  /** Skip the cache read and fetch fresh data (the result is still cached). */
  readonly refresh?: boolean | undefined;
}

export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly inFlightJoins: number;
}

/**
 * Read-through cache with single-flight: concurrent callers asking for the same key share one
 * upstream request. On a shared server this matters as much as the cache itself, because several
 * teammates (or agents) often ask for the same file at the same moment.
 */
export class CachedLoader {
  private readonly inFlight = new Map<string, Promise<Loaded<unknown>>>();
  private hits = 0;
  private misses = 0;
  private joins = 0;

  constructor(
    private readonly cache: CachePort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getOrLoad<T>(
    key: string,
    ttlMs: number,
    loader: () => Promise<T>,
    options: LoadOptions = {},
  ): Promise<Loaded<T>> {
    if (!options.refresh) {
      const hit = await this.cache.get<T>(key);
      if (hit) {
        this.hits += 1;
        return { value: hit.value, cached: true, fetchedAt: hit.fetchedAt };
      }
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      this.joins += 1;
      return (await pending) as Loaded<T>;
    }

    this.misses += 1;
    const load = (async (): Promise<Loaded<T>> => {
      const value = await loader();
      const fetchedAt = this.now().toISOString();
      await this.cache.set(key, { fetchedAt, value }, ttlMs);
      return { value, cached: false, fetchedAt };
    })();

    this.inFlight.set(key, load);
    try {
      return await load;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Returns a cached value without ever contacting upstream. */
  async peek<T>(key: string): Promise<Loaded<T> | undefined> {
    const hit = await this.cache.get<T>(key);
    return hit ? { value: hit.value, cached: true, fetchedAt: hit.fetchedAt } : undefined;
  }

  async put<T>(key: string, ttlMs: number, value: T): Promise<void> {
    await this.cache.set(key, { fetchedAt: this.now().toISOString(), value }, ttlMs);
  }

  async invalidate(key: string): Promise<void> {
    await this.cache.delete(key);
  }

  stats(): CacheStats {
    return { hits: this.hits, misses: this.misses, inFlightJoins: this.joins };
  }
}
