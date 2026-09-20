import { buildApp } from './app.js';
import { loadConfig } from './config/config.js';
import { AppError } from './core/domain/errors.js';
import { createLogger } from './infra/logger.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    // Logger needs the level from config, so report configuration problems on stderr directly.
    console.error(error instanceof AppError ? error.message : error);
    process.exit(78); // EX_CONFIG
  }

  const logger = createLogger(config.logLevel);
  const app = buildApp(config, logger);
  const { host, port } = await app.listen();
  logger.info('figma-mcp-server listening', {
    host,
    port,
    publicBaseUrl: config.server.publicBaseUrl,
    users: app.admin.listUsers().map((user) => user.name),
    figmaTokenConfigured: app.admin.getFigmaToken() !== '',
    restrictedToFiles: config.figma.allowedFileKeys.length > 0,
  });
  if (!app.admin.hasAdmin()) {
    logger.info(`No admin account yet — open ${config.server.publicBaseUrl}/ to finish setup.`);
  }

  const shutdown = (signal: string) => {
    logger.info('shutting down', { signal });
    app
      .close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error('shutdown failed', { reason: String(error) });
        process.exit(1);
      });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
