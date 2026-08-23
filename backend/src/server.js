import sdkPackage from 'snaptrade-typescript-sdk/package.json' with { type: 'json' };

import { createApp } from './app.js';
import { loadConfig, loadEnvFile } from './config/index.js';
import { createScheduler } from './jobs/scheduler.js';
import { createIngestService } from './services/ingest.js';
import { createSnapshotStore } from './services/snapshots.js';
import { createSnaptradeService } from './services/snaptrade.js';

let config;
try {
  loadEnvFile();
  config = loadConfig();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const snaptrade = createSnaptradeService({ config });
const snapshots = createSnapshotStore({ dataDir: config.dataDir });
const ingest = createIngestService({
  config,
  snaptrade,
  snapshots,
  sdkVersion: sdkPackage.version,
});
const scheduler = createScheduler({ config, ingest });
const app = createApp({ config, snaptrade, ingest, snapshots });

const server = app.listen(config.port, config.host, () => {
  console.log(
    `Wheel dashboard listening on ${config.host}:${config.port} (SnapTrade auth mode: ${config.snaptrade.authMode})`,
  );
  scheduler.start();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    scheduler.stop();
    server.close(() => process.exit(0));
  });
}
