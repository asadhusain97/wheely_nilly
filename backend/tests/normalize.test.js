import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeSnapshots, parseOccSymbol } from '../src/services/normalize.js';

const snapshot = (endpoint, payload) => ({ endpoint, payload, accountId: 'acct-1', fetchedAt: '2026-08-23T12:00:00.000Z', contentSha256: `${endpoint}-hash` });

describe('normalization', () => {
  it('parses OCC symbols while preserving the original identifier', () => {
    assert.deepEqual(parseOccSymbol('WXYZ260918P00040000'), {
      symbol: 'WXYZ260918P00040000', underlying: 'WXYZ', expiration: '2026-09-18', optionType: 'put', strikeMinor: 4000, multiplier: 100,
    });
  });
  it('deduplicates source activities and keeps orders non-authoritative', () => {
    const activity = { id: 'event-1', type: 'SELL', option_type: 'SELL_TO_OPEN', option_symbol: 'WXYZ260918P00040000', units: '-1', amount: '125', fee: '0.03', trade_date: '2026-08-20' };
    const order = { brokerage_order_id: 'order-1', action: 'SELL_OPEN', option_symbol: { symbol: 'WXYZ260918P00040000' }, filled_quantity: '1', execution_price: '1.25', time_executed: '2026-08-20' };
    const model = normalizeSnapshots([snapshot('activities', { data: [activity, activity] }), snapshot('orders', [order])]);
    assert.equal(model.events.length, 2);
    assert.equal(model.events.filter((event) => event.authoritative).length, 1);
    assert.equal(model.events[0].netCashMinor, 12497);
  });
  it('normalizes refreshed equity quotes with their snapshot time', () => {
    const model = normalizeSnapshots([snapshot('quotes', [{
      symbol: { symbol: 'WXYZ' }, last_trade_price: 43.21, bid_price: 43.20, ask_price: 43.22,
    }])]);
    assert.deepEqual(model.quotes, [{
      accountId: 'acct-1', symbol: 'WXYZ', lastTradePriceMinor: 4321,
      bidPriceMinor: 4320, askPriceMinor: 4322, asOf: '2026-08-23T12:00:00.000Z',
      snapshotHash: 'quotes-hash',
    }]);
  });
});
