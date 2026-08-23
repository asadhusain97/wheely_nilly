import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  createSnapshotStore,
  hashPayload,
  stableStringify,
} from '../src/services/snapshots.js';

let dataDir;
let store;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wheel-snapshots-'));
  store = createSnapshotStore({ dataDir });
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('stableStringify / hashPayload', () => {
  it('is insensitive to object key order', () => {
    assert.equal(
      hashPayload({ b: 1, a: { d: [3, 2], c: null } }),
      hashPayload({ a: { c: null, d: [3, 2] }, b: 1 }),
    );
  });

  it('changes when content changes', () => {
    assert.notEqual(hashPayload({ a: 1 }), hashPayload({ a: 2 }));
  });
});

describe('snapshot store', () => {
  it('writes an envelope with schema metadata and 0600 permissions', async () => {
    const result = await store.write({
      accountId: 'acct-1',
      endpoint: 'balances',
      payload: { cash: 1000 },
      fetchedAt: '2026-08-23T12:00:00.000Z',
      durationMs: 42,
      sdkVersion: '12.1.10',
    });
    assert.equal(result.skipped, false);
    const envelope = JSON.parse(await fs.readFile(result.path, 'utf8'));
    assert.equal(envelope.schemaVersion, 1);
    assert.equal(envelope.kind, 'snaptrade-raw-snapshot');
    assert.equal(envelope.source, 'snaptrade');
    assert.equal(envelope.provider, 'snaptrade');
    assert.equal(envelope.endpoint, 'balances');
    assert.equal(envelope.accountId, 'acct-1');
    assert.equal(envelope.contentSha256, hashPayload({ cash: 1000 }));
    assert.deepEqual(envelope.payload, { cash: 1000 });
    const mode = (await fs.stat(result.path)).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it('skips writing when the payload hash is unchanged', async () => {
    const input = {
      accountId: 'acct-1',
      endpoint: 'holdings',
      payload: { positions: [{ symbol: 'XYZ' }] },
      fetchedAt: '2026-08-23T12:00:00.000Z',
      durationMs: 10,
      sdkVersion: '12.1.10',
    };
    const first = await store.write(input);
    const second = await store.write({
      ...input,
      fetchedAt: '2026-08-23T12:05:00.000Z',
    });
    assert.equal(second.skipped, true);
    const dir = path.join(dataDir, 'raw', 'accounts', 'acct-1', 'holdings');
    const files = await fs.readdir(dir);
    assert.equal(files.length, 1);
    assert.ok(files[0].startsWith(first.path.split('/').pop().slice(0, 20)));
  });

  it('writes a new snapshot when the payload changes', async () => {
    const base = {
      accountId: 'acct-1',
      endpoint: 'orders',
      fetchedAt: '2026-08-23T12:00:00.000Z',
      durationMs: 10,
      sdkVersion: '12.1.10',
    };
    await store.write({ ...base, payload: [{ id: 'order-1' }] });
    const second = await store.write({
      ...base,
      fetchedAt: '2026-08-23T12:05:00.000Z',
      payload: [{ id: 'order-1' }, { id: 'order-2' }],
    });
    assert.equal(second.skipped, false);
    const dir = path.join(dataDir, 'raw', 'accounts', 'acct-1', 'orders');
    assert.equal((await fs.readdir(dir)).length, 2);
  });

  it('deduplicates a previously seen hash even when it is not the latest', async () => {
    const base = { accountId: 'acct-1', endpoint: 'orders', durationMs: 1, sdkVersion: '12.1.10' };
    await store.write({ ...base, fetchedAt: '2026-08-23T12:00:00.000Z', payload: { state: 'A' } });
    await store.write({ ...base, fetchedAt: '2026-08-23T12:01:00.000Z', payload: { state: 'B' } });
    const repeated = await store.write({ ...base, fetchedAt: '2026-08-23T12:02:00.000Z', payload: { state: 'A' } });
    assert.equal(repeated.skipped, true);
    const dir = path.join(dataDir, 'raw', 'accounts', 'acct-1', 'orders');
    assert.equal((await fs.readdir(dir)).length, 2);
  });

  it('records provider response time when data freshness supplies it', async () => {
    const written = await store.write({
      accountId: 'acct-1', endpoint: 'positions', durationMs: 1, sdkVersion: '12.1.10',
      fetchedAt: '2026-08-23T12:00:00.000Z',
      payload: { results: [], data_freshness: { last_successful_sync: '2026-08-23T11:59:00.000Z' } },
    });
    const envelope = JSON.parse(await fs.readFile(written.path, 'utf8'));
    assert.equal(envelope.providerResponseAt, '2026-08-23T11:59:00.000Z');
  });

  it('lists snapshots filtered by account and endpoint', async () => {
    const base = {
      fetchedAt: '2026-08-23T12:00:00.000Z',
      durationMs: 5,
      sdkVersion: '12.1.10',
    };
    await store.write({ ...base, accountId: 'acct-1', endpoint: 'balances', payload: { a: 1 } });
    await store.write({ ...base, accountId: 'acct-1', endpoint: 'holdings', payload: { b: 2 } });
    await store.write({ ...base, accountId: 'acct-2', endpoint: 'balances', payload: { c: 3 } });

    const all = await store.list();
    assert.equal(all.length, 3);
    const filtered = await store.list({ accountId: 'acct-1', endpoint: 'balances' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].accountId, 'acct-1');
    assert.equal(filtered[0].endpoint, 'balances');
    assert.ok(filtered[0].relativePath.startsWith(path.join('raw', 'accounts')));
  });

  it('reads back a snapshot via its relative path', async () => {
    const written = await store.write({
      accountId: 'acct-1',
      endpoint: 'activities',
      payload: [{ type: 'OPTIONEXPIRATION' }],
      fetchedAt: '2026-08-23T12:00:00.000Z',
      durationMs: 5,
      sdkVersion: '12.1.10',
    });
    const relative = path.relative(dataDir, written.path);
    const envelope = await store.readRaw(relative);
    assert.equal(envelope.endpoint, 'activities');
    assert.deepEqual(envelope.payload, [{ type: 'OPTIONEXPIRATION' }]);
  });

  it('rejects path traversal outside the raw root', async () => {
    await assert.rejects(store.readRaw('../../etc/passwd'), {
      name: 'SnapshotPathError',
    });
    await assert.rejects(store.readRaw('/absolute/path.json'), {
      name: 'SnapshotPathError',
    });
  });
});
