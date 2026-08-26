import cron from 'node-cron';
import { lifecycleAlerts, screenerAlert } from '../services/notifications.js';

export async function runOpportunityAlerts({ config, monitoring, notifications, logger = console, now = Date.now }) {
  const notificationStatus = await notifications.status();
  if (!notificationStatus.rules.screener) return { scanned: false, candidates: 0, enqueued: 0, failures: 0 };

  const batch = await monitoring.scanAll();
  const history = await notifications.audit(100);
  const runAt = now();
  let candidates = 0;
  let enqueued = 0;
  let failures = 0;
  for (const item of batch.results) {
    if (item.status !== 'success') { failures += 1; continue; }
    const candidate = item.result.candidates?.[0];
    if (!candidate) continue;
    candidates += 1;
    const event = screenerAlert(candidate, item.result, config, history, runAt);
    if (!event) continue;
    const queued = await notifications.enqueue(event);
    if (!queued.duplicate) {
      enqueued += 1;
      history.unshift({ eventType: event.type, eventKey: event.key, createdAt: new Date(runAt).toISOString() });
    }
  }
  await notifications.flush();
  if (failures) logger.warn({ failures }, 'scheduled opportunity scan had partial failures');
  return { scanned: true, candidates, enqueued, failures };
}

export function createScheduler({ config, ingest, notifications, derived, monitoring, logger = console, cronImpl = cron }) {
  let ingestTask = null;
  let opportunityTask = null;
  let outboxTimer = null;

  function start() {
    if (!config.ingest.enabled) {
      logger.info('ingest scheduler disabled by INGEST_ENABLED');
    } else {
      ingestTask = cronImpl.schedule(
        config.ingest.cron,
        async () => {
          try {
            await ingest.run('schedule');
            if (notifications && derived && config.notifications.enabled) {
              const model = await derived.load();
              for (const event of lifecycleAlerts(model, config)) await notifications.enqueue(event);
              await notifications.flush();
            }
          }
          catch (error) { logger.error({ err: error.name }, 'scheduled ingest failed'); }
        },
        { timezone: config.timezone, noOverlap: true },
      );
      logger.info({ cron: config.ingest.cron, timezone: config.timezone }, 'ingest scheduler started');
    }
    if (config.notifications.enabled && notifications && monitoring) {
      opportunityTask = cronImpl.schedule(
        config.notifications.screenerCron,
        async () => {
          try {
            const result = await runOpportunityAlerts({ config, monitoring, notifications, logger });
            logger.info(result, 'scheduled opportunity scan completed');
          } catch (error) { logger.error({ err: error.name }, 'scheduled opportunity scan failed'); }
        },
        { timezone: config.notifications.screenerTimezone, noOverlap: true },
      );
      logger.info({ cron: config.notifications.screenerCron, timezone: config.notifications.screenerTimezone }, 'opportunity scheduler started');
    }
    if (notifications) outboxTimer = setInterval(() => notifications.flush().catch((error) => logger.error({ err: error.name }, 'notification outbox flush failed')), 60_000);
  }

  function stop() {
    ingestTask?.stop();
    ingestTask = null;
    opportunityTask?.stop();
    opportunityTask = null;
    clearInterval(outboxTimer);
    outboxTimer = null;
  }

  return { start, stop, isStarted: () => ingestTask !== null };
}
