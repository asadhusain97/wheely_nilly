import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';

const config = loadConfig({ NODE_ENV: 'test', SNAPTRADE_CLIENT_ID: 'client', SNAPTRADE_CONSUMER_KEY: 'secret', INGEST_ENABLED: 'false' });
const model = {
  calculationVersion: 'wheel-v1', generatedAt: '2026-08-23T12:00:00.000Z', freshness: { stale: false },
  summary: { cycleCount: 1 }, positions: [], premiumLedger: [], reviewEvents: [],
  dashboard: { kpis: { bookedProfit: '100.00' }, opportunities: {}, openTrades: [], tickerPerformance: [], quality: {} },
  cycles: [{ id: '1', accountId: 'acct-1', underlying: 'WXYZ', stage: 'short_put', openedAt: '2026-08-01T00:00:00Z' }],
};
const app = () => createApp({
  config, snaptrade: { authMode: 'personal' },
  ingest: { isRunning: () => false, getLastRun: () => null },
  snapshots: {}, derived: { load: async () => model },
});

describe('wheel API', () => {
  it('returns versioned, freshness-aware derived responses', async () => {
    const response = await request(app()).get('/api/v1/wheel/summary');
    assert.equal(response.status, 200);
    assert.equal(response.body.calculationVersion, 'wheel-v1');
    assert.equal(response.body.freshness.stale, false);
    assert.match(response.headers['cache-control'], /no-store/);
  });
  it('returns the coherent home dashboard projection', async () => {
    const response = await request(app()).get('/api/v1/wheel/dashboard');
    assert.equal(response.status, 200);
    assert.equal(response.body.kpis.bookedProfit, '100.00');
    assert.deepEqual(response.body.openTrades, []);
  });
  it('filters cycles and bounds invalid queries', async () => {
    const filtered = await request(app()).get('/api/v1/wheel/cycles?symbol=WXYZ&state=short_put');
    assert.equal(filtered.body.cycles.length, 1);
    const invalid = await request(app()).get('/api/v1/wheel/cycles?from=yesterday');
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'INVALID_QUERY');
  });
});
