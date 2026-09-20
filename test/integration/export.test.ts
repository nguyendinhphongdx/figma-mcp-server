import { unzipSync, strFromU8 } from 'fflate';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UrlSigner } from '../../src/core/security/url-signer.js';
import { FILE_KEY, FakeFigma } from '../support/fake-figma.js';
import { SIGNING_SECRET, startTestApp, type TestApp } from '../support/test-app.js';

const figma = new FakeFigma();
let app: TestApp;

beforeAll(() => figma.start());
afterAll(() => figma.stop());
beforeEach(async () => {
  figma.reset();
  app = await startTestApp(figma);
});
afterEach(() => app.stop());

const NODES = ['1:1', '1:2', '1:3'];

async function warmOutline(): Promise<void> {
  const client = await app.connect();
  await app.call(client, 'figma_list_frames', { file: FILE_KEY });
  figma.requests.length = 0;
}

describe('figma_export_frames', () => {
  it('exports every frame with a single Figma request when layer names are already known', async () => {
    await warmOutline();
    const client = await app.connect();

    const { isError, data } = await app.call(client, 'figma_export_frames', { file: FILE_KEY, nodes: NODES });

    expect(isError).toBe(false);
    expect(data.status).toBe('complete');
    expect(data.figmaRequestsUsed).toBe(1);
    expect(figma.api()).toHaveLength(1);
    expect(figma.api('/v1/images/')[0]?.query.get('ids')).toBe('1:1,1:2,1:3');
    expect(figma.api('/v1/images/')[0]?.query.get('format')).toBe('jpg');
    expect(figma.api('/v1/images/')[0]?.query.get('scale')).toBe('2');
    expect(data.files.map((f: { fileName: string }) => f.fileName)).toEqual([
      'Welcome__1-1.jpg',
      'Đăng nhập__1-2.jpg',
      'Sign up__1-3.jpg',
    ]);
  });

  it('serves the stored files through signed links, with the right bytes and headers', async () => {
    await warmOutline();
    const client = await app.connect();
    const { data } = await app.call(client, 'figma_export_frames', { file: FILE_KEY, nodes: NODES });

    const response = await fetch(data.files[1].url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('content-disposition')).toContain(encodeURIComponent('Đăng nhập__1-2.jpg'));
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toBe('IMG:1:2.jpg');
    expect(data.files[1].bytes).toBe('IMG:1:2.jpg'.length);
  });

  it('bundles everything into a zip, keeping Vietnamese file names intact', async () => {
    await warmOutline();
    const client = await app.connect();
    const { data } = await app.call(client, 'figma_export_frames', { file: FILE_KEY, nodes: NODES });

    const response = await fetch(data.archiveUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');

    const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(Object.keys(entries).sort()).toEqual(['Sign up__1-3.jpg', 'Welcome__1-1.jpg', 'Đăng nhập__1-2.jpg'].sort());
    expect(strFromU8(entries['Welcome__1-1.jpg'] as Uint8Array)).toBe('IMG:1:1.jpg');
    expect(strFromU8(entries['Đăng nhập__1-2.jpg'] as Uint8Array)).toBe('IMG:1:2.jpg');
  });

  it('costs one extra request for names when the outline is not cached, and remembers them', async () => {
    const client = await app.connect();

    const first = await app.call(client, 'figma_export_frames', { file: FILE_KEY, nodes: NODES });
    expect(first.data.figmaRequestsUsed).toBe(2); // names (batched) + image urls (batched)
    expect(first.data.files[0].fileName).toBe('Welcome__1-1.jpg');

    figma.requests.length = 0;
    const again = await app.call(client, 'figma_export_frames', { file: FILE_KEY, nodes: NODES });
    expect(again.data.figmaRequestsUsed).toBe(0);
    expect(figma.api()).toHaveLength(0); // names and URLs both came from cache
    expect(figma.cdn()).toHaveLength(3); // but the images are downloaded again
  });

  it('skips the names lookup entirely with useLayerNames=false', async () => {
    const client = await app.connect();
    const { data } = await app.call(client, 'figma_export_frames', { file: FILE_KEY, nodes: NODES, useLayerNames: false });

    expect(data.figmaRequestsUsed).toBe(1);
    expect(data.files.map((f: { fileName: string }) => f.fileName)).toEqual(['1-1.jpg', '1-2.jpg', '1-3.jpg']);
  });

  it('accepts frame links as nodes and infers the file', async () => {
    const client = await app.connect();
    const links = ['1-1', '1-2'].map((id) => `https://www.figma.com/design/${FILE_KEY}/App?node-id=${id}`);

    const { isError, data } = await app.call(client, 'figma_export_frames', { nodes: links, useLayerNames: false });

    expect(isError).toBe(false);
    expect(data.files).toHaveLength(2);
  });

  it('passes format and scale through, and omits scale for vector formats', async () => {
    const client = await app.connect();
    await app.call(client, 'figma_export_frames', { file: FILE_KEY, nodes: ['1:1'], format: 'png', scale: 3, useLayerNames: false });
    await app.call(client, 'figma_export_frames', { file: FILE_KEY, nodes: ['1:2'], format: 'svg', useLayerNames: false });

    const [png, svg] = figma.api('/v1/images/');
    expect(png?.query.get('format')).toBe('png');
    expect(png?.query.get('scale')).toBe('3');
    expect(svg?.query.get('format')).toBe('svg');
    expect(svg?.query.has('scale')).toBe(false);
  });

  it('splits into batches only when the batch size demands it', async () => {
    await app.stop();
    app = await startTestApp(figma, { env: { EXPORT_BATCH_SIZE: '2' } });
    const client = await app.connect();

    const { data } = await app.call(client, 'figma_export_frames', { file: FILE_KEY, nodes: NODES, useLayerNames: false });

    expect(figma.api('/v1/images/').map((r) => r.query.get('ids'))).toEqual(['1:1,1:2', '1:3']);
    expect(data.figmaRequestsUsed).toBe(2);
    expect(data.status).toBe('complete');
  });

  it('returns a partial result naming the frame Figma could not render', async () => {
    figma.unrenderable.add('1:3');
    const client = await app.connect();

    const { isError, data } = await app.call(client, 'figma_export_frames', { file: FILE_KEY, nodes: NODES, useLayerNames: false });

    expect(isError).toBe(false);
    expect(data.status).toBe('partial');
    expect(data.files).toHaveLength(2);
    expect(data.failed).toEqual([{ nodeId: '1:3', reason: expect.stringContaining('could not render') }]);
  });

  it('de-duplicates ids and normalises the URL form', async () => {
    const client = await app.connect();
    const { data } = await app.call(client, 'figma_export_frames', { file: FILE_KEY, nodes: ['1-1', '1:1', '1:1'], useLayerNames: false });
    expect(data.files).toHaveLength(1);
    expect(figma.api('/v1/images/')[0]?.query.get('ids')).toBe('1:1');
  });

  it('rejects an oversized request before spending anything', async () => {
    await app.stop();
    app = await startTestApp(figma, { env: { EXPORT_MAX_NODES: '2' } });
    const client = await app.connect();

    const { isError, data } = await app.call(client, 'figma_export_frames', { file: FILE_KEY, nodes: NODES });

    expect(isError).toBe(true);
    expect(data.error.code).toBe('INVALID_INPUT');
    expect(figma.api()).toHaveLength(0);
  });

  it('will not download from hosts outside IMAGE_HOST_ALLOWLIST', async () => {
    await app.stop();
    app = await startTestApp(figma, { env: { IMAGE_HOST_ALLOWLIST: 'images.example.com' } });
    const client = await app.connect();

    const { data } = await app.call(client, 'figma_export_frames', { file: FILE_KEY, nodes: ['1:1'], useLayerNames: false });

    expect(data.status).toBe('failed');
    expect(data.failed[0].reason).toContain('IMAGE_HOST_ALLOWLIST');
    expect(figma.cdn()).toHaveLength(0);
  });

  it('forgets a cached URL the CDN now rejects, and re-renders on the next export', async () => {
    const client = await app.connect();
    await app.call(client, 'figma_export_frames', { file: FILE_KEY, nodes: ['1:2'], useLayerNames: false });

    figma.cdnStatus.set('1:2.jpg', 403);
    const broken = await app.call(client, 'figma_export_frames', { file: FILE_KEY, nodes: ['1:2'], useLayerNames: false });
    expect(broken.data.status).toBe('failed');
    expect(broken.data.failed[0].reason).toContain('HTTP 403');

    figma.cdnStatus.clear();
    figma.requests.length = 0;
    const healed = await app.call(client, 'figma_export_frames', { file: FILE_KEY, nodes: ['1:2'], useLayerNames: false });
    expect(healed.data.status).toBe('complete');
    expect(healed.data.figmaRequestsUsed).toBe(1); // had to ask Figma for a fresh URL
  });

  it('re-renders on request with refresh', async () => {
    const client = await app.connect();
    await app.call(client, 'figma_export_frames', { file: FILE_KEY, nodes: ['1:1'], useLayerNames: false });
    const { data } = await app.call(client, 'figma_export_frames', { file: FILE_KEY, nodes: ['1:1'], useLayerNames: false, refresh: true });
    expect(data.figmaRequestsUsed).toBe(1);
  });
});

describe('download links', () => {
  async function exported() {
    const client = await app.connect();
    const { data } = await app.call(client, 'figma_export_frames', { file: FILE_KEY, nodes: ['1:1'], useLayerNames: false });
    return data as { exportId: string; files: Array<{ url: string; fileName: string }>; archiveUrl: string };
  }

  it('refuse a tampered signature, a missing signature and a changed expiry', async () => {
    const { files } = await exported();
    const url = new URL(files[0]!.url);

    const tampered = new URL(url);
    tampered.searchParams.set('sig', `${url.searchParams.get('sig')?.slice(0, -2)}xx`);
    expect((await fetch(tampered)).status).toBe(403);

    const unsigned = new URL(url);
    unsigned.searchParams.delete('sig');
    expect((await fetch(unsigned)).status).toBe(403);

    const extended = new URL(url);
    extended.searchParams.set('exp', String(Number(url.searchParams.get('exp')) + 86_400));
    expect((await fetch(extended)).status).toBe(403);
  });

  it('refuse a link that has expired', async () => {
    const { exportId, files } = await exported();
    const past = new UrlSigner(SIGNING_SECRET, () => Math.floor(Date.now() / 1000) - 7200);
    const { expiresAt, signature } = past.sign(`${exportId}/${files[0]!.fileName}`, 3600);

    const response = await fetch(`${app.baseUrl}/exports/${exportId}/files/${encodeURIComponent(files[0]!.fileName)}?exp=${expiresAt}&sig=${signature}`);
    expect(response.status).toBe(403);
  });

  it('cannot be reused for another file (signature is bound to the resource)', async () => {
    const { exportId, files } = await exported();
    const url = new URL(files[0]!.url);
    const other = `${app.baseUrl}/exports/${exportId}/files/other.jpg${url.search}`;
    expect((await fetch(other)).status).toBe(403);
  });

  it('cannot be used to walk out of the export directory', async () => {
    const { exportId, files } = await exported();
    const url = new URL(files[0]!.url);
    const traversal = `${app.baseUrl}/exports/${exportId}/files/${encodeURIComponent('../../cache/x')}${url.search}`;
    const response = await fetch(traversal);
    expect([403, 404]).toContain(response.status);
  });

  it('answer 404 once the export has been purged by retention', async () => {
    const { files, archiveUrl } = await exported();
    const removed = await app.app.storage.purgeOlderThan(Date.now() + 60_000);
    expect(removed).toBe(1);

    expect((await fetch(files[0]!.url)).status).toBe(404);
    expect((await fetch(archiveUrl)).status).toBe(404);
  });
});
