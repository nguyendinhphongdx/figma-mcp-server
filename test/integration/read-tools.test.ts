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

const file = `https://www.figma.com/design/${FILE_KEY}/Muong-Kho?node-id=1-1`;

describe('figma_list_frames', () => {
  it('lists pages and top-level frames, hiding non-frame nodes by default', async () => {
    const client = await app.connect();
    const { isError, data } = await app.call(client, 'figma_list_frames', { file });

    expect(isError).toBe(false);
    expect(data.file).toMatchObject({ key: FILE_KEY, name: 'Mường Kho App', version: '4242' });
    expect(data.pages.map((page: { name: string }) => page.name)).toEqual(['Onboarding', 'Dashboard']);
    const onboarding = data.pages[0].nodes;
    expect(onboarding.map((node: { id: string }) => node.id)).toEqual(['1:1', '1:2', '1:3']);
    expect(onboarding[0]).toEqual({ id: '1:1', name: 'Welcome', type: 'FRAME', width: 375, height: 812 });
    expect(data.totalNodes).toBe(6); // 3 + 2 frames + 1 section
    expect(data.meta.cached).toBe(false);
  });

  it('filters by page name and node type', async () => {
    const client = await app.connect();
    const { data } = await app.call(client, 'figma_list_frames', { file: FILE_KEY, page: 'dash', types: ['SECTION'] });
    expect(data.pages).toHaveLength(1);
    expect(data.pages[0].nodes.map((node: { id: string }) => node.id)).toEqual(['2:3']);
  });

  it('spends one Figma request the first time and none afterwards', async () => {
    const client = await app.connect();
    await app.call(client, 'figma_list_frames', { file: FILE_KEY });
    const second = await app.call(client, 'figma_list_frames', { file: FILE_KEY });

    expect(figma.api('/v1/files/')).toHaveLength(1);
    expect(second.data.meta.cached).toBe(true);
  });

  it('bypasses the cache with refresh', async () => {
    const client = await app.connect();
    await app.call(client, 'figma_list_frames', { file: FILE_KEY });
    await app.call(client, 'figma_list_frames', { file: FILE_KEY, refresh: true });
    expect(figma.api('/v1/files/')).toHaveLength(2);
  });

  it('shares one upstream request between concurrent callers (single flight)', async () => {
    const clients = await Promise.all([app.connect(), app.connect(), app.connect()]);
    const results = await Promise.all(clients.map((client) => app.call(client, 'figma_list_frames', { file: FILE_KEY })));

    expect(results.every((result) => !result.isError)).toBe(true);
    expect(figma.api('/v1/files/')).toHaveLength(1);
  });

  it('asks Figma for depth=2 only', async () => {
    const client = await app.connect();
    await app.call(client, 'figma_list_frames', { file: FILE_KEY });
    expect(figma.api('/v1/files/')[0]?.query.get('depth')).toBe('2');
  });

  it('answers unknown files with a NOT_FOUND error, not a crash', async () => {
    const client = await app.connect();
    const { isError, data } = await app.call(client, 'figma_list_frames', { file: 'DOESNOTEXIST1' });
    expect(isError).toBe(true);
    expect(data.error.code).toBe('NOT_FOUND');
  });

  it('rejects input that is not a file at all', async () => {
    const client = await app.connect();
    const { isError, data } = await app.call(client, 'figma_list_frames', { file: 'no' });
    expect(isError).toBe(true);
    expect(data.error.code).toBe('INVALID_INPUT');
  });

  it('refuses files outside FIGMA_ALLOWED_FILE_KEYS', async () => {
    await app.stop();
    app = await startTestApp(figma, { env: { FIGMA_ALLOWED_FILE_KEYS: 'SOMEOTHERFILE1' } });
    const client = await app.connect();

    const { isError, data } = await app.call(client, 'figma_list_frames', { file: FILE_KEY });

    expect(isError).toBe(true);
    expect(data.error.code).toBe('FORBIDDEN_FILE');
    expect(figma.api()).toHaveLength(0);
  });
});

