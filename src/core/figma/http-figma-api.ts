import {
  AppError,
  AuthError,
  FigmaApiError,
  RateLimitedError,
  TransientError,
  describeError,
} from '../domain/errors.js';
import type { Logger } from '../../infra/logger.js';
import {
  classifyTransient,
  defaultSleep,
  withRetry,
  type RetryPolicy,
  type Sleep,
} from '../../infra/retry.js';
import type { RateLimitGate, Tier } from '../rate-limit/governor.js';
import {
  supportsScale,
  type FigmaApi,
  type FigmaComment,
  type FigmaFile,
  type FigmaFileMeta,
  type FigmaLibraryItem,
  type FigmaNode,
  type FigmaNodesResult,
  type ImageUrlMap,
  type ImageUrlRequest,
} from './figma-api.js';

const DEFAULT_RETRY_AFTER_SECONDS = 30;

export interface HttpFigmaApiOptions {
  /** Called fresh on every request, so a token set through the Admin UI applies immediately. */
  readonly token: () => string;
  readonly baseUrl: string;
  readonly gate: RateLimitGate;
  readonly retryPolicy: RetryPolicy;
  /** A 429 asking for a longer wait than this is not waited out: the circuit opens and callers fail fast. */
  readonly maxRetryAfterWaitSeconds: number;
  readonly requestTimeoutMs: number;
  readonly logger: Logger;
  readonly fetch?: typeof fetch;
  readonly sleep?: Sleep;
  readonly random?: () => number;
}

type Payload = { err?: string | null };
type FileResponse = Payload & FigmaFileMeta & { document?: FigmaNode };
type NodesResponse = Payload &
  FigmaFileMeta & { nodes?: Record<string, { document?: FigmaNode } | null> };
type ImagesResponse = Payload & { images?: Record<string, string | null> };
type CommentsResponse = Payload & { comments?: FigmaComment[] };
type LibraryResponse = Payload & {
  meta?: { styles?: FigmaLibraryItem[]; components?: FigmaLibraryItem[]; component_sets?: FigmaLibraryItem[] };
};

