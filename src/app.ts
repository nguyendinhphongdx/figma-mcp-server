import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createHttpHandler } from './adapters/http/http-handler.js';
import { SignedDownloadLinks } from './adapters/http/download-links.js';
import { SlidingWindowLimiter } from './adapters/http/sliding-window-limiter.js';
import { createMcpServer } from './adapters/mcp/create-mcp-server.js';
import type { UseCases } from './adapters/mcp/tools.js';
import type { AppConfig } from './config/config.js';
import { AdminStore } from './core/admin/admin-store.js';
import { SessionStore } from './core/admin/sessions.js';
import { CachedLoader } from './core/cache/cached-loader.js';
import { DiskCache, LayeredCache, MemoryTtlCache, type CachePort } from './core/cache/cache.js';
import { FetchImageDownloader } from './core/figma/image-downloader.js';
import { HttpFigmaApi } from './core/figma/http-figma-api.js';
import type { FigmaApi } from './core/figma/figma-api.js';
import { TokenBucketGovernor, type RateLimitGate } from './core/rate-limit/governor.js';
import { FileGovernorStateStore } from './core/rate-limit/governor-state.js';
import { ApiKeyAuthenticator } from './core/security/api-keys.js';
import { FileAccessPolicy } from './core/security/file-access-policy.js';
import { ImageUrlPolicy } from './core/security/image-url-policy.js';
import { UrlSigner } from './core/security/url-signer.js';
import { LocalDiskExportStorage, type ExportStorage } from './core/storage/export-storage.js';
import { GetCommentsUseCase } from './features/comments/get-comments.js';
import { ExportFramesUseCase } from './features/export/export-frames.js';
import { GetSvgUseCase } from './features/export/get-svg.js';
import { FileOutlineService } from './features/frames/file-outline.js';
import { ListFramesUseCase } from './features/frames/list-frames.js';
import { LibraryReader, ListLibraryUseCase } from './features/library/list-library.js';
import { GetNodeTreeUseCase } from './features/nodes/get-node-tree.js';
import { GetNodeSpecUseCase } from './features/nodes/get-node-spec.js';
import { FileIndexService } from './features/search/file-index.js';
import { SearchNodesUseCase } from './features/search/search-nodes.js';
import { GetQuotaStatusUseCase } from './features/quota/get-quota-status.js';
import { FileResolver } from './features/shared/file-resolver.js';
import { GetDesignTokensUseCase } from './features/tokens/design-tokens.js';
import type { Logger } from './infra/logger.js';
import type { Sleep } from './infra/retry.js';

/** Seams that tests (and only tests) replace. Production wiring uses the defaults. */
export interface AppOverrides {
  readonly fetch?: typeof fetch;
  readonly sleep?: Sleep;
  readonly clock?: () => number;
  readonly figmaApi?: FigmaApi;
}

