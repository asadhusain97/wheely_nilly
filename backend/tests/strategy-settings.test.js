import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  StrategySettingsValidationError,
  builtInStrategySettings,
  createStrategySettingsService,
  migrateV1StrategySettings,
  normalizeStrategySettings,
  resolveEffectiveSettings,
} from '../src/services/strategy-settings.js';

const LEGACY_GLOBAL = {
  minDte: 7, maxDte: 45, minMoneyness: 0.8, maxMoneyness: 1.2,
  targetDeltaMin: null, targetDeltaMax: 0.35, maxSpreadPercent: 0.2,
  minOpenInterest: 10, minVolume: 0, maxQuoteAgeSeconds: 900, minPeriodReturn: 0,
};

function legacySettings() {
  return {
    schemaVersion: 1,
    globalRules: { coveredCall: { ...LEGACY_GLOBAL }, cashSecuredPut: { ...LEGACY_GLOBAL } },
    goalPresets: {
      protect: { applicableLegs: ['coveredCall'], rules: { minDte: 30, maxDte: 60, targetDeltaMin: 0.1, targetDeltaMax: 0.2 } },
      income: { applicableLegs: ['coveredCall', 'cashSecuredPut'], rules: { minDte: 21, maxDte: 45, targetDeltaMin: 0.2, targetDeltaMax: 0.35 } },
      exit: { applicableLegs: ['coveredCall'], rules: { minDte: 7, maxDte: 30, targetDeltaMin: 0.35, targetDeltaMax: 0.7 } },
      acquire: { applicableLegs: ['cashSecuredPut'], rules: { minDte: 21, maxDte: 45, targetDeltaMin: 0.2, targetDeltaMax: 0.35 } },
    },
    tickerPlaybooks: {},
  };
}

function addPlaybook(settings, symbol = 'VOOG') {
  if (settings.schemaVersion === 1) {
    settings.tickerPlaybooks[symbol] = {
      coveredCall: { enabled: true, goal: 'income', minNetSalePriceMinor: 12_345, overrides: {} },
      cashSecuredPut: { enabled: false, goal: 'acquire', maxNetPurchasePriceMinor: null, overrides: {} },
    };
    return settings;
  }
  settings.tickerPlaybooks[symbol] = {
    goal: 'income',
    coveredCall: {
      enabled: true,
      minNetSalePriceMinor: 12_345,
      overrides: {},
    },
    cashSecuredPut: {
      enabled: false,
      maxNetPurchasePriceMinor: null,
      overrides: {},
    },
  };
  return settings;
}

async function temporaryService(overrides = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wheely-strategy-'));
  return {
    dataDir,
    service: createStrategySettingsService({ dataDir, ...overrides }),
  };
}

