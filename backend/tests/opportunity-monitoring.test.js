import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createOpportunityMonitoringService,
  discoverOpportunityTargets,
  toSidecarRequest,
} from '../src/services/opportunity-monitoring.js';
import { builtInStrategySettings, resolveEffectiveSettings } from '../src/services/strategy-settings.js';

function settingsFixture() {
  const settings = builtInStrategySettings();
  settings.tickerPlaybooks.AAPL = {
    goal: 'income',
    coveredCall: { enabled: true, minNetSalePriceMinor: 20_000, overrides: { minPeriodReturn: .02, maxDte: 28 } },
    cashSecuredPut: { enabled: true, maxNetPurchasePriceMinor: 18_000, overrides: {} },
  };
  settings.tickerPlaybooks.MSFT = {
    goal: 'income',
    coveredCall: { enabled: false, minNetSalePriceMinor: null, overrides: {} },
    cashSecuredPut: { enabled: true, maxNetPurchasePriceMinor: null, overrides: {} },
  };
  return settings;
}

function dashboardFixture() {
  return {
    opportunities: {
      cashAvailable: '12500.25',
      coveredCalls: [
        { symbol: 'AAPL', name: 'Apple Inc.', instrumentType: 'Equity', shares: 250, availableLots: 2, price: '194.50', brokerCostBasis: '175.00' },
        { symbol: 'GOOG', shares: 100, availableLots: 1, brokerCostBasis: '150.00' },
      ],
    },
    tickerPerformance: [
      { symbol: 'AAPL', stockPrice: '195.12' },
      { symbol: 'MSFT', stockPrice: '405.30' },
    ],
  };
}

function screenResult() {
  return {
    schema_version: 1, calculation_version: 'screener-2.0.0', symbol: 'AAPL', leg: 'covered_call',
    provider: 'fixture', provider_unofficial: false, underlying_price: 195.10, quote_timestamp: '2026-08-25T12:00:00Z',
    cache: { hit: false, age_seconds: 0 },
    assumptions: { executable_price: 'midpoint' }, exclusions: {}, candidates: [],
  };
}

describe('playbook-aware opportunity monitoring', () => {
  it('deduplicates holdings and playbooks while enforcing actual covered shares', () => {
    const targets = discoverOpportunityTargets(settingsFixture(), dashboardFixture());
    assert.deepEqual(targets.map(({ symbol }) => symbol), ['AAPL', 'GOOG', 'MSFT']);
    assert.deepEqual(targets.find(({ symbol }) => symbol === 'AAPL').legs, ['coveredCall', 'cashSecuredPut']);
    assert.deepEqual(targets.find(({ symbol }) => symbol === 'GOOG').legs, ['coveredCall']);
    assert.deepEqual(targets.find(({ symbol }) => symbol === 'MSFT').legs, ['cashSecuredPut']);
    assert.equal(targets.filter(({ symbol }) => symbol === 'AAPL').length, 1);
    assert.equal(targets.find(({ symbol }) => symbol === 'AAPL').name, 'Apple Inc.');
    assert.equal(targets.find(({ symbol }) => symbol === 'AAPL').instrumentType, 'Equity');
    assert.equal(targets.find(({ symbol }) => symbol === 'AAPL').stockPrice, '195.12');
    assert.equal(targets.find(({ symbol }) => symbol === 'MSFT').stockPrice, '405.30');
    assert.equal(targets.find(({ symbol }) => symbol === 'GOOG').stockPrice, null);
  });

  it('maps backend-resolved camelCase rules and net price guards to the sidecar', () => {
    const effective = resolveEffectiveSettings(settingsFixture(), { symbol: 'AAPL', leg: 'coveredCall' });
    const request = toSidecarRequest(effective, { cashAvailable: 12000, coveredShares: 200, adjustedBasisPerShare: 175 });
    assert.equal(request.min_period_return, .02);
    assert.equal(request.max_dte, 28);
    assert.equal(request.min_net_sale_price, 200);
    assert.equal(request.allow_itm_calls, false);
    assert.equal(request.covered_shares, 200);
    assert.equal(request.adjusted_basis_per_share, 175);
  });

  it('uses portfolio collateral, returns effective sources, and rejects browser thresholds', async () => {
    const calls = [];
    const service = createOpportunityMonitoringService({
      derived: { load: async () => ({ generatedAt: '2026-08-25T12:00:00Z', freshness: { stale: false }, dashboard: dashboardFixture() }) },
      strategySettings: { load: async () => ({ settings: settingsFixture(), persistence: { persisted: true } }) },
      screener: { screen: async (request) => { calls.push(request); return screenResult(); } },
    });
    const result = await service.scan({ symbol: 'AAPL', leg: 'coveredCall' });
    assert.equal(calls[0].cash_available, 12500.25);
    assert.equal(calls[0].covered_shares, 200);
    assert.equal(result.effectiveSettings.sourceMap.minPeriodReturn, 'tickerOverride');
    assert.equal((await service.targets()).targets.find(({ symbol }) => symbol === 'AAPL').stockPrice, 195.10);
    await assert.rejects(service.scan({ symbol: 'AAPL', leg: 'coveredCall', min_dte: 1 }), /Invalid scan target/);
  });

  it('keeps successful scan-all results when one ticker fails', async () => {
    const calls = [];
    const service = createOpportunityMonitoringService({
      derived: { load: async () => ({ generatedAt: '2026-08-25T12:00:00Z', freshness: { stale: false }, dashboard: dashboardFixture() }) },
      strategySettings: { load: async () => ({ settings: settingsFixture(), persistence: { persisted: true } }) },
      screener: { screen: async (request) => {
        calls.push(request);
        const { symbol } = request;
        if (symbol === 'MSFT') throw new Error('provider unavailable');
        return screenResult();
      } },
    });
    const scan = await service.scanAll();
    assert.ok(scan.results.some(({ status }) => status === 'success'));
    const failed = scan.results.find(({ symbol }) => symbol === 'MSFT');
    assert.equal(failed.status, 'error');
    assert.equal('result' in failed, false);
    assert.equal(scan.targets.find(({ symbol }) => symbol === 'GOOG').stockPrice, 195.10);
    const aapl = calls.filter(({ symbol }) => symbol === 'AAPL');
    assert.equal(aapl.length, 2);
    assert.deepEqual(aapl.map(({ chain_min_dte, chain_max_dte }) => [chain_min_dte, chain_max_dte]), [[14, 35], [14, 35]]);
  });
});
