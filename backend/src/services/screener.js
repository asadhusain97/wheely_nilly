import { z } from 'zod';

const requestSchema = z.object({
  symbol: z.string().regex(/^[A-Z][A-Z0-9.-]{0,9}$/), leg: z.enum(['cash_secured_put', 'covered_call']),
  min_dte: z.number().int().min(1).max(365).optional(), max_dte: z.number().int().min(1).max(730).optional(),
  min_moneyness: z.number().positive().max(2).optional(), max_moneyness: z.number().positive().max(3).optional(),
  min_open_interest: z.number().int().nonnegative().optional(), min_volume: z.number().int().nonnegative().optional(),
  max_spread_percent: z.number().positive().max(1).optional(), target_delta_min: z.number().min(0).max(1).nullable().optional(),
  target_delta_max: z.number().min(0).max(1).nullable().optional(), cash_available: z.number().nonnegative().optional(),
  covered_shares: z.number().int().nonnegative().optional(), adjusted_basis_per_share: z.number().positive().nullable().optional(),
  estimated_fee_per_contract: z.number().nonnegative().max(100).optional(), max_quote_age_seconds: z.number().int().positive().max(86400).optional(),
  min_period_return: z.number().min(0).max(10).optional(), min_net_sale_price: z.number().nonnegative().nullable().optional(),
  max_net_purchase_price: z.number().nonnegative().nullable().optional(), allow_itm_calls: z.boolean().optional(),
  chain_min_dte: z.number().int().min(1).max(365).optional(), chain_max_dte: z.number().int().min(1).max(730).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict()
  .refine((v) => v.min_dte == null || v.max_dte == null || v.min_dte <= v.max_dte, 'invalid DTE range')
  .refine((v) => (v.chain_min_dte == null) === (v.chain_max_dte == null), 'chain DTE bounds must be supplied together');

const candidateSchema = z.object({
  contract_symbol: z.string(), option_type: z.enum(['put', 'call']), expiration: z.string(), dte: z.number().int(),
  strike: z.number(), underlying_price: z.number(), bid: z.number(), ask: z.number(),
  executable_option_price_per_share: z.number(), gross_contract_credit: z.number(), estimated_fees: z.number(),
  net_contract_credit: z.number(), period_return: z.number(), annualized_return: z.number(), delta: z.number().nullable(),
  theta_per_day: z.number().nullable(), greek_source: z.enum(['black_scholes_estimate', 'unavailable']),
  implied_volatility: z.number().nullable(), spread_percent: z.number(), volume: z.number().int().nullable(),
  open_interest: z.number().int().nullable(), quote_time: z.string(), quote_age_seconds: z.number(), breakeven: z.number(),
  downside_buffer: z.number(), strike_distance: z.number(), net_sale_price: z.number().nullable(), net_purchase_price: z.number().nullable(),
}).passthrough();

const responseSchema = z.object({ schema_version: z.literal(1), calculation_version: z.string(), provider: z.string(),
  underlying_price: z.number().positive(), quote_timestamp: z.string().nullable(), cache: z.object({ hit: z.boolean(), age_seconds: z.number().nullable() }),
  assumptions: z.record(z.string(), z.unknown()), exclusions: z.record(z.string(), z.number()),
  provider_unofficial: z.boolean(), candidates: z.array(candidateSchema),
}).passthrough();

const instrumentQuerySchema = z.string().trim().min(1).max(50).regex(/^[A-Za-z0-9 .&'-]+$/);
const instrumentResponseSchema = z.object({
  provider: z.string(), provider_unofficial: z.boolean(),
  matches: z.array(z.object({ symbol: z.string().regex(/^[A-Z][A-Z0-9.-]{0,9}$/), name: z.string().min(1),
    instrument_type: z.enum(['Equity', 'ETF', 'Mutual Fund']), exchange: z.string().nullable(), currency: z.string().nullable() }).strict()),
}).strict();

export class ScreenerError extends Error { constructor(message, status = 503) { super(message); this.name = 'ScreenerError'; this.status = status; } }

export function createScreenerService({ config, fetchImpl = fetch, now = Date.now }) {
  let failures = 0, circuitUntil = 0;
  return { async searchInstruments(query) {
    const parsed = instrumentQuerySchema.safeParse(query);
    if (!parsed.success) throw new ScreenerError('Invalid instrument search', 400);
    try {
      const response = await fetchImpl(`${config.screener.url}/v1/instruments?${new URLSearchParams({ query: parsed.data })}`, { signal: AbortSignal.timeout(config.screener.timeoutMs), headers: { accept: 'application/json' } });
      if (!response.ok) throw new ScreenerError(`Instrument lookup returned HTTP ${response.status}`);
      const result = instrumentResponseSchema.safeParse(await response.json());
      if (!result.success) throw new ScreenerError('Instrument lookup returned an invalid contract');
      return result.data;
    } catch (error) {
      if (error instanceof ScreenerError) throw error;
      if (error instanceof TypeError) throw new ScreenerError(`Cannot connect to ticker search at ${config.screener.url}; start Wheely Nilly with npm run app`);
      throw new ScreenerError(`Instrument lookup unavailable (${error.name ?? 'network error'})`);
    }
  }, async screen(input) {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) throw new ScreenerError(`Invalid screen request: ${parsed.error.issues[0].message}`, 400);
    if (now() < circuitUntil) throw new ScreenerError('Screener circuit is temporarily open');
    try {
      const response = await fetchImpl(`${config.screener.url}/v1/screens`, { method: 'POST', signal: AbortSignal.timeout(config.screener.timeoutMs), headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(parsed.data) });
      if (!response.ok) throw new ScreenerError(`Screener returned HTTP ${response.status}`);
      const result = responseSchema.safeParse(await response.json());
      if (!result.success) throw new ScreenerError('Screener returned an invalid contract');
      failures = 0; return result.data;
    } catch (error) {
      failures += 1; if (failures >= 3) circuitUntil = now() + 30_000;
      if (error instanceof ScreenerError) throw error;
      if (error instanceof TypeError) throw new ScreenerError(`Cannot connect to screener at ${config.screener.url}; start the Python sidecar and verify PYTHON_SIDECAR_URL`);
      throw new ScreenerError(`Screener unavailable (${error.name ?? 'network error'})`);
    }
  }};
}
