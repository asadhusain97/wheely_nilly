import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { builtInStrategySettings, resolveEffectiveSettings } from '../src/services/strategy-settings.js';
import { calculateCloseResult, createPositionManagementService } from '../src/services/position-management.js';

const NOW = new Date('2026-08-27T16:00:00.000Z');

function effective({ target = 0.5, goal = 'acquire', source = 'goal' } = {}) {
  const settings = builtInStrategySettings();
  settings.goalProfiles[goal].cashSecuredPut.closeAtProfitCapture = target;
  settings.tickerPlaybooks.RKLB = {
    coveredCall: { enabled: false, goal: 'income', minNetSalePriceMinor: null, overrides: {} },
    cashSecuredPut: { enabled: true, goal, maxNetPurchasePriceMinor: null, overrides: source === 'tickerOverride' ? { closeAtProfitCapture: target } : {} },
  };
  return resolveEffectiveSettings(settings, { symbol: 'RKLB', leg: 'cashSecuredPut' });
}

function rklbTrade(overrides = {}) {
  return {
    contractSymbol: 'RKLB260918P00075000', symbol: 'RKLB', type: 'csp', contracts: 1,
    multiplier: 100, strike: '75.00', expiration: '2026-09-18', dte: 22,
    openedAt: '2026-08-01T16:00:00.000Z', openingCredit: '1515.00', stockPrice: '66.84',
    ...overrides,
  };
}

function rklbQuote(overrides = {}) {
  return {
    available: true, bid: 10.40, ask: 10.58, underlying_price: 66.84,
    implied_volatility: 0.72, delta: -0.41, theta_per_day: -0.12,
    open_interest: 1234, volume: 88,
    ...overrides,
  };
}

describe('binary Close calculations', () => {
  it('matches the RKLB CSP fixture and changes only at the configured threshold', () => {
    const neutral = calculateCloseResult({ trade: rklbTrade(), quote: rklbQuote(), effectiveSettings: effective(), now: NOW, estimatedClosingFeePerContract: 0 });
    assert.equal(neutral.signal, false);
    assert.equal(neutral.metrics.profitIfClosed, 457);
    assert.equal(neutral.metrics.premiumCapture, 0.30165017);
    assert.equal(neutral.metrics.intrinsicValue, 816);
    assert.equal(neutral.metrics.remainingExtrinsic, 242);
    assert.equal(neutral.metrics.effectiveAssignmentPrice, 59.85);
    assert.equal(neutral.metrics.assignmentDistance, 6.99);
    assert.equal(neutral.metrics.assignmentDistancePercent, 0.1045781);
    assert.equal(neutral.metrics.breakevenPrice, 59.85);

    const signaled = calculateCloseResult({ trade: rklbTrade(), quote: rklbQuote(), effectiveSettings: effective({ target: 0.3 }), now: NOW, estimatedClosingFeePerContract: 0 });
    assert.equal(signaled.signal, true);
    assert.equal(signaled.conditions.find((condition) => condition.key === 'premiumCapture').pass, true);
  });

  it('handles multiple contracts, zero DTE, OTM intrinsic value, and missing optional market fields', () => {
    const result = calculateCloseResult({
      trade: rklbTrade({ contracts: 2, openingCredit: '400.00', strike: '60.00', dte: 0 }),
      quote: rklbQuote({ ask: 1, bid: null, underlying_price: 66.84, implied_volatility: null, delta: null, theta_per_day: null, open_interest: null, volume: null }),
      effectiveSettings: effective(), now: NOW, estimatedClosingFeePerContract: 0,
    });
    assert.equal(result.available, true);
    assert.equal(result.metrics.intrinsicValue, 0);
    assert.equal(result.metrics.remainingExtrinsic, 200);
    assert.equal(result.metrics.remainingExtrinsicPerDay, 200);
    assert.equal(result.metrics.moneyState, 'OTM');
    assert.equal(result.metrics.impliedVolatility, null);
    assert.equal(result.metrics.spreadPerShare, null);
  });

  it('calculates ITM and OTM covered-call assignment metrics and assignment intent', () => {
    const settings = builtInStrategySettings();
    settings.tickerPlaybooks.RKLB = {
      coveredCall: { enabled: true, goal: 'protect', minNetSalePriceMinor: null, overrides: {} },
      cashSecuredPut: { enabled: false, goal: 'acquire', maxNetPurchasePriceMinor: null, overrides: {} },
    };
    const ccEffective = resolveEffectiveSettings(settings, { symbol: 'RKLB', leg: 'coveredCall' });
    const itm = calculateCloseResult({
      trade: rklbTrade({ type: 'cc', strike: '60.00', openingCredit: '300.00', collateral: '5000.00' }),
      quote: rklbQuote({ bid: 7.8, ask: 8, underlying_price: 66.84 }), effectiveSettings: ccEffective, now: NOW, estimatedClosingFeePerContract: 0,
    });
    assert.equal(itm.metrics.intrinsicValue, 684);
    assert.equal(itm.metrics.remainingExtrinsic, 116);
    assert.equal(itm.metrics.effectiveAssignmentPrice, 63);
    assert.equal(itm.metrics.assignmentDistance, -3.84);
    assert.equal(itm.metrics.assignmentAlignment.status, 'conflicts');
    assert.equal(itm.metrics.breakevenPrice, 47);

    const missingBasis = calculateCloseResult({
      trade: rklbTrade({ type: 'cc', strike: '60.00', openingCredit: '300.00', collateral: null }),
      quote: rklbQuote({ bid: 7.8, ask: 8, underlying_price: 66.84 }), effectiveSettings: ccEffective, now: NOW, estimatedClosingFeePerContract: 0,
    });
    assert.equal(missingBasis.metrics.breakevenPrice, 63.84);
  });

  it('stays neutral without opening credit or a usable ask', () => {
    const missingCredit = calculateCloseResult({ trade: rklbTrade({ openingCredit: null }), quote: rklbQuote(), effectiveSettings: effective(), now: NOW });
    const missingAsk = calculateCloseResult({ trade: rklbTrade(), quote: rklbQuote({ ask: null }), effectiveSettings: effective(), now: NOW });
    const zeroAsk = calculateCloseResult({ trade: rklbTrade(), quote: rklbQuote({ bid: 0, ask: 0 }), effectiveSettings: effective(), now: NOW });
    const crossedAsk = calculateCloseResult({ trade: rklbTrade(), quote: rklbQuote({ bid: 11, ask: 10 }), effectiveSettings: effective(), now: NOW });
    assert.equal(missingCredit.available, false);
    assert.equal(missingCredit.signal, null);
    assert.match(missingCredit.unavailableReason, /Opening net credit/);
    assert.equal(missingAsk.available, false);
    assert.equal(missingAsk.signal, null);
    assert.match(missingAsk.unavailableReason, /current ask/);
    assert.equal(zeroAsk.available, false);
    assert.equal(zeroAsk.signal, null);
    assert.equal(crossedAsk.available, false);
    assert.equal(crossedAsk.signal, null);
  });

  it('never gates the boolean on an old quote timestamp', () => {
    const oldQuote = { ...rklbQuote(), contract_quote_time: '2020-01-01T00:00:00.000Z' };
    const result = calculateCloseResult({ trade: rklbTrade(), quote: oldQuote, effectiveSettings: effective({ target: 0.3 }), now: NOW, estimatedClosingFeePerContract: 0 });
    assert.equal(result.signal, true);
    assert.ok(result.conditions.every((condition) => condition.key !== 'quoteAge'));
  });
});

