import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AdminStore } from '../../core/admin/admin-store.js';
import type { SessionStore } from '../../core/admin/sessions.js';
import type { Logger } from '../../infra/logger.js';
import { HttpError, readJsonBody, sendJson } from './http-handler.js';
import type { SlidingWindowLimiter } from './sliding-window-limiter.js';

export interface AdminRouteDeps {
  readonly store: AdminStore;
  readonly sessions: SessionStore;
  readonly loginLimiter: SlidingWindowLimiter;
  readonly secureCookies: boolean;
  /** The same view `figma_quota_status` gives a model, for the humans who share the budget. */
  readonly quota: { execute(): unknown };
  readonly logger: Logger;
}

const SESSION_COOKIE = 'fmcp_admin';
const ADMIN_MAX_BODY_BYTES = 8 * 1024;
const NAME_PATTERN = /^[a-z0-9._-]+$/i;
const USERS_ROUTE = /^\/api\/admin\/users\/([^/]+)$/;

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    cookies[part.slice(0, separator).trim()] = decodeURIComponent(part.slice(separator + 1).trim());
  }
  return cookies;
}

function setSessionCookie(res: ServerResponse, token: string, secure: boolean): void {
  const attrs = [`${SESSION_COOKIE}=${token}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=43200'];
  if (secure) attrs.push('Secure');
  res.setHeader('set-cookie', attrs.join('; '));
}

function clearSessionCookie(res: ServerResponse, secure: boolean): void {
  const attrs = [`${SESSION_COOKIE}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  res.setHeader('set-cookie', attrs.join('; '));
}

/** Same-origin check for the Admin UI/API. Distinct from the MCP `ALLOWED_ORIGINS`
 * allow-list (meant for third-party pages), since this UI is served by this same server. */
function assertSameOrigin(req: IncomingMessage): void {
  const origin = req.headers.origin;
  if (origin === undefined) return;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, 'Invalid Origin.');
  }
  if (originHost !== req.headers.host) {
    throw new HttpError(403, 'Cross-origin admin request rejected.');
  }
}

function requireSession(req: IncomingMessage, deps: AdminRouteDeps): string {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const username = deps.sessions.verify(token);
  if (!username) {
    throw new HttpError(401, 'Not logged in.');
  }
  return username;
}

function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

interface SetupBody {
  readonly username?: unknown;
  readonly password?: unknown;
}

function assertCredentials(body: unknown): { username: string; password: string } {
  const { username, password } = (body ?? {}) as SetupBody;
  if (typeof username !== 'string' || !NAME_PATTERN.test(username)) {
    throw new HttpError(400, 'username must contain only letters, digits, . _ -');
  }
  if (typeof password !== 'string' || password.length < 8) {
    throw new HttpError(400, 'password must be at least 8 characters.');
  }
  return { username, password };
}

/** Handles `/api/admin/*`. Returns `false` if the path isn't one of these routes (caller falls
 * through to its own 404), so this can be dropped into the existing router with one call. */
export async function handleAdminRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: AdminRouteDeps,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/admin/')) return false;

  assertSameOrigin(req);

  if (path === '/api/admin/session' && req.method === 'GET') {
    const username = deps.sessions.verify(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    sendJson(res, 200, { needsSetup: !deps.store.hasAdmin(), loggedIn: username !== undefined, username });
    return true;
  }

  if (path === '/api/admin/setup' && req.method === 'POST') {
    if (deps.store.hasAdmin()) {
      throw new HttpError(409, 'Admin is already configured.');
    }
    const { username, password } = assertCredentials(await readJsonBody(req, ADMIN_MAX_BODY_BYTES));
    deps.store.setupAdmin(username, password);
    setSessionCookie(res, deps.sessions.create(username), deps.secureCookies);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (path === '/api/admin/login' && req.method === 'POST') {
    const decision = deps.loginLimiter.hit(clientIp(req));
    if (!decision.allowed) {
      throw new HttpError(429, 'Too many login attempts.', { 'retry-after': String(decision.retryAfterSeconds) });
    }
    const { username, password } = assertCredentials(await readJsonBody(req, ADMIN_MAX_BODY_BYTES));
    if (!deps.store.verifyAdmin(username, password)) {
      throw new HttpError(401, 'Invalid username or password.');
    }
    setSessionCookie(res, deps.sessions.create(username), deps.secureCookies);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (path === '/api/admin/logout' && req.method === 'POST') {
    deps.sessions.destroy(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    clearSessionCookie(res, deps.secureCookies);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (path === '/api/admin/config' && req.method === 'GET') {
    requireSession(req, deps);
    const token = deps.store.getFigmaToken();
    sendJson(res, 200, {
      figmaTokenConfigured: token !== '',
      figmaTokenPreview: token ? `...${token.slice(-4)}` : null,
    });
    return true;
  }

  if (path === '/api/admin/config' && req.method === 'PUT') {
    const admin = requireSession(req, deps);
    const { figmaToken } = (await readJsonBody(req, ADMIN_MAX_BODY_BYTES)) as { figmaToken?: unknown };
    if (typeof figmaToken !== 'string' || figmaToken.length < 10) {
      throw new HttpError(400, 'figmaToken looks too short.');
    }
    deps.store.setFigmaToken(figmaToken);
    deps.logger.info('admin updated Figma token', { admin });
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (path === '/api/admin/quota' && req.method === 'GET') {
    requireSession(req, deps);
    // Reading the budget costs nothing and touches no Figma endpoint, so polling it is safe.
    sendJson(res, 200, deps.quota.execute());
    return true;
  }

  if (path === '/api/admin/users' && req.method === 'GET') {
    requireSession(req, deps);
    sendJson(res, 200, { users: deps.store.listUsers() });
    return true;
  }

  if (path === '/api/admin/users' && req.method === 'POST') {
    const admin = requireSession(req, deps);
    const { name } = (await readJsonBody(req, ADMIN_MAX_BODY_BYTES)) as { name?: unknown };
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
      throw new HttpError(400, 'name must contain only letters, digits, . _ -');
    }
    const added = deps.store.addUser(name);
    deps.logger.info('admin created API key', { admin, user: name });
    sendJson(res, 200, added);
    return true;
  }

  const userMatch = req.method === 'DELETE' ? USERS_ROUTE.exec(path) : null;
  if (userMatch?.[1]) {
    const admin = requireSession(req, deps);
    const name = decodeURIComponent(userMatch[1]);
    const removed = deps.store.removeUser(name);
    if (!removed) {
      throw new HttpError(404, 'No such user.');
    }
    deps.logger.info('admin revoked API key', { admin, user: name });
    sendJson(res, 200, { ok: true });
    return true;
  }

  throw new HttpError(404, 'Not found.');
}
