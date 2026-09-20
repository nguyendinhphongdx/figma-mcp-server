import { describe, expect, it, vi } from 'vitest';
import { TransientError } from '../../../src/core/domain/errors.js';
import { mapWithConcurrency, chunk } from '../../../src/infra/pool.js';
import { backoffDelay, classifyTransient, withRetry, type RetryPolicy } from '../../../src/infra/retry.js';

const policy: RetryPolicy = { maxAttempts: 4, baseDelayMs: 1_000, maxDelayMs: 5_000 };

describe('backoffDelay', () => {
  it('grows exponentially, is capped, and jitters within [50%, 100%]', () => {
    expect(backoffDelay(1, policy, () => 1)).toBe(1_000);
    expect(backoffDelay(2, policy, () => 1)).toBe(2_000);
    expect(backoffDelay(3, policy, () => 1)).toBe(4_000);
    expect(backoffDelay(4, policy, () => 1)).toBe(5_000); // capped
    expect(backoffDelay(3, policy, () => 0)).toBe(2_000);
  });
});

describe('classifyTransient', () => {
  it('retries TransientError, honouring its delay, and nothing else', () => {
    expect(classifyTransient(new TransientError('x', 1_500))).toEqual({ retry: true, delayMs: 1_500 });
    expect(classifyTransient(new TransientError('x'))).toEqual({ retry: true, delayMs: undefined });
    expect(classifyTransient(new Error('x'))).toEqual({ retry: false });
    expect(classifyTransient('string')).toEqual({ retry: false });
  });
});

describe('withRetry', () => {
  const sleeps: number[] = [];
  const options = () => {
    sleeps.length = 0;
    return { policy, classify: classifyTransient, sleep: async (ms: number) => void sleeps.push(ms), random: () => 1 };
  };

  it('returns immediately on success', async () => {
    const operation = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(operation, options())).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('retries transient failures with backoff and passes the attempt number', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new TransientError('a'))
      .mockRejectedValueOnce(new TransientError('b'))
      .mockResolvedValueOnce('ok');
    const onRetry = vi.fn();

    await expect(withRetry(operation, { ...options(), onRetry })).resolves.toBe('ok');

    expect(operation.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2, 3]);
    expect(sleeps).toEqual([1_000, 2_000]);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('prefers a server-provided delay over backoff', async () => {
    const operation = vi.fn().mockRejectedValueOnce(new TransientError('slow down', 7_000)).mockResolvedValueOnce('ok');
    await withRetry(operation, options());
    expect(sleeps).toEqual([7_000]);
  });

  it('does not retry non-transient errors', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('fatal'));
    await expect(withRetry(operation, options())).rejects.toThrow('fatal');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxAttempts and throws the last error', async () => {
    const operation = vi.fn().mockImplementation(async (attempt: number) => {
      throw new TransientError(`attempt ${attempt}`);
    });
    await expect(withRetry(operation, options())).rejects.toThrow('attempt 4');
    expect(operation).toHaveBeenCalledTimes(4);
  });
});

describe('mapWithConcurrency', () => {
  it('keeps input order regardless of completion order', async () => {
    const delays = [30, 5, 15, 1];
    const result = await mapWithConcurrency(delays, 4, async (ms, index) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return index;
    });
    expect(result).toEqual([0, 1, 2, 3]);
  });

  it('never exceeds the concurrency limit and does use it fully', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    });
    expect(peak).toBe(3);
  });

  it('handles empty input and limits larger than the input', async () => {
    await expect(mapWithConcurrency([], 5, async () => 1)).resolves.toEqual([]);
    await expect(mapWithConcurrency([1, 2], 10, async (n) => n * 2)).resolves.toEqual([2, 4]);
  });

  it('rejects when a worker rejects', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('bad item');
        return n;
      }),
    ).rejects.toThrow('bad item');
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects an invalid limit (%s)', async (limit) => {
    await expect(mapWithConcurrency([1], limit, async (n) => n)).rejects.toThrow(RangeError);
  });
});

describe('chunk', () => {
  it('splits into groups of at most `size`', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([1, 2], 5)).toEqual([[1, 2]]);
    expect(chunk([], 3)).toEqual([]);
  });

  it('does not mutate its input', () => {
    const input = [1, 2, 3];
    chunk(input, 2);
    expect(input).toEqual([1, 2, 3]);
  });

  it.each([0, -2, 0.5])('rejects size %s', (size) => {
    expect(() => chunk([1], size)).toThrow(RangeError);
  });
});
