/**
 * Maps `items` through `worker` with at most `limit` concurrent executions.
 * Results keep the input order. The first rejection rejects the whole call,
 * so workers that must not abort the batch should catch their own errors.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`Concurrency limit must be a positive integer, got ${limit}`);
  }

  const results = new Array<R>(items.length);
  let cursor = 0;

  const runLane = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index] as T, index);
    }
  };

  const lanes = Array.from({ length: Math.min(limit, items.length) }, runLane);
  await Promise.all(lanes);
  return results;
}

/** Splits `items` into consecutive groups of at most `size` elements. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`Chunk size must be a positive integer, got ${size}`);
  }
  const groups: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    groups.push(items.slice(start, start + size));
  }
  return groups;
}
