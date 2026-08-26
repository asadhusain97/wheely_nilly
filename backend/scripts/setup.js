#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';

import dotenv from 'dotenv';
import sdkPackage from 'snaptrade-typescript-sdk/package.json' with { type: 'json' };

import { loadConfig } from '../src/config/index.js';
import { redactText, maskAccountNumber } from '../src/lib/sanitize.js';
import { createIngestService } from '../src/services/ingest.js';
import { createSnapshotStore } from '../src/services/snapshots.js';
import { createSnaptradeService } from '../src/services/snaptrade.js';

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const envPath = path.join(rootDirectory, '.env');
const exampleEnvPath = path.join(rootDirectory, '.env.example');

const SNAPTRADE_SIGNUP_URL = 'https://dashboard.snaptrade.com/signup';
const SNAPTRADE_KEY_URL = 'https://dashboard.snaptrade.com/api-key';

function envLine(key, value) {
  const text = String(value ?? '');
  if (/[\r\n']/.test(text)) throw new TypeError(`${key} contains unsupported quote or newline characters`);
  return `${key}='${text}'`;
}

export function mergeEnvContent(content, updates) {
  let next = content.endsWith('\n') ? content : `${content}\n`;
  for (const [key, value] of Object.entries(updates)) {
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    const line = envLine(key, value);
    next = pattern.test(next) ? next.replace(pattern, () => line) : `${next}${line}\n`;
  }
  return next;
}

export function parseAccountSelection(value, count) {
  if (!Number.isInteger(count) || count < 1) throw new RangeError('No accounts are available');
  const trimmed = value.trim();
  if (!trimmed) return Array.from({ length: count }, (_, index) => index);
  const selected = trimmed.split(',').map((part) => Number(part.trim()) - 1);
  if (selected.some((index) => !Number.isInteger(index) || index < 0 || index >= count)) {
    throw new RangeError(`Choose account numbers between 1 and ${count}`);
  }
  return [...new Set(selected)];
}

async function readEnvFiles() {
  const example = await fs.readFile(exampleEnvPath, 'utf8');
  try {
    const current = await fs.readFile(envPath, 'utf8');
    return { content: current, values: dotenv.parse(current), exists: true };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { content: example, values: dotenv.parse(example), exists: false };
  }
}

async function writeEnv(content, updates) {
  await fs.writeFile(envPath, mergeEnvContent(content, updates), { mode: 0o600 });
  await fs.chmod(envPath, 0o600);
}

function createPrompter() {
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stdout.write(chunk, encoding);
      callback();
    },
  });
  const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const readline = createInterface({ input: process.stdin, output, terminal });

  async function ask(label, { current = '', secret = false } = {}) {
    const existing = current ? ` [configured; Enter keeps it]` : '';
    if (secret && terminal) {
      process.stdout.write(`${label}${existing}: `);
      muted = true;
      const answer = await readline.question('');
      muted = false;
      process.stdout.write('\n');
      return answer.trim() || current;
    }
    const answer = await readline.question(`${label}${existing}: `);
    return answer.trim() || current;
  }

  return { ask, close: () => readline.close() };
}

function printHelp() {
  console.log(`Wheely Nilly setup

Usage:
  npm run setup

The interactive wizard stores server-side credentials in the repository-root
.env file, connects a personal SnapTrade account, selects brokerage accounts,
and performs the first portfolio sync. It never places trades.`);
}

function printIntroduction(envExists) {
  console.log(`
Wheely Nilly · personal setup
--------------------------------
This wizard prepares one private, self-hosted dashboard for the person running it.

It will:
  1. Store your API credentials in ${envExists ? 'your existing' : 'a new'} .env file (mode 0600).
  2. Verify your Personal SnapTrade API key.
  3. Help connect a brokerage and choose which accounts to sync.
  4. Download read-only portfolio snapshots into the ignored data/ directory.

It will not send credentials to the browser or place, change, or cancel trades.
`);
}

function accountLabel(account) {
  const institution = account.institution_name ?? 'Unknown institution';
  const name = account.name ?? 'Unnamed account';
  return `${institution} · ${name} · ${maskAccountNumber(account.number)}`;
}

async function chooseAccounts(prompt, accounts) {
  console.log('\nAccounts available to sync:');
  accounts.forEach((account, index) => console.log(`  ${index + 1}. ${accountLabel(account)}`));
  if (accounts.length === 1) {
    console.log('  Selecting the only available account.');
    return accounts;
  }
  console.log('The dashboard currently highlights one wheel-active account even when several are synced.');
  while (true) {
    const answer = await prompt.ask('Account numbers, comma-separated [Enter selects all]');
    try {
      return parseAccountSelection(answer, accounts.length).map((index) => accounts[index]);
    } catch (error) {
      console.log(`  ${error.message}.`);
    }
  }
}

