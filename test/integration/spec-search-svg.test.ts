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

describe('figma_search_nodes', () => {
  it('finds top-level frames by name and reports where they live', async () => {
    const client = await app.connect();
    const { isError, data } = await app.call(client, 'figma_search_nodes', { file: FILE_KEY, query: 'welcome' });

    expect(isError).toBe(false);
    expect(data.scope).toBe('top-level');
    expect(data.matches).toEqual([
      { id: '1:1', name: 'Welcome', type: 'FRAME', page: 'Onboarding', path: 'Onboarding', width: 375, height: 812 },
    ]);
    expect(data.totalMatches).toBe(1);
  });

  it('ignores case and Vietnamese diacritics, which is how people type queries', async () => {
    const client = await app.connect();
    const { data } = await app.call(client, 'figma_search_nodes', { file: FILE_KEY, query: 'dang nhap' });
    expect(data.matches.map((match: { id: string }) => match.id)).toEqual(['1:2']);
  });

  it('reuses the outline other tools already cached, spending nothing', async () => {
    const client = await app.connect();
    await app.call(client, 'figma_list_frames', { file: FILE_KEY });
    const { data } = await app.call(client, 'figma_search_nodes', { file: FILE_KEY, query: 'home' });

    expect(figma.api('/v1/files/')).toHaveLength(1);
    expect(data.meta.cached).toBe(true);
  });

  it('only reaches nested layers when asked to go deep', async () => {
    const client = await app.connect();

    const shallow = await app.call(client, 'figma_search_nodes', { file: FILE_KEY, query: 'nut luu' });
    expect(shallow.data.matches).toEqual([]);

    const deep = await app.call(client, 'figma_search_nodes', { file: FILE_KEY, query: 'nut luu', deep: true });
    expect(deep.data.scope).toBe('deep');
    expect(deep.data.matches).toEqual([
      { id: '2:11', name: 'Nút Lưu', type: 'INSTANCE', page: 'Dashboard', path: 'Dashboard / Home / Thanh điều hướng', width: 80, height: 32 },
    ]);
  });

  it('caches the deep index per depth', async () => {
    const client = await app.connect();
    await app.call(client, 'figma_search_nodes', { file: FILE_KEY, query: 'a', deep: true });
    const second = await app.call(client, 'figma_search_nodes', { file: FILE_KEY, query: 'b', deep: true });

    expect(figma.api('/v1/files/')).toHaveLength(1);
    expect(second.data.meta.cached).toBe(true);
  });

  it('filters by type and caps results with limit', async () => {
    const client = await app.connect();

    const typed = await app.call(client, 'figma_search_nodes', { file: FILE_KEY, query: 'e', types: ['SECTION'] });
    expect(typed.data.matches.map((match: { id: string }) => match.id)).toEqual(['2:3']);

    const limited = await app.call(client, 'figma_search_nodes', { file: FILE_KEY, query: 'e', limit: 1 });
    expect(limited.data.returned).toBe(1);
    expect(limited.data.totalMatches).toBeGreaterThan(1);
  });

  it('ranks by relevance, not document order', async () => {
    const client = await app.connect();
    // Figma names text layers after their content, so a long paragraph can contain the query
    // while the layer actually called that sits further down the file.
    const { data } = await app.call(client, 'figma_search_nodes', { file: FILE_KEY, query: 'home', deep: true });

    expect(data.matches[0]).toMatchObject({ id: '2:1', name: 'Home' });
    expect(data.totalMatches).toBeGreaterThan(1);
  });

  it('refuses an empty query rather than returning the whole file', async () => {
    const client = await app.connect();
    // `query` is rejected by the schema, before the use case ever runs.
    const result = await client.callTool({ name: 'figma_search_nodes', arguments: { file: FILE_KEY, query: '' } });
    expect(result.isError).toBe(true);
    expect(figma.api('/v1/files/')).toHaveLength(0);
  });
});

describe('figma_list_frames paging', () => {
  it('pages across pages and says when there is more', async () => {
    const client = await app.connect();
    const first = await app.call(client, 'figma_list_frames', { file: FILE_KEY, limit: 4 });

    expect(first.data.returned).toBe(4);
    expect(first.data.totalNodes).toBe(6);
    expect(first.data.hasMore).toBe(true);
    expect(first.data.pages.flatMap((page: { nodes: Array<{ id: string }> }) => page.nodes.map((node) => node.id))).toEqual([
      '1:1',
      '1:2',
      '1:3',
      '2:1',
    ]);

    const second = await app.call(client, 'figma_list_frames', { file: FILE_KEY, limit: 4, offset: 4 });
    expect(second.data.hasMore).toBe(false);
    expect(second.data.pages.flatMap((page: { nodes: Array<{ id: string }> }) => page.nodes.map((node) => node.id))).toEqual([
      '2:2',
      '2:3',
    ]);
    expect(second.data.pages.map((page: { name: string }) => page.name)).toEqual(['Dashboard']);
  });
});

