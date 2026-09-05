import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  builtInSettingsDocument,
  normalizeSettingsDocument,
  normalizeTrackedTickers,
  resolveTickerGoal,
  resolveTickerLeg,
  visibleTickerEntries,
} from '../assets/js/settings.js';

function playbook() {
  return {
    goal: 'acquire',
    coveredCall: { enabled: false, minNetSalePriceMinor: null, overrides: {} },
    cashSecuredPut: { enabled: false, maxNetPurchasePriceMinor: null, overrides: {} },
  };
}

describe('Settings ticker collection UI', () => {
  it('migrates saved browser settings before the editor validates them', () => {
    const legacy = builtInSettingsDocument();
    legacy.schemaVersion = 2;
    for (const profiles of Object.values(legacy.goalProfiles)) {
      for (const rules of Object.values(profiles)) delete rules.rollReviewDte;
    }
    legacy.tickerPlaybooks.RKLB = {
      coveredCall: { enabled: false, goal: 'income', minNetSalePriceMinor: null, overrides: {} },
      cashSecuredPut: { enabled: true, goal: 'acquire', maxNetPurchasePriceMinor: null, overrides: {} },
    };

    const migrated = normalizeSettingsDocument(legacy);

    assert.equal(migrated.schemaVersion, 3);
    assert.equal(migrated.goalProfiles.protect.coveredCall.rollReviewDte, 21);
    assert.equal(migrated.goalProfiles.income.cashSecuredPut.rollReviewDte, 21);
    assert.equal(migrated.goalProfiles.acquire.cashSecuredPut.rollReviewDte, 7);
    assert.equal(migrated.tickerPlaybooks.RKLB.goal, 'acquire');
    assert.equal('goal' in migrated.tickerPlaybooks.RKLB.coveredCall, false);
    assert.equal('goal' in migrated.tickerPlaybooks.RKLB.cashSecuredPut, false);
  });

  it('normalizes symbols and keeps the most recent source for each ticker', () => {
    const tickers = normalizeTrackedTickers([
      { symbol: 'voog', preferredLeg: 'coveredCall', goal: 'income', lastActivityAt: '2026-08-01T00:00:00Z' },
      { symbol: 'VOOG', preferredLeg: 'cashSecuredPut', goal: 'acquire', lastActivityAt: '2026-08-20T00:00:00Z' },
      { symbol: '<bad>', lastActivityAt: '2026-08-24T00:00:00Z' },
    ]);
    assert.deepEqual([...tickers.keys()], ['VOOG']);
    assert.equal(tickers.get('VOOG').preferredLeg, 'cashSecuredPut');
    assert.equal(tickers.get('VOOG').goal, 'acquire');
  });

  it('always resolves one goal, including before a ticker playbook is enabled', () => {
    const settings = playbook();
    assert.equal(resolveTickerGoal(settings, { preferredLeg: 'cashSecuredPut', goal: 'acquire' }), 'acquire');
    settings.coveredCall.enabled = true;
    settings.goal = 'protect';
    settings.coveredCall.enabled = true;
    assert.equal(resolveTickerGoal(settings, { preferredLeg: 'cashSecuredPut', goal: 'acquire' }), 'protect');
    assert.equal(resolveTickerLeg(settings, { preferredLeg: 'cashSecuredPut', goal: 'acquire' }), 'coveredCall');
  });

  it('defaults unconfigured stocks to income and funds with covered calls to keep shares', () => {
    const tickers = normalizeTrackedTickers([
      { symbol: 'MSFT', preferredLeg: 'coveredCall', instrumentType: 'Equity' },
      { symbol: 'VOO', preferredLeg: 'coveredCall', instrumentType: 'ETF' },
      { symbol: 'VFIAX', preferredLeg: 'coveredCall', instrumentType: 'Mutual Fund' },
      { symbol: 'SPY', preferredLeg: 'cashSecuredPut', instrumentType: 'ETF' },
    ]);
    assert.equal(tickers.get('MSFT').goal, 'income');
    assert.equal(tickers.get('VOO').goal, 'protect');
    assert.equal(tickers.get('VFIAX').goal, 'protect');
    assert.equal(tickers.get('SPY').goal, 'income');
  });

  it('sorts by recency, limits the default view to eight, and shows every search match', () => {
    const tickers = Array.from({ length: 11 }, (_, index) => ({
      symbol: `T${String(index).padStart(2, '0')}`,
      recency: index,
    }));
    const collapsed = visibleTickerEntries(tickers);
    assert.equal(collapsed.sorted[0].symbol, 'T10');
    assert.equal(collapsed.visible.length, 8);
    assert.equal(visibleTickerEntries(tickers, '', true).visible.length, 11);
    assert.deepEqual(visibleTickerEntries(tickers, 'T0').visible.map(({ symbol }) => symbol), [
      'T09', 'T08', 'T07', 'T06', 'T05', 'T04', 'T03', 'T02', 'T01', 'T00',
    ]);
  });
});
