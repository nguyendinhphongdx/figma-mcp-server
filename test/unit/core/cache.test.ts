import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiskCache, LayeredCache, MemoryTtlCache, type CacheEnvelope } from '../../../src/core/cache/cache.js';
import { FakeClock } from '../../support/fake-clock.js';

const envelope = <T>(value: T): CacheEnvelope<T> => ({ fetchedAt: '2026-09-19T00:00:00.000Z', value });

describe('MemoryTtlCache', () => {
  it('returns what was stored until the TTL elapses', async () => {
    const clock = new FakeClock();
    const cache = new MemoryTtlCache(10, clock.now);
    await cache.set('k', envelope({ a: 1 }), 1_000);

    expect((await cache.get('k'))?.value).toEqual({ a: 1 });
    clock.advance(999);
    expect(await cache.get('k')).toBeDefined();
    clock.advance(1);
    expect(await cache.get('k')).toBeUndefined();
  });

  it('evicts the least recently used entry when full', async () => {
    const cache = new MemoryTtlCache(2);
    await cache.set('a', envelope(1), 10_000);
    await cache.set('b', envelope(2), 10_000);
    await cache.get('a'); // a is now the most recent
    await cache.set('c', envelope(3), 10_000);

    expect(await cache.get('b')).toBeUndefined();
    expect(await cache.get('a')).toBeDefined();
    expect(await cache.get('c')).toBeDefined();
    expect(cache.size).toBe(2);
  });

  it('overwriting a key refreshes its TTL and position', async () => {
    const clock = new FakeClock();
    const cache = new MemoryTtlCache(2, clock.now);
    await cache.set('a', envelope(1), 1_000);
    clock.advance(900);
    await cache.set('a', envelope(2), 1_000);
    clock.advance(900);
    expect((await cache.get('a'))?.value).toBe(2);
  });

  it('deletes and sweeps expired entries', async () => {
    const clock = new FakeClock();
    const cache = new MemoryTtlCache(10, clock.now);
    await cache.set('short', envelope(1), 100);
    await cache.set('long', envelope(2), 10_000);
    await cache.set('gone', envelope(3), 10_000);
    await cache.delete('gone');

    clock.advance(500);
    expect(await cache.sweep()).toBe(1);
    expect(cache.size).toBe(1);
  });
});

describe('DiskCache', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'disk-cache-'));
  });
  afterEach(() => rm(directory, { recursive: true, force: true }));

  it('round-trips values across instances (survives a restart)', async () => {
    await new DiskCache(directory).set('outline:abc', envelope({ pages: ['x'] }), 60_000);
    const reloaded = await new DiskCache(directory).get<{ pages: string[] }>('outline:abc');
    expect(reloaded).toEqual(envelope({ pages: ['x'] }));
  });

  it('expires entries and removes their file', async () => {
    const clock = new FakeClock();
    const cache = new DiskCache(directory, clock.now);
    await cache.set('k', envelope(1), 1_000);
    clock.advance(1_000);

    expect(await cache.get('k')).toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
  });

  it('handles keys with characters that are illegal in file names', async () => {
    const cache = new DiskCache(directory);
    await cache.set('nodes:F/1:2?x=../../etc', envelope('ok'), 60_000);
    expect((await cache.get('nodes:F/1:2?x=../../etc'))?.value).toBe('ok');
    expect((await readdir(directory)).every((name) => /^[0-9a-f]{64}\.json$/.test(name))).toBe(true);
  });

  it('treats a corrupt file as a miss and sweeps it away', async () => {
    const cache = new DiskCache(directory);
    await cache.set('k', envelope(1), 60_000);
    const [file] = await readdir(directory);
    await writeFile(join(directory, file as string), '{not json', 'utf8');

    expect(await cache.get('k')).toBeUndefined();
    expect(await cache.sweep()).toBe(1);
    expect(await readdir(directory)).toEqual([]);
  });

  it('sweep removes only expired entries and tolerates a missing directory', async () => {
    const clock = new FakeClock();
    const cache = new DiskCache(directory, clock.now);
    await cache.set('old', envelope(1), 100);
    await cache.set('fresh', envelope(2), 100_000);
    clock.advance(1_000);

    expect(await cache.sweep()).toBe(1);
    expect((await cache.get('fresh'))?.value).toBe(2);
    expect(await new DiskCache(join(directory, 'missing')).sweep()).toBe(0);
  });

  it('delete is idempotent', async () => {
    const cache = new DiskCache(directory);
    await expect(cache.delete('never-set')).resolves.toBeUndefined();
  });
});

describe('LayeredCache', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'layered-cache-'));
  });
  afterEach(() => rm(directory, { recursive: true, force: true }));

  it('writes to both layers and reads hot values from memory', async () => {
    const memory = new MemoryTtlCache(10);
    const disk = new DiskCache(directory);
    const layered = new LayeredCache(memory, disk, 60_000);
    await layered.set('k', envelope(1), 60_000);

    expect(await memory.get('k')).toBeDefined();
    expect(await disk.get('k')).toBeDefined();
  });

  it('promotes a disk hit into memory (e.g. after a restart)', async () => {
    const disk = new DiskCache(directory);
    await disk.set('k', envelope('cold'), 60_000);

    const memory = new MemoryTtlCache(10);
    const layered = new LayeredCache(memory, disk, 60_000);
    expect((await layered.get('k'))?.value).toBe('cold');
    expect(await memory.get('k')).toBeDefined();
  });

  it('delete removes from both layers, so a stale copy cannot be resurrected', async () => {
    const memory = new MemoryTtlCache(10);
    const disk = new DiskCache(directory);
    const layered = new LayeredCache(memory, disk, 60_000);
    await layered.set('k', envelope(1), 60_000);
    await layered.delete('k');

    expect(await layered.get('k')).toBeUndefined();
    expect(await disk.get('k')).toBeUndefined();
  });

  it('sweep totals both layers', async () => {
    const clock = new FakeClock();
    const layered = new LayeredCache(new MemoryTtlCache(10, clock.now), new DiskCache(directory, clock.now), 1_000);
    await layered.set('k', envelope(1), 100);
    clock.advance(500);
    expect(await layered.sweep()).toBe(2);
  });
});
