import { TransientError } from '../core/domain/errors.js';

export type Sleep = (ms: number) => Promise<void>;

export const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export type Clock = () => number;

export interface RetryPolicy {
  /** Total attempts including the first one. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export type RetryDecision =
  | { readonly retry: false }
  | { readonly retry: true; readonly delayMs?: number | undefined };

export interface RetryInfo {
  readonly attempt: number;
  readonly delayMs: number;
  readonly error: unknown;
}

export interface RetryOptions {
  readonly policy: RetryPolicy;
  /** Decides whether an error is retryable and, optionally, how long to wait. */
  readonly classify: (error: unknown) => RetryDecision;
  readonly sleep?: Sleep;
  readonly random?: () => number;
  readonly onRetry?: (info: RetryInfo) => void;
}

/** Exponential backoff with jitter: the delay lands in [50%, 100%] of the exponential step. */
export function backoffDelay(attempt: number, policy: RetryPolicy, random: () => number): number {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.round(exponential * (0.5 + random() / 2));
}

export function classifyTransient(error: unknown): RetryDecision {
  return error instanceof TransientError
    ? { retry: true, delayMs: error.retryAfterMs }
    : { retry: false };
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const { policy, classify, sleep = defaultSleep, random = Math.random, onRetry } = options;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      const decision = classify(error);
      if (!decision.retry || attempt >= policy.maxAttempts) {
        throw error;
      }
      const delayMs = decision.delayMs ?? backoffDelay(attempt, policy, random);
      onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
}