async function finishWithoutAccount(content, updates) {
  await writeEnv(content, { ...updates, SNAPTRADE_ACCOUNT_IDS: '' });
  console.log(`
Credentials saved to ${envPath}.
Run npm run setup again after connecting a brokerage to finish account selection and sync.`);
}

export async function runSetup() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('The setup wizard needs an interactive terminal.');
  }
  const stored = await readEnvFiles();
  const prompt = createPrompter();
  const secrets = [];
  try {
    printIntroduction(stored.exists);
    const start = await prompt.ask('Continue? [Y/n]');
    if (/^n(?:o)?$/i.test(start)) {
      console.log('No changes made.');
      return;
    }
    if (stored.values.SNAPTRADE_USER_ID || stored.values.SNAPTRADE_USER_SECRET) {
      throw new Error('Commercial SnapTrade credentials are already configured. This wizard supports Personal mode; keep the existing .env and use the manual README instructions.');
    }

    console.log(`
Step 1 of 3 · SnapTrade Personal API key
Create a free Personal account: ${SNAPTRADE_SIGNUP_URL}
Enable two-factor authentication, then create a key: ${SNAPTRADE_KEY_URL}
The key has a client ID and consumer key. Keep the consumer key private.
`);
    const clientId = await prompt.ask('SnapTrade client ID', { current: stored.values.SNAPTRADE_CLIENT_ID });
    const consumerKey = await prompt.ask('SnapTrade consumer key', { current: stored.values.SNAPTRADE_CONSUMER_KEY, secret: true });
    if (!clientId || !consumerKey) throw new Error('Both SnapTrade values are required.');
    secrets.push(clientId, consumerKey);

    const baseUpdates = {
      SNAPTRADE_CLIENT_ID: clientId,
      SNAPTRADE_CONSUMER_KEY: consumerKey,
      SNAPTRADE_USER_ID: '',
      SNAPTRADE_USER_SECRET: '',
    };
    const initialConfig = loadConfig({ ...process.env, ...stored.values, ...baseUpdates });
    const snaptrade = createSnaptradeService({ config: initialConfig });

    console.log('\nChecking the SnapTrade key…');
    let accounts = await snaptrade.listAccounts();
    console.log('  Key accepted.');

    console.log('\nStep 2 of 3 · Brokerage connection');
    while (accounts.length === 0) {
      const portal = await snaptrade.createConnectionPortal();
      console.log(`No brokerage accounts are connected yet.

Open this short-lived SnapTrade Connection Portal URL:
${portal.redirectURI}

SnapTrade—not Wheely Nilly—handles the brokerage sign-in and authorization.`);
      const answer = await prompt.ask('Press Enter after connecting, or type q to save and finish later');
      if (/^q(?:uit)?$/i.test(answer)) {
        await finishWithoutAccount(stored.content, baseUpdates);
        return;
      }
      console.log('Checking for connected accounts…');
      accounts = await snaptrade.listAccounts();
      if (accounts.length === 0) console.log('  No accounts found yet. Finish the portal flow, then try again.');
    }

    const selected = await chooseAccounts(prompt, accounts);
    const updates = { ...baseUpdates, SNAPTRADE_ACCOUNT_IDS: selected.map((account) => account.id).join(',') };
    await writeEnv(stored.content, updates);
    console.log(`
Step 3 of 3 · First portfolio sync
Saved ${selected.length} account selection${selected.length === 1 ? '' : 's'} to ${envPath}.
Downloading balances, positions, orders, activities, and quotes…`);

    const config = loadConfig({ ...process.env, ...stored.values, ...updates });
    const snapshots = createSnapshotStore({ dataDir: config.dataDir });
    const ingest = createIngestService({ config, snaptrade, snapshots, sdkVersion: sdkPackage.version });
    const report = await ingest.run('setup');
    const completed = report.endpoints.filter((endpoint) => endpoint.status === 'ok').length;
    const failed = report.endpoints.length - completed;
    console.log(`  ${completed} data request${completed === 1 ? '' : 's'} completed${failed ? `; ${failed} failed` : ''}.`);
    console.log(`
${report.ok ? 'Setup complete.' : 'Setup saved, but the first sync needs attention.'}

Start the full app locally:
  npm run app

Then open:
  http://127.0.0.1:3000
`);
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`\nSetup stopped: ${redactText(error.message, secrets)}`);
    process.exitCode = 1;
  } finally {
    prompt.close();
  }
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  printHelp();
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runSetup();
}
