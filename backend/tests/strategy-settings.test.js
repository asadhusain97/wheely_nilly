import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  StrategySettingsValidationError,
  builtInStrategySettings,
  createStrategySettingsService,
  normalizeStrategySettings,
  resolveEffectiveSettings,
} from '../src/services/strategy-settings.js';

function addPlaybook(settings, symbol = 'VOOG') {
  settings.tickerPlaybooks[symbol] = {
    coveredCall: {
      enabled: true,
      goal: 'income',
      minNetSalePriceMinor: 12_345,
      overrides: {},
    },
    cashSecuredPut: {
      enabled: false,
      goal: 'acquire',
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
    first.settings.globalRules.coveredCall.minDte = 99;
    const second = await service.load();
    assert.deepEqual(second.settings, builtInStrategySettings());
    assert.equal(second.persistence.persisted, false);
    assert.equal(second.persistence.updatedAt, null);
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
    changed.globalRules.coveredCall.minDte = 8;

    await assert.rejects(failing.save(changed), /rename failed/);
    assert.deepEqual((await service.load()).settings, original);
    assert.equal((await fs.readdir(path.dirname(service.file))).filter((name) => name.includes('.tmp-')).length, 0);
  });

  it('serializes concurrent replacements in invocation order', async () => {
    const { service } = await temporaryService();
    const first = builtInStrategySettings();
    first.globalRules.coveredCall.minDte = 8;
    const second = builtInStrategySettings();
    second.globalRules.coveredCall.minDte = 9;
    await Promise.all([service.save(first), service.save(second)]);
    assert.equal((await service.load()).settings.globalRules.coveredCall.minDte, 9);
  });

  it('rejects unknown fields, incompatible goals, unsafe money, and effective range inversions', () => {
    const unknown = builtInStrategySettings();
    unknown.futureMetric = true;
    assert.throws(() => normalizeStrategySettings(unknown), StrategySettingsValidationError);

    const incompatible = addPlaybook(builtInStrategySettings());
    incompatible.tickerPlaybooks.VOOG.coveredCall.goal = 'acquire';
    assert.throws(() => normalizeStrategySettings(incompatible), /goal/);

    const unsafeMoney = addPlaybook(builtInStrategySettings());
    unsafeMoney.tickerPlaybooks.VOOG.coveredCall.minNetSalePriceMinor = 12.5;
    assert.throws(() => normalizeStrategySettings(unsafeMoney), /minNetSalePriceMinor/);

    const inverted = addPlaybook(builtInStrategySettings());
    inverted.tickerPlaybooks.VOOG.coveredCall.overrides.minDte = 46;
    assert.throws(() => normalizeStrategySettings(inverted), /maxDte/);

    const invertedDelta = builtInStrategySettings();
    invertedDelta.globalRules.coveredCall.targetDeltaMin = 0.6;
    invertedDelta.globalRules.coveredCall.targetDeltaMax = 0.4;
    assert.throws(() => normalizeStrategySettings(invertedDelta), /targetDeltaMax/);

    const inheritedMoneynessInversion = builtInStrategySettings();
    inheritedMoneynessInversion.goalPresets.income.rules.minMoneyness = 1.3;
    assert.throws(() => normalizeStrategySettings(inheritedMoneynessInversion), /maxMoneyness/);
  });

  it('normalizes ticker keys and rejects malformed symbols', () => {
    const normalized = addPlaybook(builtInStrategySettings(), ' voog ');
    assert.ok(normalizeStrategySettings(normalized).tickerPlaybooks.VOOG);

    const malformed = addPlaybook(builtInStrategySettings(), '<VOOG>');
    assert.throws(() => normalizeStrategySettings(malformed), /Invalid key|valid ticker/);
  });
});

describe('effective strategy settings resolution', () => {
  it('resolves global → preset → ticker precedence with an accurate source map', () => {
    const settings = addPlaybook(builtInStrategySettings());
    settings.globalRules.coveredCall.minDte = 10;
    settings.goalPresets.income.rules.minDte = 20;
    settings.tickerPlaybooks.VOOG.coveredCall.overrides.minDte = 25;
    settings.tickerPlaybooks.VOOG.coveredCall.overrides.minVolume = 50;

    const effective = resolveEffectiveSettings(settings, { symbol: 'voog', leg: 'coveredCall' });
    assert.equal(effective.rules.minDte, 25);
    assert.equal(effective.rules.maxDte, 45);
    assert.equal(effective.rules.minMoneyness, 0.8);
    assert.equal(effective.rules.minVolume, 50);
    assert.equal(effective.sourceMap.minDte, 'tickerOverride');
    assert.equal(effective.sourceMap.maxDte, 'preset');
    assert.equal(effective.sourceMap.minMoneyness, 'global');
    assert.equal(effective.sourceMap.minVolume, 'tickerOverride');
    assert.equal(effective.goal, 'income');
    assert.deepEqual(effective.priceGuard, { field: 'minNetSalePriceMinor', valueMinor: 12_345 });
  });

  it('restores inheritance when a ticker override is removed', () => {
    const settings = addPlaybook(builtInStrategySettings());
    settings.tickerPlaybooks.VOOG.coveredCall.overrides.minDte = 28;
    assert.equal(resolveEffectiveSettings(settings, { symbol: 'VOOG', leg: 'coveredCall' }).rules.minDte, 28);
    delete settings.tickerPlaybooks.VOOG.coveredCall.overrides.minDte;
    const reset = resolveEffectiveSettings(settings, { symbol: 'VOOG', leg: 'coveredCall' });
    assert.equal(reset.rules.minDte, 21);
    assert.equal(reset.sourceMap.minDte, 'preset');
  });

  it('uses global rules and a disabled state for an unconfigured ticker', () => {
    const effective = resolveEffectiveSettings(builtInStrategySettings(), { symbol: 'MSFT', leg: 'cashSecuredPut' });
    assert.equal(effective.enabled, false);
    assert.equal(effective.goal, null);
    assert.equal(effective.rules.minDte, 7);
    assert.ok(Object.values(effective.sourceMap).every((source) => source === 'global'));
  });
});
