import cron from 'node-cron';
import { lifecycleAlerts } from '../services/notifications.js';

export function createScheduler({ config, ingest, notifications, derived, logger = console }) {
  let task = null;
  let outboxTimer = null;

  function start() {
    if (!config.ingest.enabled) {
      logger.info('ingest scheduler disabled by INGEST_ENABLED');
    } else {
      task = cron.schedule(
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
        { timezone: config.timezone },
      );
      logger.info({ cron: config.ingest.cron, timezone: config.timezone }, 'ingest scheduler started');
    }
    if (notifications) outboxTimer = setInterval(() => notifications.flush().catch((error) => logger.error({ err: error.name }, 'notification outbox flush failed')), 60_000);
  }

  function stop() {
    task?.stop();
    task = null;
    clearInterval(outboxTimer);
    outboxTimer = null;
  }

  return { start, stop, isStarted: () => task !== null };
}
