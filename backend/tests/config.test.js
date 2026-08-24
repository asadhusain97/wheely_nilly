import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../src/config/index.js';

const baseEnv = {
  NODE_ENV: 'test',
  SNAPTRADE_CLIENT_ID: 'test-client-id',
  SNAPTRADE_CONSUMER_KEY: 'test-consumer-key',
  SNAPTRADE_ACCOUNT_IDS: 'acct-individual-1, acct-individual-2',
  INGEST_ENABLED: 'false',
};

describe('loadConfig', () => {
  it('parses a valid personal-mode environment with defaults', () => {
    const config = loadConfig({ ...baseEnv });
    assert.equal(config.snaptrade.authMode, 'personal');
    assert.equal(config.port, 3000);
    assert.equal(config.timezone, 'UTC');
    assert.equal(config.ingest.cron, '*/30 * * * *');
    assert.equal(config.ingest.activitiesDays, undefined);
    assert.equal(config.retry.attempts, 3);
    assert.deepEqual(config.snaptrade.accountIds, [
      'acct-individual-1',
      'acct-individual-2',
    ]);
    assert.match(config.dataDir, /data$/);
  });

  it('detects commercial mode only when both user credentials are set', () => {
    const config = loadConfig({
      ...baseEnv,
      SNAPTRADE_USER_ID: 'user-1',
      SNAPTRADE_USER_SECRET: 'secret-1',
    });
    assert.equal(config.snaptrade.authMode, 'commercial');
  });

  it('fails fast naming the missing SnapTrade variable', () => {
    const env = { ...baseEnv };
    delete env.SNAPTRADE_CLIENT_ID;
    assert.throws(() => loadConfig(env), /SNAPTRADE_CLIENT_ID/);
  });

  it('rejects a half-configured commercial credential pair', () => {
    assert.throws(
      () => loadConfig({ ...baseEnv, SNAPTRADE_USER_ID: 'user-1' }),
      /SNAPTRADE_USER_ID and SNAPTRADE_USER_SECRET/,
    );
  });

  it('rejects an invalid cron expression', () => {
    assert.throws(
      () => loadConfig({ ...baseEnv, INGEST_CRON: 'not-a-cron' }),
      /INGEST_CRON/,
    );
  });

  it('never includes secret values in validation errors', () => {
    const env = { ...baseEnv, INGEST_CRON: 'bad', SNAPTRADE_CONSUMER_KEY: 'super-secret-value' };
    try {
      loadConfig(env);
      assert.fail('expected ConfigError');
    } catch (error) {
      assert.ok(!error.message.includes('super-secret-value'));
    }
  });
});
