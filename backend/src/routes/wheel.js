import { Router } from 'express';

const STATES = new Set(['short_put', 'shares_held', 'covered_call', 'complete', 'awaiting_review']);

function badRequest(message) {
  const error = new Error(message); error.name = 'WheelQueryError'; return error;
}

function parseDate(value, name) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw badRequest(`${name} must use YYYY-MM-DD`);
  return Date.parse(`${value}T00:00:00.000Z`);
}

function filterCycles(cycles, query) {
  const symbol = String(query.symbol ?? '').trim().toUpperCase();
  const accountId = String(query.accountId ?? '').trim();
  const state = String(query.state ?? '').trim();
  if (symbol && !/^[A-Z0-9.]{1,10}$/.test(symbol)) throw badRequest('symbol is invalid');
  if (state && !STATES.has(state)) throw badRequest('state is invalid');
  const from = parseDate(query.from, 'from');
  const to = parseDate(query.to, 'to');
  if (from && to && (to < from || to - from > 10 * 365 * 86_400_000)) throw badRequest('date range is invalid or exceeds 10 years');
  return cycles.filter((cycle) =>
    (!symbol || cycle.underlying.toUpperCase() === symbol) &&
    (!accountId || cycle.accountId === accountId) &&
    (!state || cycle.stage === state) &&
    (!from || Date.parse(cycle.openedAt) >= from) &&
    (!to || Date.parse(cycle.openedAt) <= to));
}

export function createWheelRouter({ derived }) {
  const router = Router();
  router.use((request, response, next) => {
    response.setHeader('cache-control', 'private, no-store');
    next();
  });
  router.get('/summary', async (_request, response, next) => {
    try { const model = await derived.load(); response.json({ calculationVersion: model.calculationVersion, generatedAt: model.generatedAt, freshness: model.freshness, scope: model.scope, summary: model.summary }); } catch (error) { next(error); }
  });
  router.get('/cycles', async (request, response, next) => {
    try {
      const model = await derived.load();
      const parsed = Number.parseInt(request.query.limit ?? '100', 10);
      const limit = Math.max(1, Math.min(Number.isNaN(parsed) ? 100 : parsed, 500));
      response.json({ calculationVersion: model.calculationVersion, generatedAt: model.generatedAt, freshness: model.freshness, scope: model.scope, cycles: filterCycles(model.cycles, request.query).slice(0, limit) });
    } catch (error) {
      if (error.name === 'WheelQueryError') { response.status(400).json({ error: { code: 'INVALID_QUERY', message: error.message } }); return; }
      next(error);
    }
  });
  for (const [path, key] of [['/positions', 'positions'], ['/premiums', 'premiumLedger'], ['/review', 'reviewEvents']]) {
    router.get(path, async (_request, response, next) => {
      try { const model = await derived.load(); response.json({ calculationVersion: model.calculationVersion, generatedAt: model.generatedAt, freshness: model.freshness, [key]: model[key] }); } catch (error) { next(error); }
    });
  }
  return router;
}
