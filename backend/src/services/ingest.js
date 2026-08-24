import { maskAccountNumber } from '../lib/sanitize.js';
import { parseOccSymbol } from './normalize.js';

export class AccountSelectionError extends Error {
  constructor(message, candidates) {
    super(message);
    this.name = 'AccountSelectionError';
    this.candidates = candidates;
  }
}

function describeCandidates(accounts) {
  return accounts.map((account) => ({
    id: account.id,
    institution: account.institution_name ?? null,
    name: account.name ?? null,
    number: maskAccountNumber(account.number),
  }));
}

function payloadItems(payload, key) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.[key])) return payload[key];
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function quoteTicker(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const symbol = value.replace(/\s/g, '').toUpperCase();
    return parseOccSymbol(symbol)?.underlying ?? (/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol) ? symbol : null);
  }
  const underlying = value.underlying?.symbol ?? value.underlying_symbol?.symbol
    ?? value.underlying ?? value.underlying_symbol;
  if (typeof underlying === 'string') return underlying.trim().toUpperCase();
  return quoteTicker(value.symbol ?? value.raw_symbol ?? value.ticker);
}

function quoteSymbols(payloads) {
  const symbols = new Set();
  const add = (value) => {
    const symbol = quoteTicker(value);
    if (symbol) symbols.add(symbol);
  };
  for (const position of payloadItems(payloads.get('positions'), 'results')) add(position.instrument ?? position.symbol);
  for (const order of payloadItems(payloads.get('orders'), 'orders')) add(order.option_symbol ?? order.instrument ?? order.symbol);
  for (const activity of payloadItems(payloads.get('activities'), 'activities')) add(activity.option_symbol ?? activity.instrument ?? activity.symbol);
  return [...symbols].sort();
}

export function createIngestService({
  config,
  snaptrade,
  snapshots,
  logger = console,
  sdkVersion = 'unknown',
}) {
  let inFlight = null;
  let lastRun = null;

  async function resolveAccounts() {
    const accounts = await snaptrade.listAccounts();
    if (config.snaptrade.accountIds.length === 0) {
      throw new AccountSelectionError(
        'SNAPTRADE_ACCOUNT_IDS is not configured. Discover accounts via GET /api/v1/snaptrade/accounts and pin the intended account IDs in .env.',
        describeCandidates(accounts),
      );
    }
    const wanted = new Set(config.snaptrade.accountIds);
    const selected = accounts.filter((account) => wanted.has(account.id));
    const missing = config.snaptrade.accountIds.filter(
      (id) => !accounts.some((account) => account.id === id),
    );
    if (missing.length > 0) {
      throw new AccountSelectionError(
        `Configured SNAPTRADE_ACCOUNT_IDS not found in the SnapTrade account list: ${missing.join(', ')}`,
        describeCandidates(accounts),
      );
    }
    return selected;
  }

  async function ingestAccount(account, report) {
    const payloads = new Map();
    const steps = [
      ['balances', () => snaptrade.getBalances(account.id)],
      ['positions', () => snaptrade.getPositions(account.id)],
      ['orders', () => snaptrade.getOrders(account.id, config.ingest.ordersDays)],
      [
        'activities',
        () => snaptrade.getActivities(account.id),
      ],
    ];

    for (const [endpoint, fetcher] of steps) {
      const stepStart = Date.now();
      try {
        const payload = await fetcher();
        payloads.set(endpoint, payload);
        const result = await snapshots.write({
          accountId: account.id,
          endpoint,
          payload,
          fetchedAt: new Date().toISOString(),
          durationMs: Date.now() - stepStart,
          sdkVersion,
        });
        report.endpoints.push({
          accountId: account.id,
          endpoint,
          status: 'ok',
          skipped: result.skipped,
          hash: result.hash.slice(0, 16),
          durationMs: Date.now() - stepStart,
        });
      } catch (error) {
        report.ok = false;
        report.endpoints.push({
          accountId: account.id,
          endpoint,
          status: 'error',
          error: error.message,
          durationMs: Date.now() - stepStart,
        });
        logger.error(
          { accountId: account.id, endpoint, err: error.name },
          'ingest step failed',
        );
      }
    }

    const symbols = payloads.has('positions') && payloads.has('activities') ? quoteSymbols(payloads) : [];
    if (symbols.length) {
      const stepStart = Date.now();
      try {
        const quotes = [];
        for (let index = 0; index < symbols.length; index += 10) {
          quotes.push(...await snaptrade.getQuotes(account.id, symbols.slice(index, index + 10)));
        }
        const result = await snapshots.write({
          accountId: account.id,
          endpoint: 'quotes',
          payload: quotes,
          fetchedAt: new Date().toISOString(),
          durationMs: Date.now() - stepStart,
          sdkVersion,
        });
        report.endpoints.push({
          accountId: account.id,
          endpoint: 'quotes',
          status: 'ok',
          skipped: result.skipped,
          hash: result.hash.slice(0, 16),
          durationMs: Date.now() - stepStart,
        });
      } catch (error) {
        report.ok = false;
        report.endpoints.push({
          accountId: account.id,
          endpoint: 'quotes',
          status: 'error',
          error: error.message,
          durationMs: Date.now() - stepStart,
        });
        logger.error({ accountId: account.id, endpoint: 'quotes', err: error.name }, 'ingest step failed');
      }
    }
  }

  function run(trigger = 'manual') {
    if (inFlight) {
      return inFlight;
    }
    inFlight = (async () => {
      const report = {
        trigger,
        startedAt: new Date().toISOString(),
        ok: true,
        endpoints: [],
      };
      try {
        const accounts = await resolveAccounts();
        for (const account of accounts) {
          await ingestAccount(account, report);
        }
      } catch (error) {
        report.ok = false;
        report.error = error.message;
        throw error;
      } finally {
        report.finishedAt = new Date().toISOString();
        lastRun = report;
        inFlight = null;
      }
      return report;
    })();
    return inFlight;
  }

  return {
    run,
    getLastRun: () => lastRun,
    isRunning: () => inFlight !== null,
  };
}
