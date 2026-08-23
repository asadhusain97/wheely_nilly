import { Router } from 'express';

import { maskAccountNumber } from '../lib/sanitize.js';
import { AccountSelectionError } from '../services/ingest.js';

export function createSnaptradeRouter({ snaptrade, ingest, snapshots, config }) {
  const router = Router();

  router.get('/status', async (_request, response, next) => {
    try {
      const freshness = await snapshots.status({
        staleAfterMs: config.ingest.staleAfterMs,
      });
      response.json({
      authMode: snaptrade.authMode,
      scheduler: {
        enabled: config.ingest.enabled,
        cron: config.ingest.cron,
        timezone: config.timezone,
        running: ingest.isRunning(),
      },
      configuredAccountIds: config.snaptrade.accountIds,
      configuredBrokerageAuthorizationId:
        config.snaptrade.brokerageAuthorizationId || null,
      freshness,
      lastRun: ingest.getLastRun(),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/authorizations', async (_request, response, next) => {
    try {
      const authorizations = await snaptrade.listBrokerageAuthorizations();
      response.json({
        authorizations: authorizations.map((authorization) => ({
          id: authorization.id,
          brokerage: authorization.brokerage?.name ?? authorization.name ?? null,
          disabled: authorization.disabled ?? false,
          createdAt: authorization.created_date ?? null,
          updatedAt: authorization.updated_date ?? null,
        })),
        configuredBrokerageAuthorizationId:
          config.snaptrade.brokerageAuthorizationId || null,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/connection-portal', async (_request, response, next) => {
    try {
      const portal = await snaptrade.createConnectionPortal();
      response.json({ redirectUri: portal.redirectURI, expiresAt: portal.expiresAt ?? null });
    } catch (error) {
      next(error);
    }
  });

  router.get('/accounts', async (_request, response, next) => {
    try {
      const accounts = await snaptrade.listAccounts();
      response.json({
        accounts: accounts.map((account) => ({
          id: account.id,
          institution: account.institution_name ?? null,
          name: account.name ?? null,
          number: maskAccountNumber(account.number),
          syncStatus: account.sync_status ?? null,
        })),
        configuredAccountIds: config.snaptrade.accountIds,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/refresh', async (_request, response, next) => {
    try {
      const report = await ingest.run('manual');
      response.status(report.ok ? 200 : 207).json(report);
    } catch (error) {
      if (error instanceof AccountSelectionError) {
        response.status(409).json({
          error: {
            code: 'ACCOUNT_SELECTION_REQUIRED',
            message: error.message,
            candidates: error.candidates ?? [],
          },
        });
        return;
      }
      next(error);
    }
  });

  router.get('/snapshots', async (request, response, next) => {
    try {
      const parsed = Number.parseInt(request.query.limit ?? '50', 10);
      const limit = Math.max(1, Math.min(Number.isNaN(parsed) ? 50 : parsed, 200));
      const items = await snapshots.list({
        accountId: request.query.accountId,
        endpoint: request.query.endpoint,
        limit,
      });
      response.json({ snapshots: items });
    } catch (error) {
      next(error);
    }
  });

  router.get('/snapshots/raw', async (request, response, next) => {
    try {
      const envelope = await snapshots.readRaw(String(request.query.path ?? ''));
      response.json(envelope);
    } catch (error) {
      if (error.name === 'SnapshotPathError') {
        response.status(400).json({
          error: { code: 'INVALID_PATH', message: error.message },
        });
        return;
      }
      if (error.code === 'ENOENT') {
        response.status(404).json({
          error: { code: 'NOT_FOUND', message: 'Snapshot not found' },
        });
        return;
      }
      next(error);
    }
  });

  return router;
}
