import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createNotificationService, lifecycleAlerts, screenerAlert } from '../src/services/notifications.js';

async function service(overrides = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wheely-ntfy-'));
  const config = { dataDir, notifications: { baseUrl: 'https://ntfy.test', topic: 'private-topic', token: 'secret', timeoutMs: 1000, dryRun: false, enabled: true } };
  return { dataDir, config, notifications: createNotificationService({ config, sleep: async () => {}, random: () => .5, ...overrides }) };
}

describe('notification outbox', () => {
  it('deduplicates the same event across service restarts', async () => {
    const fixture = await service({ fetchImpl: async () => new Response(JSON.stringify({ id: 'upstream-1' }), { status: 200 }) });
    const event = { type: 'expiration', key: 'AAPL-2026-09-18-200-C', state: '7d', title: 'Expiry', message: 'AAPL call expires in 7 days' };
    assert.equal((await fixture.notifications.enqueue(event)).duplicate, false);
    await fixture.notifications.flush();
    const restarted = createNotificationService({ config: fixture.config });
    assert.equal((await restarted.enqueue(event)).duplicate, true);
  });
  it('does not retry permanent authentication failures', async () => {
    let calls = 0; const fixture = await service({ fetchImpl: async () => { calls += 1; return new Response('', { status: 401 }); } });
    await fixture.notifications.enqueue({ type: 'test', key: '1', state: 'x', title: 'Test', message: 'Safe test' });
    const [result] = await fixture.notifications.flush();
    assert.equal(result.status, 'failed'); assert.equal(calls, 1);
  });
  it('records dry runs without network delivery', async () => {
    const fixture = await service(); fixture.config.notifications.dryRun = true;
    await fixture.notifications.enqueue({ type: 'test', key: '2', state: 'x', title: 'Test', message: 'Safe test' });
    assert.equal((await fixture.notifications.flush())[0].status, 'dry-run');
  });
  it('alerts only for reconciled open contracts and labels risk as estimated', () => {
    const now = Date.parse('2026-08-23T20:00:00Z');
    const config = { notifications: { expirationDte: [7], assignmentMaxDte: 7, assignmentMinMoneyness: 1 } };
    const model = { generatedAt: '2026-08-23T19:59:00Z', positions: [{ symbol: 'XYZ', price: '94.00' }], cycles: [
      { underlying: 'XYZ', stage: 'short_put', needsReview: false, contracts: [{ symbol: 'XYZ260830P00095000', optionType: 'put', strikeMinor: 9500, expiration: '2026-08-30', openQuantity: 1 }] },
      { underlying: 'OLD', stage: 'complete', needsReview: false, contracts: [{ symbol: 'OLD', optionType: 'put', strikeMinor: 1000, expiration: '2026-08-30', openQuantity: 0 }] },
    ] };
    const alerts = lifecycleAlerts(model, config, now);
    assert.equal(alerts.filter((item) => item.type === 'expiration').length, 1);
    assert.match(alerts.find((item) => item.type === 'assignment-risk').message, /estimated.*not a confirmed assignment/i);
  });
});

it('uses whole dollars for totals while retaining strike and delta precision in alerts', () => {
  const candidate = {
    contract_symbol: 'XYZ260918P00095500', expiration: '2026-09-18', strike: 95.5,
    executable_premium: 204.35, annualized_return: .158, delta: -.287,
    spread_percent: .02, quote_age_seconds: 12,
  };
  const config = { notifications: { dailyCap: 5, cooldownMs: 0, screenerRule: {
    minAnnualizedReturn: .1, maxDelta: .4, maxSpreadPercent: .05, maxQuoteAgeSeconds: 30, dashboardUrl: null,
  } } };

  const alert = screenerAlert(candidate, { symbol: 'XYZ', leg: 'cash_secured_put' }, config);

  assert.match(alert.message, /\$95\.5: est\. \$204,/);
  assert.match(alert.message, /Δ -0\.29/);
  assert.doesNotMatch(alert.message, /\$204\.35/);
});
