import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDerivedModel, buildWheelCycles } from '../src/domain/wheel.js';

const option = (optionType, strikeMinor, symbol) => ({ underlying: 'WXYZ', optionType, strikeMinor, symbol, multiplier: 100, expiration: '2026-09-18' });
const event = (id, action, optionValue, occurredAt, netCashMinor = 0) => ({ id, accountId: 'acct-1', action, option: optionValue, occurredAt, quantity: 1, netCashMinor, feeMinor: action === 'assignment' ? 0 : 3, amountMinor: netCashMinor + 3, authoritative: true });
const normalized = (events, positions = []) => ({ events, positions, balances: [] });

describe('wheel lifecycle engine', () => {
  it('handles a put expiration and buy-to-close deterministically', () => {
    const putA = option('put', 4000, 'WXYZ260918P00040000');
    const expired = buildWheelCycles(normalized([event('1', 'sell_to_open', putA, '2026-08-01', 12497), event('2', 'expiration', putA, '2026-09-18')]))[0];
    assert.equal(expired.stage, 'complete');
    assert.equal(expired.netPremium, '124.97');
    const putB = option('put', 3900, 'WXYZ260821P00039000');
    const closed = buildWheelCycles(normalized([event('3', 'sell_to_open', putB, '2026-08-01', 9997), event('4', 'buy_to_close', putB, '2026-08-10', -2003)]))[0];
    assert.equal(closed.stage, 'complete');
    assert.equal(closed.netPremium, '79.94');
  });

  it('tracks assignment, covered call, call-away, and adjusted basis', () => {
    const put = option('put', 4000, 'WXYZ260918P00040000');
    const call = option('call', 4500, 'WXYZ261016C00045000');
    const cycle = buildWheelCycles(normalized([
      event('1', 'sell_to_open', put, '2026-08-01', 12497), event('2', 'assignment', put, '2026-09-18'),
      event('3', 'sell_to_open', call, '2026-09-21', 8497), event('4', 'assignment', call, '2026-10-16'),
    ]))[0];
    assert.equal(cycle.stage, 'complete');
    assert.equal(cycle.shares, 0);
    assert.equal(cycle.adjustedBasis, '37.90');
    assert.equal(cycle.netPremium, '209.94');
  });

  it('models a same-day roll as a close and a new open contract', () => {
    const oldPut = option('put', 4000, 'WXYZ260918P00040000');
    const newPut = option('put', 3900, 'WXYZ261016P00039000');
    const cycle = buildWheelCycles(normalized([
      event('1', 'sell_to_open', oldPut, '2026-08-01', 12497), event('2', 'buy_to_close', oldPut, '2026-08-20T10:00:00Z', -5003), event('3', 'sell_to_open', newPut, '2026-08-20T10:01:00Z', 14997),
    ]))[0];
    assert.equal(cycle.contracts.length, 2);
    assert.ok(cycle.notes.includes('Roll detected'));
    assert.equal(cycle.stage, 'short_put');
  });

  it('keeps concurrent short puts as separate cycles', () => {
    const cycles = buildWheelCycles(normalized([
      event('1', 'sell_to_open', option('put', 4000, 'WXYZ260918P00040000'), '2026-08-01', 10000),
      event('2', 'sell_to_open', option('put', 3500, 'WXYZ261016P00035000'), '2026-08-02', 9000),
    ]));
    assert.equal(cycles.length, 2);
  });

  it('supports partial assignment quantities', () => {
    const put = option('put', 4000, 'WXYZ260918P00040000');
    const open = { ...event('1', 'sell_to_open', put, '2026-08-01', 24994), quantity: 2 };
    const partial = event('2', 'assignment', put, '2026-09-01');
    const cycle = buildWheelCycles(normalized([open, partial]))[0];
    assert.equal(cycle.shares, 100);
    assert.equal(cycle.contracts[0].openQuantity, 1);
    assert.equal(cycle.stage, 'short_put');
  });

  it('supports early assignment and manual share transactions', () => {
    const put = option('put', 4000, 'WXYZ260918P00040000');
    const early = buildWheelCycles(normalized([
      event('1', 'sell_to_open', put, '2026-08-01', 10000),
      event('2', 'assignment', put, '2026-08-20'),
    ]))[0];
    assert.equal(early.shares, 100);
    assert.equal(early.stage, 'shares_held');

    const buyShares = { ...event('3', 'buy_shares', null, '2026-08-01', -400000), underlying: 'WXYZ', quantity: 100, option: null };
    const sellShares = { ...event('4', 'sell_shares', null, '2026-08-10', 450000), underlying: 'WXYZ', quantity: 100, option: null };
    const manual = buildWheelCycles(normalized([buyShares, sellShares]))[0];
    assert.equal(manual.stage, 'complete');
    assert.equal(manual.realized, '500.00');
  });

  it('excludes ambiguous cycles from authoritative premium totals', () => {
    const call = option('call', 4500, 'WXYZ261016C00045000');
    const model = buildDerivedModel(normalized([event('1', 'sell_to_open', call, '2026-08-01', 8497)]), { stale: false });
    assert.equal(model.summary.totalNetPremium, '0.00');
    assert.equal(model.premiumLedger[0].includedInTotals, false);
    assert.equal(model.reconciliation.reconciled, true);
  });
});
