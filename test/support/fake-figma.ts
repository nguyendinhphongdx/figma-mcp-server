import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const FILE_KEY = 'FILEKEY0001';
export const FIGMA_TOKEN = 'figd_test_token_123';

export interface RecordedRequest {
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: IncomingMessage['headers'];
}

interface Scripted429 {
  readonly retryAfter: number;
  remaining: number;
}

function box(width: number, height: number, x = 0, y = 0) {
  return { x, y, width, height };
}

/** The fixture file: two pages of frames, one frame with a small layer tree. */
export const FIXTURE = {
  name: 'Mường Kho App',
  lastModified: '2026-09-18T10:00:00Z',
  version: '4242',
  editorType: 'figma',
  pages: [
    {
      id: '0:1',
      name: 'Onboarding',
      children: [
        { id: '1:1', name: 'Welcome', type: 'FRAME', absoluteBoundingBox: box(375, 812) },
        { id: '1:2', name: 'Đăng nhập', type: 'FRAME', absoluteBoundingBox: box(375, 812, 400, 0) },
        { id: '1:3', name: 'Sign up', type: 'FRAME', absoluteBoundingBox: box(375, 812, 800, 0) },
        { id: '1:9', name: 'Loose group', type: 'GROUP', absoluteBoundingBox: box(10, 10) },
      ],
    },
    {
      id: '0:2',
      name: 'Dashboard',
      children: [
        {
          id: '2:1',
          name: 'Home',
          type: 'FRAME',
          absoluteBoundingBox: box(1440, 900),
          // Nested on purpose: only a deep search can reach these.
          children: [
            {
              id: '2:10',
              name: 'Thanh điều hướng',
              type: 'FRAME',
              absoluteBoundingBox: box(1440, 64),
              children: [
                { id: '2:11', name: 'Nút Lưu', type: 'INSTANCE', absoluteBoundingBox: box(80, 32) },
                // Figma names a text layer after its content, so long names containing the query
                // are the common case, not the exception.
                { id: '2:12', name: 'Quay về Home để xem báo cáo', type: 'TEXT', absoluteBoundingBox: box(200, 20) },
              ],
            },
          ],
        },
        { id: '2:2', name: 'Settings', type: 'FRAME', absoluteBoundingBox: box(1440, 900, 1500, 0) },
        { id: '2:3', name: 'Reports', type: 'SECTION' },
      ],
    },
  ],
} as const;

const WELCOME_TREE = {
  id: '1:1',
  name: 'Welcome',
  type: 'FRAME',
  absoluteBoundingBox: box(375, 812),
  layoutMode: 'VERTICAL',
  itemSpacing: 16,
  paddingLeft: 24,
  paddingRight: 24,
  fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
  cornerRadius: 12,
  children: [
    {
      id: '1:10',
      name: 'Header',
      type: 'FRAME',
      absoluteBoundingBox: box(375, 88),
      children: [
        {
          id: '1:11',
          name: 'Title',
          type: 'TEXT',
          characters: 'Welcome back',
          absoluteBoundingBox: box(200, 32, 24, 40),
          style: { fontFamily: 'Inter', fontWeight: 700, fontSize: 28, lineHeightPx: 34, unrelatedField: 'x' },
          fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }],
        },
        { id: '1:12', name: 'Hidden badge', type: 'RECTANGLE', visible: false, absoluteBoundingBox: box(8, 8) },
      ],
    },
    { id: '1:13', name: 'CTA', type: 'INSTANCE', componentId: '3:1', absoluteBoundingBox: box(327, 48, 24, 700) },
  ],
};

