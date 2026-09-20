import { randomBytes } from 'node:crypto';
import {
  AppError,
  DownloadError,
  InvalidInputError,
  RateLimitedError,
  describeError,
  type RateLimitDetails,
} from '../../core/domain/errors.js';
import type { CachedLoader } from '../../core/cache/cached-loader.js';
import type { FigmaApi, ImageFormat } from '../../core/figma/figma-api.js';
import { IMAGE_FORMATS, supportsScale } from '../../core/figma/figma-api.js';
import type { ImageDownloader } from '../../core/figma/image-downloader.js';
import type { ExportStorage } from '../../core/storage/export-storage.js';
import { buildFileName } from '../../core/storage/file-namer.js';
import type { Logger } from '../../infra/logger.js';
import { chunk, mapWithConcurrency } from '../../infra/pool.js';
import type { FileOutlineService } from '../frames/file-outline.js';
import type { CacheTtls } from '../shared/cache-ttls.js';
import type { FileResolver } from '../shared/file-resolver.js';

export interface ExportFramesInput {
  /** Figma file URL or key. Optional when `nodes` are full Figma links. */
  readonly file?: string | undefined;
  /** Node ids (`1:2`) or frame links. */
  readonly nodes: readonly string[];
  readonly format?: ImageFormat | undefined;
  /** 0.01-4; jpg/png only. */
  readonly scale?: number | undefined;
  readonly useAbsoluteBounds?: boolean | undefined;
  /** Name files after layer names (free when the file outline is cached, otherwise one extra request). */
  readonly useLayerNames?: boolean | undefined;
  readonly createArchive?: boolean | undefined;
  /** Ignore cached image URLs and render again. */
  readonly refresh?: boolean | undefined;
}

export interface ExportedFile {
  readonly nodeId: string;
  readonly fileName: string;
  readonly bytes: number;
  readonly url: string;
}

export interface FailedExport {
  readonly nodeId: string;
  readonly reason: string;
}

export interface ExportFramesOutput {
  readonly status: 'complete' | 'partial' | 'failed';
  readonly exportId: string;
  /** ISO time when the download links stop working. */
  readonly linksExpireAt: string;
  readonly files: readonly ExportedFile[];
  readonly archiveUrl?: string;
  readonly failed: readonly FailedExport[];
  /** Figma API requests this call spent (cache hits are free). */
  readonly figmaRequestsUsed: number;
  /** Set when Figma's rate limit cut the export short. */
  readonly rateLimited?: RateLimitDetails;
}

/** Issues time-limited download links for stored exports (implemented by the HTTP adapter). */
export interface DownloadLinks {
  forFile(exportId: string, fileName: string): { url: string; expiresAt: Date };
  forArchive(exportId: string): { url: string; expiresAt: Date };
}

export interface ExportFramesSettings {
  readonly maxNodes: number;
  /** Ids per Figma request. Every request costs rate-limit budget, so keep this high. */
  readonly batchSize: number;
  readonly downloadConcurrency: number;
}

const DEFAULTS = { format: 'jpg', scale: 2 } as const;

interface Candidate {
  readonly nodeId: string;
  readonly fileName: string;
}

function imageUrlKey(fileKey: string, nodeId: string, format: ImageFormat, scale: number, absolute: boolean): string {
  return `imgurl:${fileKey}:${nodeId}:${format}:${supportsScale(format) ? scale : 1}:${absolute ? 'abs' : 'crop'}`;
}

function nameKey(fileKey: string, nodeId: string): string {
  return `nodename:${fileKey}:${nodeId}`;
}

/**
 * Bulk export. Everything that costs Figma budget is batched and cached:
 *   names   : from the cached file outline (free), else one batched request, then remembered per node
 *   URLs    : one request per `batchSize` nodes, remembered for the URLs' lifetime
 *   images  : downloaded from Figma's storage (no API budget) into server storage
 * A repeated export of the same frames therefore costs zero Figma requests.
 */
