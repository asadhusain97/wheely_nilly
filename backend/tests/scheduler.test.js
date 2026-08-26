import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createScheduler, runOpportunityAlerts } from '../src/jobs/scheduler.js';

const candidate = {
  contract_symbol: 'AAPL260918P00180000', expiration: '2026-09-18', strike: 180,
  executable_premium: 2.5, annualized_return: 0.24, delta: -0.25,
  spread_percent: 0.08, quote_age_seconds: 30,
};

function config() {
  return {
    timezone: 'UTC', ingest: { enabled: false, cron: '*/30 * * * *' },
    notifications: {
      enabled: true, dailyCap: 5, cooldownMs: 60_000,
      screenerCron: '*/15 10-15 * * 1-5', screenerTimezone: 'America/New_York',
      screenerRule: { minAnnualizedReturn: 0.2, maxDelta: 0.35, maxSpreadPercent: 0.15, maxQuoteAgeSeconds: 900, dashboardUrl: null },
    },
  };
}

describe('scheduled opportunity alerts', () => {
  it('enqueues only the top passing candidate from each successful screen', async () => {
    const events = [];
    let flushes = 0;
    const result = await runOpportunityAlerts({
      config: config(), now: () => Date.parse('2026-08-25T15:00:00Z'),
      monitoring: { scanAll: async () => ({ results: [
        { status: 'success', result: { symbol: 'AAPL', leg: 'cash_secured_put', degraded: false, cache: { stale: false }, candidates: [candidate, { ...candidate, contract_symbol: 'second' }] } },
        { status: 'success', result: { symbol: 'MSFT', leg: 'covered_call', degraded: true, cache: { stale: false }, candidates: [{ ...candidate, contract_symbol: 'degraded' }] } },
        { status: 'error', error: { message: 'provider unavailable' } },
      ] }) },
      notifications: {
        status: async () => ({ rules: { screener: true } }), audit: async () => [],
        enqueue: async (event) => { events.push(event); return { duplicate: false }; },
        flush: async () => { flushes += 1; },
      },
      logger: { warn() {} },
    });
    assert.deepEqual(events.map((event) => event.key), [candidate.contract_symbol]);
    assert.deepEqual(result, { scanned: true, candidates: 2, enqueued: 1, failures: 1 });
    assert.equal(flushes, 1);
  });

  it('registers a non-overlapping market-hours schedule when alerts are enabled', () => {
    const schedules = [];
    const cronImpl = { schedule(expression, callback, options) {
      const task = { expression, callback, options, stopped: false, stop() { this.stopped = true; } };
      schedules.push(task); return task;
    } };
    const scheduler = createScheduler({
      config: config(), ingest: {}, derived: {}, monitoring: {},
      notifications: { flush: async () => {} }, cronImpl,
      logger: { info() {}, error() {} },
    });
    scheduler.start();
    assert.equal(schedules.length, 1);
    assert.equal(schedules[0].expression, '*/15 10-15 * * 1-5');
    assert.deepEqual(schedules[0].options, { timezone: 'America/New_York', noOverlap: true });
    scheduler.stop();
    assert.equal(schedules[0].stopped, true);
  });
});
