import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const SNAPSHOT_SCHEMA_VERSION = 1;

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

export function hashPayload(payload) {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function providerResponseAt(payload) {
  const freshness = payload?.data_freshness;
  if (!freshness || typeof freshness !== 'object') return null;
  for (const key of ['last_successful_sync', 'last_updated', 'as_of', 'timestamp']) {
    if (typeof freshness[key] === 'string') return freshness[key];
  }
  return null;
}

async function safeReaddir(dir) {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

export function createSnapshotStore({ dataDir }) {
  const rawRoot = path.join(dataDir, 'raw');

  function endpointDir(accountId, endpoint) {
    return path.join(rawRoot, 'accounts', accountId, endpoint);
  }

  async function hasHash(accountId, endpoint, hash) {
    const files = (await safeReaddir(endpointDir(accountId, endpoint)))
      .filter((file) => file.endsWith('.json'))
      .sort();
    return files.some((file) => file.endsWith(`-${hash.slice(0, 16)}.json`));
  }

  async function write({ accountId, endpoint, payload, fetchedAt, durationMs, sdkVersion }) {
    const hash = hashPayload(payload);
    if (await hasHash(accountId, endpoint, hash)) {
      return { skipped: true, hash, path: null };
    }

    const dir = endpointDir(accountId, endpoint);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const stamp = fetchedAt.replace(/[:.]/g, '-');
    const fileName = `${stamp}-${hash.slice(0, 16)}.json`;
    const finalPath = path.join(dir, fileName);
    const envelope = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      kind: 'snaptrade-raw-snapshot',
      source: 'snaptrade',
      provider: 'snaptrade',
      endpoint,
      accountId,
      fetchedAt,
      providerResponseAt: providerResponseAt(payload),
      durationMs,
      sdkVersion,
      contentSha256: hash,
      payload,
    };
    const tmpPath = `${finalPath}.tmp-${process.pid}`;
    await fs.writeFile(tmpPath, JSON.stringify(envelope, null, 2), {
      mode: 0o600,
    });
    await fs.rename(tmpPath, finalPath);
    return { skipped: false, hash, path: finalPath };
  }

  async function list({ accountId, endpoint, limit = 50 } = {}) {
    const results = [];
    const accountsRoot = path.join(rawRoot, 'accounts');
    const accountDirs = accountId ? [accountId] : await safeReaddir(accountsRoot);
    for (const account of accountDirs) {
      const endpoints = endpoint
        ? [endpoint]
        : await safeReaddir(path.join(accountsRoot, account));
      for (const ep of endpoints) {
        const dir = endpointDir(account, ep);
        const files = (await safeReaddir(dir)).filter((file) =>
          file.endsWith('.json'),
        );
        for (const file of files) {
          const fullPath = path.join(dir, file);
          const stat = await fs.stat(fullPath);
          results.push({
            accountId: account,
            endpoint: ep,
            file,
            modifiedAt: stat.mtime.toISOString(),
            sizeBytes: stat.size,
            relativePath: path.relative(dataDir, fullPath),
          });
        }
      }
    }
    return results
      .sort((a, b) => b.file.localeCompare(a.file))
      .slice(0, limit);
  }

  async function readRaw(relativePath) {
    const resolved = path.resolve(dataDir, relativePath);
    const rawResolved = path.resolve(rawRoot);
    if (
      !resolved.startsWith(rawResolved + path.sep) ||
      !resolved.endsWith('.json')
    ) {
      const error = new Error('Invalid snapshot path');
      error.name = 'SnapshotPathError';
      throw error;
    }
    return JSON.parse(await fs.readFile(resolved, 'utf8'));
  }

  async function status({ staleAfterMs }) {
    const items = await list({ limit: 10000 });
    const latest = items.reduce((value, item) =>
      !value || item.file > value.file ? item : value, null);
    if (!latest) return { lastSuccessAt: null, stale: true, ageMs: null };
    const envelope = await readRaw(latest.relativePath);
    const ageMs = Math.max(0, Date.now() - Date.parse(envelope.fetchedAt));
    return { lastSuccessAt: envelope.fetchedAt, stale: ageMs > staleAfterMs, ageMs };
  }

  return { write, list, readRaw, status, rawRoot };
}