export class ExportFramesUseCase {
  constructor(
    private readonly api: FigmaApi,
    private readonly loader: CachedLoader,
    private readonly files: FileResolver,
    private readonly outlines: FileOutlineService,
    private readonly downloader: ImageDownloader,
    private readonly storage: ExportStorage,
    private readonly links: DownloadLinks,
    private readonly ttls: CacheTtls,
    private readonly settings: ExportFramesSettings,
    private readonly logger: Logger,
  ) {}

  async execute(input: ExportFramesInput): Promise<ExportFramesOutput> {
    if (input.nodes.length === 0 || input.nodes.length > this.settings.maxNodes) {
      throw new InvalidInputError(`Provide between 1 and ${this.settings.maxNodes} nodes per export.`);
    }
    const format = input.format ?? DEFAULTS.format;
    if (!IMAGE_FORMATS.includes(format)) {
      throw new InvalidInputError(`format must be one of ${IMAGE_FORMATS.join(', ')}.`);
    }
    const scale = input.scale ?? DEFAULTS.scale;
    if (!(scale >= 0.01 && scale <= 4)) {
      throw new InvalidInputError('scale must be between 0.01 and 4.');
    }
    const absolute = input.useAbsoluteBounds ?? false;

    const { fileKey, nodeIds } = this.files.resolveWithNodes(input.file, input.nodes);
    const run = new RunState();

    const names = input.useLayerNames === false ? new Map<string, string>() : await this.resolveNames(fileKey, nodeIds, run);
    const candidates: Candidate[] = nodeIds.map((nodeId) => ({
      nodeId,
      fileName: buildFileName({ id: nodeId, ...(names.has(nodeId) ? { name: names.get(nodeId) } : {}) }, format),
    }));

    const urls = await this.resolveUrls(fileKey, candidates, { format, scale, absolute, refresh: input.refresh ?? false }, run);
    const exportId = randomBytes(16).toString('hex');
    const stored = await this.downloadAll(exportId, fileKey, candidates, urls, { format, scale, absolute }, run);

    return this.buildOutput(exportId, stored, input.createArchive ?? true, run);
  }

  private async resolveNames(fileKey: string, nodeIds: readonly string[], run: RunState): Promise<Map<string, string>> {
    const names = await this.outlines.peekNames(fileKey, nodeIds);

    const missing: string[] = [];
    for (const id of nodeIds) {
      if (names.has(id)) continue;
      const remembered = await this.loader.peek<string>(nameKey(fileKey, id));
      if (remembered) names.set(id, remembered.value);
      else missing.push(id);
    }

    for (const ids of chunk(missing, this.settings.batchSize)) {
      if (run.rateLimited) break;
      run.figmaRequests += 1;
      try {
        const result = await this.api.getNodes(fileKey, ids, { depth: 1 });
        for (const id of ids) {
          const name = result.nodes[id]?.name;
          if (name) {
            names.set(id, name);
            await this.loader.put(nameKey(fileKey, id), this.ttls.structureMs, name);
          }
        }
      } catch (error) {
        // Names are cosmetic: fall back to id-only file names rather than failing the export.
        run.noteApiFailure(error);
        this.logger.warn('Could not resolve layer names; using node ids', { reason: describeError(error) });
      }
    }
    return names;
  }

