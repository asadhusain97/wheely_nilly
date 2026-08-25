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
  limit: z.number().int().min(1).max(100).optional(),
}).strict().refine((v) => v.min_dte == null || v.max_dte == null || v.min_dte <= v.max_dte, 'invalid DTE range');

const responseSchema = z.object({ schema_version: z.literal(1), calculation_version: z.string(), provider: z.string(),
  quote_timestamp: z.string(), cache: z.object({ hit: z.boolean(), age_seconds: z.number().nullable(), stale: z.boolean() }),
  degraded: z.boolean(), warning: z.string().nullable().optional(), assumptions: z.record(z.string(), z.unknown()), exclusions: z.record(z.string(), z.number()),
  candidates: z.array(z.object({ contract_symbol: z.string(), expiration: z.string(), dte: z.number(), strike: z.number(),
    executable_premium: z.number(), annualized_return: z.number(), delta: z.number().nullable(), quote_age_seconds: z.number() }).passthrough()),
}).passthrough();

export class ScreenerError extends Error { constructor(message, status = 503) { super(message); this.name = 'ScreenerError'; this.status = status; } }

export function createScreenerService({ config, fetchImpl = fetch, now = Date.now }) {
  let failures = 0, circuitUntil = 0;
  return { async screen(input) {
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
