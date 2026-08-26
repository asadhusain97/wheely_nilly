import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import dotenv from 'dotenv';

import { mergeEnvContent, parseAccountSelection } from '../scripts/setup.js';
import { createSidecarEnvironment, isSupportedPythonVersion, parseLocalSidecarUrl } from '../scripts/start-local.js';

describe('setup wizard helpers', () => {
  it('updates known values, preserves unrelated settings, and safely quotes secrets', () => {
    const content = '# Runtime\nTZ=UTC\nSNAPTRADE_CLIENT_ID=old\n';
    const updated = mergeEnvContent(content, {
      SNAPTRADE_CLIENT_ID: 'client-new',
      SNAPTRADE_CONSUMER_KEY: 'secret with #, "quotes", and $&',
      SNAPTRADE_ACCOUNT_IDS: 'acct-1,acct-2',
    });
    const parsed = dotenv.parse(updated);
    assert.equal(parsed.TZ, 'UTC');
    assert.equal(parsed.SNAPTRADE_CLIENT_ID, 'client-new');
    assert.equal(parsed.SNAPTRADE_CONSUMER_KEY, 'secret with #, "quotes", and $&');
    assert.equal(parsed.SNAPTRADE_ACCOUNT_IDS, 'acct-1,acct-2');
    assert.equal(updated.match(/^SNAPTRADE_CLIENT_ID=/gm).length, 1);
  });

  it('selects all accounts by default and parses unique numbered choices', () => {
    assert.deepEqual(parseAccountSelection('', 3), [0, 1, 2]);
    assert.deepEqual(parseAccountSelection('3, 1, 3', 3), [2, 0]);
  });

  it('rejects account choices outside the displayed range', () => {
    assert.throws(() => parseAccountSelection('0', 2), /between 1 and 2/);
    assert.throws(() => parseAccountSelection('3', 2), /between 1 and 2/);
    assert.throws(() => parseAccountSelection('one', 2), /between 1 and 2/);
  });
});

describe('local launcher helpers', () => {
  it('passes only required runtime and screener values to the sidecar', () => {
    const env = createSidecarEnvironment({
      PATH: '/usr/bin',
      SCREENER_TIMEOUT_SECONDS: '15',
      SNAPTRADE_CONSUMER_KEY: 'snaptrade-secret',
      NTFY_TOKEN: 'ntfy-secret',
    });
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.SCREENER_TIMEOUT_SECONDS, '15');
    assert.equal(env.SNAPTRADE_CONSUMER_KEY, undefined);
    assert.equal(env.NTFY_TOKEN, undefined);
  });

  it('aligns uvicorn with a loopback sidecar URL', () => {
    assert.deepEqual(parseLocalSidecarUrl('http://127.0.0.1:9000'), { host: '127.0.0.1', port: '9000' });
    assert.throws(() => parseLocalSidecarUrl('http://screener:8000'), /loopback HTTP origin/);
    assert.throws(() => parseLocalSidecarUrl('https://127.0.0.1:8000'), /loopback HTTP origin/);
  });

  it('requires Python 3.12 or newer', () => {
    assert.equal(isSupportedPythonVersion('3.11'), false);
    assert.equal(isSupportedPythonVersion('3.12'), true);
    assert.equal(isSupportedPythonVersion('4.0'), true);
  });
});
