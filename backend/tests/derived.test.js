import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scopeToOptionsAccount } from '../src/services/derived.js';

describe('dashboard account and holding scope', () => {
  it('keeps every wheel position while projecting equities at or above 100 shares', () => {
    const normalized = {
      events: [
        { id: 'a', accountId: 'options-account', underlying: 'KEEP' },
        { id: 'b', accountId: 'options-account', underlying: 'HIDE' },
        { id: 'csp', accountId: 'options-account', underlying: 'PUTS', option: { underlying: 'PUTS' } },
        { id: 'c', accountId: 'other-account', underlying: 'OTHER' },
      ],
      positions: [
        { accountId: 'options-account', symbol: 'KEEP', option: null, quantity: 101 },
        { accountId: 'options-account', symbol: 'HIDE', option: null, quantity: 100 },
        { accountId: 'options-account', symbol: 'KEEP', option: { symbol: 'KEEP-CALL', underlying: 'KEEP', optionType: 'call', expiration: '2026-09-18' }, quantity: -1 },
        { accountId: 'options-account', symbol: 'PUTS', option: { symbol: 'PUTS-PUT', underlying: 'PUTS', optionType: 'put', expiration: '2026-09-18' }, quantity: -2 },
        { accountId: 'other-account', symbol: 'OTHER', option: null, quantity: 500 },
      ],
      balances: [{ accountId: 'options-account' }, { accountId: 'other-account' }],
      quotes: [
        { accountId: 'options-account', symbol: 'KEEP', lastTradePriceMinor: 1234 },
        { accountId: 'other-account', symbol: 'OTHER', lastTradePriceMinor: 5678 },
      ],
    };
    const scoped = scopeToOptionsAccount(normalized);
    assert.equal(scoped.scope.accountId, 'options-account');
    assert.deepEqual(scoped.scope.symbols, ['HIDE', 'KEEP', 'PUTS']);
    assert.deepEqual(scoped.events.map(({ id }) => id), ['a', 'b', 'csp']);
    assert.equal(scoped.positions.length, 4);
    assert.equal(scoped.holdings.length, 2);
    assert.equal(scoped.optionPositions.length, 2);
    assert.equal(scoped.holdings[0].quantity, 101);
    assert.deepEqual(scoped.holdings[0].coveredCall, {
      status: 'open', contracts: 1, expirations: ['2026-09-18'], availableLots: 0, totalLots: 1,
    });
    assert.equal(scoped.holdings[1].coveredCall.status, 'available');
    assert.equal(scoped.balances.length, 1);
    assert.deepEqual(scoped.quotes.map(({ symbol }) => symbol), ['KEEP']);
  });

  it('falls back to option history when no option contract is currently open', () => {
    const scoped = scopeToOptionsAccount({
      events: [{ id: 'old-option', accountId: 'a', underlying: 'XYZ', option: { underlying: 'XYZ' } }],
      positions: [{ accountId: 'a', symbol: 'XYZ', option: null, quantity: 200 }],
      balances: [{ accountId: 'a' }],
    });
    assert.equal(scoped.scope.accountId, 'a');
    assert.equal(scoped.holdings.length, 1);
  });
});
