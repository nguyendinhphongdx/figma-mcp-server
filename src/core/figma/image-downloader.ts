import { Readable, Transform, pipeline } from 'node:stream';
import { DownloadError, TransientError, describeError } from '../domain/errors.js';
import type { Logger } from '../../infra/logger.js';
import {
  classifyTransient,
  defaultSleep,
  withRetry,
  type RetryPolicy,
  type Sleep,
} from '../../infra/retry.js';
import type { ImageUrlPolicy } from '../security/image-url-policy.js';

/** Opens a pre-signed image URL as a byte stream. */
export interface ImageDownloader {
  open(url: string): Promise<Readable>;
}

export interface FetchImageDownloaderOptions {
  readonly policy: ImageUrlPolicy;
  readonly retryPolicy: RetryPolicy;
  readonly requestTimeoutMs: number;
  readonly maxBytes: number;
  readonly logger: Logger;
  readonly fetch?: typeof fetch;
  readonly sleep?: Sleep;
}

/**
 * Fetches images from Figma's storage.
 * The Figma token is deliberately NOT sent: these URLs are pre-signed. Redirects are refused,
 * so an allow-listed host cannot bounce the request somewhere else.
 */
export class FetchImageDownloader implements ImageDownloader {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: FetchImageDownloaderOptions) {
    this.fetchFn = options.fetch ?? fetch;
  }

  async open(rawUrl: string): Promise<Readable> {
    const url = this.options.policy.assertAllowed(rawUrl);

    const response = await withRetry(() => this.requestOnce(url), {
      policy: this.options.retryPolicy,
      classify: classifyTransient,
      sleep: this.options.sleep ?? defaultSleep,
      onRetry: ({ attempt, delayMs, error }) =>
        this.options.logger.warn('Image download failed, retrying', {
          host: url.hostname,
          attempt,
          delayMs,
          reason: describeError(error),
        }),
    });

    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.options.maxBytes) {
      await response.body?.cancel();
      throw new DownloadError(`Image is ${declared} bytes, above the ${this.options.maxBytes}-byte limit.`);
    }
    if (!response.body) {
      throw new DownloadError('Image response had no body.');
    }

    // `pipeline` (unlike `.pipe`) forwards a mid-stream network error to the returned stream,
    // so consumers fail instead of hanging on a source that died.
    const limiter = byteLimit(this.options.maxBytes);
    pipeline(Readable.fromWeb(response.body), limiter, () => undefined);
    return limiter;
  }

  private async requestOnce(url: URL): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(this.options.requestTimeoutMs),
      });
    } catch (cause) {
      throw new TransientError(`network error: ${describeError(cause)}`, undefined, { cause });
    }

    if (response.ok) {
      return response;
    }
    await response.body?.cancel();
    const message = `HTTP ${response.status} while downloading image`;
    throw response.status >= 500 || response.status === 429 ? new TransientError(message) : new DownloadError(message);
  }
}

/** Aborts the stream once more than `maxBytes` have passed through, whatever the server claimed. */
export function byteLimit(maxBytes: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > maxBytes) {
        callback(new DownloadError(`Image exceeds the ${maxBytes}-byte limit.`));
        return;
      }
      callback(null, chunk);
    },
  });
}
