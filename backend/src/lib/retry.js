const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNABORTED',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNREFUSED',
]);

export function isRetryable(error) {
  const status = error?.status;
  if (typeof status === 'number') {
    return status === 429 || status >= 500;
  }
  return RETRYABLE_NETWORK_CODES.has(error?.code);
}

export function computeDelayMs(attempt, baseMs, maxMs, random = Math.random) {
  const exponential = baseMs * 2 ** attempt;
  const capped = Math.min(exponential, maxMs);
  const jitter = capped * 0.25 * (random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry(
  fn,
  {
    retries = 3,
    baseMs = 500,
    maxMs = 8000,
    random = Math.random,
    sleep = defaultSleep,
  } = {},
) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === retries || !isRetryable(error)) {
        throw error;
      }
      await sleep(computeDelayMs(attempt, baseMs, maxMs, random));
    }
  }
  throw lastError;
}