export interface App {
  readonly server: Server;
  readonly useCases: UseCases;
  readonly governor: RateLimitGate;
  readonly storage: ExportStorage;
  readonly admin: AdminStore;
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/** Composition root: the only place that knows which concrete classes implement which port. */
export function buildApp(config: AppConfig, logger: Logger, overrides: AppOverrides = {}): App {
  const clock = overrides.clock ?? Date.now;
  const retryPolicy = { maxAttempts: config.figma.maxRetries + 1, baseDelayMs: 1_000, maxDelayMs: 30_000 };

  // --- admin store (Figma token + users are hot-reloadable; everything else is static) ---
  const adminStore = new AdminStore(join(config.storage.dataDir, 'admin.json'));
  adminStore.seedFromEnv(config.figma.token, config.auth.apiKeyHashes);
  const sessions = new SessionStore(clock);

  // --- rate limiting + Figma access -------------------------------------------------------
  const governor = new TokenBucketGovernor({
    policies: {
      1: policyFor(config.figma.requestsPerMinute[1]),
      2: policyFor(config.figma.requestsPerMinute[2]),
      3: policyFor(config.figma.requestsPerMinute[3]),
    },
    maxQueueWaitMs: config.figma.maxQueueWaitMs,
    costBytesPerUnit: config.figma.costBytesPerUnit,
    store: new FileGovernorStateStore(join(config.storage.dataDir, 'governor.json'), (reason) =>
      logger.warn('Could not persist rate-limit state', { reason }),
    ),
    clock,
    ...(overrides.sleep ? { sleep: overrides.sleep } : {}),
  });

  const api: FigmaApi =
    overrides.figmaApi ??
    new HttpFigmaApi({
      token: () => adminStore.getFigmaToken(),
      baseUrl: config.figma.apiBaseUrl,
      gate: governor,
      retryPolicy,
      maxRetryAfterWaitSeconds: config.figma.maxRetryAfterWaitSeconds,
      requestTimeoutMs: config.figma.requestTimeoutMs,
      logger,
      ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
      ...(overrides.sleep ? { sleep: overrides.sleep } : {}),
    });

  // --- caching ---------------------------------------------------------------------------
  const memory = new MemoryTtlCache(config.storage.cacheMemoryMaxEntries, clock);
  const cache: CachePort = new LayeredCache(
    memory,
    new DiskCache(join(config.storage.dataDir, 'cache'), clock),
    config.storage.ttls.structureMs,
  );
  const loader = new CachedLoader(cache);

  // --- security + storage ----------------------------------------------------------------
  const policy = new FileAccessPolicy(config.figma.allowedFileKeys);
  const files = new FileResolver(policy);
  const signer = new UrlSigner(config.downloads.signingSecret);
  const storage = new LocalDiskExportStorage(join(config.storage.dataDir, 'exports'));
  const links = new SignedDownloadLinks(config.server.publicBaseUrl, signer, config.downloads.urlTtlSeconds);
  const downloader = new FetchImageDownloader({
    policy: new ImageUrlPolicy({
      allowedHostSuffixes: config.export.imageHostAllowlist,
      allowInsecure: config.export.allowInsecureImageUrls,
    }),
    retryPolicy,
    requestTimeoutMs: 60_000,
    maxBytes: config.export.maxImageBytes,
    logger,
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
    ...(overrides.sleep ? { sleep: overrides.sleep } : {}),
  });

  // --- use cases -------------------------------------------------------------------------
  const ttls = config.storage.ttls;
  const outlines = new FileOutlineService(api, loader, ttls);
  const index = new FileIndexService(api, loader, ttls);
  const library = new LibraryReader(api, loader, ttls);
  const useCases: UseCases = {
    listFrames: new ListFramesUseCase(files, outlines),
    searchNodes: new SearchNodesUseCase(files, outlines, index),
    getNodeTree: new GetNodeTreeUseCase(api, loader, files, ttls),
    getNodeSpec: new GetNodeSpecUseCase(api, loader, files, ttls),
    exportFrames: new ExportFramesUseCase(api, loader, files, outlines, downloader, storage, links, ttls, {
      maxNodes: config.export.maxNodes,
      batchSize: config.export.batchSize,
      downloadConcurrency: config.export.downloadConcurrency,
    }, logger),
    getSvg: new GetSvgUseCase(api, loader, files, outlines, downloader, ttls, {
      batchSize: config.export.batchSize,
      downloadConcurrency: config.export.downloadConcurrency,
    }),
    listStyles: new ListLibraryUseCase('styles', files, library),
    listComponents: new ListLibraryUseCase('components', files, library),
    getDesignTokens: new GetDesignTokensUseCase(api, loader, files, library, ttls, config.export.batchSize),
    getComments: new GetCommentsUseCase(api, loader, files, ttls),
    getQuotaStatus: new GetQuotaStatusUseCase(governor, loader, policy),
  };

  // --- HTTP ------------------------------------------------------------------------------
  const limiter = new SlidingWindowLimiter(config.auth.requestsPerMinutePerUser, 60_000, clock);
  const loginLimiter = new SlidingWindowLimiter(10, 60_000, clock);
  const server = createServer(
    createHttpHandler({
      authenticator: new ApiKeyAuthenticator(() => adminStore.getApiKeyHashes()),
      limiter,
      signer,
      storage,
      createMcpServer: (principal) => createMcpServer(useCases, principal, logger),
      logger,
      allowedOrigins: config.server.allowedOrigins,
      maxBodyBytes: config.server.maxRequestBodyBytes,
      admin: {
        store: adminStore,
        sessions,
        loginLimiter,
        secureCookies: config.server.publicBaseUrl.startsWith('https://'),
        quota: useCases.getQuotaStatus,
        logger,
      },
    }),
  );

  // --- housekeeping ----------------------------------------------------------------------
  const sweeper = setInterval(() => {
    const cutoff = clock() - config.export.retentionHours * 60 * 60 * 1000;
    Promise.all([storage.purgeOlderThan(cutoff), cache.sweep()])
      .then(([exports, cacheEntries]) => {
        limiter.sweep();
        loginLimiter.sweep();
        sessions.sweep();
        if (exports > 0 || cacheEntries > 0) logger.info('housekeeping', { exportsRemoved: exports, cacheEntriesRemoved: cacheEntries });
      })
      .catch((error: unknown) => logger.warn('housekeeping failed', { reason: String(error) }));
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();

  return {
    server,
    useCases,
    governor,
    storage,
    admin: adminStore,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.server.port, config.server.host, () => {
          const address = server.address() as AddressInfo;
          resolve({ host: address.address, port: address.port });
        });
      }),
    close: () =>
      new Promise((resolve, reject) => {
        clearInterval(sweeper);
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      }),
  };
}

function policyFor(requestsPerMinute: number) {
  // Allow about half a minute's worth back-to-back, then pace evenly.
  return { requestsPerMinute, burst: Math.max(1, Math.ceil(requestsPerMinute / 2)) };
}
