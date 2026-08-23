import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import { Snaptrade, SnaptradeAuth } from 'snaptrade-typescript-sdk';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(root, '.env'), quiet: true });

const userId = process.argv[2]?.trim();
if (!userId) {
  console.error('Usage: npm run register:snaptrade-user -- <stable-user-id>');
  process.exit(1);
}
const clientId = process.env.SNAPTRADE_CLIENT_ID?.trim();
const consumerKey = process.env.SNAPTRADE_CONSUMER_KEY?.trim();
if (!clientId || !consumerKey) {
  console.error('SNAPTRADE_CLIENT_ID and SNAPTRADE_CONSUMER_KEY are required.');
  process.exit(1);
}

const snaptrade = new Snaptrade({
  auth: SnaptradeAuth.commercialApiKey({ clientId, consumerKey }),
  baseOptions: { timeout: 20_000 },
});
const response = await snaptrade.authentication.registerSnapTradeUser({
  snapTradeRegisterUserRequestBody: { userId },
});
const privateDir = path.join(root, 'data', 'private');
const output = path.join(privateDir, 'snaptrade-user.json');
await fs.mkdir(privateDir, { recursive: true, mode: 0o700 });
await fs.writeFile(
  output,
  JSON.stringify({ userId: response.data.userId, userSecret: response.data.userSecret }, null, 2),
  { mode: 0o600, flag: 'wx' },
);
console.log(`Registered SnapTrade user ${response.data.userId}.`);
console.log(`Credentials were written with mode 0600 to ${output}.`);
console.log('Copy them into .env, then securely remove the temporary credential file.');
