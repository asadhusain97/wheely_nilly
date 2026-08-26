import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';

import { sanitizeError } from './lib/sanitize.js';
import { createSnaptradeRouter } from './routes/snaptrade.js';
import { createWheelRouter } from './routes/wheel.js';
import { createScreenerRouter } from './routes/screener.js';
import { createNotificationsRouter } from './routes/notifications.js';
import { createStrategySettingsRouter } from './routes/strategy-settings.js';

const frontendDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../frontend',
);

export function createApp({ config, snaptrade, ingest, snapshots, derived, opportunityMonitoring, notifications, strategySettings }) {
  const app = express();

  app.disable('x-powered-by');
  app.use(
    pinoHttp({
      genReqId: (request, response) => {
        const id = request.headers['x-request-id'] || crypto.randomUUID();
        response.setHeader('x-request-id', id);
        return id;
      },
      redact: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers.set-cookie',
      ],
    }),
  );
  if (derived) app.use('/api/v1/wheel', createWheelRouter({ derived }));
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { 'upgrade-insecure-requests': null },
      },
      strictTransportSecurity: false,
    }),
  );
  app.use(express.json({ limit: '100kb' }));

  if (opportunityMonitoring) app.use('/api/v1/screens', createScreenerRouter({ monitoring: opportunityMonitoring }));
  if (notifications) app.use('/api/v1/notifications', createNotificationsRouter({ notifications }));
  if (strategySettings) app.use('/api/v1/strategy-settings', createStrategySettingsRouter({ strategySettings }));

  if (config.corsOrigins.length > 0) {
    app.use(cors({ origin: config.corsOrigins }));
  }

  app.get('/api/health', (_request, response) => {
    response.json({ service: 'wheel-dashboard-backend', status: 'ok' });
  });

  app.use(
    '/api/v1/snaptrade',
    createSnaptradeRouter({ snaptrade, ingest, snapshots, config }),
  );

  app.use(express.static(frontendDirectory));

  app.use((_request, response) => {
    response
      .status(404)
      .json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  app.use((error, _request, response, _next) => {
    const safe = sanitizeError(error, {
      secrets: [
        config.snaptrade.clientId,
        config.snaptrade.consumerKey,
        config.snaptrade.userSecret,
        config.notifications?.token,
      ],
    });
    const isUpstream = safe.kind === 'snaptrade';
    const status = !isUpstream
      ? 500
      : safe.status === 401 || safe.status === 403
        ? 502
        : safe.status === 429
          ? 503
          : safe.status >= 400 && safe.status < 500
            ? 502
            : 502;
    const code = !isUpstream
      ? 'INTERNAL_ERROR'
      : safe.status === 401 || safe.status === 403
        ? 'UPSTREAM_AUTHENTICATION_ERROR'
        : safe.status === 429
          ? 'UPSTREAM_RATE_LIMITED'
          : 'UPSTREAM_ERROR';
    response.status(status).json({
      error: {
        code,
        message: safe.message,
        upstreamStatus: safe.status,
      },
    });
  });

  return app;
}
