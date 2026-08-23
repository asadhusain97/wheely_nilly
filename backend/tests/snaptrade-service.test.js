import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../src/config/index.js';
import {
  createSnaptradeService,
  SnaptradeServiceError,
} from '../src/services/snaptrade.js';

function makeConfig(overrides = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    SNAPTRADE_CLIENT_ID: 'test-client-id',
    SNAPTRADE_CONSUMER_KEY: 'test-consumer-key',
    INGEST_ENABLED: 'false',
    RETRY_ATTEMPTS: '2',
    RETRY_BASE_MS: '100',
    ...overrides,
  });
}

function makeFakeClient(overrides = {}) {
  const calls = [];
  const record = (name) => (params) => {
    calls.push([name, params]);
    return Promise.resolve({ data: [] });
  };
  return {
    calls,
    apiStatus: { check: () => Promise.resolve({ data: { version: 151 } }) },
    connections: { listBrokerageAuthorizations: record('listBrokerageAuthorizations') },
    authentication: { loginSnapTradeUser: record('loginSnapTradeUser') },
    accountInformation: {
      listUserAccounts: record('listUserAccounts'),
      getUserAccountBalance: record('getUserAccountBalance'),
      getAllAccountPositions: record('getAllAccountPositions'),
      getUserAccountOrders: record('getUserAccountOrders'),
      getAccountActivities: record('getAccountActivities'),
      ...overrides,
    },
  };
}

describe('snaptrade service adapter', () => {
  it('omits user credentials entirely in personal mode', async () => {
    const client = makeFakeClient();
    const service = createSnaptradeService({
      config: makeConfig(),
      client,
    });
    await service.listAccounts();
    assert.deepEqual(client.calls[0], ['listUserAccounts', {}]);
  });

  it('passes user credentials in commercial mode', async () => {
    const client = makeFakeClient();
    const service = createSnaptradeService({
      config: makeConfig({
        SNAPTRADE_USER_ID: 'user-1',
        SNAPTRADE_USER_SECRET: 'commercial-secret',
      }),
      client,
    });
    await service.listAccounts();
    assert.deepEqual(client.calls[0], [
      'listUserAccounts',
      { userId: 'user-1', userSecret: 'commercial-secret' },
    ]);
  });

  it('retries transient upstream failures', async () => {
    let attempts = 0;
    const client = makeFakeClient({
      getAllAccountPositions: () => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error('rate limited');
          error.status = 429;
          return Promise.reject(error);
        }
        return Promise.resolve({ data: { positions: [] } });
      },
    });
    const service = createSnaptradeService({ config: makeConfig(), client });
    const result = await service.getPositions('acct-1');
    assert.deepEqual(result, { positions: [] });
    assert.equal(attempts, 2);
  });

  it('wraps permanent failures without leaking secrets', async () => {
    const client = makeFakeClient({
      listUserAccounts: () => {
        const error = new Error(
          '401 Unauthorized for userSecret=commercial-secret',
        );
        error.status = 401;
        return Promise.reject(error);
      },
    });
    const service = createSnaptradeService({
      config: makeConfig({
        SNAPTRADE_USER_ID: 'user-1',
        SNAPTRADE_USER_SECRET: 'commercial-secret',
      }),
      client,
    });
    await assert.rejects(service.listAccounts(), (error) => {
      assert.ok(error instanceof SnaptradeServiceError);
      assert.equal(error.status, 401);
      assert.equal(error.operation, 'accountInformation.listUserAccounts');
      return true;
    });
  });

  it('requests orders with state=all and the configured day window', async () => {
    const client = makeFakeClient();
    const service = createSnaptradeService({ config: makeConfig(), client });
    await service.getOrders('acct-1', 45);
    assert.deepEqual(client.calls[0], [
      'getUserAccountOrders',
      { accountId: 'acct-1', state: 'all', days: 45 },
    ]);
  });

  it('paginates activities until the reported total is collected', async () => {
    const offsets = [];
    const client = makeFakeClient({
      getAccountActivities: ({ offset }) => {
        offsets.push(offset);
        const data = offset === 0 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }];
        return Promise.resolve({ data: { data, pagination: { total: 3 } } });
      },
    });
    const service = createSnaptradeService({ config: makeConfig(), client });
    const result = await service.getActivities('acct-1', {
      startDate: '2026-01-01', endDate: '2026-01-31', limit: 2,
    });
    assert.deepEqual(offsets, [0, 2]);
    assert.deepEqual(result.data.map(({ id }) => id), [1, 2, 3]);
  });

  it('redacts configured secrets from wrapped upstream messages', async () => {
    const client = makeFakeClient({
      listUserAccounts: () => Promise.reject(Object.assign(new Error('token commercial-secret'), { status: 401 })),
    });
    const service = createSnaptradeService({
      config: makeConfig({ SNAPTRADE_USER_ID: 'user-1', SNAPTRADE_USER_SECRET: 'commercial-secret' }), client,
    });
    await assert.rejects(service.listAccounts(), (error) => {
      assert.doesNotMatch(error.message, /commercial-secret/);
      return true;
    });
  });
});
