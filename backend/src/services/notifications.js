import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { withRetry } from '../lib/retry.js';
import { stableStringify } from './snapshots.js';

const STORE_VERSION = 1;
const defaultState = () => ({ schemaVersion: STORE_VERSION, rules: { expiration: true, assignmentRisk: true, screener: true }, events: {}, outbox: [] });

export function notificationFingerprint(event) {
  return crypto.createHash('sha256').update(stableStringify({ type: event.type, key: event.key, state: event.state })).digest('hex');
}

export function createNotificationService({ config, fetchImpl = fetch, now = Date.now, sleep, random } = {}) {
  const file = path.join(config.dataDir, 'notifications', 'state.json');
  let chain = Promise.resolve();
  async function read() { try { const state = JSON.parse(await fs.readFile(file, 'utf8')); return state.schemaVersion === STORE_VERSION ? state : defaultState(); } catch (error) { if (error.code === 'ENOENT') return defaultState(); throw error; } }
  async function write(state) { await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); const tmp = `${file}.tmp-${process.pid}`; await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 }); await fs.rename(tmp, file); }
  function serialized(fn) { const next = chain.then(fn, fn); chain = next.catch(() => {}); return next; }

  async function enqueue(event) { return serialized(async () => {
    const state = await read(); const id = notificationFingerprint(event);
    if (state.events[id]) return { id, duplicate: true };
    const item = { id, event: { type: event.type, key: event.key, state: event.state }, title: event.title, message: event.message,
      priority: event.priority ?? 3, tags: event.tags ?? [], link: event.link ?? null, status: 'pending', attempts: 0, createdAt: new Date(now()).toISOString(), nextAttemptAt: new Date(now()).toISOString() };
    state.events[id] = { status: 'pending', createdAt: item.createdAt }; state.outbox.push(item); await write(state); return { id, duplicate: false };
  }); }

  async function deliver(item) {
    if (config.notifications.dryRun) return { status: 'dry-run', upstreamId: null };
    if (!config.notifications.topic) { const error = new Error('NTFY_TOPIC is not configured'); error.status = 400; throw error; }
    return withRetry(async () => {
      const response = await fetchImpl(`${config.notifications.baseUrl}/${encodeURIComponent(config.notifications.topic)}`, { method: 'POST', signal: AbortSignal.timeout(config.notifications.timeoutMs),
        headers: { 'content-type': 'text/plain; charset=utf-8', title: item.title, priority: String(item.priority), tags: item.tags.join(','), 'x-event-id': item.id,
          ...(item.link ? { click: item.link } : {}), ...(config.notifications.token ? { authorization: `Bearer ${config.notifications.token}` } : {}) }, body: item.message });
      if (!response.ok) { const error = new Error(`ntfy returned HTTP ${response.status}`); error.status = response.status; throw error; }
      const body = await response.json().catch(() => ({})); return { status: 'sent', upstreamId: body.id ?? null };
    }, { retries: 2, baseMs: 250, maxMs: 2000, sleep, random });
  }

  async function flush() { return serialized(async () => {
    const state = await read(); const results = [];
    for (const item of state.outbox.filter((entry) => entry.status === 'pending' && Date.parse(entry.nextAttemptAt) <= now()).slice(0, 10)) {
      item.attempts += 1; item.lastAttemptAt = new Date(now()).toISOString();
      try { const result = await deliver(item); item.status = result.status; item.upstreamId = result.upstreamId; state.events[item.id] = { ...state.events[item.id], status: result.status, sentAt: item.lastAttemptAt }; }
      catch (error) { item.lastError = error.status === 401 || error.status === 403 ? 'authentication failed' : error.message; item.status = error.status && error.status >= 400 && error.status < 500 && error.status !== 429 ? 'failed' : 'pending'; item.nextAttemptAt = new Date(now() + Math.min(3600000, 1000 * 2 ** item.attempts)).toISOString(); }
      results.push({ id: item.id, status: item.status });
    }
    await write(state); return results;
  }); }

  async function status() { const state = await read(); return { configured: Boolean(config.notifications.topic), enabled: config.notifications.enabled, dryRun: config.notifications.dryRun,
    counts: state.outbox.reduce((counts, item) => ({ ...counts, [item.status]: (counts[item.status] ?? 0) + 1 }), {}), rules: state.rules }; }
  async function audit(limit = 50) { const state = await read(); return state.outbox.slice(-limit).reverse().map(({ event, ...item }) => ({ ...item, eventType: event.type, eventKey: event.key, eventState: event.state })); }
  async function setRules(rules) { return serialized(async () => { const state = await read(); state.rules = { ...state.rules, ...rules }; await write(state); return state.rules; }); }
  return { enqueue, flush, status, audit, setRules };
}

