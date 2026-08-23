import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import {
  Snaptrade,
  SnaptradeAuth,
  SnaptradeError,
} from 'snaptrade-typescript-sdk';

const rootDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
dotenv.config({ path: path.join(rootDirectory, '.env'), override: false });

const env = (name) => (process.env[name] ?? '').trim();
const clientId = env('SNAPTRADE_CLIENT_ID');
const consumerKey = env('SNAPTRADE_CONSUMER_KEY');
const userId = env('SNAPTRADE_USER_ID');
const userSecret = env('SNAPTRADE_USER_SECRET');

let authMode;
if (!userId && !userSecret) {
  authMode = 'personal';
} else if (userId && userSecret) {
  authMode = 'commercial';
} else {
  console.error(
    'Incomplete Commercial credentials: set both SNAPTRADE_USER_ID and SNAPTRADE_USER_SECRET, or remove both to use Personal API key mode.',
  );
  process.exit(1);
}

if (!clientId || !consumerKey) {
  const missing = [
    !clientId ? 'SNAPTRADE_CLIENT_ID' : null,
    !consumerKey ? 'SNAPTRADE_CONSUMER_KEY' : null,
  ].filter(Boolean);
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  console.error(
    'Create a .env file at the repository root (see .env.example) with your SnapTrade Personal API key values.',
  );
  process.exit(1);
}

console.log(`Auth mode detected: ${authMode}`);

const snaptrade = new Snaptrade({
  auth:
    authMode === 'personal'
      ? SnaptradeAuth.personalApiKey({ clientId, consumerKey })
      : SnaptradeAuth.commercialApiKey({ clientId, consumerKey }),
  baseOptions: { timeout: 20000 },
});

const userCredentials =
  authMode === 'commercial' ? { userId, userSecret } : {};

function describeError(error) {
  if (error instanceof SnaptradeError) {
    const head = `HTTP ${error.status ?? '?'} ${error.statusText ?? ''}`.trim();
    return error.message ? `${head}: ${error.message}` : head;
  }
  return error?.message ?? String(error);
}

try {
  const status = await snaptrade.apiStatus.check();
  console.log(
    `[1/3] API reachable, request signature accepted (service version: ${status.data.version ?? 'unknown'})`,
  );
} catch (error) {
  console.error(`[1/3] Status check failed: ${describeError(error)}`);
  if (
    error instanceof SnaptradeError &&
    (error.status === 401 || error.status === 403)
  ) {
    console.error(
      'Authentication rejected. Confirm SNAPTRADE_CLIENT_ID and SNAPTRADE_CONSUMER_KEY come from the same SnapTrade application.',
    );
  }
  process.exit(1);
}

let accounts;
try {
  const response = await snaptrade.accountInformation.listUserAccounts(userCredentials);
  accounts = response.data;
  console.log(`[2/3] Account-data authorization succeeded. Accounts found: ${accounts.length}`);
} catch (error) {
  console.error(`[2/3] Account listing failed: ${describeError(error)}`);
  process.exit(1);
}

for (const account of accounts) {
  const rawNumber = typeof account.number === 'string' ? account.number : '';
  const maskedNumber =
    rawNumber.length > 4 ? `****${rawNumber.slice(-4)}` : '****';
  console.log(
    `      - ${account.institution_name ?? 'Unknown institution'} | ${
      account.name ?? 'Unnamed account'
    } | #${maskedNumber} | id=${account.id}`,
  );
}

if (accounts.length === 0) {
  try {
    const login = await snaptrade.authentication.loginSnapTradeUser(userCredentials);
    console.log('[3/3] No brokerage connected yet.');
    console.log('');
    console.log(
      'Open this Connection Portal link in a browser to link Robinhood (short-lived, do not share):',
    );
    console.log(login.data.redirectURI);
  } catch (error) {
    console.error(`[3/3] Could not generate Connection Portal URL: ${describeError(error)}`);
    process.exit(1);
  }
} else {
  console.log('[3/3] Brokerage connection present. Connection test complete.');
}
