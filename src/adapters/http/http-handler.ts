import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Zip, ZipPassThrough } from 'fflate';
import type { ApiKeyAuthenticator, Principal } from '../../core/security/api-keys.js';
import type { UrlSigner } from '../../core/security/url-signer.js';
import { isExportId, type ExportStorage } from '../../core/storage/export-storage.js';
import type { Logger } from '../../infra/logger.js';
import { handleAdminRoute, type AdminRouteDeps } from './admin-routes.js';
import { ADMIN_UI_HTML } from './admin-ui.js';
import { archiveResource, fileResource } from './download-links.js';
import type { SlidingWindowLimiter } from './sliding-window-limiter.js';

export interface HttpHandlerDeps {
  readonly authenticator: ApiKeyAuthenticator;
  readonly limiter: SlidingWindowLimiter;
  readonly signer: UrlSigner;
  readonly storage: ExportStorage;
  /** Builds the (stateless) MCP server that serves one authenticated request. */
  readonly createMcpServer: (principal: Principal) => McpServer;
  readonly logger: Logger;
  readonly allowedOrigins: readonly string[];
  readonly maxBodyBytes: number;
  readonly admin: AdminRouteDeps;
}

/** A failure with a known HTTP status; everything else becomes an opaque 500. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

const FILE_ROUTE = /^\/exports\/([a-f0-9]{32})\/files\/([^/]+)$/;
const ARCHIVE_ROUTE = /^\/exports\/([a-f0-9]{32})\/archive\.zip$/;

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null }, headers);
}

export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) {
      throw new HttpError(413, 'Request body too large.');
    }
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON.');
  }
}

export function createHttpHandler(deps: HttpHandlerDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const { logger } = deps;

  const authenticate = (req: IncomingMessage): Principal => {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    const principal = match?.[1] ? deps.authenticator.authenticate(match[1]) : undefined;
    if (!principal) {
      throw new HttpError(401, 'Missing or invalid API key.', { 'www-authenticate': 'Bearer realm="figma-mcp"' });
    }
    return principal;
  };

  const assertOrigin = (req: IncomingMessage): void => {
    const origin = req.headers.origin;
    // Non-browser MCP clients send no Origin. A browser that does must be explicitly trusted,
    // otherwise any web page could drive this server through a visitor's network position.
    if (origin !== undefined && !deps.allowedOrigins.includes(origin)) {
      throw new HttpError(403, 'Origin not allowed.');
    }
  };

  const handleMcp = async (req: IncomingMessage, res: ServerResponse): Promise<string | undefined> => {
    if (req.method !== 'POST') {
      // Stateless server: there are no sessions and no server-initiated streams to attach to.
      jsonRpcError(res, 405, -32000, 'Method not allowed.', { allow: 'POST' });
      return undefined;
    }
    assertOrigin(req);
    const principal = authenticate(req);

    const decision = deps.limiter.hit(principal.name);
    if (!decision.allowed) {
      throw new HttpError(429, 'Too many requests.', { 'retry-after': String(decision.retryAfterSeconds) });
    }

    const body = await readJsonBody(req, deps.maxBodyBytes);
    const server = deps.createMcpServer(principal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    return principal.name;
  };

  const verifySignedLink = (url: URL, resource: string): void => {
    const expiresAt = Number(url.searchParams.get('exp'));
    const signature = url.searchParams.get('sig') ?? '';
    if (!deps.signer.verify(resource, expiresAt, signature)) {
      // One generic answer for bad, tampered and expired links: do not help a guesser.
      throw new HttpError(403, 'Invalid or expired download link.');
    }
  };

  const handleFile = async (url: URL, res: ServerResponse, exportId: string, encodedName: string): Promise<void> => {
    let fileName: string;
    try {
      fileName = decodeURIComponent(encodedName);
    } catch {
      throw new HttpError(400, 'Malformed file name.');
    }
    verifySignedLink(url, fileResource(exportId, fileName));

    const file = await deps.storage.open(exportId, fileName);
    if (!file) {
      throw new HttpError(404, 'File not found (exports are deleted after their retention period).');
    }
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(fileName).toLowerCase()] ?? 'application/octet-stream',
      'content-length': String(file.bytes),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'cache-control': 'private, no-store',
    });
    await pipeline(file.stream, res);
  };

  const handleArchive = async (url: URL, res: ServerResponse, exportId: string): Promise<void> => {
    verifySignedLink(url, archiveResource(exportId));

    const files = await deps.storage.list(exportId);
    if (files.length === 0) {
      throw new HttpError(404, 'Export not found (exports are deleted after their retention period).');
    }

    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="figma-export-${exportId.slice(0, 8)}.zip"`,
      'cache-control': 'private, no-store',
      'x-accel-buffering': 'no',
    });

    // Images are already compressed, so entries are stored, not deflated.
    const zip = new Zip((error, chunk, final) => {
      if (error) {
        res.destroy(error);
        return;
      }
      res.write(chunk);
      if (final) res.end();
    });

    for (const { fileName } of files) {
      const opened = await deps.storage.open(exportId, fileName);
      if (!opened) continue;
      const entry = new ZipPassThrough(fileName);
      zip.add(entry);
      for await (const chunk of opened.stream) {
        if (res.writableNeedDrain) await once(res, 'drain');
        entry.push(chunk as Uint8Array);
      }
      entry.push(new Uint8Array(0), true);
    }
    zip.end();
  };

  const route = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<string | undefined> => {
    const path = url.pathname;

    if (path === '/healthz' && req.method === 'GET') {
      sendJson(res, 200, { status: 'ok' });
      return undefined;
    }
    if (path === '/mcp') {
      res.setHeader('cache-control', 'no-store');
      return handleMcp(req, res);
    }
    if (path === '/' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(ADMIN_UI_HTML);
      return undefined;
    }
    if (await handleAdminRoute(req, res, url, deps.admin)) {
      return undefined;
    }

    if (req.method === 'GET') {
      const file = FILE_ROUTE.exec(path);
      if (file?.[1] && file[2]) {
        await handleFile(url, res, file[1], file[2]);
        return undefined;
      }
      const archive = ARCHIVE_ROUTE.exec(path);
      if (archive?.[1] && isExportId(archive[1])) {
        await handleArchive(url, res, archive[1]);
        return undefined;
      }
    }
    throw new HttpError(404, 'Not found.');
  };

  return (req, res) => {
    const startedAt = Date.now();
    const url = new URL(req.url ?? '/', 'http://localhost');
    let principalName: string | undefined;

    res.setHeader('x-content-type-options', 'nosniff');
    res.on('finish', () => {
      logger.info('http', {
        method: req.method,
        // Query strings carry signatures; never log them.
        path: url.pathname,
        status: res.statusCode,
        ms: Date.now() - startedAt,
        ...(principalName ? { principal: principalName } : {}),
      });
    });

    route(req, res, url)
      .then((name) => {
        principalName = name;
      })
      .catch((error: unknown) => {
        if (res.headersSent) {
          // Mid-stream failure: the status line is gone, so the only honest signal is a cut connection.
          logger.error('response failed after headers were sent', { path: url.pathname, reason: String(error) });
          res.destroy();
          return;
        }
        if (error instanceof HttpError) {
          sendJson(res, error.status, { error: error.message }, error.headers);
          return;
        }
        logger.error('unhandled request error', {
          path: url.pathname,
          reason: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        sendJson(res, 500, { error: 'Internal server error.' });
      });
  };
}
