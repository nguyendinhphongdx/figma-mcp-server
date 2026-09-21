import { describe, expect, it } from 'vitest';
import { RateLimitedError } from '../../../src/core/domain/errors.js';
import { TokenBucketGovernor, type GovernorOptions } from '../../../src/core/rate-limit/governor.js';
import { FakeClock } from '../../support/fake-clock.js';

function makeGovernor(overrides: Partial<GovernorOptions> = {}, clock = new FakeClock()) {
  const governor = new TokenBucketGovernor({
    policies: {
      1: { requestsPerMinute: 6, burst: 3 }, // one token every 10 s
      2: { requestsPerMinute: 60, burst: 30 },
      3: { requestsPerMinute: 60, burst: 30 },
    },
    maxQueueWaitMs: 25_000,
    clock: clock.now,
    sleep: clock.sleep,
    ...overrides,
  });
  return { governor, clock };
}

async function rejection(promise: Promise<unknown>): Promise<RateLimitedError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RateLimitedError);
    return error as RateLimitedError;
  }
  throw new Error('expected the promise to reject');
}

describe('TokenBucketGovernor pacing', () => {
  it('lets a burst through without waiting', async () => {
    const { governor, clock } = makeGovernor();
    await governor.acquire(1);
    await governor.acquire(1);
    await governor.acquire(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('paces requests after the burst at the sustained rate', async () => {
    const { governor, clock } = makeGovernor();
    for (let i = 0; i < 3; i += 1) await governor.acquire(1);
    await governor.acquire(1);
    expect(clock.sleeps).toEqual([10_000]);
  });

  it('refills over time but never above the burst size', async () => {
    const { governor, clock } = makeGovernor();
    for (let i = 0; i < 3; i += 1) await governor.acquire(1);
    clock.advance(10 * 60_000); // far longer than needed to refill
    expect(governor.status().tiers[0]?.availableSlots).toBe(3);
  });

  it('fails fast with a local refusal when the wait would exceed maxQueueWaitMs', async () => {
    const { governor } = makeGovernor({ maxQueueWaitMs: 5_000 });
    for (let i = 0; i < 3; i += 1) await governor.acquire(1);

    const error = await rejection(governor.acquire(1));
    expect(error.details).toMatchObject({ tier: 1, source: 'local', retryAfterSeconds: 10 });
  });

  it('keeps tiers independent', async () => {
    const { governor } = makeGovernor({ maxQueueWaitMs: 1_000 });
    for (let i = 0; i < 3; i += 1) await governor.acquire(1);
    await expect(governor.acquire(2)).resolves.toBeUndefined();
    await rejection(governor.acquire(1));
  });
});

describe('TokenBucketGovernor circuit breaker', () => {
  it('refuses immediately, naming Figma as the source, while a long penalty is active', async () => {
    const { governor, clock } = makeGovernor();
    governor.reportRateLimited(1, { retryAfterSeconds: 3600, planTier: 'pro', limitType: 'low', upgradeLink: 'https://x.test/up' });

    const error = await rejection(governor.acquire(1));
    expect(error.details).toMatchObject({
      tier: 1,
      source: 'figma',
      retryAfterSeconds: 3600,
      planTier: 'pro',
      limitType: 'low',
      upgradeLink: 'https://x.test/up',
    });
    expect(clock.sleeps).toEqual([]);
  });

  it('waits out a penalty shorter than maxQueueWaitMs, then proceeds', async () => {
    const { governor, clock } = makeGovernor();
    governor.reportRateLimited(1, { retryAfterSeconds: 5 });
    await governor.acquire(1);
    expect(clock.sleeps[0]).toBe(5_000);
  });

  it('closes the circuit once the penalty has passed', async () => {
    const { governor, clock } = makeGovernor();
    governor.reportRateLimited(1, { retryAfterSeconds: 60 });
    clock.advance(60_001);
    // Bucket was emptied by the 429, so one token needs to refill first.
    await expect(governor.acquire(1)).resolves.toBeUndefined();
    expect(governor.status().tiers[0]?.blockedUntil).toBeNull();
  });

  it('only blocks the tier that was limited', async () => {
    const { governor } = makeGovernor();
    governor.reportRateLimited(1, { retryAfterSeconds: 3600 });
    await expect(governor.acquire(3)).resolves.toBeUndefined();
  });

  it('never shortens an existing penalty', async () => {
    const { governor } = makeGovernor();
    governor.reportRateLimited(1, { retryAfterSeconds: 3600 });
    governor.reportRateLimited(1, { retryAfterSeconds: 5 });
    expect(governor.status().tiers[0]?.retryAfterSeconds).toBe(3600);
  });

  it('assumes a default penalty when Figma gives no Retry-After', () => {
    const { governor } = makeGovernor({ defaultRetryAfterSeconds: 45 });
    governor.reportRateLimited(2, {});
    const tier = governor.status().tiers[1];
    expect(tier?.retryAfterSeconds).toBe(45);
    expect(tier?.lastRateLimited?.retryAfterSeconds).toBeNull();
  });
});

describe('TokenBucketGovernor status', () => {
  it('reports usage, 429 history and the last rate-limit details', async () => {
    const { governor } = makeGovernor();
    await governor.acquire(1);
    await governor.acquire(1);
    governor.reportRateLimited(1, { retryAfterSeconds: 120, planTier: 'pro' });

    const tier = governor.status().tiers[0];
    expect(tier).toMatchObject({
      tier: 1,
      requestsPerMinute: 6,
      burst: 3,
      requestsLastHour: 2,
      rateLimitedLast24h: 1,
      retryAfterSeconds: 120,
    });
    expect(tier?.blockedUntil).toBe(new Date(1_700_000_000_000 + 120_000).toISOString());
    expect(tier?.lastRateLimited).toMatchObject({ planTier: 'pro', retryAfterSeconds: 120 });
  });

  it('forgets requests older than an hour and 429s older than a day', async () => {
    const { governor, clock } = makeGovernor();
    await governor.acquire(1);
    governor.reportRateLimited(1, { retryAfterSeconds: 1 });

    clock.advance(61 * 60_000);
    expect(governor.status().tiers[0]).toMatchObject({ requestsLastHour: 0, rateLimitedLast24h: 1 });

    clock.advance(24 * 60 * 60_000);
    expect(governor.status().tiers[0]?.rateLimitedLast24h).toBe(0);
  });
});

describe('cost accounting', () => {
  it('charges a large response extra budget, because Figma bills by response size', () => {
    const { governor } = makeGovernor({ costBytesPerUnit: 1_000 });

    const before = governor.status().tiers[0]?.availableSlots;
    governor.reportCost(1, 3_500); // three whole units beyond the request itself
    const after = governor.status().tiers[0]?.availableSlots;

    expect(before).toBe(3);
    expect(after).toBe(0);
  });

  it('reports bytes and the extra cost they caused', () => {
    const { governor } = makeGovernor({ costBytesPerUnit: 1_000 });
    governor.reportCost(1, 2_400);

    const tier = governor.status().tiers[0];
    expect(tier?.bytesLastHour).toBe(2_400);
    expect(tier?.costUnitsLastHour).toBe(2);
  });

  it('ignores a response too small to matter', () => {
    const { governor } = makeGovernor({ costBytesPerUnit: 1_000 });
    governor.reportCost(1, 999);
    expect(governor.status().tiers[0]?.availableSlots).toBe(3);
  });
});

describe('surviving a restart', () => {
  it('still refuses requests for a penalty learned before the restart', async () => {
    const clock = new FakeClock();
    let saved: unknown;
    const store = { load: () => saved as never, save: (snapshot: unknown) => { saved = snapshot; } };

    const first = makeGovernor({ store }, clock).governor;
    first.reportRateLimited(1, { retryAfterSeconds: 3_600 });

    // A fresh process, as after `fmcp stop && fmcp start`.
    const restarted = makeGovernor({ store }, clock).governor;
    const error = await rejection(restarted.acquire(1));

    // Refused locally: the point is that no request is thrown at Figma to be refused again.
    expect(error.details.source).toBe('figma');
    expect(restarted.status().tiers[0]?.blockedUntil).not.toBeNull();
  });

  it('starts clean when the penalty has expired in the meantime', async () => {
    const clock = new FakeClock();
    let saved: unknown;
    const store = { load: () => saved as never, save: (snapshot: unknown) => { saved = snapshot; } };

    makeGovernor({ store }, clock).governor.reportRateLimited(1, { retryAfterSeconds: 60 });
    clock.advance(61_000);

    const restarted = makeGovernor({ store }, clock).governor;
    await expect(restarted.acquire(1)).resolves.toBeUndefined();
  });
});
