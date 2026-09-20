import { describe, expect, it, vi } from 'vitest';
import { MemoryTtlCache } from '../../../src/core/cache/cache.js';
import { CachedLoader } from '../../../src/core/cache/cached-loader.js';

const FIXED = new Date('2026-09-19T12:00:00.000Z');
const newLoader = () => new CachedLoader(new MemoryTtlCache(100), () => FIXED);

describe('CachedLoader', () => {
  it('loads once, then serves from cache and says so', async () => {
    const loader = newLoader();
    const upstream = vi.fn().mockResolvedValue({ n: 1 });

    const first = await loader.getOrLoad('k', 1_000, upstream);
    const second = await loader.getOrLoad('k', 1_000, upstream);

    expect(upstream).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ value: { n: 1 }, cached: false, fetchedAt: FIXED.toISOString() });
    expect(second).toEqual({ value: { n: 1 }, cached: true, fetchedAt: FIXED.toISOString() });
    expect(loader.stats()).toEqual({ hits: 1, misses: 1, inFlightJoins: 0 });
  });

  it('shares one upstream call between concurrent callers (single-flight)', async () => {
    const loader = newLoader();
    let release!: (value: string) => void;
    const upstream = vi.fn(() => new Promise<string>((resolve) => (release = resolve)));

    const calls = [loader.getOrLoad('k', 1_000, upstream), loader.getOrLoad('k', 1_000, upstream), loader.getOrLoad('k', 1_000, upstream)];
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(1));
    release('shared');

    const results = await Promise.all(calls);
    expect(results.map((result) => result.value)).toEqual(['shared', 'shared', 'shared']);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(loader.stats().inFlightJoins).toBe(2);
  });

  it('does not cache failures and lets the next caller retry', async () => {
    const loader = newLoader();
    const upstream = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('fine');

    await expect(loader.getOrLoad('k', 1_000, upstream)).rejects.toThrow('boom');
    await expect(loader.getOrLoad('k', 1_000, upstream)).resolves.toMatchObject({ value: 'fine', cached: false });
  });

  it('a failed in-flight load rejects every joined caller', async () => {
    const loader = newLoader();
    let fail!: (error: Error) => void;
    const upstream = vi.fn(() => new Promise<string>((_, reject) => (fail = reject)));

    const calls = [loader.getOrLoad('k', 1_000, upstream), loader.getOrLoad('k', 1_000, upstream)];
    await vi.waitFor(() => expect(upstream).toHaveBeenCalled());
    fail(new Error('upstream down'));

    const settled = await Promise.allSettled(calls);
    expect(settled.map((entry) => entry.status)).toEqual(['rejected', 'rejected']);
  });

  it('refresh bypasses the cache read but still updates it', async () => {
    const loader = newLoader();
    const upstream = vi.fn().mockResolvedValueOnce('old').mockResolvedValueOnce('new');
    await loader.getOrLoad('k', 1_000, upstream);

    const refreshed = await loader.getOrLoad('k', 1_000, upstream, { refresh: true });
    expect(refreshed).toMatchObject({ value: 'new', cached: false });
    expect((await loader.getOrLoad('k', 1_000, upstream)).value).toBe('new');
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('peek never calls upstream; put and invalidate manage entries directly', async () => {
    const loader = newLoader();
    expect(await loader.peek('k')).toBeUndefined();

    await loader.put('k', 1_000, 'seeded');
    expect(await loader.peek('k')).toEqual({ value: 'seeded', cached: true, fetchedAt: FIXED.toISOString() });

    await loader.invalidate('k');
    expect(await loader.peek('k')).toBeUndefined();
  });

  it('keys are independent', async () => {
    const loader = newLoader();
    const upstream = vi.fn(async () => 'x');
    await loader.getOrLoad('a', 1_000, upstream);
    await loader.getOrLoad('b', 1_000, upstream);
    expect(upstream).toHaveBeenCalledTimes(2);
  });
});