/** REST adapter: authentication, per-tier gating, retry of transient failures, response mapping. */
export class HttpFigmaApi implements FigmaApi {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: HttpFigmaApiOptions) {
    this.fetchFn = options.fetch ?? fetch;
  }

  async getFile(fileKey: string, options: { depth?: number } = {}): Promise<FigmaFile> {
    const query = new URLSearchParams();
    if (options.depth !== undefined) {
      query.set('depth', String(options.depth));
    }
    const payload = await this.getJson<FileResponse>(1, `/v1/files/${encodeURIComponent(fileKey)}`, query);
    if (!payload.document) {
      throw new FigmaApiError('Figma returned a file without a document', 200);
    }
    return { ...pickMeta(payload), document: payload.document };
  }

  async getNodes(
    fileKey: string,
    ids: readonly string[],
    options: { depth?: number } = {},
  ): Promise<FigmaNodesResult> {
    const query = new URLSearchParams({ ids: ids.join(',') });
    if (options.depth !== undefined) {
      query.set('depth', String(options.depth));
    }
    const payload = await this.getJson<NodesResponse>(
      1,
      `/v1/files/${encodeURIComponent(fileKey)}/nodes`,
      query,
    );
    const nodes = Object.fromEntries(ids.map((id) => [id, payload.nodes?.[id]?.document ?? null]));
    return { meta: pickMeta(payload), nodes };
  }

  async getImageUrls(request: ImageUrlRequest): Promise<ImageUrlMap> {
    const query = new URLSearchParams({ ids: request.ids.join(','), format: request.format });
    if (supportsScale(request.format)) {
      query.set('scale', String(request.scale));
    }
    if (request.useAbsoluteBounds) {
      query.set('use_absolute_bounds', 'true');
    }
    const payload = await this.getJson<ImagesResponse>(
      1,
      `/v1/images/${encodeURIComponent(request.fileKey)}`,
      query,
    );
    const images = payload.images ?? {};
    // Figma guarantees every requested id is present; be defensive anyway.
    return Object.fromEntries(request.ids.map((id) => [id, images[id] ?? null]));
  }

  async getComments(fileKey: string, options: { asMarkdown?: boolean } = {}): Promise<readonly FigmaComment[]> {
    const query = new URLSearchParams();
    if (options.asMarkdown) {
      query.set('as_md', 'true');
    }
    const payload = await this.getJson<CommentsResponse>(
      2,
      `/v1/files/${encodeURIComponent(fileKey)}/comments`,
      query,
    );
    return payload.comments ?? [];
  }

  async getStyles(fileKey: string): Promise<readonly FigmaLibraryItem[]> {
    const payload = await this.getLibrary(fileKey, 'styles');
    return payload.meta?.styles ?? [];
  }

  async getComponents(fileKey: string): Promise<readonly FigmaLibraryItem[]> {
    const payload = await this.getLibrary(fileKey, 'components');
    return payload.meta?.components ?? [];
  }

  async getComponentSets(fileKey: string): Promise<readonly FigmaLibraryItem[]> {
    const payload = await this.getLibrary(fileKey, 'component_sets');
    return payload.meta?.component_sets ?? [];
  }

  private getLibrary(fileKey: string, resource: 'styles' | 'components' | 'component_sets') {
    return this.getJson<LibraryResponse>(3, `/v1/files/${encodeURIComponent(fileKey)}/${resource}`, new URLSearchParams());
  }

  private async getJson<T extends Payload>(tier: Tier, path: string, query: URLSearchParams): Promise<T> {
    const queryString = query.toString();
    const url = `${this.options.baseUrl}${path}${queryString ? `?${queryString}` : ''}`;

    const payload = await withRetry(() => this.requestOnce<T>(tier, url), {
      policy: this.options.retryPolicy,
      classify: classifyTransient,
      sleep: this.options.sleep ?? defaultSleep,
      ...(this.options.random ? { random: this.options.random } : {}),
      onRetry: ({ attempt, delayMs, error }) =>
        this.options.logger.warn('Figma API call failed, retrying', {
          tier,
          path,
          attempt,
          delayMs,
          reason: describeError(error),
        }),
    });

    if (payload.err) {
      throw new FigmaApiError(`Figma API error: ${payload.err}`, 200);
    }
    return payload;
  }

  private async requestOnce<T>(tier: Tier, url: string): Promise<T> {
    const token = this.options.token();
    if (!token) {
      throw new AuthError('Figma token is not configured yet. Complete setup in the Admin UI before using this tool.');
    }

    // Every attempt (including retries) spends budget, so every attempt passes the gate.
    await this.options.gate.acquire(tier);

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        headers: { 'X-Figma-Token': token, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.options.requestTimeoutMs),
      });
    } catch (cause) {
      throw new TransientError(`Network error calling the Figma API: ${describeError(cause)}`, undefined, {
        cause,
      });
    }

    if (response.ok) {
      this.options.gate.reportSuccess(tier);
      // Read as text first so the governor learns how big the answer was. Figma prices this
      // endpoint by payload size, and a `depth` query can turn one request into megabytes.
      const body = await response.text();
      this.options.gate.reportCost(tier, Buffer.byteLength(body));
      return JSON.parse(body) as T;
    }
    throw await this.toError(tier, response);
  }

  private async toError(tier: Tier, response: Response): Promise<AppError> {
    const status = response.status;

    if (status === 429) {
      return this.toRateLimitError(tier, response);
    }
    if (status >= 500) {
      return new TransientError(`Figma API responded with ${status}`);
    }

    const detail = await readErrorDetail(response);
    const hint =
      status === 403
        ? ' (check that FIGMA_TOKEN is valid, has the required scope and can access this file)'
        : '';
    return new FigmaApiError(`Figma API ${status}: ${detail}${hint}`, status);
  }

  private toRateLimitError(tier: Tier, response: Response): AppError {
    const parsed = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
    const retryAfterSeconds = Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
    const planTier = response.headers.get('x-figma-plan-tier') ?? undefined;
    const limitType = response.headers.get('x-figma-rate-limit-type') ?? undefined;
    const upgradeLink = response.headers.get('x-figma-upgrade-link') ?? undefined;

    this.options.gate.reportRateLimited(tier, { retryAfterSeconds, planTier, limitType, upgradeLink });

    const waitSeconds = retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS;
    if (waitSeconds > this.options.maxRetryAfterWaitSeconds) {
      return new RateLimitedError(
        `Figma rate limit reached for Tier ${tier}; Retry-After is ${formatDuration(waitSeconds)}. ` +
          'The server will not retry until then.',
        { tier, retryAfterSeconds, source: 'figma', planTier, limitType, upgradeLink },
      );
    }
    return new TransientError('Figma rate limit reached (429)', waitSeconds * 1000);
  }
}

function pickMeta(payload: FigmaFileMeta): FigmaFileMeta {
  return {
    name: payload.name,
    lastModified: payload.lastModified,
    version: payload.version,
    ...(payload.editorType ? { editorType: payload.editorType } : {}),
    ...(payload.thumbnailUrl ? { thumbnailUrl: payload.thumbnailUrl } : {}),
  };
}

async function readErrorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as { err?: string; message?: string };
    return parsed.err ?? parsed.message ?? (text || response.statusText);
  } catch {
    return text || response.statusText;
  }
}

export function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 120) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 120) {
    return `${minutes} minutes`;
  }
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
}