describe('position-management scan coverage', () => {
  it('evaluates untracked and disabled open shorts and preserves per-contract provider failures', async () => {
    const settings = builtInStrategySettings();
    settings.tickerPlaybooks.RKLB = {
      coveredCall: { enabled: false, goal: 'income', minNetSalePriceMinor: null, overrides: {} },
      cashSecuredPut: { enabled: false, goal: 'acquire', maxNetPurchasePriceMinor: null, overrides: {} },
    };
    const trades = [rklbTrade({ accountId: 'acct-1' }), rklbTrade({ accountId: 'acct-1', symbol: 'XYZ', contractSymbol: 'XYZ260918C00070000', type: 'cc', strike: '70.00' })];
    const service = createPositionManagementService({
      now: () => NOW.getTime(),
      strategySettings: { load: async () => ({ settings }) },
      derived: { load: async () => ({ generatedAt: NOW.toISOString(), dashboard: { openTrades: trades } }) },
      screener: { quoteContracts: async () => ({ scanned_at: NOW.toISOString(), results: [
        { contract: { contract_symbol: trades[0].contractSymbol }, ...rklbQuote(), provider: 'fixture', contract_quote_time: '2020-01-01T00:00:00.000Z' },
        { contract: { contract_symbol: trades[1].contractSymbol }, available: false, unavailable_reason: 'exact contract quote not found' },
      ] }) },
      estimatedClosingFeePerContract: 0,
    });
    const batch = await service.scan();
    assert.equal(batch.results.length, 2);
    assert.equal(batch.results[0].effectiveSettings.enabled, false);
    assert.equal(batch.results[0].effectiveSettings.goal, 'acquire');
    assert.equal(batch.results[0].quoteTimestamps.contract, '2020-01-01T00:00:00.000Z');
    assert.equal(batch.results[1].close.available, false);
    assert.equal(batch.failures, 1);
  });
});
