import { Router } from 'express';

export function createPositionManagementRouter({ positionManagement }) {
  const router = Router();
  router.use((_request, response, next) => {
    response.setHeader('cache-control', 'private, no-store');
    next();
  });
  const rejectInput = (request, response) => {
    const hasBody = request.body !== undefined && (
      request.body === null || Array.isArray(request.body) || typeof request.body !== 'object' || Object.keys(request.body).length > 0
    );
    if (Object.keys(request.query).length === 0 && !hasBody) return false;
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Position-management scans do not accept browser-supplied positions or rules.' } });
    return true;
  };
  router.get('/', async (request, response, next) => {
    if (rejectInput(request, response)) return;
    try { response.json(await positionManagement.current()); } catch (error) { next(error); }
  });
  router.post('/scan', async (request, response, next) => {
    if (rejectInput(request, response)) return;
    try { response.json(await positionManagement.scan()); } catch (error) { next(error); }
  });
  return router;
}
