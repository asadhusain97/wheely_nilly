import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createScreenerService } from '../src/services/screener.js';

const config = { screener: { url: 'http://screener:8000', timeoutMs: 1000 } };
const valid = { schema_version: 1, calculation_version: 'screener-1.0.0', provider: 'fixture', quote_timestamp: '2026-08-23T12:00:00Z', cache: { hit: false, age_seconds: 0, stale: false }, degraded: false, assumptions: {}, exclusions: {}, candidates: [] };

describe('screener adapter', () => {
  it('validates requests and responses', async () => {
    const service = createScreenerService({ config, fetchImpl: async () => new Response(JSON.stringify(valid), { status: 200 }) });
    assert.equal((await service.screen({ symbol: 'AAPL', leg: 'cash_secured_put' })).provider, 'fixture');
    await assert.rejects(service.screen({ symbol: '<bad>', leg: 'put' }), /Invalid screen request/);
  });
  it('rejects malformed sidecar output', async () => {
    const service = createScreenerService({ config, fetchImpl: async () => new Response('{}', { status: 200 }) });
    await assert.rejects(service.screen({ symbol: 'AAPL', leg: 'covered_call' }), /invalid contract/);
  });
  it('opens the circuit after three failures', async () => {
    let calls = 0; const service = createScreenerService({ config, fetchImpl: async () => { calls += 1; throw new Error('offline'); }, now: () => 1000 });
    for (let index = 0; index < 3; index += 1) await assert.rejects(service.screen({ symbol: 'AAPL', leg: 'covered_call' }));
    await assert.rejects(service.screen({ symbol: 'AAPL', leg: 'covered_call' }), /circuit/);
    assert.equal(calls, 3);
  });
  it('explains how to recover when the sidecar is not reachable', async () => {
    const service = createScreenerService({ config, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    await assert.rejects(service.screen({ symbol: 'AAPL', leg: 'covered_call' }), /start the Python sidecar.*PYTHON_SIDECAR_URL/);
  });
});
