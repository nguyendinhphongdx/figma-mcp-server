import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AppError, RateLimitedError } from '../../core/domain/errors.js';
import type { Principal } from '../../core/security/api-keys.js';
import type { Logger } from '../../infra/logger.js';

export interface ToolContext {
  readonly principal: Principal;
  readonly logger: Logger;
}

export interface ToolErrorPayload {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryAfterSeconds?: number;
    readonly tier?: number;
    readonly source?: string;
    readonly hint?: string;
  };
}

/** Maps any thrown value to a payload that is safe to show a model: no stack traces, no internals. */
export function toToolError(error: unknown): ToolErrorPayload {
  if (error instanceof RateLimitedError) {
    const { retryAfterSeconds, tier, source } = error.details;
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
        tier,
        source,
        hint: 'Do not retry before retryAfterSeconds have passed. Call figma_quota_status to inspect the shared budget, and prefer cached results.',
      },
    };
  }
  if (error instanceof AppError) {
    return { error: { code: error.code, message: error.message } };
  }
  return { error: { code: 'INTERNAL', message: 'Unexpected server error. It has been logged.' } };
}

/** An image the tool sends alongside its JSON payload. */
export interface InlineImage {
  readonly mimeType: string;
  readonly base64: string;
}

function ok(data: object, images: readonly InlineImage[] = []): CallToolResult {
  return {
    content: [
      { type: 'text', text: JSON.stringify(data) },
      ...images.map((image) => ({ type: 'image' as const, data: image.base64, mimeType: image.mimeType })),
    ],
    structuredContent: data as Record<string, unknown>,
  };
}

function failure(payload: ToolErrorPayload): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload as unknown as Record<string, unknown>,
  };
}

/**
 * Runs a use-case for a tool call: times it, logs it against the calling principal,
 * and converts failures into MCP error results instead of protocol errors.
 */
export async function runTool(
  context: ToolContext,
  tool: string,
  operation: () => Promise<object>,
): Promise<CallToolResult> {
  return runMediaTool(context, tool, async () => ({ data: await operation() }));
}

/**
 * Like `runTool`, but the operation may also return images to attach as content blocks.
 * The images never reach `data`: base64 in the JSON payload would be billed as text tokens and
 * read by nothing.
 */
export async function runMediaTool(
  context: ToolContext,
  tool: string,
  operation: () => Promise<{ data: object; images?: readonly InlineImage[] }>,
): Promise<CallToolResult> {
  const startedAt = Date.now();
  try {
    const { data, images } = await operation();
    context.logger.info('tool call', {
      tool,
      principal: context.principal.name,
      ms: Date.now() - startedAt,
      ok: true,
      ...(images?.length ? { images: images.length } : {}),
    });
    return ok(data, images ?? []);
  } catch (error) {
    const payload = toToolError(error);
    const level = error instanceof AppError ? 'warn' : 'error';
    context.logger[level]('tool call failed', {
      tool,
      principal: context.principal.name,
      ms: Date.now() - startedAt,
      code: payload.error.code,
      reason: error instanceof Error ? error.message : String(error),
      ...(error instanceof AppError ? {} : { stack: error instanceof Error ? error.stack : undefined }),
    });
    return failure(payload);
  }
}
