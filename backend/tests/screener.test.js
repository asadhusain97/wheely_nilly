import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createScreenerService } from '../src/services/screener.js';

const config = { screener: { url: 'http://screener:8000', timeoutMs: 1000 } };
const valid = { schema_version: 1, calculation_version: 'screener-2.0.0', provider: 'fixture', provider_unofficial: false,
  underlying_price: 195, quote_timestamp: '2026-08-23T12:00:00Z', cache: { hit: false, age_seconds: 0 }, assumptions: {}, exclusions: {}, candidates: [] };
const candidate = { contract_symbol: 'AAPL260918C00200000', option_type: 'call', expiration: '2026-09-18', dte: 24, strike: 200,
  underlying_price: 195, bid: 2, ask: 2.1, executable_option_price_per_share: 2.05, gross_contract_credit: 205,
  estimated_fees: .65, net_contract_credit: 204.35, period_return: .0104, annualized_return: .158, delta: .3,
  theta_per_day: -.04, greek_source: 'black_scholes_estimate', implied_volatility: .28, spread_percent: .0488, volume: 120,
  open_interest: 900, quote_time: '2026-08-25T12:00:00Z', quote_age_seconds: 3, breakeven: 192.9565,
  downside_buffer: -.0256, strike_distance: .0256, net_sale_price: 202.0435, net_purchase_price: null };

describe('screener adapter', () => {
  it('validates provider-backed instrument matches', async () => {
    let requestedUrl;
    const service = createScreenerService({ config, fetchImpl: async (url) => {
      requestedUrl = url;
      return new Response(JSON.stringify({ provider: 'yfinance', provider_unofficial: true,
        matches: [{ symbol: 'AAPL', name: 'Apple Inc.', instrument_type: 'Equity', exchange: 'NasdaqGS', currency: null }] }), { status: 200 });
    } });
    const result = await service.searchInstruments('Apple');
    assert.equal(result.matches[0].name, 'Apple Inc.');
    assert.match(requestedUrl, /\/v1\/instruments\?query=Apple$/);
    await assert.rejects(service.searchInstruments('<script>'), /Invalid instrument search/);
  });
  it('rejects malformed instrument matches', async () => {
    const service = createScreenerService({ config, fetchImpl: async () => new Response(JSON.stringify({ provider: 'fixture', matches: [{ symbol: 'FAKE!', name: '' }] }), { status: 200 }) });
    await assert.rejects(service.searchInstruments('fake'), /invalid contract/);
  });

  it('explains how to recover when ticker search cannot reach the sidecar', async () => {
    const service = createScreenerService({ config, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    await assert.rejects(service.searchInstruments('AAPL'), /start Wheely Nilly with npm run app/);
  });
  it('validates requests and responses', async () => {
    const service = createScreenerService({ config, fetchImpl: async () => new Response(JSON.stringify({ ...valid, candidates: [candidate] }), { status: 200 }) });
    const result = await service.screen({ symbol: 'AAPL', leg: 'cash_secured_put' });
    assert.equal(result.provider, 'fixture');
    assert.equal(result.underlying_price, 195);
    assert.equal(result.candidates[0].net_contract_credit, 204.35);
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

  it('validates exact-contract requests and preserves partial provider results', async () => {
    const contract = { contract_symbol: 'AAPL260918P00180000', symbol: 'AAPL', option_type: 'put', expiration: '2026-09-18', strike: 180 };
    const response = {
      schema_version: 1, calculation_version: 'screener-2.2.0', scanned_at: '2026-08-27T16:00:00Z', duration_ms: 2,
      results: [
        { contract, available: true, unavailable_reason: null, provider: 'fixture', provider_unofficial: false,
          bid: 2, ask: 2.1, underlying_price: 195, strike: 180, expiration: '2026-09-18', option_type: 'put',
          volume: null, open_interest: 100, implied_volatility: null, delta: null, theta_per_day: null,
          contract_quote_time: '2020-01-01T00:00:00Z', underlying_quote_time: '2026-08-27T16:00:00Z',
          fetched_at: '2026-08-27T16:00:00Z', cache: { hit: false, age_seconds: 0 } },
      ],
    };
    let body;
    const service = createScreenerService({ config, fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return new Response(JSON.stringify(response), { status: 200 });
    } });
    const result = await service.quoteContracts({ contracts: [contract] });
    assert.deepEqual(body, { contracts: [contract] });
    assert.equal(result.results[0].ask, 2.1);
    assert.equal(result.results[0].contract_quote_time, '2020-01-01T00:00:00Z');
    await assert.rejects(service.quoteContracts({ contracts: [{ ...contract, contract_symbol: 'bad' }] }), /Invalid exact-contract request/);
  });
});
