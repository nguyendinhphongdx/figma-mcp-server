import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Clock } from '../../infra/retry.js';

/** Stored form of a cached value: keeps when it was fetched so tools can report staleness. */
export interface CacheEnvelope<T> {
  readonly fetchedAt: string;
  readonly value: T;
}

export interface CachePort {
  get<T>(key: string): Promise<CacheEnvelope<T> | undefined>;
  set<T>(key: string, envelope: CacheEnvelope<T>, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Removes expired entries; returns how many were dropped. */
  sweep(): Promise<number>;
}

interface MemoryEntry {
  readonly envelope: CacheEnvelope<unknown>;
  readonly expiresAt: number;
}

/** Bounded in-memory cache; least-recently-used entries are evicted first. */
export class MemoryTtlCache implements CachePort {
  private readonly entries = new Map<string, MemoryEntry>();

  constructor(
    private readonly maxEntries: number,
    private readonly clock: Clock = Date.now,
  ) {}

  async get<T>(key: string): Promise<CacheEnvelope<T> | undefined> {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= this.clock()) {
      this.entries.delete(key);
      return undefined;
    }
    // Re-insert to mark as most recently used.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.envelope as CacheEnvelope<T>;
  }

  async set<T>(key: string, envelope: CacheEnvelope<T>, ttlMs: number): Promise<void> {
    this.entries.delete(key);
    this.entries.set(key, { envelope, expiresAt: this.clock() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async sweep(): Promise<number> {
    const now = this.clock();
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.entries.size;
  }
}

interface DiskRecord {
  readonly key: string;
  readonly expiresAt: number;
  readonly envelope: CacheEnvelope<unknown>;
}

/**
 * JSON-file cache that survives restarts, so a redeploy does not throw away hours of Figma quota.
 * Keys are hashed into file names; the key is stored inside to detect (theoretical) collisions.
 */
export class DiskCache implements CachePort {
  constructor(
    private readonly directory: string,
    private readonly clock: Clock = Date.now,
  ) {}

  async get<T>(key: string): Promise<CacheEnvelope<T> | undefined> {
    const path = this.pathFor(key);
    const record = await this.read(path);
    if (!record || record.key !== key) {
      return undefined;
    }
    if (record.expiresAt <= this.clock()) {
      await rm(path, { force: true });
      return undefined;
    }
    return record.envelope as CacheEnvelope<T>;
  }

  async set<T>(key: string, envelope: CacheEnvelope<T>, ttlMs: number): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const path = this.pathFor(key);
    const temporaryPath = `${path}.${process.pid}.tmp`;
    const record: DiskRecord = { key, expiresAt: this.clock() + ttlMs, envelope };
    await writeFile(temporaryPath, JSON.stringify(record), 'utf8');
    await rename(temporaryPath, path);
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async sweep(): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch {
      return 0;
    }

    const now = this.clock();
    let removed = 0;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const path = join(this.directory, name);
      const record = await this.read(path);
      // Unreadable files are dropped too: a corrupt cache entry is never worth keeping.
      if (!record || record.expiresAt <= now) {
        await rm(path, { force: true });
        removed += 1;
      }
    }
    return removed;
  }

  private pathFor(key: string): string {
    return join(this.directory, `${createHash('sha256').update(key).digest('hex')}.json`);
  }

  private async read(path: string): Promise<DiskRecord | undefined> {
    try {
      await stat(path);
      return JSON.parse(await readFile(path, 'utf8')) as DiskRecord;
    } catch {
      return undefined;
    }
  }
}

/** Memory in front of disk: hot reads never touch the file system. */
export class LayeredCache implements CachePort {
  constructor(
    private readonly memory: CachePort,
    private readonly disk: CachePort,
    /** TTL used when promoting a disk hit into memory. */
    private readonly promoteTtlMs: number,
  ) {}

  async get<T>(key: string): Promise<CacheEnvelope<T> | undefined> {
    const hot = await this.memory.get<T>(key);
    if (hot) {
      return hot;
    }
    const cold = await this.disk.get<T>(key);
    if (cold) {
      await this.memory.set(key, cold, this.promoteTtlMs);
    }
    return cold;
  }

  async set<T>(key: string, envelope: CacheEnvelope<T>, ttlMs: number): Promise<void> {
    await Promise.all([this.memory.set(key, envelope, ttlMs), this.disk.set(key, envelope, ttlMs)]);
  }

  async delete(key: string): Promise<void> {
    await Promise.all([this.memory.delete(key), this.disk.delete(key)]);
  }

  async sweep(): Promise<number> {
    const [fromMemory, fromDisk] = await Promise.all([this.memory.sweep(), this.disk.sweep()]);
    return fromMemory + fromDisk;
  }
}
