import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Tier } from './governor.js';

export interface PersistedTierState {
  readonly blockedUntil: number | null;
  readonly requestTimes: readonly number[];
  readonly rateLimitedTimes: readonly number[];
  readonly byteSamples: ReadonlyArray<readonly [number, number]>;
  readonly lastRateLimited: unknown;
}

export type GovernorSnapshot = Partial<Record<Tier, PersistedTierState>>;

/**
 * Where the governor remembers an active penalty across a restart.
 *
 * Without this the breaker is in-memory only, so a restart during a Figma penalty forgets it and
 * the next call goes to Figma purely to be refused — a request thrown at a wall that can extend
 * the penalty. Observed in practice, which is why this exists.
 */
export interface GovernorStateStore {
  load(): GovernorSnapshot | undefined;
  save(snapshot: GovernorSnapshot): void;
}

/** Keeps the snapshot as one small JSON file next to the rest of the server's data. */
export class FileGovernorStateStore implements GovernorStateStore {
  constructor(
    private readonly path: string,
    private readonly onError: (reason: string) => void = () => undefined,
  ) {}

  load(): GovernorSnapshot | undefined {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as GovernorSnapshot;
    } catch {
      // No file yet, or it is unreadable: starting cold is correct and safe.
      return undefined;
    }
  }

  save(snapshot: GovernorSnapshot): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(snapshot), 'utf8');
    } catch (error) {
      // Losing the snapshot degrades restarts; it must never fail a Figma call.
      this.onError(error instanceof Error ? error.message : String(error));
    }
  }
}

/** Store that remembers nothing; for tests and for deployments that do not want the file. */
export const ephemeralGovernorState: GovernorStateStore = {
  load: () => undefined,
  save: () => undefined,
};
