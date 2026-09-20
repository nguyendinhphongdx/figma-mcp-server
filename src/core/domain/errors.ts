export type ErrorCode =
  | 'CONFIG'
  | 'INVALID_INPUT'
  | 'FORBIDDEN_FILE'
  | 'NOT_FOUND'
  | 'FIGMA_API'
  | 'RATE_LIMITED'
  | 'TRANSIENT'
  | 'DOWNLOAD'
  | 'AUTH'
  | 'TOO_MANY_REQUESTS'
  | 'INTERNAL';

/** Base class for every error raised deliberately by this application. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ConfigError extends AppError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'CONFIG', options);
  }
}

/** The caller supplied something we cannot act on (bad id, too many nodes, ...). */
export class InvalidInputError extends AppError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'INVALID_INPUT', options);
  }
}

/** The file is not in the server's allow-list. */
export class ForbiddenFileError extends AppError {
  constructor(message: string) {
    super(message, 'FORBIDDEN_FILE');
  }
}

/** Non-retryable error response from the Figma API (4xx other than 429). */
export class FigmaApiError extends AppError {
  constructor(
    message: string,
    readonly status: number,
    options?: ErrorOptions,
  ) {
    super(message, status === 404 ? 'NOT_FOUND' : 'FIGMA_API', options);
  }
}

export type RateLimitSource = 'figma' | 'local';

export interface RateLimitDetails {
  /** Figma API tier (1-3) whose budget is exhausted. */
  readonly tier: 1 | 2 | 3;
  /** Seconds until a retry can succeed, when known. */
  readonly retryAfterSeconds: number | undefined;
  /** `figma`: Figma answered 429. `local`: our governor refused to send the request. */
  readonly source: RateLimitSource;
  readonly planTier?: string | undefined;
  readonly limitType?: string | undefined;
  readonly upgradeLink?: string | undefined;
}

/** The request was not sent (or was rejected) because a Figma rate-limit budget is exhausted. */
export class RateLimitedError extends AppError {
  constructor(
    message: string,
    readonly details: RateLimitDetails,
  ) {
    super(message, 'RATE_LIMITED');
  }
}

/** Failure that is worth retrying (network error, 5xx, short 429). */
export class TransientError extends AppError {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super(message, 'TRANSIENT', options);
  }
}

export class DownloadError extends AppError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'DOWNLOAD', options);
  }
}

/** Something that needs to be configured (e.g. the Figma token) before this call can work. */
export class AuthError extends AppError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'AUTH', options);
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
