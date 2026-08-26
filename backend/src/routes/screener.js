import express from 'express';

export function createScreenerRouter({ monitoring }) {
  const router = express.Router();
  router.use((_request, response, next) => { response.setHeader('cache-control', 'private, no-store'); next(); });
  router.get('/targets', async (_request, response, next) => {
    try { response.json(await monitoring.targets()); } catch (error) { next(error); }
  });
  router.get('/instruments', async (request, response, next) => {
    try { response.json(await monitoring.instruments(request.query.query)); }
    catch (error) {
      if (error.name === 'ScreenerError') response.status(error.status).json({ error: { code: error.status === 400 ? 'INVALID_QUERY' : 'SCREENER_UNAVAILABLE', message: error.message } });
      else next(error);
    }
  });
  router.post('/', async (request, response, next) => {
    try {
      response.json(await monitoring.scan(request.body));
    }
    catch (error) {
      if (['ScreenerError', 'OpportunityMonitoringError'].includes(error.name)) response.status(error.status).json({ error: { code: error.status === 400 ? 'INVALID_SCREEN' : 'SCREENER_UNAVAILABLE', message: error.message } });
      else next(error);
    }
  });
  router.post('/scan-all', async (_request, response, next) => {
    try { response.json(await monitoring.scanAll()); }
    catch (error) { next(error); }
  });
  return router;
}
