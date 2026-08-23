import express from 'express';
import { screenerAlert } from '../services/notifications.js';

export function createScreenerRouter({ screener, notifications, config }) {
  const router = express.Router();
  router.post('/', async (request, response, next) => {
    try {
      const result = await screener.screen(request.body);
      if (notifications && config.notifications.enabled) {
        const history = await notifications.audit(100);
        for (const candidate of result.candidates) { const event = screenerAlert(candidate, result, config, history); if (event) await notifications.enqueue(event); }
      }
      response.json(result);
    }
    catch (error) { if (error.name === 'ScreenerError') response.status(error.status).json({ error: { code: error.status === 400 ? 'INVALID_SCREEN' : 'SCREENER_UNAVAILABLE', message: error.message } }); else next(error); }
  });
  return router;
}
