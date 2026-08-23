import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scopeToOptionsAccount } from '../src/services/derived.js';

describe('dashboard account and holding scope', () => {
  it('keeps only the account with options and equities at or above 100 shares', () => {
    const normalized = {
      events: [
        { id: 'a', accountId: 'options-account', underlying: 'KEEP' },
        { id: 'b', accountId: 'options-account', underlying: 'HIDE' },
        { id: 'c', accountId: 'other-account', underlying: 'OTHER' },
      ],
      positions: [
        { accountId: 'options-account', symbol: 'KEEP', option: null, quantity: 101 },
        { accountId: 'options-account', symbol: 'HIDE', option: null, quantity: 100 },
        { accountId: 'options-account', symbol: 'KEEP', option: { symbol: 'KEEP-CALL', underlying: 'KEEP', optionType: 'call', expiration: '2026-09-18' }, quantity: -1 },
        { accountId: 'other-account', symbol: 'OTHER', option: null, quantity: 500 },
      ],
      balances: [{ accountId: 'options-account' }, { accountId: 'other-account' }],
    };
    const scoped = scopeToOptionsAccount(normalized);
    assert.equal(scoped.scope.accountId, 'options-account');
    assert.deepEqual(scoped.scope.symbols, ['HIDE', 'KEEP']);
    assert.deepEqual(scoped.events.map(({ id }) => id), ['a', 'b']);
    assert.equal(scoped.positions.length, 2);
    assert.equal(scoped.positions[0].quantity, 101);
    assert.deepEqual(scoped.positions[0].coveredCall, {
      status: 'open', contracts: 1, expirations: ['2026-09-18'], availableLots: 0, totalLots: 1,
    });
    assert.equal(scoped.positions[1].coveredCall.status, 'available');
    assert.equal(scoped.balances.length, 1);
  });

  it('returns an empty dashboard when no account has an open option position', () => {
    const scoped = scopeToOptionsAccount({ events: [], positions: [{ accountId: 'a', symbol: 'XYZ', option: null, quantity: 200 }], balances: [] });
    assert.equal(scoped.scope.accountId, null);
    assert.deepEqual(scoped.positions, []);
  });
});
