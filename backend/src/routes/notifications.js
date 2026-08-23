import crypto from 'node:crypto';
import express from 'express';
import { z } from 'zod';

const rulesSchema = z.object({ expiration: z.boolean().optional(), assignmentRisk: z.boolean().optional(), screener: z.boolean().optional() }).strict();

export function createNotificationsRouter({ notifications }) {
  const router = express.Router();
  router.get('/status', async (_request, response, next) => { try { response.json(await notifications.status()); } catch (error) { next(error); } });
  router.get('/audit', async (request, response, next) => { try { response.json({ notifications: await notifications.audit(Math.min(100, Number(request.query.limit) || 50)) }); } catch (error) { next(error); } });
  router.patch('/rules', async (request, response) => { const result = rulesSchema.safeParse(request.body); if (!result.success) return response.status(400).json({ error: { code: 'INVALID_RULES', message: result.error.issues[0].message } }); return response.json({ rules: await notifications.setRules(result.data) }); });
  router.post('/test', async (_request, response, next) => { try { const queued = await notifications.enqueue({ type: 'test', key: crypto.randomUUID(), state: 'test', title: 'Wheely Nilly test', message: 'Notifications are connected. No account details are included.', tags: ['white_check_mark'] }); const delivery = await notifications.flush(); response.status(202).json({ queued, delivery }); } catch (error) { next(error); } });
  router.post('/flush', async (_request, response, next) => { try { response.json({ results: await notifications.flush() }); } catch (error) { next(error); } });
  return router;
}