describe('strategy settings model and persistence', () => {
  it('returns independent deterministic defaults when no saved file exists', async () => {
    const { service } = await temporaryService();
    const first = await service.load();
    first.settings.goalProfiles.protect.coveredCall.minDte = 99;
    const second = await service.load();
    assert.deepEqual(second.settings, builtInStrategySettings());
    assert.equal(second.persistence.persisted, false);
    assert.equal(second.persistence.updatedAt, null);
    assert.equal(second.settings.goalProfiles.acquire.cashSecuredPut.closeAtProfitCapture, 0.85);
    assert.equal(second.settings.goalProfiles.acquire.cashSecuredPut.rollReviewDte, 7);
    assert.equal('maxQuoteAgeSeconds' in second.settings.goalProfiles.acquire.cashSecuredPut, false);
  });

  it('gives every built-in goal a complete, distinct rule set', () => {
    const profiles = builtInStrategySettings().goalProfiles;
    assert.deepEqual(profiles.protect.coveredCall, {
      minDte: 30, maxDte: 60, minMoneyness: 1.05, maxMoneyness: 1.25,
      targetDeltaMin: 0.08, targetDeltaMax: 0.18, maxSpreadPercent: 0.08,
      minOpenInterest: 100, minVolume: 20, minPeriodReturn: 0.002,
      closeAtProfitCapture: 0.35, rollReviewDte: 21,
    });
    assert.deepEqual(profiles.income.coveredCall, {
      minDte: 14, maxDte: 35, minMoneyness: 1, maxMoneyness: 1.1,
      targetDeltaMin: 0.30, targetDeltaMax: 0.45, maxSpreadPercent: 0.08,
      minOpenInterest: 100, minVolume: 20, minPeriodReturn: 0.01,
      closeAtProfitCapture: 0.50, rollReviewDte: 21,
    });
    assert.deepEqual(profiles.income.cashSecuredPut, {
      minDte: 14, maxDte: 35, minMoneyness: 0.9, maxMoneyness: 1,
      targetDeltaMin: 0.30, targetDeltaMax: 0.45, maxSpreadPercent: 0.08,
      minOpenInterest: 100, minVolume: 20, minPeriodReturn: 0.01,
      closeAtProfitCapture: 0.50, rollReviewDte: 21,
    });
    assert.deepEqual(profiles.exit.coveredCall, {
      minDte: 7, maxDte: 21, minMoneyness: 0.95, maxMoneyness: 1.05,
      targetDeltaMin: 0.45, targetDeltaMax: 0.65, maxSpreadPercent: 0.10,
      minOpenInterest: 50, minVolume: 10, minPeriodReturn: 0.0025,
      closeAtProfitCapture: 0.90, rollReviewDte: 7,
    });
    assert.deepEqual(profiles.acquire.cashSecuredPut, {
      minDte: 7, maxDte: 28, minMoneyness: 0.97, maxMoneyness: 1,
      targetDeltaMin: 0.40, targetDeltaMax: 0.55, maxSpreadPercent: 0.10,
      minOpenInterest: 50, minVolume: 10, minPeriodReturn: 0.005,
      closeAtProfitCapture: 0.85, rollReviewDte: 7,
    });
  });

  it('atomically saves, reloads across service restarts, and restricts permissions', async () => {
    const now = Date.parse('2026-08-24T12:00:00.000Z');
    const { dataDir, service } = await temporaryService({ now: () => now });
    const settings = addPlaybook(builtInStrategySettings());
    const saved = await service.save(settings);
    const restarted = createStrategySettingsService({ dataDir });
    const loaded = await restarted.load();

    assert.deepEqual(loaded, saved);
    assert.equal(loaded.settings.tickerPlaybooks.VOOG.coveredCall.minNetSalePriceMinor, 12_345);
    assert.equal((await fs.stat(path.dirname(service.file))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(service.file)).mode & 0o777, 0o600);
  });

  it('keeps the previous document when atomic rename fails', async () => {
    const { dataDir, service } = await temporaryService();
    const original = addPlaybook(builtInStrategySettings());
    await service.save(original);
    const failingFs = { ...fs, rename: async () => { throw new Error('rename failed'); } };
    const failing = createStrategySettingsService({ dataDir, fsImpl: failingFs });
    const changed = structuredClone(original);
    changed.goalProfiles.protect.coveredCall.minDte = 31;

    await assert.rejects(failing.save(changed), /rename failed/);
    assert.deepEqual((await service.load()).settings, original);
    assert.equal((await fs.readdir(path.dirname(service.file))).filter((name) => name.includes('.tmp-')).length, 0);
  });

  it('serializes concurrent replacements in invocation order', async () => {
    const { service } = await temporaryService();
    const first = builtInStrategySettings();
    first.goalProfiles.protect.coveredCall.minDte = 31;
    const second = builtInStrategySettings();
    second.goalProfiles.protect.coveredCall.minDte = 32;
    await Promise.all([service.save(first), service.save(second)]);
    assert.equal((await service.load()).settings.goalProfiles.protect.coveredCall.minDte, 32);
  });

  it('rejects unknown fields, incompatible goals, unsafe money, and effective range inversions', () => {
    const unknown = builtInStrategySettings();
    unknown.futureMetric = true;
    assert.throws(() => normalizeStrategySettings(unknown), StrategySettingsValidationError);

    const invalidGoal = addPlaybook(builtInStrategySettings());
    invalidGoal.tickerPlaybooks.VOOG.goal = 'invalid';
    assert.throws(() => normalizeStrategySettings(invalidGoal), /goal/);

    const unsafeMoney = addPlaybook(builtInStrategySettings());
    unsafeMoney.tickerPlaybooks.VOOG.coveredCall.minNetSalePriceMinor = 12.5;
    assert.throws(() => normalizeStrategySettings(unsafeMoney), /minNetSalePriceMinor/);

    const inverted = addPlaybook(builtInStrategySettings());
    inverted.tickerPlaybooks.VOOG.coveredCall.overrides.minDte = 46;
    assert.throws(() => normalizeStrategySettings(inverted), /maxDte/);

    const invertedDelta = builtInStrategySettings();
    invertedDelta.goalProfiles.protect.coveredCall.targetDeltaMin = 0.6;
    invertedDelta.goalProfiles.protect.coveredCall.targetDeltaMax = 0.4;
    assert.throws(() => normalizeStrategySettings(invertedDelta), /targetDeltaMax/);

    const moneynessInversion = builtInStrategySettings();
    moneynessInversion.goalProfiles.income.cashSecuredPut.minMoneyness = 1.3;
    assert.throws(() => normalizeStrategySettings(moneynessInversion), /maxMoneyness/);
  });

  it('normalizes ticker keys and rejects malformed symbols', () => {
    const normalized = addPlaybook(builtInStrategySettings(), ' voog ');
    assert.ok(normalizeStrategySettings(normalized).tickerPlaybooks.VOOG);

    const malformed = addPlaybook(builtInStrategySettings(), '<VOOG>');
    assert.throws(() => normalizeStrategySettings(malformed), /Invalid key|valid ticker/);
  });

  it('migrates version 1 baselines into complete goal and strategy profiles', () => {
    const legacy = legacySettings();
    legacy.globalRules.coveredCall.minVolume = 25;
    legacy.globalRules.cashSecuredPut.minVolume = 50;
    legacy.goalPresets.income.rules.maxDte = 42;
    const migrated = migrateV1StrategySettings(legacy);

    assert.equal(migrated.schemaVersion, 3);
    assert.equal(migrated.goalProfiles.income.coveredCall.minVolume, 25);
    assert.equal(migrated.goalProfiles.income.cashSecuredPut.minVolume, 50);
    assert.equal(migrated.goalProfiles.income.coveredCall.maxDte, 42);
    assert.equal(migrated.goalProfiles.protect.coveredCall.minDte, 30);
    assert.equal(migrated.goalProfiles.protect.coveredCall.rollReviewDte, 10);
    assert.equal(migrated.goalProfiles.exit.coveredCall.rollReviewDte, 7);
    assert.equal(migrated.globalRules, undefined);
  });

  it('loads a persisted version 1 document without changing its timestamp or ticker overrides', async () => {
    const { service } = await temporaryService();
    const legacy = addPlaybook(legacySettings());
    legacy.globalRules.coveredCall.minVolume = 25;
    const updatedAt = '2026-08-24T12:00:00.000Z';
    await fs.mkdir(path.dirname(service.file), { recursive: true });
    await fs.writeFile(service.file, JSON.stringify({ ...legacy, updatedAt }));

    const loaded = await service.load();
    assert.equal(loaded.settings.schemaVersion, 3);
    assert.equal(loaded.settings.goalProfiles.income.coveredCall.minVolume, 25);
    assert.equal(loaded.settings.tickerPlaybooks.VOOG.coveredCall.minNetSalePriceMinor, 12_345);
    assert.deepEqual(loaded.persistence, { persisted: true, updatedAt });
    assert.equal(loaded.settings.goalProfiles.income.coveredCall.closeAtProfitCapture, 0.5);
    assert.equal('maxQuoteAgeSeconds' in loaded.settings.goalProfiles.income.coveredCall, false);
  });

  it('defaults persisted schema-v2 Close and roll fields without discarding saved values', async () => {
    const { service } = await temporaryService();
    const olderV2 = builtInStrategySettings();
    olderV2.schemaVersion = 2;
    olderV2.goalProfiles.protect.coveredCall.minVolume = 77;
    for (const profiles of Object.values(olderV2.goalProfiles)) {
      for (const rules of Object.values(profiles)) {
        delete rules.closeAtProfitCapture;
        delete rules.rollReviewDte;
        rules.maxQuoteAgeSeconds = 123;
      }
    }
    const updatedAt = '2026-08-24T12:00:00.000Z';
    await fs.mkdir(path.dirname(service.file), { recursive: true });
    await fs.writeFile(service.file, JSON.stringify({ ...olderV2, updatedAt }));
    const loaded = await service.load();
    assert.equal(loaded.settings.goalProfiles.protect.coveredCall.minVolume, 77);
    assert.equal(loaded.settings.goalProfiles.protect.coveredCall.closeAtProfitCapture, 0.5);
    assert.equal(loaded.settings.goalProfiles.protect.coveredCall.rollReviewDte, 21);
    assert.equal(loaded.settings.goalProfiles.exit.coveredCall.rollReviewDte, 7);
    assert.equal('maxQuoteAgeSeconds' in loaded.settings.goalProfiles.protect.coveredCall, false);
    assert.deepEqual(loaded.persistence, { persisted: true, updatedAt });
  });

  it('upgrades only saved profiles that still match the former built-ins', async () => {
    const { service } = await temporaryService();
    const former = migrateV1StrategySettings(legacySettings());
    former.goalProfiles.protect.coveredCall.minVolume = 77;
    const updatedAt = '2026-08-24T12:00:00.000Z';
    await fs.mkdir(path.dirname(service.file), { recursive: true });
    await fs.writeFile(service.file, JSON.stringify({ ...former, updatedAt }));

    const loaded = await service.load();
    assert.equal(loaded.settings.goalProfiles.protect.coveredCall.minVolume, 77);
    assert.equal(loaded.settings.goalProfiles.protect.coveredCall.minDte, 30);
    assert.equal(loaded.settings.goalProfiles.income.coveredCall.minDte, 14);
    assert.equal(loaded.settings.goalProfiles.income.coveredCall.minMoneyness, 1);
    assert.equal(loaded.settings.goalProfiles.acquire.cashSecuredPut.closeAtProfitCapture, 0.85);
  });

  it('validates Close as greater than zero through one', () => {
    for (const value of [0, -0.1, 1.01]) {
      const settings = builtInStrategySettings();
      settings.goalProfiles.acquire.cashSecuredPut.closeAtProfitCapture = value;
      assert.throws(() => normalizeStrategySettings(settings), /closeAtProfitCapture/);
    }
    const settings = builtInStrategySettings();
    settings.goalProfiles.acquire.cashSecuredPut.closeAtProfitCapture = 1;
    assert.equal(normalizeStrategySettings(settings).goalProfiles.acquire.cashSecuredPut.closeAtProfitCapture, 1);
  });

  it('validates roll review DTE as a whole number from zero through 365', () => {
    for (const value of [-1, 2.5, 366]) {
      const settings = builtInStrategySettings();
      settings.goalProfiles.income.coveredCall.rollReviewDte = value;
      assert.throws(() => normalizeStrategySettings(settings), /rollReviewDte/);
    }
    const settings = builtInStrategySettings();
    settings.goalProfiles.income.coveredCall.rollReviewDte = 0;
    assert.equal(normalizeStrategySettings(settings).goalProfiles.income.coveredCall.rollReviewDte, 0);
  });
});

