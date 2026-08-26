import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import { AccountSelectionError } from '../src/services/ingest.js';
import { SnaptradeServiceError } from '../src/services/snaptrade.js';

const fixtureAccounts = JSON.parse(
  readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'fixtures',
      'accounts.json',
    ),
    'utf8',
  ),
);

function makeConfig(overrides = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    SNAPTRADE_CLIENT_ID: 'test-client-id',
    SNAPTRADE_CONSUMER_KEY: 'test-consumer-key',
    INGEST_ENABLED: 'false',
    ...overrides,
  });
}

function makeDeps(overrides = {}) {
  return {
    config: makeConfig(),
    snaptrade: {
      authMode: 'personal',
      listAccounts: async () => fixtureAccounts,
    },
    ingest: {
      run: async () => ({ ok: true, endpoints: [] }),
      getLastRun: () => null,
      isRunning: () => false,
    },
    snapshots: {
      list: async () => [
        {
          accountId: 'acct-1',
          endpoint: 'balances',
          file: '2026-08-23T12-00-00-000Z-abcdef0123456789.json',
          relativePath: 'raw/accounts/acct-1/balances/x.json',
        },
      ],
      readRaw: async () => ({ envelope: true }),
      status: async () => ({ lastSuccessAt: null, stale: true, ageMs: null }),
    },
    ...overrides,
  };
}

describe('HTTP API', () => {
  it('serves the health check', async () => {
    const response = await request(createApp(makeDeps())).get('/api/health');
    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'ok');
    assert.ok(response.headers['x-request-id']);
  });

  it('reports persisted freshness and scheduler status', async () => {
    const response = await request(createApp(makeDeps())).get('/api/v1/snaptrade/status');
    assert.equal(response.status, 200);
    assert.equal(response.body.freshness.stale, true);
    assert.equal(response.body.scheduler.enabled, false);
  });

  it('returns verified instrument identity through the monitoring route', async () => {
    const opportunityMonitoring = {
      instruments: async (query) => ({ provider: 'fixture', provider_unofficial: false,
        matches: [{ symbol: query.toUpperCase(), name: 'Apple Inc.', instrument_type: 'Equity', exchange: 'NASDAQ', currency: 'USD' }] }),
    };
    const response = await request(createApp(makeDeps({ opportunityMonitoring }))).get('/api/v1/screens/instruments?query=aapl');
    assert.equal(response.status, 200);
    assert.equal(response.body.matches[0].name, 'Apple Inc.');
  });

  it('lists accounts with masked numbers only', async () => {
    const response = await request(createApp(makeDeps())).get(
      '/api/v1/snaptrade/accounts',
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.accounts.length, 3);
    const serialized = JSON.stringify(response.body);
    assert.ok(!serialized.includes('881234567'));
    assert.ok(serialized.includes('****4567'));
  });

  it('returns 409 with candidates when account selection is missing', async () => {
    const deps = makeDeps({
      ingest: {
        run: async () => {
          throw new AccountSelectionError('SNAPTRADE_ACCOUNT_IDS is not configured.', [
            { id: 'acct-1', number: '****4567' },
          ]);
        },
        getLastRun: () => null,
        isRunning: () => false,
      },
    });
    const response = await request(createApp(deps)).post(
      '/api/v1/snaptrade/refresh',
    );
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'ACCOUNT_SELECTION_REQUIRED');
    assert.equal(response.body.error.candidates.length, 1);
  });

  it('maps upstream SnapTrade failures to 502 without secret material', async () => {
    const deps = makeDeps({
      snaptrade: {
        authMode: 'personal',
        listAccounts: async () => {
          const cause = new Error('503 service unavailable');
          cause.status = 503;
          throw new SnaptradeServiceError(
            'accountInformation.listUserAccounts',
            cause,
          );
        },
      },
    });
    const response = await request(createApp(deps)).get(
      '/api/v1/snaptrade/accounts',
    );
    assert.equal(response.status, 502);
    assert.equal(response.body.error.code, 'UPSTREAM_ERROR');
    assert.equal(response.body.error.upstreamStatus, 503);
  });

  it('distinguishes an upstream rate limit', async () => {
    const cause = Object.assign(new Error('rate limited'), { status: 429 });
    const deps = makeDeps({ snaptrade: { authMode: 'personal', listAccounts: async () => { throw new SnaptradeServiceError('list', cause); } } });
    const response = await request(createApp(deps)).get('/api/v1/snaptrade/accounts');
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'UPSTREAM_RATE_LIMITED');
  });

  it('rejects snapshot raw reads with invalid paths', async () => {
    const deps = makeDeps({
      snapshots: {
        list: async () => [],
        readRaw: async () => {
          const error = new Error('Invalid snapshot path');
          error.name = 'SnapshotPathError';
          throw error;
        },
      },
    });
    const response = await request(createApp(deps)).get(
      '/api/v1/snaptrade/snapshots/raw?path=../../secret',
    );
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'INVALID_PATH');
  });

  it('lists snapshots', async () => {
    const response = await request(createApp(makeDeps())).get(
      '/api/v1/snaptrade/snapshots?limit=10',
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.snapshots.length, 1);
  });

  it('returns JSON 404 for unknown API routes', async () => {
    const response = await request(createApp(makeDeps())).get(
      '/api/v1/snaptrade/nope',
    );
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'NOT_FOUND');
  });
});
