import cron from 'node-cron';

export function createScheduler({ config, ingest, logger = console }) {
  let task = null;

  function start() {
    if (!config.ingest.enabled) {
      logger.info('ingest scheduler disabled by INGEST_ENABLED');
      return;
    }
    task = cron.schedule(
      config.ingest.cron,
      async () => {
        try {
          await ingest.run('schedule');
        } catch (error) {
          logger.error({ err: error.name }, 'scheduled ingest failed');
        }
      },
      { timezone: config.timezone },
    );
    logger.info(
      { cron: config.ingest.cron, timezone: config.timezone },
      'ingest scheduler started',
    );
  }

  function stop() {
    task?.stop();
    task = null;
  }

  return { start, stop, isStarted: () => task !== null };
}