const STYLE_NODES: Record<string, unknown> = {
  '9:1': { id: '9:1', name: 'Brand/Primary/500', type: 'RECTANGLE', fills: [{ type: 'SOLID', color: { r: 0.102, g: 0.4, b: 0.902, a: 1 } }] },
  '9:2': {
    id: '9:2',
    name: 'Heading/H1',
    type: 'TEXT',
    style: { fontFamily: 'Inter', fontWeight: 700, fontSize: 32, lineHeightPx: 40, letterSpacing: -0.5 },
  },
  '9:3': {
    id: '9:3',
    name: 'Shadow/Card',
    type: 'RECTANGLE',
    effects: [{ type: 'DROP_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, radius: 8, spread: 0 }],
  },
};

const STYLES = [
  { key: 's1', name: 'Brand/Primary/500', style_type: 'FILL', node_id: '9:1', description: 'Primary brand colour' },
  { key: 's2', name: 'Heading/H1', style_type: 'TEXT', node_id: '9:2' },
  { key: 's3', name: 'Shadow/Card', style_type: 'EFFECT', node_id: '9:3' },
  { key: 's4', name: 'Layout/12 col', style_type: 'GRID', node_id: '9:4' },
];

const COMPONENTS = [
  {
    key: 'c1',
    name: 'Button/Primary',
    node_id: '3:1',
    description: 'Main call to action',
    containing_frame: { name: 'Buttons', nodeId: '3:0', pageName: 'Components' },
  },
  { key: 'c2', name: 'Input/Text', node_id: '3:2', containing_frame: { name: 'Inputs', pageName: 'Components' } },
];

const COMMENTS = [
  { id: 'k1', message: 'Can we shorten this title?', created_at: '2026-09-17T08:00:00Z', resolved_at: null, user: { id: 'u1', handle: 'linh' }, client_meta: { node_id: '1:2', node_offset: { x: 1, y: 1 } } },
  { id: 'k2', message: 'Done, see v2', created_at: '2026-09-17T09:00:00Z', parent_id: 'k1', user: { id: 'u2', handle: 'phong' } },
  { id: 'k3', message: 'Old feedback', created_at: '2026-09-10T08:00:00Z', resolved_at: '2026-09-11T08:00:00Z', user: { id: 'u1', handle: 'linh' }, client_meta: { node_id: '2:1' } },
];

/** In-process stand-in for the Figma REST API and its image CDN. */
export class FakeFigma {
  readonly requests: RecordedRequest[] = [];
  /** Node ids the image endpoint refuses to render. */
  readonly unrenderable = new Set<string>();
  /** CDN answers this HTTP status for image files whose name matches (e.g. `1:2.jpg`). */
  readonly cdnStatus = new Map<string, number>();
  private readonly scripted = new Map<string, Scripted429>();
  private server!: Server;
  baseUrl = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  reset(): void {
    this.requests.length = 0;
    this.unrenderable.clear();
    this.cdnStatus.clear();
    this.scripted.clear();
  }

  /** Answer the next `times` requests whose path starts with `prefix` with 429. */
  script429(prefix: string, retryAfter: number, times = 1): void {
    this.scripted.set(prefix, { retryAfter, remaining: times });
  }

  /** Requests to `/v1/...` whose path starts with `prefix`. */
  api(prefix = '/v1/'): RecordedRequest[] {
    return this.requests.filter((request) => request.path.startsWith(prefix));
  }

  cdn(): RecordedRequest[] {
    return this.requests.filter((request) => request.path.startsWith('/img/'));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', this.baseUrl);
    this.requests.push({ path: url.pathname, query: url.searchParams, headers: req.headers });

    if (url.pathname.startsWith('/img/')) {
      const name = decodeURIComponent(url.pathname.slice('/img/'.length));
      const status = this.cdnStatus.get(name);
      if (status) {
        res.writeHead(status);
        res.end();
        return;
      }
      if (name.endsWith('.svg')) {
        res.writeHead(200, { 'content-type': 'image/svg+xml' });
        // `1:3` stands in for an illustration too large to inline; everything else is a small icon.
        const body = name.startsWith('1:3')
          ? `<svg viewBox="0 0 16 16">${'<path d="M2 8h12"/>'.repeat(200)}</svg>`
          : '<svg width="16" height="16" viewBox="0 0 16 16">\n  <path d="M2 8h12" stroke="#000"/>\n</svg>';
        res.end(`<?xml version="1.0"?>\n${body}`);
        return;
      }
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end(`IMG:${name}`);
      return;
    }

    if (req.headers['x-figma-token'] !== FIGMA_TOKEN) {
      return this.json(res, 403, { status: 403, err: 'Invalid token' });
    }

    for (const [prefix, script] of this.scripted) {
      if (url.pathname.startsWith(prefix) && script.remaining > 0) {
        script.remaining -= 1;
        res.writeHead(429, {
          'retry-after': String(script.retryAfter),
          'x-figma-plan-tier': 'pro',
          'x-figma-rate-limit-type': 'low',
          'x-figma-upgrade-link': 'https://www.figma.com/pricing',
        });
        res.end();
        return;
      }
    }

    const base = `/v1/files/${FILE_KEY}`;
    const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
    const meta = { name: FIXTURE.name, lastModified: FIXTURE.lastModified, version: FIXTURE.version, editorType: FIXTURE.editorType };

    if (url.pathname === base) {
      return this.json(res, 200, {
        ...meta,
        document: { id: '0:0', name: 'Document', type: 'DOCUMENT', children: FIXTURE.pages },
      });
    }
    if (url.pathname === `${base}/nodes`) {
      const nodes = Object.fromEntries(
        ids.map((id) => [id, this.nodeFor(id)]),
      );
      return this.json(res, 200, { ...meta, nodes });
    }
    if (url.pathname === `/v1/images/${FILE_KEY}`) {
      const images = Object.fromEntries(
        ids.map((id) => [
          id,
          this.unrenderable.has(id)
            ? null
            : `${this.baseUrl}/img/${encodeURIComponent(`${id}.${url.searchParams.get('format')}`)}`,
        ]),
      );
      return this.json(res, 200, { err: null, images });
    }
    if (url.pathname === `${base}/comments`) return this.json(res, 200, { comments: COMMENTS });
    if (url.pathname === `${base}/styles`) return this.json(res, 200, { status: 200, error: false, meta: { styles: STYLES } });
    if (url.pathname === `${base}/components`) return this.json(res, 200, { status: 200, error: false, meta: { components: COMPONENTS } });
    if (url.pathname === `${base}/component_sets`) return this.json(res, 200, { status: 200, error: false, meta: { component_sets: [] } });

    this.json(res, 404, { status: 404, err: 'Not found' });
  }

  private nodeFor(id: string): { document: unknown } | null {
    if (id === '1:1') return { document: WELCOME_TREE };
    if (STYLE_NODES[id]) return { document: STYLE_NODES[id] };
    for (const page of FIXTURE.pages) {
      const found = page.children.find((child) => child.id === id);
      if (found) return { document: found };
    }
    return null;
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}
