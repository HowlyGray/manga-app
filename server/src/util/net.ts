export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serializes async work with a minimum interval between executions.
 * Used to stay well under remote API rate limits.
 */
export class RateLimiter {
  private last = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly minIntervalMs: number) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      const now = Date.now();
      const wait = Math.max(0, this.last + this.minIntervalMs - now);
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      return await fn();
    });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export type FetchOptions = RequestInit & {
  retries?: number;
  /** Extra response codes to retry (treated like throttling/hiccups). Default: 429 + 5xx. */
  retryStatuses?: number[];
};

/**
 * fetch() that retries rate limits and transient 5xx errors, honoring
 * Retry-After headers with exponential backoff.
 */
export async function fetchWithRetry(
  input: string,
  init: FetchOptions = {},
): Promise<Response> {
  const { retries = 5, retryStatuses = [], ...rest } = init;
  const shouldRetry = (status: number) =>
    status === 429 || status >= 500 || retryStatuses.includes(status);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(input, rest);
    if (res.ok) return res;

    const status = res.status;
    const retryAfterMs =
      (Number(res.headers.get('retry-after')) || 0) * 1000 || (status === 429 ? 2000 : 0);
    if (shouldRetry(status) && attempt < retries) {
      const backoff = retryAfterMs || Math.min(1000 * 2 ** attempt, 20000);
      await sleep(backoff);
      continue;
    }
    return res;
  }
}

/** Helper: GET and parse JSON; returns null on non-2xx. */
export async function getJson<T>(
  url: string,
  init: FetchOptions = {},
): Promise<T | null> {
  const res = await fetchWithRetry(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) return null;
  return (await res.json()) as T;
}