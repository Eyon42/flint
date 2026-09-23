import os from "node:os";

export function defaultConcurrency(): number {
  const parallelism = os.availableParallelism();
  return Math.max(1, Math.min(parallelism, 8));
}

export interface Limiter {
  <T>(fn: () => Promise<T>): Promise<T>;
  readonly active: number;
  readonly max: number;
}

export function createLimiter(maxConcurrency: number): Limiter {
  const max = Math.max(1, Math.floor(maxConcurrency));
  let active = 0;
  const waiting: Array<() => void> = [];

  const release = (): void => {
    active -= 1;
    const resume = waiting.shift();
    if (resume) {
      active += 1;
      resume();
    }
  };

  const limiter = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < max) {
      active += 1;
    } else {
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
      });
    }
    try {
      return await fn();
    } finally {
      release();
    }
  };

  return Object.defineProperties(limiter, {
    active: { get: () => active },
    max: { get: () => max },
  }) as Limiter;
}

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limiter = createLimiter(limit);
  return Promise.all(
    items.map((item, index) => limiter(() => fn(item, index))),
  );
}