  private async resolveUrls(
    fileKey: string,
    candidates: readonly Candidate[],
    options: { format: ImageFormat; scale: number; absolute: boolean; refresh: boolean },
    run: RunState,
  ): Promise<Map<string, string>> {
    const urls = new Map<string, string>();
    const unresolved: Candidate[] = [];

    for (const candidate of candidates) {
      const key = imageUrlKey(fileKey, candidate.nodeId, options.format, options.scale, options.absolute);
      const cached = options.refresh ? undefined : await this.loader.peek<string>(key);
      if (cached) urls.set(candidate.nodeId, cached.value);
      else unresolved.push(candidate);
    }

    for (const group of chunk(unresolved, this.settings.batchSize)) {
      if (run.rateLimited) {
        group.forEach((item) => run.fail(item.nodeId, 'skipped: Figma rate limit reached'));
        continue;
      }

      run.figmaRequests += 1;
      let resolved: Readonly<Record<string, string | null>>;
      try {
        resolved = await this.api.getImageUrls({
          fileKey,
          ids: group.map((item) => item.nodeId),
          format: options.format,
          scale: options.scale,
          useAbsoluteBounds: options.absolute,
        });
      } catch (error) {
        run.noteApiFailure(error);
        const reason = describeError(error);
        group.forEach((item) => run.fail(item.nodeId, reason));
        continue;
      }

      for (const item of group) {
        const url = resolved[item.nodeId];
        if (url) {
          urls.set(item.nodeId, url);
          await this.loader.put(
            imageUrlKey(fileKey, item.nodeId, options.format, options.scale, options.absolute),
            this.ttls.imageUrlMs,
            url,
          );
        } else {
          run.fail(item.nodeId, 'Figma could not render this node (no URL returned); check the id and that the node is visible');
        }
      }
    }
    return urls;
  }

  private async downloadAll(
    exportId: string,
    fileKey: string,
    candidates: readonly Candidate[],
    urls: ReadonlyMap<string, string>,
    options: { format: ImageFormat; scale: number; absolute: boolean },
    run: RunState,
  ): Promise<ExportedFile[]> {
    const ready = candidates.filter((candidate) => urls.has(candidate.nodeId));

    const results = await mapWithConcurrency(ready, this.settings.downloadConcurrency, async (candidate) => {
      try {
        const source = await this.downloader.open(urls.get(candidate.nodeId) as string);
        const saved = await this.storage.save(exportId, candidate.fileName, source);
        return {
          nodeId: candidate.nodeId,
          fileName: candidate.fileName,
          bytes: saved.bytes,
          url: this.links.forFile(exportId, candidate.fileName).url,
        } satisfies ExportedFile;
      } catch (error) {
        run.fail(candidate.nodeId, describeError(error));
        // A rejected pre-signed URL has probably expired: forget it so the next export re-renders.
        if (error instanceof DownloadError && /HTTP 4\d\d/.test(error.message)) {
          await this.loader.invalidate(imageUrlKey(fileKey, candidate.nodeId, options.format, options.scale, options.absolute));
        }
        return undefined;
      }
    });

    return results.filter((file): file is ExportedFile => file !== undefined);
  }

  private buildOutput(
    exportId: string,
    files: readonly ExportedFile[],
    createArchive: boolean,
    run: RunState,
  ): ExportFramesOutput {
    const linkExpiry = this.links.forArchive(exportId).expiresAt.toISOString();
    const status = run.failed.length === 0 ? 'complete' : files.length > 0 ? 'partial' : 'failed';

    return {
      status,
      exportId,
      linksExpireAt: linkExpiry,
      files,
      ...(createArchive && files.length > 0 ? { archiveUrl: this.links.forArchive(exportId).url } : {}),
      failed: run.failed,
      figmaRequestsUsed: run.figmaRequests,
      ...(run.rateLimited ? { rateLimited: run.rateLimited } : {}),
    };
  }
}

/** Mutable bookkeeping for a single export call. */
class RunState {
  figmaRequests = 0;
  rateLimited: RateLimitDetails | undefined;
  readonly failed: FailedExport[] = [];

  fail(nodeId: string, reason: string): void {
    this.failed.push({ nodeId, reason });
  }

  /** Remembers a rate-limit stop; rethrows anything that is not an expected application error. */
  noteApiFailure(error: unknown): void {
    if (error instanceof RateLimitedError) {
      this.rateLimited = error.details;
      return;
    }
    if (!(error instanceof AppError)) {
      throw error;
    }
  }
}
