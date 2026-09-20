import { RateLimitedError } from '../domain/errors.js';
import { defaultSleep, type Clock, type Sleep } from '../../infra/retry.js';

export type Tier = 1 | 2 | 3;
export const TIERS: readonly Tier[] = [1, 2, 3];

export interface RateLimitReport {
  readonly retryAfterSeconds?: number | undefined;
  readonly planTier?: string | undefined;
  readonly limitType?: string | undefined;
  readonly upgradeLink?: string | undefined;
}

/**
 * Gate every Figma HTTP attempt must pass through.
 * One instance is shared by all callers of the server, because Figma's budget is per token,
 * not per MCP user: a burst from one user must not burn the quota of the whole team.
 */
export interface RateLimitGate {
  /** Resolves when a request may be sent; rejects with RateLimitedError when it must not. */
  acquire(tier: Tier): Promise<void>;
  reportSuccess(tier: Tier): void;
  /** Called when Figma answered 429; opens the circuit for the tier. */
  reportRateLimited(tier: Tier, report: RateLimitReport): void;
  status(): GovernorStatus;
}

export interface TierPolicy {
  /** Sustained requests per minute. */
  readonly requestsPerMinute: number;
  /** Requests allowed back-to-back before pacing starts. */
  readonly burst: number;
}

export interface GovernorOptions {
  readonly policies: Readonly<Record<Tier, TierPolicy>>;
  /** Longest a caller is queued for a slot (or a short circuit-open period) before failing fast. */
  readonly maxQueueWaitMs: number;
  /** Assumed when Figma answers 429 without a usable Retry-After. */
  readonly defaultRetryAfterSeconds?: number;
  readonly clock?: Clock;
  readonly sleep?: Sleep;
}

export interface TierStatus {
  readonly tier: Tier;
  readonly requestsPerMinute: number;
  readonly burst: number;
  readonly availableSlots: number;
  readonly requestsLastHour: number;
  readonly rateLimitedLast24h: number;
  /** ISO time until which requests are refused without contacting Figma; null when the circuit is closed. */
  readonly blockedUntil: string | null;
  readonly retryAfterSeconds: number | null;
  readonly lastRateLimited: {
    readonly at: string;
    readonly retryAfterSeconds: number | null;
    readonly planTier: string | null;
    readonly limitType: string | null;
    readonly upgradeLink: string | null;
  } | null;
}

export interface GovernorStatus {
  readonly tiers: readonly TierStatus[];
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

interface TierState {
  tokens: number;
  lastRefillAt: number;
  blockedUntil: number | null;
  requestTimes: number[];
  rateLimitedTimes: number[];
  lastRateLimited: TierStatus['lastRateLimited'];
}

/**
 * Token bucket per tier plus a circuit breaker driven by Figma's own 429 answers.
 *
 * - Pacing keeps us under the configured requests-per-minute so we rarely provoke a 429.
 * - When Figma does answer 429 the tier is blocked for `Retry-After`; callers arriving meanwhile
 *   fail immediately with a precise retry hint instead of hammering Figma (which would only
 *   extend the penalty) or hanging for hours.
 */
export class TokenBucketGovernor implements RateLimitGate {
  private readonly clock: Clock;
  private readonly sleep: Sleep;
  private readonly states = new Map<Tier, TierState>();

  constructor(private readonly options: GovernorOptions) {
    this.clock = options.clock ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    for (const tier of TIERS) {
      this.states.set(tier, {
        tokens: options.policies[tier].burst,
        lastRefillAt: this.clock(),
        blockedUntil: null,
        requestTimes: [],
        rateLimitedTimes: [],
        lastRateLimited: null,
      });
    }
  }

