import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FILE_KEY, FakeFigma } from '../support/fake-figma.js';
import { startTestApp, type TestApp } from '../support/test-app.js';

const figma = new FakeFigma();
let app: TestApp;

beforeAll(() => figma.start());
afterAll(() => figma.stop());
beforeEach(async () => {
  figma.reset();
  app = await startTestApp(figma);
});
afterEach(() => app.stop());

describe('Figma rate limits', () => {
  it('waits out a short Retry-After and succeeds without bothering the caller', async () => {
    figma.script429('/v1/images/', 0, 1);
    const client = await app.connect();

    const { isError, data } = await app.call(client, 'figma_export_frames', { file: FILE_KEY, nodes: ['1:1'], useLayerNames: false });

    expect(isError).toBe(false);
    expect(data.status).toBe('complete');
    expect(figma.api('/v1/images/')).toHaveLength(2);
  });

  it('opens a circuit on a long Retry-After: partial result, then fail-fast for everyone, per tier', async () => {
    figma.script429('/v1/images/', 432_000, 1);
    const alice = await app.connect();

    // 1. The export is cut short and says exactly why and until when.
    const exported = await app.call(alice, 'figma_export_frames', { file: FILE_KEY, nodes: ['1:1', '1:2'], useLayerNames: false });
    expect(exported.isError).toBe(false);
    expect(exported.data.status).toBe('failed');
    expect(exported.data.rateLimited).toMatchObject({
      tier: 1,
      source: 'figma',
      retryAfterSeconds: 432_000,
      planTier: 'pro',
      limitType: 'low',
      upgradeLink: 'https://www.figma.com/pricing',
    });
    expect(figma.cdn()).toHaveLength(0);

    // 2. Another user asking for Tier 1 data is refused locally: Figma is not contacted again.
    figma.requests.length = 0;
    const bob = await app.connect('fmcp_test-key-for-bob');
    const refused = await app.call(bob, 'figma_list_frames', { file: FILE_KEY });
    expect(refused.isError).toBe(true);
    expect(refused.data.error).toMatchObject({ code: 'RATE_LIMITED', tier: 1, source: 'figma' });
    expect(refused.data.error.retryAfterSeconds).toBeGreaterThan(400_000);
    expect(refused.data.error.hint).toContain('figma_quota_status');
    expect(figma.api()).toHaveLength(0);

    // 3. Other tiers are unaffected.
    const comments = await app.call(alice, 'figma_get_comments', { file: FILE_KEY });
    expect(comments.isError).toBe(false);

    // 4. Cached data keeps working while the circuit is open.
    const cachedOk = await app.call(alice, 'figma_get_comments', { file: FILE_KEY });
    expect(cachedOk.data.meta.cached).toBe(true);
  });

  it('reports the shared budget through figma_quota_status', async () => {
    figma.script429('/v1/images/', 432_000, 1);
    const client = await app.connect();
    await app.call(client, 'figma_list_frames', { file: FILE_KEY }); // 1 Tier-1 request
    await app.call(client, 'figma_get_comments', { file: FILE_KEY }); // 1 Tier-2 request
    await app.call(client, 'figma_export_frames', { file: FILE_KEY, nodes: ['1:1'], useLayerNames: false }); // trips Tier 1

    const { data } = await app.call(client, 'figma_quota_status');

    const tier = (n: number) => data.tiers.find((t: { tier: number }) => t.tier === n);
    expect(tier(1)).toMatchObject({ requestsLastHour: 2, rateLimitedLast24h: 1, retryAfterSeconds: expect.any(Number) });
    expect(tier(1).blockedUntil).not.toBeNull();
    expect(tier(1).lastRateLimited).toMatchObject({ planTier: 'pro', limitType: 'low', retryAfterSeconds: 432_000 });
    expect(tier(2)).toMatchObject({ requestsLastHour: 1, blockedUntil: null });
    expect(tier(3)).toMatchObject({ requestsLastHour: 0, blockedUntil: null });
    expect(data.cache.hits + data.cache.misses).toBeGreaterThan(0);
    expect(data.guidance.length).toBeGreaterThan(0);
  });

  it('refuses locally, without contacting Figma, when the configured pace would exceed the queue limit', async () => {
    await app.stop();
    app = await startTestApp(figma, { env: { FIGMA_TIER1_RPM: '1', FIGMA_MAX_QUEUE_WAIT_SECONDS: '1' } });
    const client = await app.connect();

    const first = await app.call(client, 'figma_list_frames', { file: FILE_KEY });
    expect(first.isError).toBe(false);

    const second = await app.call(client, 'figma_get_node_tree', { file: FILE_KEY, ids: ['1:1'] });
    expect(second.isError).toBe(true);
    expect(second.data.error).toMatchObject({ code: 'RATE_LIMITED', source: 'local', tier: 1 });
    expect(figma.api()).toHaveLength(1);
  });
});
