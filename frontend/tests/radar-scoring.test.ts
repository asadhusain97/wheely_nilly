import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { radarScoringConfig, resolveRadarScoringConfig } from '../assets/js/radar-scoring-config.js';
import {
  calculateDeltaFit,
  calculateDteFit,
  calculateLiquidity,
  calculateReturnMetrics,
  calculateStrikeDistance,
  createRadarCandidateViewModel,
  fitLabel,
  generateTradeWarnings,
  prepareRadarCandidates,
} from '../assets/js/radar-scoring.js';

const config = resolveRadarScoringConfig({ leg: 'cashSecuredPut', symbol: 'RKLB' });

function marketForSpread(spreadPercent, fields = {}) {
  const midpoint = 100;
  const halfSpread = spreadPercent / 2;
  return { bid: midpoint - halfSpread, ask: midpoint + halfSpread, openInterest: 2_000, volume: 500, ...fields };
}

function candidate(fields = {}) {
  return {
    contract_symbol: 'RKLB260918P00060000', option_type: 'put', expiration: '2026-09-18', dte: 22,
    strike: 60, underlying_price: 67.51, bid: 1.78, ask: 1.88, executable_option_price_per_share: 1.83,
    net_contract_credit: 182, period_return: 0.0313, annualized_return: 0.52, delta: -0.24,
    theta_per_day: -0.0751, implied_volatility: 0.6692, open_interest: 3_510, volume: 343,
    ...fields,
  };
}

function result(candidates = [candidate()]) {
  return {
    symbol: 'RKLB', leg: 'cash_secured_put', underlying_price: 67.51, candidates,
    effectiveSettings: { rules: {
      minDte: 21, maxDte: 45, minMoneyness: 0.8, maxMoneyness: 1.2,
      targetDeltaMin: 0.20, targetDeltaMax: 0.30, minPeriodReturn: 0.025,
    } },
  };
}

describe('Radar liquidity interpretation', () => {
  it('keeps spread boundaries inclusive and independently adjustable', () => {
    assert.equal(calculateLiquidity(marketForSpread(1.99), config).factors.spread.label, 'excellent');
    assert.equal(calculateLiquidity(marketForSpread(2.01), config).factors.spread.label, 'good');
    assert.equal(calculateLiquidity(marketForSpread(5.01), config).factors.spread.label, 'fair');
    assert.equal(calculateLiquidity(marketForSpread(10.01), config).factors.spread.label, 'poor');
  });

  it('weights spread most while retaining open-interest and volume evidence', () => {
    const excellentSpreadLowInterest = calculateLiquidity(marketForSpread(1, { openInterest: 0, volume: 0 }), config);
    assert.equal(excellentSpreadLowInterest.score, 61.75);
    assert.equal(excellentSpreadLowInterest.label, 'good');
    assert.equal(excellentSpreadLowInterest.factors.openInterest.label, 'poor');

    const poorSpreadExcellentInterest = calculateLiquidity(marketForSpread(12, { openInterest: 3_000, volume: 800 }), config);
    assert.equal(poorSpreadExcellentInterest.score, 53.25);
    assert.equal(poorSpreadExcellentInterest.label, 'fair');
  });

  it('handles zero interest, zero volume, missing data, and invalid quotes without false confidence', () => {
    assert.notEqual(calculateLiquidity(marketForSpread(1, { openInterest: 0 }), config).label, 'excellent');
    assert.equal(calculateLiquidity(marketForSpread(1, { volume: 0 }), config).factors.volume.label, 'poor');
    assert.equal(calculateLiquidity(marketForSpread(1, { volume: null }), config).label, 'unknown');
    assert.equal(calculateLiquidity({ bid: 0, ask: 1, openInterest: 2_000, volume: 500 }, config).label, 'unknown');
    assert.equal(calculateLiquidity({ bid: 2, ask: 1, openInterest: 2_000, volume: 500 }, config).label, 'unknown');
  });

  it('caps a hard-wide spread below Good regardless of the weighted score', () => {
    const liquidity = calculateLiquidity(marketForSpread(15.01, { openInterest: 3_000, volume: 800 }), config);
    assert.ok(['fair', 'poor'].includes(liquidity.label));
    assert.equal(liquidity.warnings[0].severity, 'critical');
  });
});

