import { AppError, InvalidInputError, RateLimitedError, describeError, type RateLimitDetails } from '../../core/domain/errors.js';
import type { CachedLoader } from '../../core/cache/cached-loader.js';
import type { FigmaApi } from '../../core/figma/figma-api.js';
import type { ImageDownloader } from '../../core/figma/image-downloader.js';
import { chunk, mapWithConcurrency } from '../../infra/pool.js';
import type { FileOutlineService } from '../frames/file-outline.js';
import type { CacheTtls } from '../shared/cache-ttls.js';
import { imageUrlKey } from '../shared/image-url-cache.js';
import type { FileResolver } from '../shared/file-resolver.js';

export const MAX_SVG_NODES = 50;
export const DEFAULT_MAX_SVG_BYTES = 24 * 1024;
export const MAX_TOTAL_SVG_BYTES = 512 * 1024;

export interface GetSvgInput {
  readonly file?: string | undefined;
  readonly nodes: readonly string[];
  /** Skip a node whose SVG is larger than this. Default 24576. */
  readonly maxBytesPerNode?: number | undefined;
  readonly refresh?: boolean | undefined;
}

export interface SvgResult {
  readonly nodeId: string;
  readonly name?: string;
  readonly bytes: number;
  /** The SVG source itself. */
  readonly svg: string;
}

export interface SvgFailure {
  readonly nodeId: string;
  readonly reason: string;
}

export interface GetSvgOutput {
  readonly file: { readonly key: string };
  readonly svgs: readonly SvgResult[];
  readonly failed: readonly SvgFailure[];
  readonly figmaRequestsUsed: number;
  readonly rateLimited?: RateLimitDetails;
}

export interface GetSvgSettings {
  readonly batchSize: number;
  readonly downloadConcurrency: number;
}

/**
 * Figma's REST API describes a VECTOR layer by its bounds and paints but never by its path data, so
 * a caller implementing an icon has everything except its shape. Exporting the node as SVG produces
 * that shape, but as a file to download — which an agent writing markup cannot inline. This returns
 * the SVG source in the tool result instead, which is what an icon is actually needed for.
 */
export class GetSvgUseCase {
  constructor(
    private readonly api: FigmaApi,
    private readonly loader: CachedLoader,
    private readonly files: FileResolver,
    private readonly outlines: FileOutlineService,
    private readonly downloader: ImageDownloader,
    private readonly ttls: CacheTtls,
    private readonly settings: GetSvgSettings,
  ) {}

  async execute(input: GetSvgInput): Promise<GetSvgOutput> {
    if (input.nodes.length === 0 || input.nodes.length > MAX_SVG_NODES) {
      throw new InvalidInputError(`Provide between 1 and ${MAX_SVG_NODES} nodes.`);
    }
    const maxBytes = Math.min(
      Math.max(input.maxBytesPerNode ?? DEFAULT_MAX_SVG_BYTES, 256),
      MAX_TOTAL_SVG_BYTES,
    );

    const { fileKey, nodeIds } = this.files.resolveWithNodes(input.file, input.nodes);
    const failed: SvgFailure[] = [];
    let figmaRequests = 0;
    let rateLimited: RateLimitDetails | undefined;

    // Reuses the URL cache the bulk export fills, so exporting these nodes as SVG first makes
    // this call free.
    const urls = new Map<string, string>();
    const unresolved: string[] = [];
    for (const nodeId of nodeIds) {
      const key = imageUrlKey(fileKey, nodeId, 'svg', 1, false);
      const cached = input.refresh ? undefined : await this.loader.peek<string>(key);
      if (cached) urls.set(nodeId, cached.value);
      else unresolved.push(nodeId);
    }

    for (const group of chunk(unresolved, this.settings.batchSize)) {
      if (rateLimited) {
        group.forEach((nodeId) => failed.push({ nodeId, reason: 'skipped: Figma rate limit reached' }));
        continue;
      }
      figmaRequests += 1;
      try {
        const resolved = await this.api.getImageUrls({
          fileKey,
          ids: group,
          format: 'svg',
          scale: 1,
          useAbsoluteBounds: false,
        });
        for (const nodeId of group) {
          const url = resolved[nodeId];
          if (url) {
            urls.set(nodeId, url);
            await this.loader.put(imageUrlKey(fileKey, nodeId, 'svg', 1, false), this.ttls.imageUrlMs, url);
          } else {
            failed.push({ nodeId, reason: 'Figma could not render this node as SVG; check the id and that it is visible' });
          }
        }
      } catch (error) {
        if (error instanceof RateLimitedError) rateLimited = error.details;
        else if (!(error instanceof AppError)) throw error;
        const reason = describeError(error);
        group.forEach((nodeId) => failed.push({ nodeId, reason }));
      }
    }

    const names = await this.outlines.peekNames(fileKey, [...urls.keys()]);
    const ready = [...urls.entries()];
    const fetched = await mapWithConcurrency(ready, this.settings.downloadConcurrency, async ([nodeId, url]) => {
      try {
        const source = await this.downloader.open(url);
        const svg = minifySvg(await readText(source, maxBytes));
        const name = names.get(nodeId);
        return { nodeId, ...(name ? { name } : {}), bytes: Buffer.byteLength(svg), svg } satisfies SvgResult;
      } catch (error) {
        failed.push({ nodeId, reason: describeError(error) });
        return undefined;
      }
    });

    // Preserve the caller's order rather than whichever download finished first.
    const byId = new Map(fetched.filter((item): item is SvgResult => item !== undefined).map((item) => [item.nodeId, item]));
    const svgs = nodeIds.flatMap((nodeId) => (byId.has(nodeId) ? [byId.get(nodeId) as SvgResult] : []));

    return {
      file: { key: fileKey },
      svgs,
      failed,
      figmaRequestsUsed: figmaRequests,
      ...(rateLimited ? { rateLimited } : {}),
    };
  }
}

/** Reads a stream as UTF-8, refusing anything past `maxBytes` rather than buffering it. */
async function readText(stream: NodeJS.ReadableStream, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const piece of stream) {
    const buffer = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as string);
    total += buffer.length;
    if (total > maxBytes) {
      throw new InvalidInputError(
        `SVG is larger than the ${maxBytes}-byte inline limit; raise maxBytesPerNode or use figma_export_frames.`,
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Drops the parts of a Figma SVG export that carry no drawing information. */
export function minifySvg(svg: string): string {
  return svg
    .replace(/<\?xml[^>]*\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/>\s+</g, '><')
    .trim();
}
