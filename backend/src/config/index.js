import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import cron from 'node-cron';
import { z } from 'zod';

export const rootDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

export function loadEnvFile(envPath = path.join(rootDirectory, '.env')) {
  dotenv.config({ path: envPath, quiet: true });
}

const boolFromEnv = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((value) => ['true', '1', 'yes'].includes(value));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  SERVER_HOST: z.string().min(1).default('127.0.0.1'),
  TZ: z.string().min(1).default('UTC'),
  CORS_ORIGIN: z.string().default(''),
  DATA_DIR: z.string().default(''),
  SNAPTRADE_CLIENT_ID: z.string().min(1, 'is required'),
  SNAPTRADE_CONSUMER_KEY: z.string().min(1, 'is required'),
  SNAPTRADE_USER_ID: z.string().default(''),
  SNAPTRADE_USER_SECRET: z.string().default(''),
  SNAPTRADE_BROKERAGE_AUTHORIZATION_ID: z.string().default(''),
  SNAPTRADE_ACCOUNT_IDS: z.string().default(''),
  INGEST_ENABLED: boolFromEnv.default('true'),
  INGEST_CRON: z.string().min(1).default('*/30 * * * *'),
  INGEST_ACTIVITIES_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  INGEST_ORDERS_DAYS: z.coerce.number().int().min(1).max(90).default(90),
  INGEST_STALE_AFTER_MINUTES: z.coerce.number().int().min(1).max(10080).default(60),
  SNAPTRADE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(20000),
  RETRY_ATTEMPTS: z.coerce.number().int().min(0).max(5).default(3),
  RETRY_BASE_MS: z.coerce.number().int().min(100).max(10000).default(500),
});

function configError(lines) {
  const error = new Error(`Invalid configuration:\n  ${lines.join('\n  ')}`);
  error.name = 'ConfigError';
  return error;
}

export function loadConfig(env = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw configError(
      parsed.error.issues.map(
        (issue) => `${issue.path.join('.')}: ${issue.message}`,
      ),
    );
  }
  const raw = parsed.data;

  if (!cron.validate(raw.INGEST_CRON)) {
    throw configError(['INGEST_CRON: is not a valid cron expression']);
  }

  const hasUserId = raw.SNAPTRADE_USER_ID.length > 0;
  const hasUserSecret = raw.SNAPTRADE_USER_SECRET.length > 0;
  if (hasUserId !== hasUserSecret) {
    throw configError([
      'SNAPTRADE_USER_ID and SNAPTRADE_USER_SECRET: must be set together or both left empty',
    ]);
  }

  return {
    nodeEnv: raw.NODE_ENV,
    port: raw.PORT,
    host: raw.SERVER_HOST,
    timezone: raw.TZ,
    corsOrigins: raw.CORS_ORIGIN.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    dataDir: raw.DATA_DIR || path.join(rootDirectory, 'data'),
    snaptrade: {
      clientId: raw.SNAPTRADE_CLIENT_ID,
      consumerKey: raw.SNAPTRADE_CONSUMER_KEY,
      userId: raw.SNAPTRADE_USER_ID,
      userSecret: raw.SNAPTRADE_USER_SECRET,
      brokerageAuthorizationId: raw.SNAPTRADE_BROKERAGE_AUTHORIZATION_ID,
      authMode: hasUserId ? 'commercial' : 'personal',
      accountIds: raw.SNAPTRADE_ACCOUNT_IDS.split(',')
        .map((id) => id.trim())
        .filter(Boolean),
      timeoutMs: raw.SNAPTRADE_TIMEOUT_MS,
    },
    ingest: {
      enabled: raw.INGEST_ENABLED,
      cron: raw.INGEST_CRON,
      activitiesDays: raw.INGEST_ACTIVITIES_DAYS,
      ordersDays: raw.INGEST_ORDERS_DAYS,
      staleAfterMs: raw.INGEST_STALE_AFTER_MINUTES * 60_000,
    },
    retry: {
      attempts: raw.RETRY_ATTEMPTS,
      baseMs: raw.RETRY_BASE_MS,
    },
  };
}
