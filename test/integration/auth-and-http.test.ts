import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeFigma } from '../support/fake-figma.js';
import { TEST_API_KEY, startTestApp, type TestApp } from '../support/test-app.js';

const figma = new FakeFigma();
let app: TestApp;

beforeAll(() => figma.start());
afterAll(() => figma.stop());
beforeEach(async () => {
  figma.reset();
  app = await startTestApp(figma);
});
afterEach(() => app.stop());

const initializeBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } },
});

function post(headers: Record<string, string> = {}, body = initializeBody) {
  return fetch(`${app.baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body,
  });
}

describe('HTTP surface', () => {
  it('serves /healthz without authentication', async () => {
    const response = await fetch(`${app.baseUrl}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('rejects /mcp without an API key', async () => {
    const response = await post();
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('rejects a wrong API key', async () => {
    expect((await post({ authorization: 'Bearer fmcp_wrong' })).status).toBe(401);
    expect((await post({ authorization: 'Basic abc' })).status).toBe(401);
  });

  it('accepts a valid API key', async () => {
    const response = await post({ authorization: `Bearer ${TEST_API_KEY}` });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe('figma-mcp-server');
  });

  it('refuses browser origins that are not allow-listed (DNS-rebinding defence)', async () => {
    const response = await post({ authorization: `Bearer ${TEST_API_KEY}`, origin: 'https://evil.example' });
    expect(response.status).toBe(403);
  });

  it('answers 405 to GET and DELETE on /mcp because the server is stateless', async () => {
    for (const method of ['GET', 'DELETE']) {
      const response = await fetch(`${app.baseUrl}/mcp`, { method, headers: { authorization: `Bearer ${TEST_API_KEY}` } });
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
    }
  });

  it('returns 400 for a body that is not JSON and 413 for an oversized one', async () => {
    const headers = { authorization: `Bearer ${TEST_API_KEY}` };
    expect((await post(headers, '{not json')).status).toBe(400);

    const huge = JSON.stringify({ pad: 'x'.repeat(app.config.server.maxRequestBodyBytes + 10) });
    expect((await post(headers, huge)).status).toBe(413);
  });

  it('returns 404 JSON for unknown routes', async () => {
    const response = await fetch(`${app.baseUrl}/nope`);
    expect(response.status).toBe(404);
  });

  it('throttles a single user without affecting others', async () => {
    await app.stop();
    app = await startTestApp(figma, { env: { REQUESTS_PER_MINUTE_PER_USER: '3' } });
    const alice = { authorization: `Bearer ${TEST_API_KEY}` };

    const statuses = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await post(alice)).status);
    expect(statuses).toEqual([200, 200, 200, 429]);

    const limited = await post(alice);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);

    const bob = await post({ authorization: 'Bearer fmcp_test-key-for-bob' });
    expect(bob.status).toBe(200);
  });
});

describe('MCP protocol', () => {
  it('lists the tools with cost-aware descriptions and correct read-only hints', async () => {
    const client = await app.connect();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    expect([...byName.keys()].sort()).toEqual([
      'figma_export_frames',
      'figma_get_comments',
      'figma_get_design_tokens',
      'figma_get_node_spec',
      'figma_get_node_tree',
      'figma_get_svg',
      'figma_list_components',
      'figma_list_frames',
      'figma_list_styles',
      'figma_quota_status',
      'figma_search_nodes',
    ]);
    expect(byName.get('figma_list_frames')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('figma_export_frames')?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get('figma_export_frames')?.description).toContain('ONE call');
  });

  it('rejects invalid arguments at the protocol level', async () => {
    const client = await app.connect();
    const result = await client.callTool({ name: 'figma_list_frames', arguments: {} });
    expect(result.isError).toBe(true);
  });
});