describe('Radar fit, return, and explanations', () => {
  it('calculates CSP cushion and CC upside from spot', () => {
    assert.deepEqual(calculateStrikeDistance({ optionType: 'put', strike: 90, currentPrice: 100 }), { percent: 10, label: '10.0% cushion' });
    assert.deepEqual(calculateStrikeDistance({ optionType: 'call', strike: 112, currentPrice: 100 }), { percent: 12, label: '12.0% upside' });
  });

  it('uses each complete goal range midpoint as its own delta and DTE target', () => {
    const rules = { targetDeltaMin: 0.30, targetDeltaMax: 0.46, minDte: 8, maxDte: 20 };
    assert.ok(calculateDeltaFit(0.38, rules, config).score > calculateDeltaFit(0.30, rules, config).score);
    assert.ok(calculateDeltaFit(0.38, rules, config).score > calculateDeltaFit(0.46, rules, config).score);
    assert.ok(calculateDeltaFit(0.25, { targetDeltaMin: null, targetDeltaMax: null }, config).score
      > calculateDeltaFit(0.05, { targetDeltaMin: null, targetDeltaMax: null }, config).score);
    assert.ok(calculateDteFit(14, rules, config).score > calculateDteFit(8, rules, config).score);
    assert.ok(calculateDteFit(14, rules, config).score > calculateDteFit(20, rules, config).score);
  });

  it('reuses canonical ROC and derives ROC per day and capital from it', () => {
    assert.deepEqual(calculateReturnMetrics(candidate()), {
      netCredit: 182,
      roc: 3.13,
      rocPerDay: 0.1422727273,
      annualizedReturn: 52,
      capitalRequired: 182 / 0.0313,
    });
  });

  it('applies fit-label boundaries from central config', () => {
    assert.equal(fitLabel(85, config), 'excellent');
    assert.equal(fitLabel(70, config), 'strong');
    assert.equal(fitLabel(55, config), 'good');
    assert.equal(fitLabel(54.99, config), 'marginal');
  });

  it('creates traceable reasons and first-class warnings for the RKLB example', () => {
    const viewModel = createRadarCandidateViewModel(candidate(), result(), 0);
    assert.equal(viewModel.execution.liquidityLabel, 'good');
    assert.equal(viewModel.risk.strikeDistanceLabel, '11.1% cushion');
    assert.ok(viewModel.reasons.some((reason) => reason.type === 'delta' && reason.message.includes('0.20–0.30')));
    assert.ok(viewModel.reasons.some((reason) => reason.type === 'return' && reason.message.includes('2.50% minimum')));
    assert.ok(viewModel.warnings.some((warning) => warning.type === 'wide_spread'));
    assert.ok(viewModel.reasons.length <= radarScoringConfig.explanations.maxItems);
    assert.equal(viewModel.rawMetrics.executable_option_price_per_share, 1.83);
  });

  it('generates boundary, low-return, and missing-market warnings deterministically', () => {
    const viewModel = createRadarCandidateViewModel(candidate({ delta: -0.20, period_return: 0.02, volume: null }), result(), 0);
    const types = new Set(viewModel.warnings.map((warning) => warning.type));
    assert.ok(types.has('near_delta_boundary'));
    assert.ok(types.has('low_return'));
    assert.ok(types.has('missing_market_data'));
  });

  it('keeps ranking stable for equal scores and favors target fit over raw credit', () => {
    const preferred = candidate({ contract_symbol: 'PREFERRED', delta: -0.25, dte: 30, net_contract_credit: 180, period_return: 0.03 });
    const highCredit = candidate({ contract_symbol: 'HIGHCREDIT', delta: -0.30, dte: 45, net_contract_credit: 240, period_return: 0.04 });
    const ranked = prepareRadarCandidates(result([highCredit, preferred]));
    assert.equal(ranked[0].rawMetrics.contract_symbol, 'PREFERRED');

    const equal = prepareRadarCandidates(result([candidate({ contract_symbol: 'FIRST' }), candidate({ contract_symbol: 'SECOND' })]));
    assert.deepEqual(equal.map((item) => item.rawMetrics.contract_symbol), ['FIRST', 'SECOND']);
  });

  it('resolves strategy, ticker, then user interpretation overrides', () => {
    const resolved = resolveRadarScoringConfig({
      leg: 'coveredCall', symbol: 'RKLB',
      tickerConfig: { targets: { preferredDelta: 0.35 } },
      userPreferences: { targets: { preferredDelta: 0.4 } },
    });
    assert.equal(resolved.targets.preferredDte, 30);
    assert.equal(resolved.targets.preferredDelta, 0.4);
  });
});