describe('figma_get_node_spec', () => {
  it('returns CSS declarations and text in one call', async () => {
    const client = await app.connect();
    const { isError, data } = await app.call(client, 'figma_get_node_spec', { file: FILE_KEY, ids: ['1:1'] });

    expect(isError).toBe(false);
    const root = data.nodes['1:1'];
    expect(root.css).toMatchObject({
      display: 'flex',
      'flex-direction': 'column',
      gap: '16px',
      padding: '0 24px',
      background: '#ffffff',
      'border-radius': '12px',
    });

    // "Welcome back" sits two levels down; the spec surfaces it without a second call.
    const title = root.children[0].children[0];
    expect(title).toMatchObject({ type: 'TEXT', text: 'Welcome back' });
    expect(title.css).toMatchObject({ 'font-family': 'Inter', 'font-weight': '700', 'font-size': '28px' });
  });

  it('keeps instances identifiable so they can map onto code components', async () => {
    const client = await app.connect();
    const { data } = await app.call(client, 'figma_get_node_spec', { file: FILE_KEY, ids: ['1:1'] });
    expect(data.nodes['1:1'].children[1]).toMatchObject({ id: '1:13', name: 'CTA', componentId: '3:1' });
  });

  it('shares its Figma request with figma_get_node_tree at the same depth', async () => {
    const client = await app.connect();
    await app.call(client, 'figma_get_node_spec', { file: FILE_KEY, ids: ['1:1'], depth: 4 });
    const tree = await app.call(client, 'figma_get_node_tree', { file: FILE_KEY, ids: ['1:1'], depth: 4 });

    expect(figma.api('/v1/files/')).toHaveLength(1);
    expect(tree.data.meta.cached).toBe(true);
  });

  it('reports missing nodes as null rather than failing the call', async () => {
    const client = await app.connect();
    const { data } = await app.call(client, 'figma_get_node_spec', { file: FILE_KEY, ids: ['1:1', '99:99'] });
    expect(data.nodes['99:99']).toBeNull();
    expect(data.nodes['1:1']).not.toBeNull();
  });
});

describe('figma_get_svg', () => {
  it('returns SVG source inline, minified', async () => {
    const client = await app.connect();
    const { isError, data } = await app.call(client, 'figma_get_svg', { file: FILE_KEY, nodes: ['1:1'] });

    expect(isError).toBe(false);
    expect(data.svgs).toHaveLength(1);
    expect(data.svgs[0].svg).toBe('<svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 8h12" stroke="#000"/></svg>');
    expect(data.svgs[0].nodeId).toBe('1:1');
    expect(data.failed).toEqual([]);
  });

  it('shares rendered URLs with the bulk export, so the second call is free', async () => {
    const client = await app.connect();
    await app.call(client, 'figma_export_frames', { file: FILE_KEY, nodes: ['1:1'], format: 'svg' });
    const before = figma.api('/v1/images/').length;

    const { data } = await app.call(client, 'figma_get_svg', { file: FILE_KEY, nodes: ['1:1'] });
    expect(figma.api('/v1/images/')).toHaveLength(before);
    expect(data.figmaRequestsUsed).toBe(0);
  });

  it('reports an oversized SVG instead of returning it', async () => {
    const client = await app.connect();
    const { data } = await app.call(client, 'figma_get_svg', { file: FILE_KEY, nodes: ['1:3'], maxBytesPerNode: 256 });

    expect(data.svgs).toEqual([]);
    expect(data.failed[0].nodeId).toBe('1:3');
    expect(data.failed[0].reason).toContain('inline limit');
  });

  it('reports nodes Figma cannot render', async () => {
    figma.unrenderable.add('1:2');
    const client = await app.connect();
    const { data } = await app.call(client, 'figma_get_svg', { file: FILE_KEY, nodes: ['1:2'] });

    expect(data.svgs).toEqual([]);
    expect(data.failed[0]).toMatchObject({ nodeId: '1:2' });
  });
});

describe('figma_export_frames inline', () => {
  it('attaches the rendered images to the result as image content', async () => {
    const client = await app.connect();
    const result = await client.callTool({
      name: 'figma_export_frames',
      arguments: { file: FILE_KEY, nodes: ['1:1'], format: 'png', inline: true },
    });

    const content = result.content as Array<{ type: string; text?: string; mimeType?: string; data?: string }>;
    const image = content.find((block) => block.type === 'image');
    expect(image?.mimeType).toBe('image/png');
    expect(Buffer.from(image?.data ?? '', 'base64').toString()).toBe('IMG:1:1.png');

    // The base64 must not also be in the JSON payload, where it would cost tokens for nothing.
    expect(content[0]?.text).not.toContain(image?.data);
    expect(JSON.parse(content[0]?.text ?? '{}').previews).toBeUndefined();
  });

  it('explains why it did not inline instead of silently dropping the request', async () => {
    const client = await app.connect();
    const { data } = await app.call(client, 'figma_export_frames', {
      file: FILE_KEY,
      nodes: ['1:1'],
      format: 'svg',
      inline: true,
    });
    expect(data.inlineSkipped).toContain('figma_get_svg');
  });

  it('refuses to inline more images than the limit', async () => {
    const client = await app.connect();
    const { data } = await app.call(client, 'figma_export_frames', {
      file: FILE_KEY,
      nodes: ['1:1', '1:2', '1:3', '2:1', '2:2', '2:3'],
      format: 'png',
      inline: true,
    });
    expect(data.inlineSkipped).toContain('limited to 5');
  });
});