describe('figma_get_node_tree', () => {
  it('returns a trimmed tree from a frame link, without needing `file`', async () => {
    const client = await app.connect();
    const { isError, data } = await app.call(client, 'figma_get_node_tree', { ids: [file], depth: 3 });

    expect(isError).toBe(false);
    const root = data.nodes['1:1'];
    expect(root).toMatchObject({ id: '1:1', name: 'Welcome', type: 'FRAME', bounds: { width: 375, height: 812 } });
    const [header, cta] = root.children;
    expect(header.children[0]).toMatchObject({ id: '1:11', type: 'TEXT', text: 'Welcome back' });
    expect(header.children[1]).toMatchObject({ id: '1:12', visible: false });
    expect(cta).toMatchObject({ type: 'INSTANCE', componentId: '3:1' });
    // Trimmed: raw geometry/unknown fields are not passed through.
    expect(JSON.stringify(data)).not.toContain('unrelatedField');
    expect(root.layout).toBeUndefined();
  });

  it('adds layout, style and font details only when asked', async () => {
    const client = await app.connect();
    const { data } = await app.call(client, 'figma_get_node_tree', {
      file: FILE_KEY,
      ids: ['1:1'],
      depth: 3,
      include: ['layout', 'style', 'text'],
    });

    const root = data.nodes['1:1'];
    expect(root.layout).toMatchObject({ layoutMode: 'VERTICAL', itemSpacing: 16, paddingLeft: 24 });
    expect(root.style).toMatchObject({ fills: [{ type: 'SOLID', color: '#ffffff' }], cornerRadius: 12 });
    expect(root.children[0].children[0].font).toEqual({ fontFamily: 'Inter', fontWeight: 700, fontSize: 28, lineHeightPx: 34 });
  });

  it('respects depth and marks nodes that have hidden children', async () => {
    const client = await app.connect();
    const { data } = await app.call(client, 'figma_get_node_tree', { file: FILE_KEY, ids: ['1:1'], depth: 1 });

    const header = data.nodes['1:1'].children[0];
    expect(header.id).toBe('1:10');
    expect(header.children).toEqual([]); // exists, but was not expanded
    expect(figma.api('/v1/files/')[0]?.query.get('depth')).toBe('1');
  });

  it('truncates at maxNodes and says so', async () => {
    const client = await app.connect();
    const { data } = await app.call(client, 'figma_get_node_tree', { file: FILE_KEY, ids: ['1:1'], depth: 5, maxNodes: 2 });
    expect(data.truncated).toBe(true);
  });

  it('reports missing nodes as null and batches ids into one request', async () => {
    const client = await app.connect();
    const { data } = await app.call(client, 'figma_get_node_tree', { file: FILE_KEY, ids: ['1:1', '1-2', '77:77'] });

    expect(data.nodes['1:2']).toMatchObject({ name: 'Đăng nhập' });
    expect(data.nodes['77:77']).toBeNull();
    expect(figma.api('/v1/files/')).toHaveLength(1);
    expect(figma.api('/v1/files/')[0]?.query.get('ids')).toBe('1:1,1:2,77:77');
  });

  it('serves a different `include` from the same cached request', async () => {
    const client = await app.connect();
    await app.call(client, 'figma_get_node_tree', { file: FILE_KEY, ids: ['1:1'] });
    await app.call(client, 'figma_get_node_tree', { file: FILE_KEY, ids: ['1:1'], include: ['style'] });
    expect(figma.api('/v1/files/')).toHaveLength(1);
  });

  it('rejects links to two different files', async () => {
    const client = await app.connect();
    const { isError, data } = await app.call(client, 'figma_get_node_tree', {
      ids: [`https://www.figma.com/design/${FILE_KEY}/A?node-id=1-1`, 'https://www.figma.com/design/OTHERFILE0001/B?node-id=1-1'],
    });
    expect(isError).toBe(true);
    expect(data.error.code).toBe('INVALID_INPUT');
  });
});

describe('library tools', () => {
  it('lists styles, filtered by type and query', async () => {
    const client = await app.connect();
    const all = await app.call(client, 'figma_list_styles', { file: FILE_KEY });
    expect(all.data.total).toBe(4);

    const fills = await app.call(client, 'figma_list_styles', { file: FILE_KEY, styleType: 'FILL' });
    expect(fills.data.items).toEqual([
      { key: 's1', name: 'Brand/Primary/500', nodeId: '9:1', description: 'Primary brand colour', styleType: 'FILL' },
    ]);

    const searched = await app.call(client, 'figma_list_styles', { file: FILE_KEY, query: 'shadow' });
    expect(searched.data.items.map((item: { name: string }) => item.name)).toEqual(['Shadow/Card']);
    expect(figma.api('/v1/files/')).toHaveLength(1); // one styles request, reused
  });

  it('lists components with where they live', async () => {
    const client = await app.connect();
    const { data } = await app.call(client, 'figma_list_components', { file: FILE_KEY, query: 'button' });
    expect(data.items).toEqual([
      { key: 'c1', name: 'Button/Primary', nodeId: '3:1', description: 'Main call to action', page: 'Components', frame: 'Buttons' },
    ]);
  });

  it('honours limit and reports truncation', async () => {
    const client = await app.connect();
    const { data } = await app.call(client, 'figma_list_styles', { file: FILE_KEY, limit: 1 });
    expect(data.items).toHaveLength(1);
    expect(data.truncated).toBe(true);
    expect(data.total).toBe(4);
  });
});

