import { EmailError } from "./errors";

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Up to 3 attempts with exponential backoff and full jitter. Only errors an
 * adapter marked retryable (429, 5xx, network) are retried; permanent
 * failures surface immediately (contract invariant 4).
 */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const retryable = e instanceof EmailError && e.retryable;
      if (!retryable || attempt === MAX_ATTEMPTS - 1) throw e;
      await sleep(BASE_DELAY_MS * 2 ** attempt + Math.random() * BASE_DELAY_MS);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
