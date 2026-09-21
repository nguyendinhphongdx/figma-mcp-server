import { z } from 'zod';
import { ConfigError } from '../core/domain/errors.js';
import { parseApiKeyConfig } from '../core/security/api-keys.js';
import type { Tier } from '../core/rate-limit/governor.js';
import type { CacheTtls } from '../features/shared/cache-ttls.js';

const csv = z
  .string()
  .default('')
  .transform((value) => value.split(',').map((part) => part.trim()).filter(Boolean));

const flag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const DAY_SECONDS = 24 * 60 * 60;

const envSchema = z.object({
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  /** Externally visible origin of this server; download links are built from it. */
  PUBLIC_BASE_URL: z.url(),
  /** Browser origins allowed to call /mcp. Empty = reject any request that carries an Origin header. */
  ALLOWED_ORIGINS: csv,
  MAX_REQUEST_BODY_BYTES: positiveInt(1_048_576),

  /** Optional: only used to seed the Admin UI's store on first run. Empty means "configure it in the UI". */
  FIGMA_TOKEN: z
    .string()
    .default('')
    .refine((value) => value === '' || value.length >= 10, 'FIGMA_TOKEN looks too short'),
  FIGMA_API_BASE_URL: z.url().default('https://api.figma.com'),
  /** Empty = any file the token can open. */
  FIGMA_ALLOWED_FILE_KEYS: csv,
  /** Sustained requests per minute per tier. Defaults match a Professional Dev/Full seat. */
  FIGMA_TIER1_RPM: positiveInt(10),
  FIGMA_TIER2_RPM: positiveInt(25),
  FIGMA_TIER3_RPM: positiveInt(50),
  FIGMA_MAX_QUEUE_WAIT_SECONDS: positiveInt(20),
  /** Response bytes that count as one extra request's worth of budget. See the governor. */
  FIGMA_COST_BYTES_PER_UNIT: positiveInt(512 * 1024),
  FIGMA_MAX_RETRY_AFTER_WAIT_SECONDS: positiveInt(60),
  FIGMA_REQUEST_TIMEOUT_SECONDS: positiveInt(120),
  FIGMA_MAX_RETRIES: z.coerce.number().int().min(0).default(3),

  /** Optional: comma-separated `name=<sha256 hex>` pairs, only used to seed the Admin UI's
   * store on first run. Empty means "add users in the UI". See `npm run key:generate`. */
  MCP_API_KEYS: z.string().default(''),
  REQUESTS_PER_MINUTE_PER_USER: positiveInt(120),

  DOWNLOAD_SIGNING_SECRET: z.string().min(32, 'DOWNLOAD_SIGNING_SECRET must be at least 32 characters'),
  DOWNLOAD_URL_TTL_SECONDS: positiveInt(3600),

  DATA_DIR: z.string().default('./data'),
  CACHE_TTL_STRUCTURE_SECONDS: positiveInt(600),
  CACHE_TTL_COMMENTS_SECONDS: positiveInt(120),
  CACHE_MEMORY_MAX_ENTRIES: positiveInt(500),

  EXPORT_MAX_NODES: positiveInt(300),
  EXPORT_BATCH_SIZE: positiveInt(100),
  EXPORT_DOWNLOAD_CONCURRENCY: positiveInt(5),
  EXPORT_RETENTION_HOURS: positiveInt(24),
  EXPORT_MAX_IMAGE_BYTES: positiveInt(50 * 1024 * 1024),
  /** Hostname suffixes images may be downloaded from. */
  IMAGE_HOST_ALLOWLIST: csv.transform((hosts) => (hosts.length > 0 ? hosts : ['amazonaws.com', 'figma.com'])),
  /** Test-only escape hatch: allow http:// image URLs. */
  ALLOW_INSECURE_IMAGE_URLS: flag,

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
});

