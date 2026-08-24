import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPerformanceDashboard } from '../src/services/performance.js';

const option = (symbol, optionType, strikeMinor) => ({
  symbol,
  underlying: 'WXYZ',
  optionType,
  strikeMinor,
  multiplier: 100,
  expiration: '2026-09-18',
});

const event = (id, action, optionValue, occurredAt, quantity, netCashMinor) => ({
  id,
  accountId: 'acct-1',
  action,
  option: optionValue,
  underlying: optionValue.underlying,
  occurredAt,
  quantity,
  netCashMinor,
  authoritative: true,
});

function model({ basisMinor = 4000 } = {}) {
  const put = option('WXYZ260918P00050000', 'put', 5000);
  const closedCall = option('WXYZ260918C00045000', 'call', 4500);
  const openCall = option('WXYZ260918C00046000', 'call', 4600);
  const equity = {
    accountId: 'acct-1', symbol: 'WXYZ', option: null, quantity: 250,
    priceMinor: 4300, brokerCostBasisMinor: basisMinor,
    coveredCall: { status: 'open', contracts: 1, expirations: ['2026-09-18'], availableLots: 1, totalLots: 2 },
  };
  return {
    scope: { accountId: 'acct-1', symbols: ['WXYZ'] },
    events: [
      event('put-open', 'sell_to_open', put, '2026-08-01T00:00:00Z', 2, 20000),
      event('put-close', 'buy_to_close', put, '2026-08-11T00:00:00Z', 1, -4000),
      event('call-open', 'sell_to_open', closedCall, '2026-08-01T00:00:00Z', 1, 15000),
      event('call-close', 'buy_to_close', closedCall, '2026-08-21T00:00:00Z', 1, -5000),
      event('open-call', 'sell_to_open', openCall, '2026-08-10T00:00:00Z', 1, 12000),
    ],
    positions: [
      equity,
      { accountId: 'acct-1', symbol: 'WXYZ', option: put, quantity: -1, priceMinor: 90, brokerCostBasisMinor: 100 },
      { accountId: 'acct-1', symbol: 'WXYZ', option: openCall, quantity: -1, priceMinor: 80, brokerCostBasisMinor: 120 },
    ],
    holdings: [equity],
    optionPositions: [
      { accountId: 'acct-1', symbol: 'WXYZ', option: put, quantity: -1, priceMinor: 90, brokerCostBasisMinor: 100 },
      { accountId: 'acct-1', symbol: 'WXYZ', option: openCall, quantity: -1, priceMinor: 80, brokerCostBasisMinor: 120 },
    ],
    quotes: [{ accountId: 'acct-1', symbol: 'WXYZ', lastTradePriceMinor: 4321, asOf: '2026-08-23T12:00:00.000Z' }],
    balances: [{ accountId: 'acct-1', currency: 'USD', cashMinor: 1250000, buyingPowerMinor: 2000000 }],
  };
}

describe('wheel performance dashboard', () => {
  it('separates realized profit from open credit and weights returns by collateral-days', () => {
    const dashboard = buildPerformanceDashboard(model(), { now: new Date('2026-08-23T00:00:00Z') });
    assert.equal(dashboard.kpis.bookedProfit, '160.00');
    assert.equal(dashboard.kpis.returnRate, 0.017778);
    assert.equal(dashboard.kpis.annualizedReturnRate, 0.449231);
    assert.equal(dashboard.kpis.capitalVelocity, 36.92);
    assert.equal(dashboard.kpis.premiumCaptureRate, 0.64);
    assert.equal(dashboard.kpis.openCspContracts, 1);
    assert.equal(dashboard.kpis.openCcContracts, 1);
    assert.equal(dashboard.kpis.cspCollateral, '5000.00');
    assert.equal(dashboard.kpis.shareCapital, '8000.00');
    assert.equal(dashboard.kpis.wheelCapital, '13000.00');
    assert.equal(dashboard.opportunities.cashAvailable, '12500.00');
    assert.deepEqual(dashboard.opportunities.coveredCalls.map(({ symbol, availableLots }) => ({ symbol, availableLots })), [{ symbol: 'WXYZ', availableLots: 1 }]);
    assert.equal(dashboard.openTrades.length, 2);
    assert.deepEqual(dashboard.openTrades.map(({ type, contracts }) => ({ type, contracts })), [
      { type: 'cc', contracts: 1 },
      { type: 'csp', contracts: 1 },
    ]);
    assert.ok(dashboard.openTrades.every((trade) => trade.stockPrice === '43.21'));
    assert.equal(dashboard.tickerPerformance.length, 1);
    const ticker = dashboard.tickerPerformance[0];
    assert.equal(ticker.symbol, 'WXYZ');
    assert.equal(ticker.bookedProfit, '160.00');
    assert.equal(ticker.returnRate, 0.017778);
    assert.equal(ticker.annualizedReturnRate, 0.449231);
    assert.equal(ticker.capitalInvolved, '13000.00');
    assert.equal(ticker.stockPrice, '43.21');
    assert.deepEqual(
      { total: ticker.openContracts, csps: ticker.openCspContracts, ccs: ticker.openCcContracts },
      { total: 2, csps: 1, ccs: 1 },
    );
    assert.equal(ticker.openTrades.length, 2);
    assert.equal(ticker.pastTrades.length, 2);
    assert.deepEqual(ticker.pastTrades.map(({ type, profit, daysHeld }) => ({ type, profit, daysHeld })), [
      { type: 'cc', profit: '100.00', daysHeld: 20 },
      { type: 'csp', profit: '60.00', daysHeld: 10 },
    ]);
    assert.equal(ticker.quality.returnTradesIncluded, 2);
    assert.equal(ticker.quality.returnTradesExcluded, 0);
    assert.equal(dashboard.quality.optionEvents, 5);
    assert.equal(dashboard.quality.historyStartsAt, '2026-08-01T00:00:00Z');
    assert.equal(dashboard.quality.historyEndsAt, '2026-08-21T00:00:00Z');
    assert.equal(dashboard.quality.returnTradesIncluded, 2);
    assert.equal(dashboard.quality.returnTradesExcluded, 0);
  });

  it('keeps booked profit but excludes covered calls without a collateral basis from rates', () => {
    const dashboard = buildPerformanceDashboard(model({ basisMinor: null }), { now: new Date('2026-08-23T00:00:00Z') });
    assert.equal(dashboard.kpis.bookedProfit, '160.00');
    assert.equal(dashboard.kpis.returnRate, 0.012);
    assert.equal(dashboard.tickerPerformance[0].bookedProfit, '160.00');
    assert.equal(dashboard.tickerPerformance[0].returnRate, 0.012);
    assert.equal(dashboard.tickerPerformance[0].capitalInvolved, '5000.00');
    assert.equal(dashboard.tickerPerformance[0].quality.capitalNeedsReview, true);
    assert.equal(dashboard.tickerPerformance[0].quality.returnTradesExcluded, 1);
    assert.equal(dashboard.quality.returnTradesIncluded, 1);
    assert.equal(dashboard.quality.returnTradesExcluded, 1);
  });

  it('falls back to the refreshed position price when no quote is available', () => {
    const input = model();
    input.quotes = [];
    const dashboard = buildPerformanceDashboard(input, { now: new Date('2026-08-23T00:00:00Z') });
    assert.equal(dashboard.tickerPerformance[0].stockPrice, '43.00');
    assert.ok(dashboard.openTrades.every((trade) => trade.stockPrice === '43.00'));
  });
});
