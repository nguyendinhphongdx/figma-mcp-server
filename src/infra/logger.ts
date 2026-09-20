import { pino, type Logger as PinoLogger } from 'pino';

export type LogContext = Record<string, unknown>;

/** Minimal structured-logging port; core code never depends on pino directly. */
export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

class PinoAdapter implements Logger {
  constructor(private readonly pinoLogger: PinoLogger) {}

  debug(message: string, context: LogContext = {}): void {
    this.pinoLogger.debug(context, message);
  }

  info(message: string, context: LogContext = {}): void {
    this.pinoLogger.info(context, message);
  }

  warn(message: string, context: LogContext = {}): void {
    this.pinoLogger.warn(context, message);
  }

  error(message: string, context: LogContext = {}): void {
    this.pinoLogger.error(context, message);
  }
}

export function createLogger(level: string): Logger {
  return new PinoAdapter(
    pino({
      level,
      // Defence in depth: credentials must never reach the logs, whatever a caller passes in.
      redact: {
        paths: ['token', 'authorization', 'headers.authorization', 'headers["x-figma-token"]', '*.token', '*.apiKey'],
        censor: '[redacted]',
      },
    }),
  );
}