export interface AppConfig {
  readonly server: {
    readonly host: string;
    readonly port: number;
    readonly publicBaseUrl: string;
    readonly allowedOrigins: readonly string[];
    readonly maxRequestBodyBytes: number;
  };
  readonly figma: {
    readonly token: string;
    readonly apiBaseUrl: string;
    readonly allowedFileKeys: readonly string[];
    readonly requestsPerMinute: Readonly<Record<Tier, number>>;
    readonly maxQueueWaitMs: number;
    readonly costBytesPerUnit: number;
    readonly maxRetryAfterWaitSeconds: number;
    readonly requestTimeoutMs: number;
    readonly maxRetries: number;
  };
  readonly auth: {
    readonly apiKeyHashes: ReadonlyMap<string, string>;
    readonly requestsPerMinutePerUser: number;
  };
  readonly downloads: {
    readonly signingSecret: string;
    readonly urlTtlSeconds: number;
  };
  readonly storage: {
    readonly dataDir: string;
    readonly cacheMemoryMaxEntries: number;
    readonly ttls: CacheTtls;
  };
  readonly export: {
    readonly maxNodes: number;
    readonly batchSize: number;
    readonly downloadConcurrency: number;
    readonly retentionHours: number;
    readonly maxImageBytes: number;
    readonly imageHostAllowlist: readonly string[];
    readonly allowInsecureImageUrls: boolean;
  };
  readonly logLevel: string;
}

/** Validates the environment once at start-up so misconfiguration fails fast with a readable message. */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  - ${issue.path.join('.') || 'env'}: ${issue.message}`);
    throw new ConfigError(`Invalid configuration:\n${problems.join('\n')}`);
  }
  const values = parsed.data;

  return {
    server: {
      host: values.HOST,
      port: values.PORT,
      publicBaseUrl: values.PUBLIC_BASE_URL.replace(/\/+$/, ''),
      allowedOrigins: values.ALLOWED_ORIGINS,
      maxRequestBodyBytes: values.MAX_REQUEST_BODY_BYTES,
    },
    figma: {
      token: values.FIGMA_TOKEN,
      apiBaseUrl: values.FIGMA_API_BASE_URL.replace(/\/+$/, ''),
      allowedFileKeys: values.FIGMA_ALLOWED_FILE_KEYS,
      requestsPerMinute: { 1: values.FIGMA_TIER1_RPM, 2: values.FIGMA_TIER2_RPM, 3: values.FIGMA_TIER3_RPM },
      maxQueueWaitMs: values.FIGMA_MAX_QUEUE_WAIT_SECONDS * 1000,
      costBytesPerUnit: values.FIGMA_COST_BYTES_PER_UNIT,
      maxRetryAfterWaitSeconds: values.FIGMA_MAX_RETRY_AFTER_WAIT_SECONDS,
      requestTimeoutMs: values.FIGMA_REQUEST_TIMEOUT_SECONDS * 1000,
      maxRetries: values.FIGMA_MAX_RETRIES,
    },
    auth: {
      apiKeyHashes: values.MCP_API_KEYS ? parseApiKeyConfig(values.MCP_API_KEYS) : new Map(),
      requestsPerMinutePerUser: values.REQUESTS_PER_MINUTE_PER_USER,
    },
    downloads: {
      signingSecret: values.DOWNLOAD_SIGNING_SECRET,
      urlTtlSeconds: values.DOWNLOAD_URL_TTL_SECONDS,
    },
    storage: {
      dataDir: values.DATA_DIR,
      cacheMemoryMaxEntries: values.CACHE_MEMORY_MAX_ENTRIES,
      ttls: {
        structureMs: values.CACHE_TTL_STRUCTURE_SECONDS * 1000,
        commentsMs: values.CACHE_TTL_COMMENTS_SECONDS * 1000,
        // Figma image URLs live 30 days; expire ours a day earlier.
        imageUrlMs: 29 * DAY_SECONDS * 1000,
      },
    },
    export: {
      maxNodes: values.EXPORT_MAX_NODES,
      batchSize: values.EXPORT_BATCH_SIZE,
      downloadConcurrency: values.EXPORT_DOWNLOAD_CONCURRENCY,
      retentionHours: values.EXPORT_RETENTION_HOURS,
      maxImageBytes: values.EXPORT_MAX_IMAGE_BYTES,
      imageHostAllowlist: values.IMAGE_HOST_ALLOWLIST,
      allowInsecureImageUrls: values.ALLOW_INSECURE_IMAGE_URLS,
    },
    logLevel: values.LOG_LEVEL,
  };
}
