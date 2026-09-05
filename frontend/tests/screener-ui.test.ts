import assert from 'node:assert/strict';
import { it } from 'node:test';

import {
  candidateHeadline,
  candidateReturnCaption,
  exactInstrumentIdentity,
  exclusionSummary,
  failedScanEntry,
  hydrateTargetIdentities,
  legForGoal,
  loadStoredScanResults,
  marketDateTime,
  providerName,
  storeScanResults,
  targetIdentity,
} from '../assets/js/screener.js';
import { builtInSettingsDocument, settingsWithoutTicker, settingsWithTicker } from '../assets/js/settings.js';

it('shows contract-level net credit instead of the per-share option price', () => {
  const headline = candidateHeadline({ net_contract_credit: 204.35, executable_option_price_per_share: 2.05 });
  assert.equal(headline, '$204 net credit');
  assert.doesNotMatch(headline, /\$2\.05/);
});

it('explains the candidate period return as a term-specific return on capital', () => {
  assert.equal(candidateReturnCaption({ period_return: .0313, dte: 23 }), 'Estimated 23-day return on capital: 3.13%');
});

it('infers strategy from the goal and asks only when Earn Income is ambiguous', () => {
  assert.equal(legForGoal('protect'), 'coveredCall');
  assert.equal(legForGoal('exit'), 'coveredCall');
  assert.equal(legForGoal('acquire'), 'cashSecuredPut');
  assert.equal(legForGoal('income'), 'cashSecuredPut');
  assert.equal(legForGoal('income', 'coveredCall'), 'coveredCall');
  assert.equal(legForGoal('income', 'invalid'), null);
});

it('uses plain scan metadata and summarizes no-match filters without counts', () => {
  assert.equal(providerName('yfinance'), 'Yahoo Finance');
  assert.equal(marketDateTime('2026-08-26T19:59:00Z'), 'Aug 26, 3:59 PM ET');
  assert.deepEqual(exclusionSummary({ period_return: 18, delta_low: 8, delta_high: 7, spread: 4 }), [
    'term return', 'delta range', 'bid-ask spread',
  ]);
  assert.deepEqual(exclusionSummary({ open_interest_unavailable: 2 }), ['available open-interest data']);
});

it('shows the instrument name and type beside the ticker mark without repeating the ticker', () => {
  assert.deepEqual(targetIdentity({ symbol: 'AAPL', name: 'Apple Inc.', instrumentType: 'Equity' }), {
    name: 'Apple Inc.', instrumentType: 'Equity',
  });
  assert.deepEqual(targetIdentity({ symbol: 'VOO' }, { symbol: 'VOO', name: 'Vanguard S&P 500 ETF', instrumentType: 'ETF' }), {
    name: 'Vanguard S&P 500 ETF', instrumentType: 'ETF',
  });
  assert.deepEqual(targetIdentity({ symbol: 'MSFT' }), { name: '', instrumentType: '' });
  assert.deepEqual(exactInstrumentIdentity([
    { symbol: 'GOOG', name: 'Alphabet Inc.', instrument_type: 'Equity' },
    { symbol: 'GOOGL', name: 'Alphabet Inc. Class A', instrument_type: 'Equity' },
  ], 'GOOGL'), { name: 'Alphabet Inc. Class A', instrumentType: 'Equity' });
});

it('hydrates existing Radar targets with exact verified identities and caches them', async () => {
  const calls = [];
  const responses = {
    GOOGL: [{ symbol: 'GOOGL', name: 'Alphabet Inc. Class A', instrument_type: 'Equity' }],
    RKLB: [{ symbol: 'RKLB', name: 'Rocket Lab Corporation', instrument_type: 'Equity' }],
  };
  const request = async (path) => {
    calls.push(path);
    const symbol = new URL(path, 'http://localhost').searchParams.get('query');
    return { matches: responses[symbol] };
  };
  const targets = [{ symbol: 'GOOGL' }, { symbol: 'RKLB' }];
  const identities = await hydrateTargetIdentities(targets, request, () => null);

  assert.deepEqual(identities.get('GOOGL'), { name: 'Alphabet Inc. Class A', instrumentType: 'Equity' });
  assert.deepEqual(identities.get('RKLB'), { name: 'Rocket Lab Corporation', instrumentType: 'Equity' });
  await hydrateTargetIdentities(targets, request, () => null, identities);
  assert.equal(calls.length, 2);
});

it('restores the latest completed Radar results and ignores transient entries', () => {
  let saved = '';
  const storage = {
    getItem: () => saved,
    setItem: (_key, value) => { saved = value; },
  };
  const result = {
    status: 'success',
    result: { symbol: 'AAPL', quote_timestamp: '2026-08-25T12:00:00Z', candidates: [] },
  };
  storeScanResults(new Map([
    ['AAPL:coveredCall', result],
    ['MSFT:cashSecuredPut', { status: 'loading' }],
    ['invalid', result],
  ]), storage);

  assert.deepEqual([...loadStoredScanResults(storage)], [['AAPL:coveredCall', result]]);
  saved = '{not valid JSON';
  assert.deepEqual([...loadStoredScanResults(storage)], []);
});

it('keeps the previous Radar result when refreshed quotes are unavailable', () => {
  const previous = {
    status: 'success',
    result: { symbol: 'AAPL', quote_timestamp: '2026-08-25T12:00:00Z', candidates: [{ strike: 200 }] },
  };
  assert.deepEqual(failedScanEntry(previous, { code: 'SCREENER_UNAVAILABLE' }), {
    ...previous,
    refreshFailed: true,
  });
  assert.deepEqual(failedScanEntry(null, { code: 'SCREENER_UNAVAILABLE' }), {
    status: 'error',
    error: { code: 'SCREENER_UNAVAILABLE' },
  });
});

it('adds the selected ticker playbook to the settings document', () => {
  const settings = builtInSettingsDocument();
  const added = settingsWithTicker(settings, 'AAPL', 'cashSecuredPut', 'acquire');
  assert.equal(added.tickerPlaybooks.AAPL.cashSecuredPut.enabled, true);
  assert.equal(added.tickerPlaybooks.AAPL.goal, 'acquire');
  assert.equal(added.tickerPlaybooks.AAPL.coveredCall.enabled, false);
  assert.equal(settings.tickerPlaybooks.AAPL, undefined);

  const withCall = settingsWithTicker(added, 'AAPL', 'coveredCall', 'income');
  assert.equal(withCall.tickerPlaybooks.AAPL.goal, 'income');
  assert.equal(withCall.tickerPlaybooks.AAPL.cashSecuredPut.enabled, true);
  assert.equal(withCall.tickerPlaybooks.AAPL.coveredCall.enabled, true);
});

it('removes the whole ticker playbook without mutating the current settings', () => {
  const settings = settingsWithTicker(builtInSettingsDocument(), 'AAPL', 'cashSecuredPut', 'acquire');
  const removed = settingsWithoutTicker(settings, 'AAPL');

  assert.equal(removed.tickerPlaybooks.AAPL, undefined);
  assert.ok(settings.tickerPlaybooks.AAPL);
});