export function screenerAlert(candidate, screen, config, history = [], now = Date.now()) {
  const rule = config.notifications.screenerRule;
  if (!rule || screen.degraded || screen.cache.stale || candidate.annualized_return < rule.minAnnualizedReturn || Math.abs(candidate.delta ?? 99) > rule.maxDelta || candidate.spread_percent > rule.maxSpreadPercent || candidate.quote_age_seconds > rule.maxQuoteAgeSeconds) return null;
  const today = new Date(now).toISOString().slice(0, 10);
  if (history.filter((item) => item.eventType === 'screener' && item.createdAt.startsWith(today)).length >= config.notifications.dailyCap) return null;
  const lastForContract = history.find((item) => item.eventType === 'screener' && item.eventKey === candidate.contract_symbol);
  if (lastForContract && now - Date.parse(lastForContract.createdAt) < config.notifications.cooldownMs) return null;
  return { type: 'screener', key: candidate.contract_symbol, state: `${Math.round(candidate.annualized_return * 1000)}:${Math.round(candidate.executable_premium * 100)}`,
    title: `${screen.symbol} ${screen.leg === 'cash_secured_put' ? 'put' : 'call'} candidate`,
    message: `${screen.symbol} ${candidate.expiration} $${candidate.strike}: est. $${candidate.executable_premium.toFixed(2)}, ${(candidate.annualized_return * 100).toFixed(1)}% annualized, Δ ${candidate.delta?.toFixed(2) ?? 'n/a'}, quote age ${Math.round(candidate.quote_age_seconds)}s. Informational estimate—verify with your broker.`,
    priority: 3, tags: ['chart_with_upwards_trend'], link: rule.dashboardUrl };
}

export function lifecycleAlerts(model, config, now = Date.now()) {
  const alerts = [];
  for (const cycle of model.cycles ?? []) {
    if (cycle.needsReview || ['complete', 'awaiting_review'].includes(cycle.stage)) continue;
    for (const contract of cycle.contracts?.filter((item) => item.openQuantity > 0) ?? []) {
      const dte = Math.ceil((Date.parse(`${contract.expiration}T20:00:00Z`) - now) / 86_400_000);
      if (config.notifications.expirationDte.includes(dte)) alerts.push({ type: 'expiration', key: contract.symbol, state: `${dte}d`,
        title: `${cycle.underlying} expires ${dte === 0 ? 'today' : `in ${dte} days`}`,
        message: `${cycle.underlying} ${contract.optionType} $${(contract.strikeMinor / 100).toFixed(2)} expires ${contract.expiration}. Reconciled open position; verify with your broker.`, priority: dte <= 1 ? 4 : 3, tags: ['calendar'] });
      const position = model.positions?.find((item) => item.symbol === cycle.underlying);
      const spot = Number(position?.price), strike = contract.strikeMinor / 100;
      const moneyness = contract.optionType === 'put' ? strike / spot : spot / strike;
      if (spot > 0 && dte >= 0 && dte <= config.notifications.assignmentMaxDte && moneyness >= config.notifications.assignmentMinMoneyness) alerts.push({
        type: 'assignment-risk', key: contract.symbol, state: `${dte}:${Math.round(moneyness * 100)}`,
        title: `${cycle.underlying} assignment risk estimate`,
        message: `${cycle.underlying} ${contract.optionType} is an estimated elevated assignment risk (${dte} DTE, ${(moneyness * 100).toFixed(1)}% moneyness). This is not a confirmed assignment. Source position time: ${model.generatedAt}.`, priority: 4, tags: ['warning'] });
    }
  }
  return alerts;
}