describe('effective strategy settings resolution', () => {
  it('uses one saved ticker goal for both open-contract strategies', () => {
    const settings = addPlaybook(builtInStrategySettings());
    settings.tickerPlaybooks.VOOG.goal = 'acquire';
    settings.tickerPlaybooks.VOOG.coveredCall.enabled = false;
    settings.tickerPlaybooks.VOOG.cashSecuredPut.enabled = true;

    const call = resolveEffectiveSettings(settings, { symbol: 'VOOG', leg: 'coveredCall' });
    const put = resolveEffectiveSettings(settings, { symbol: 'VOOG', leg: 'cashSecuredPut' });

    assert.equal(call.goal, 'acquire');
    assert.equal(put.goal, 'acquire');
    assert.equal(call.sourceMap.rollReviewDte, 'system');
    assert.equal(put.sourceMap.rollReviewDte, 'goal');
  });

  it('resolves goal → ticker precedence with an accurate source map', () => {
    const settings = addPlaybook(builtInStrategySettings());
    settings.goalProfiles.income.coveredCall.minDte = 20;
    settings.tickerPlaybooks.VOOG.coveredCall.overrides.minDte = 25;
    settings.tickerPlaybooks.VOOG.coveredCall.overrides.minVolume = 50;

    const effective = resolveEffectiveSettings(settings, { symbol: 'voog', leg: 'coveredCall' });
    assert.equal(effective.rules.minDte, 25);
    assert.equal(effective.rules.maxDte, 35);
    assert.equal(effective.rules.minMoneyness, 1);
    assert.equal(effective.rules.minVolume, 50);
    assert.equal(effective.sourceMap.minDte, 'tickerOverride');
    assert.equal(effective.sourceMap.maxDte, 'goal');
    assert.equal(effective.sourceMap.minMoneyness, 'goal');
    assert.equal(effective.sourceMap.minVolume, 'tickerOverride');
    assert.equal(effective.sourceMap.closeAtProfitCapture, 'goal');
    assert.equal(effective.rules.rollReviewDte, 21);
    assert.equal(effective.sourceMap.rollReviewDte, 'goal');
    assert.equal(effective.goal, 'income');
    assert.deepEqual(effective.priceGuard, { field: 'minNetSalePriceMinor', valueMinor: 12_345 });
  });

  it('restores inheritance when a ticker override is removed', () => {
    const settings = addPlaybook(builtInStrategySettings());
    settings.tickerPlaybooks.VOOG.coveredCall.overrides.minDte = 28;
    assert.equal(resolveEffectiveSettings(settings, { symbol: 'VOOG', leg: 'coveredCall' }).rules.minDte, 28);
    delete settings.tickerPlaybooks.VOOG.coveredCall.overrides.minDte;
    const reset = resolveEffectiveSettings(settings, { symbol: 'VOOG', leg: 'coveredCall' });
    assert.equal(reset.rules.minDte, 14);
    assert.equal(reset.sourceMap.minDte, 'goal');
  });

  it('resolves a ticker-specific Close threshold and source', () => {
    const settings = addPlaybook(builtInStrategySettings());
    settings.tickerPlaybooks.VOOG.coveredCall.overrides.closeAtProfitCapture = 0.3;
    const effective = resolveEffectiveSettings(settings, { symbol: 'VOOG', leg: 'coveredCall' });
    assert.equal(effective.rules.closeAtProfitCapture, 0.3);
    assert.equal(effective.sourceMap.closeAtProfitCapture, 'tickerOverride');
  });

  it('resolves a ticker-specific roll review window and source', () => {
    const settings = addPlaybook(builtInStrategySettings());
    settings.tickerPlaybooks.VOOG.coveredCall.overrides.rollReviewDte = 4;
    const effective = resolveEffectiveSettings(settings, { symbol: 'VOOG', leg: 'coveredCall' });
    assert.equal(effective.rules.rollReviewDte, 4);
    assert.equal(effective.sourceMap.rollReviewDte, 'tickerOverride');
  });

  it('uses an income goal and a disabled state for an unconfigured stock ticker', () => {
    const effective = resolveEffectiveSettings(builtInStrategySettings(), { symbol: 'MSFT', leg: 'cashSecuredPut' });
    assert.equal(effective.enabled, false);
    assert.equal(effective.goal, 'income');
    assert.equal(effective.goalDefaulted, true);
    assert.equal(effective.rules.minDte, 14);
    assert.ok(Object.values(effective.sourceMap).every((source) => source === 'goal'));
  });

  it('uses Keep Shares for an unconfigured ETF covered call', () => {
    const effective = resolveEffectiveSettings(builtInStrategySettings(), {
      symbol: 'VOO', leg: 'coveredCall', instrumentType: 'ETF',
    });
    assert.equal(effective.goal, 'protect');
    assert.equal(effective.rules.targetDeltaMax, 0.18);
  });
});
