import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { computeDelayMs, isRetryable, withRetry } from '../src/lib/retry.js';

describe('isRetryable', () => {
  it('retries 429 and 5xx statuses', () => {
    assert.equal(isRetryable({ status: 429 }), true);
    assert.equal(isRetryable({ status: 500 }), true);
    assert.equal(isRetryable({ status: 503 }), true);
  });

  it('does not retry permanent client errors', () => {
    assert.equal(isRetryable({ status: 400 }), false);
    assert.equal(isRetryable({ status: 401 }), false);
    assert.equal(isRetryable({ status: 403 }), false);
    assert.equal(isRetryable({ status: 404 }), false);
  });

  it('retries transient network codes', () => {
    assert.equal(isRetryable({ code: 'ECONNRESET' }), true);
    assert.equal(isRetryable({ code: 'ETIMEDOUT' }), true);
    assert.equal(isRetryable({ code: 'ENOTFOUND' }), true);
  });
});

describe('computeDelayMs', () => {
  it('grows exponentially with zero jitter at the midpoint', () => {
    const midpoint = () => 0.5;
    assert.equal(computeDelayMs(0, 500, 8000, midpoint), 500);
    assert.equal(computeDelayMs(1, 500, 8000, midpoint), 1000);
    assert.equal(computeDelayMs(2, 500, 8000, midpoint), 2000);
  });

  it('caps at maxMs', () => {
    assert.equal(computeDelayMs(10, 500, 8000, () => 0.5), 8000);
  });

  it('stays within +/-25% jitter bounds', () => {
    assert.equal(computeDelayMs(1, 1000, 8000, () => 1), 2500);
    assert.equal(computeDelayMs(1, 1000, 8000, () => 0), 1500);
  });
});

describe('withRetry', () => {
  it('succeeds after transient failures without real sleeping', async () => {
    const delays = [];
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          const error = new Error('upstream down');
          error.status = 503;
          throw error;
        }
        return 'ok';
      },
      { retries: 3, baseMs: 100, sleep: async (ms) => delays.push(ms), random: () => 0.5 },
    );
    assert.equal(result, 'ok');
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [100, 200]);
  });

  it('does not retry permanent failures', async () => {
    let attempts = 0;
    await assert.rejects(
      withRetry(
        async () => {
          attempts += 1;
          const error = new Error('unauthorized');
          error.status = 401;
          throw error;
        },
        { retries: 3, sleep: async () => {} },
      ),
      /unauthorized/,
    );
    assert.equal(attempts, 1);
  });

  it('gives up after the configured number of retries', async () => {
    let attempts = 0;
    await assert.rejects(
      withRetry(
        async () => {
          attempts += 1;
          const error = new Error('still down');
          error.status = 500;
          throw error;
        },
        { retries: 2, sleep: async () => {} },
      ),
      /still down/,
    );
    assert.equal(attempts, 3);
  });
});
