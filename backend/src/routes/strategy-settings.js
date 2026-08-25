import { Router } from 'express';
import { z } from 'zod';

import {
  StrategySettingsValidationError,
  tickerSymbolSchema,
} from '../services/strategy-settings.js';

const effectiveQuerySchema = z.object({
  symbol: tickerSymbolSchema,
  leg: z.enum(['coveredCall', 'cashSecuredPut']),
}).strict();

function validationError(response, code, error) {
  response.status(400).json({
    error: {
      code,
      message: error.message,
    },
  });
}

export function createStrategySettingsRouter({ strategySettings }) {
  const router = Router();
  router.use((_request, response, next) => {
    response.setHeader('cache-control', 'private, no-store');
    next();
  });

  router.get('/', async (_request, response, next) => {
    try {
      response.json(await strategySettings.load());
    } catch (error) {
      next(error);
    }
  });

  router.put('/', async (request, response, next) => {
    try {
      response.json(await strategySettings.save(request.body));
    } catch (error) {
      if (error instanceof StrategySettingsValidationError) {
        validationError(response, 'INVALID_STRATEGY_SETTINGS', error);
        return;
      }
      next(error);
    }
  });

  router.get('/effective', async (request, response, next) => {
    const query = effectiveQuerySchema.safeParse(request.query);
    if (!query.success) {
      validationError(response, 'INVALID_QUERY', new Error(query.error.issues[0].message));
      return;
    }
    try {
      response.json(await strategySettings.effective(query.data));
    } catch (error) {
      if (error instanceof StrategySettingsValidationError) {
        validationError(response, 'INVALID_QUERY', error);
        return;
      }
      next(error);
    }
  });

  return router;
}