describe('figma_get_design_tokens', () => {
  it('builds colour, typography and shadow tokens from published styles', async () => {
    const client = await app.connect();
    const { isError, data } = await app.call(client, 'figma_get_design_tokens', { file: FILE_KEY });

    expect(isError).toBe(false);
    expect(data.tokens.colors).toEqual([
      { name: 'Brand/Primary/500', path: ['Brand', 'Primary', '500'], description: 'Primary brand colour', value: [{ type: 'SOLID', color: '#1a66e6' }] },
    ]);
    expect(data.tokens.typography[0].value).toEqual({ fontFamily: 'Inter', fontWeight: 700, fontSize: 32, lineHeightPx: 40, letterSpacing: -0.5 });
    expect(data.tokens.effects[0].value).toEqual([{ type: 'DROP_SHADOW', color: '#00000040', offset: { x: 0, y: 4 }, radius: 8, spread: 0 }]);
    expect(data.notes.join(' ')).toContain('Variables');
  });

  it('renders CSS custom properties on request', async () => {
    const client = await app.connect();
    const { data } = await app.call(client, 'figma_get_design_tokens', { file: FILE_KEY, format: 'css' });

    expect(data.css).toContain(':root {');
    expect(data.css).toContain('--color-brand-primary-500: #1a66e6;');
    expect(data.css).toContain('--font-heading-h1-family: "Inter";');
    expect(data.css).toContain('--font-heading-h1-size: 32px;');
    expect(data.css).toContain('--font-heading-h1-line-height: 40px;');
    expect(data.css).toContain('--shadow-shadow-card: 0px 4px 8px 0px #00000040;');
  });

  it('is free the second time (one styles request, one batched node request, then cache)', async () => {
    const client = await app.connect();
    await app.call(client, 'figma_get_design_tokens', { file: FILE_KEY });
    const requestsAfterFirst = figma.api().length;
    expect(requestsAfterFirst).toBe(2);

    const second = await app.call(client, 'figma_get_design_tokens', { file: FILE_KEY, format: 'css' });
    expect(second.data.meta.cached).toBe(true);
    expect(figma.api()).toHaveLength(requestsAfterFirst);
  });
});

describe('figma_get_comments', () => {
  it('groups replies into threads, newest first', async () => {
    const client = await app.connect();
    const { data } = await app.call(client, 'figma_get_comments', { file: FILE_KEY });

    expect(data.total).toBe(2);
    expect(data.threads[0]).toMatchObject({
      id: 'k1',
      author: 'linh',
      message: 'Can we shorten this title?',
      nodeId: '1:2',
      resolvedAt: null,
      replies: [{ id: 'k2', author: 'phong', message: 'Done, see v2' }],
    });
    expect(data.threads[1]).toMatchObject({ id: 'k3', resolvedAt: '2026-09-11T08:00:00Z' });
  });

  it('filters by status and node', async () => {
    const client = await app.connect();
    const open = await app.call(client, 'figma_get_comments', { file: FILE_KEY, status: 'open' });
    expect(open.data.threads.map((t: { id: string }) => t.id)).toEqual(['k1']);

    const resolved = await app.call(client, 'figma_get_comments', { file: FILE_KEY, status: 'resolved' });
    expect(resolved.data.threads.map((t: { id: string }) => t.id)).toEqual(['k3']);

    const byNode = await app.call(client, 'figma_get_comments', { file: FILE_KEY, nodeId: '2-1' });
    expect(byNode.data.threads.map((t: { id: string }) => t.id)).toEqual(['k3']);
    expect(figma.api('/v1/files/')).toHaveLength(1);
  });
});
