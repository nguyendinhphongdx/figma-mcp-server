import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FIGMA_TOKEN, FILE_KEY, FakeFigma } from '../support/fake-figma.js';
import { startTestApp, type TestApp } from '../support/test-app.js';

const figma = new FakeFigma();
let app: TestApp;

beforeAll(() => figma.start());
afterAll(() => figma.stop());
beforeEach(() => figma.reset());
afterEach(() => app.stop());

function extractCookie(response: Response): string {
  const setCookie = response.headers.get('set-cookie') ?? '';
  return setCookie.split(';')[0] ?? '';
}

async function startWithoutSeed(): Promise<TestApp> {
  return startTestApp(figma, { env: { FIGMA_TOKEN: '', MCP_API_KEYS: '' } });
}

describe('Admin UI/API', () => {
  it('serves the admin page at / without authentication', async () => {
    app = await startWithoutSeed();
    const response = await fetch(`${app.baseUrl}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
  });

  it('reports needsSetup until an admin account exists', async () => {
    app = await startWithoutSeed();
    const before = await (await fetch(`${app.baseUrl}/api/admin/session`)).json();
    expect(before).toEqual({ needsSetup: true, loggedIn: false, username: undefined });

    const setup = await fetch(`${app.baseUrl}/api/admin/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: 'a-strong-password' }),
    });
    expect(setup.status).toBe(200);

    const after = await (await fetch(`${app.baseUrl}/api/admin/session`)).json();
    expect(after).toEqual({ needsSetup: false, loggedIn: false, username: undefined });
  });

  it('refuses a second setup once an admin exists', async () => {
    app = await startWithoutSeed();
    const first = { username: 'root', password: 'a-strong-password' };
    await fetch(`${app.baseUrl}/api/admin/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(first),
    });
    const second = await fetch(`${app.baseUrl}/api/admin/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'someone-else', password: 'another-password' }),
    });
    expect(second.status).toBe(409);
  });

  it('rejects admin API calls without a session', async () => {
    app = await startWithoutSeed();
    expect((await fetch(`${app.baseUrl}/api/admin/users`)).status).toBe(401);
    expect(
      (
        await fetch(`${app.baseUrl}/api/admin/config`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ figmaToken: 'figd_x' }),
        })
      ).status,
    ).toBe(401);
  });

  it('lets a logged-in admin configure the Figma token and manage users, applying both without restart', async () => {
    app = await startWithoutSeed();

    const setup = await fetch(`${app.baseUrl}/api/admin/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: 'a-strong-password' }),
    });
    const cookie = extractCookie(setup);
    expect(cookie).toContain('fmcp_admin=');

    const created = await fetch(`${app.baseUrl}/api/admin/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'alice' }),
    });
    expect(created.status).toBe(200);
    const { key } = (await created.json()) as { key: string };
    expect(key.startsWith('fmcp_')).toBe(true);

    // The freshly created key authenticates immediately, but the tool call fails: no Figma token yet.
    const client = await app.connect(key);
    const noToken = await app.call(client, 'figma_list_frames', { file: FILE_KEY });
    expect(noToken.isError).toBe(true);
    expect(noToken.data.error.code).toBe('AUTH');

    // Setting the token through the Admin API applies immediately, no restart.
    const updated = await fetch(`${app.baseUrl}/api/admin/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ figmaToken: FIGMA_TOKEN }),
    });
    expect(updated.status).toBe(200);

    const afterToken = await app.call(client, 'figma_list_frames', { file: FILE_KEY });
    expect(afterToken.isError).toBe(false);

    // Revoking the user takes effect immediately too.
    const removed = await fetch(`${app.baseUrl}/api/admin/users/alice`, { method: 'DELETE', headers: { cookie } });
    expect(removed.status).toBe(200);

    const revokedClient = await app.connect(key).catch(() => undefined);
    expect(revokedClient).toBeUndefined();
  });

  it('rejects a cross-origin admin request', async () => {
    app = await startWithoutSeed();
    const response = await fetch(`${app.baseUrl}/api/admin/session`, { headers: { origin: 'https://evil.example' } });
    expect(response.status).toBe(403);
  });

  it('rate-limits repeated failed logins', async () => {
    app = await startWithoutSeed();
    await fetch(`${app.baseUrl}/api/admin/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: 'a-strong-password' }),
    });

    let lastStatus = 0;
    for (let i = 0; i < 11; i += 1) {
      const response = await fetch(`${app.baseUrl}/api/admin/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'root', password: 'wrong' }),
      });
      lastStatus = response.status;
    }
    expect(lastStatus).toBe(429);
  });
});