  async acquire(tier: Tier): Promise<void> {
    const policy = this.options.policies[tier];
    const state = this.stateOf(tier);
    const startedAt = this.clock();

    for (;;) {
      const now = this.clock();

      if (state.blockedUntil !== null && state.blockedUntil > now) {
        const remainingMs = state.blockedUntil - now;
        if (now - startedAt + remainingMs > this.options.maxQueueWaitMs) {
          throw this.refusal(tier, remainingMs, 'figma', state);
        }
        await this.sleep(remainingMs);
        continue;
      }
      state.blockedUntil = null;

      this.refill(state, policy, now);
      if (state.tokens >= 1) {
        state.tokens -= 1;
        state.requestTimes.push(now);
        return;
      }

      const waitMs = Math.ceil(((1 - state.tokens) * 60_000) / policy.requestsPerMinute);
      if (now - startedAt + waitMs > this.options.maxQueueWaitMs) {
        throw this.refusal(tier, waitMs, 'local', state);
      }
      await this.sleep(waitMs);
    }
  }

  reportSuccess(_tier: Tier): void {
    // Requests are counted at acquire time; nothing else to record on success.
  }

  reportRateLimited(tier: Tier, report: RateLimitReport): void {
    const state = this.stateOf(tier);
    const now = this.clock();
    const retryAfterSeconds = report.retryAfterSeconds ?? this.options.defaultRetryAfterSeconds ?? 30;

    state.blockedUntil = Math.max(state.blockedUntil ?? 0, now + retryAfterSeconds * 1000);
    state.tokens = 0;
    state.rateLimitedTimes.push(now);
    state.lastRateLimited = {
      at: new Date(now).toISOString(),
      retryAfterSeconds: report.retryAfterSeconds ?? null,
      planTier: report.planTier ?? null,
      limitType: report.limitType ?? null,
      upgradeLink: report.upgradeLink ?? null,
    };
  }

  status(): GovernorStatus {
    const now = this.clock();
    return {
      tiers: TIERS.map((tier) => {
        const policy = this.options.policies[tier];
        const state = this.stateOf(tier);
        this.refill(state, policy, now);
        this.prune(state, now);

        const blocked = state.blockedUntil !== null && state.blockedUntil > now;
        return {
          tier,
          requestsPerMinute: policy.requestsPerMinute,
          burst: policy.burst,
          availableSlots: Math.floor(state.tokens),
          requestsLastHour: state.requestTimes.length,
          rateLimitedLast24h: state.rateLimitedTimes.length,
          blockedUntil: blocked ? new Date(state.blockedUntil as number).toISOString() : null,
          retryAfterSeconds: blocked ? Math.ceil(((state.blockedUntil as number) - now) / 1000) : null,
          lastRateLimited: state.lastRateLimited,
        };
      }),
    };
  }

  private refusal(tier: Tier, waitMs: number, source: 'figma' | 'local', state: TierState): RateLimitedError {
    const retryAfterSeconds = Math.max(1, Math.ceil(waitMs / 1000));
    const last = state.lastRateLimited;
    const why =
      source === 'figma'
        ? `Figma rate-limited Tier ${tier} requests; the server is holding back until the penalty expires`
        : `Tier ${tier} request budget is used up locally (${this.options.policies[tier].requestsPerMinute}/min)`;
    return new RateLimitedError(`${why}. Retry in about ${retryAfterSeconds}s.`, {
      tier,
      retryAfterSeconds,
      source,
      planTier: last?.planTier ?? undefined,
      limitType: last?.limitType ?? undefined,
      upgradeLink: last?.upgradeLink ?? undefined,
    });
  }

  private refill(state: TierState, policy: TierPolicy, now: number): void {
    const elapsedMs = Math.max(0, now - state.lastRefillAt);
    state.tokens = Math.min(policy.burst, state.tokens + (elapsedMs * policy.requestsPerMinute) / 60_000);
    state.lastRefillAt = now;
  }

  private prune(state: TierState, now: number): void {
    state.requestTimes = state.requestTimes.filter((time) => now - time < HOUR_MS);
    state.rateLimitedTimes = state.rateLimitedTimes.filter((time) => now - time < DAY_MS);
  }

  private stateOf(tier: Tier): TierState {
    const state = this.states.get(tier);
    if (!state) {
      throw new RangeError(`Unknown tier ${tier}`);
    }
    return state;
  }
}

/** Gate that never blocks; for tests and for fake API doubles. */
export const openGate: RateLimitGate = {
  acquire: async () => undefined,
  reportSuccess: () => undefined,
  reportRateLimited: () => undefined,
  status: () => ({ tiers: [] }),
};
