import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';

const config = loadConfig({
  NODE_ENV: 'test', SNAPTRADE_CLIENT_ID: 'client', SNAPTRADE_CONSUMER_KEY: 'secret', INGEST_ENABLED: 'false',
});

function appWith(positionManagement) {
  return createApp({
    config, positionManagement,
    snaptrade: { authMode: 'personal' },
    ingest: { isRunning: () => false, getLastRun: () => null },
    snapshots: {},
  });
}

describe('position-management API', () => {
  it('returns current results and triggers an explicit scan', async () => {
    let scans = 0;
    const batch = { scanTimestamp: '2026-08-27T16:00:00.000Z', results: [], failures: 0 };
    const app = appWith({ current: async () => batch, scan: async () => { scans += 1; return batch; } });
    const current = await request(app).get('/api/v1/position-management');
    const refreshed = await request(app).post('/api/v1/position-management/scan');
    assert.equal(current.status, 200);
    assert.equal(refreshed.status, 200);
    assert.equal(scans, 1);
    assert.match(current.headers['cache-control'], /no-store/);
  });

  it('uses the standard error envelope when authoritative inputs cannot load', async () => {
    const app = appWith({ current: async () => { throw new Error('settings unavailable'); }, scan: async () => ({}) });
    const response = await request(app).get('/api/v1/position-management');
    assert.equal(response.status, 500);
    assert.equal(response.body.error.code, 'INTERNAL_ERROR');
  });

  it('rejects browser-supplied contracts and rules', async () => {
    const app = appWith({ current: async () => ({}), scan: async () => ({}) });
    const response = await request(app).post('/api/v1/position-management/scan').send({ symbol: 'RKLB', closeAtProfitCapture: 0.1 });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'INVALID_REQUEST');
  });
});
