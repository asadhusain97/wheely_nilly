import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import request from 'supertest';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import {
  builtInStrategySettings,
  createStrategySettingsService,
} from '../src/services/strategy-settings.js';

async function appFixture() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wheely-strategy-api-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    SNAPTRADE_CLIENT_ID: 'client',
    SNAPTRADE_CONSUMER_KEY: 'secret',
    INGEST_ENABLED: 'false',
    DATA_DIR: dataDir,
  });
  const strategySettings = createStrategySettingsService({ dataDir, now: () => Date.parse('2026-08-24T12:00:00Z') });
  const app = createApp({
    config,
    strategySettings,
    snaptrade: { authMode: 'personal' },
    ingest: { isRunning: () => false, getLastRun: () => null },
    snapshots: {},
  });
  return { app, strategySettings };
}

function configuredSettings() {
  const settings = builtInStrategySettings();
  settings.tickerPlaybooks.VOOG = {
    coveredCall: { enabled: true, goal: 'income', minNetSalePriceMinor: 18_000, overrides: { maxDte: 40 } },
    cashSecuredPut: { enabled: false, goal: 'acquire', maxNetPurchasePriceMinor: 17_500, overrides: {} },
  };
  return settings;
}

describe('strategy settings API', () => {
  it('continues to serve the dashboard and the settings module from same-origin static routes', async () => {
    const { app } = await appFixture();
    const index = await request(app).get('/');
    const module = await request(app).get('/assets/js/settings.js');
    const glossaryModule = await request(app).get('/assets/js/glossary.js');
    const settingsStyles = await request(app).get('/assets/css/settings.css');
    assert.equal(index.status, 200);
    assert.match(index.text, /id="more-title">Strategy settings/);
    assert.equal(module.status, 200);
    assert.match(module.text, /createStrategySettingsController/);
    assert.equal(glossaryModule.status, 200);
    assert.match(glossaryModule.text, /initializeGlossary/);
    assert.equal(settingsStyles.status, 200);
    assert.match(settingsStyles.text, /--settings-glass/);
  });

  it('returns defaults with persistence metadata and replaces the full document', async () => {
    const { app } = await appFixture();
    const initial = await request(app).get('/api/v1/strategy-settings');
    assert.equal(initial.status, 200);
    assert.equal(initial.body.settings.schemaVersion, 1);
    assert.equal(initial.body.persistence.persisted, false);

    const saved = await request(app).put('/api/v1/strategy-settings').send(configuredSettings());
    assert.equal(saved.status, 200);
    assert.equal(saved.body.persistence.updatedAt, '2026-08-24T12:00:00.000Z');
    assert.equal(saved.body.settings.tickerPlaybooks.VOOG.coveredCall.minNetSalePriceMinor, 18_000);
  });

  it('validates effective queries and reports resolved values and sources', async () => {
    const { app, strategySettings } = await appFixture();
    await strategySettings.save(configuredSettings());
    const response = await request(app).get('/api/v1/strategy-settings/effective?symbol=voog&leg=coveredCall');
    assert.equal(response.status, 200);
    assert.equal(response.body.symbol, 'VOOG');
    assert.equal(response.body.rules.minDte, 21);
    assert.equal(response.body.rules.maxDte, 40);
    assert.equal(response.body.sourceMap.minDte, 'preset');
    assert.equal(response.body.sourceMap.maxDte, 'tickerOverride');

    for (const query of [
      'symbol=%3Cbad%3E&leg=coveredCall',
      'symbol=VOOG&leg=shortPut',
      'symbol=VOOG&leg=coveredCall&extra=true',
    ]) {
      const invalid = await request(app).get(`/api/v1/strategy-settings/effective?${query}`);
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.error.code, 'INVALID_QUERY');
    }
  });

  it('rejects malformed complete replacements using the existing error envelope', async () => {
    const { app } = await appFixture();
    const invalid = configuredSettings();
    invalid.globalRules.coveredCall.minDte = 90;
    invalid.globalRules.coveredCall.maxDte = 45;
    const response = await request(app).put('/api/v1/strategy-settings').send(invalid);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'INVALID_STRATEGY_SETTINGS');
    assert.match(response.body.error.message, /maxDte/);
  });
});
