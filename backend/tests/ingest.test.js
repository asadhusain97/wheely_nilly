import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { loadConfig } from '../src/config/index.js';
import {
  AccountSelectionError,
  createIngestService,
} from '../src/services/ingest.js';

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

function makeFakeSnaptrade(overrides = {}) {
  const calls = [];
  return {
    calls,
    authMode: 'personal',
    async listAccounts() {
      return fixtureAccounts;
    },
    async getBalances(accountId) {
      calls.push(['balances', accountId]);
      return { balances: [] };
    },
    async getPositions(accountId) {
      calls.push(['positions', accountId]);
      return { positions: [] };
    },
    async getOrders(accountId, days) {
      calls.push(['orders', accountId, days]);
      return [];
    },
    async getActivities(accountId, window) {
      calls.push(['activities', accountId, window]);
      return [];
    },
    ...overrides,
  };
}

function makeFakeSnapshots() {
  const writes = [];
  return {
    writes,
    async write(entry) {
      writes.push(entry);
      return { skipped: false, hash: 'a'.repeat(64), path: '/tmp/fake.json' };
    },
  };
}

describe('ingest service', () => {
  it('refuses to run without explicitly pinned account IDs', async () => {
    const ingest = createIngestService({
      config: makeConfig({ SNAPTRADE_ACCOUNT_IDS: '' }),
      snaptrade: makeFakeSnaptrade(),
      snapshots: makeFakeSnapshots(),
      logger: { error: () => {}, info: () => {} },
    });
    await assert.rejects(ingest.run('manual'), (error) => {
      assert.equal(error.name, 'AccountSelectionError');
      assert.match(error.message, /SNAPTRADE_ACCOUNT_IDS/);
      assert.equal(error.candidates.length, 3);
      assert.ok(
        error.candidates.every(
          (candidate) => !String(candidate.number).includes('881234567'),
        ),
      );
      return true;
    });
  });

  it('rejects configured IDs that do not exist upstream', async () => {
    const ingest = createIngestService({
      config: makeConfig({ SNAPTRADE_ACCOUNT_IDS: 'acct-does-not-exist' }),
      snaptrade: makeFakeSnaptrade(),
      snapshots: makeFakeSnapshots(),
      logger: { error: () => {}, info: () => {} },
    });
    await assert.rejects(ingest.run('manual'), /acct-does-not-exist/);
  });

  it('ingests all four endpoints for each selected account', async () => {
    const snaptrade = makeFakeSnaptrade();
    const snapshots = makeFakeSnapshots();
    const ingest = createIngestService({
      config: makeConfig({
        SNAPTRADE_ACCOUNT_IDS: 'acct-individual-1,acct-individual-2',
      }),
      snaptrade,
      snapshots,
      logger: { error: () => {}, info: () => {} },
    });
    const report = await ingest.run('manual');
    assert.equal(report.ok, true);
    assert.equal(report.endpoints.length, 8);
    assert.equal(snapshots.writes.length, 8);
    const orderCalls = snaptrade.calls.filter(([name]) => name === 'orders');
    assert.deepEqual(
      orderCalls.map(([, accountId, days]) => [accountId, days]),
      [
        ['acct-individual-1', 90],
        ['acct-individual-2', 90],
      ],
    );
    const activityCalls = snaptrade.calls.filter(([name]) => name === 'activities');
    assert.deepEqual(activityCalls, [
      ['activities', 'acct-individual-1', undefined],
      ['activities', 'acct-individual-2', undefined],
    ]);
  });

  it('continues other endpoints when one step fails and marks the report', async () => {
    const snaptrade = makeFakeSnaptrade({
      async getPositions() {
        throw new Error('boom');
      },
    });
    const ingest = createIngestService({
      config: makeConfig({ SNAPTRADE_ACCOUNT_IDS: 'acct-individual-1' }),
      snaptrade,
      snapshots: makeFakeSnapshots(),
      logger: { error: () => {}, info: () => {} },
    });
    const report = await ingest.run('manual');
    assert.equal(report.ok, false);
    const failed = report.endpoints.filter((entry) => entry.status === 'error');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].endpoint, 'positions');
    assert.equal(
      report.endpoints.filter((entry) => entry.status === 'ok').length,
      3,
    );
  });

  it('prevents overlapping runs by sharing the in-flight promise', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const snaptrade = makeFakeSnaptrade({
      async listAccounts() {
        await gate;
        return fixtureAccounts;
      },
    });
    const ingest = createIngestService({
      config: makeConfig({ SNAPTRADE_ACCOUNT_IDS: 'acct-individual-1' }),
      snaptrade,
      snapshots: makeFakeSnapshots(),
      logger: { error: () => {}, info: () => {} },
    });
    const first = ingest.run('schedule');
    const second = ingest.run('manual');
    assert.equal(ingest.isRunning(), true);
    assert.strictEqual(first, second);
    release();
    await first;
    assert.equal(ingest.isRunning(), false);
    assert.equal(ingest.getLastRun().trigger, 'schedule');
  });
});
