import { maskAccountNumber } from '../lib/sanitize.js';

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
    const endDate = new Date();
    const startDate = new Date(
      endDate.getTime() - config.ingest.activitiesDays * 86_400_000,
    );
    const steps = [
      ['balances', () => snaptrade.getBalances(account.id)],
      ['positions', () => snaptrade.getPositions(account.id)],
      ['orders', () => snaptrade.getOrders(account.id, config.ingest.ordersDays)],
      [
        'activities',
        () =>
          snaptrade.getActivities(account.id, {
            startDate: startDate.toISOString().slice(0, 10),
            endDate: endDate.toISOString().slice(0, 10),
          }),
      ],
    ];

    for (const [endpoint, fetcher] of steps) {
      const stepStart = Date.now();
      try {
        const payload = await fetcher();
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
