import { createHash } from 'node:crypto';

import { toMinor } from '../lib/money.js';

export const NORMALIZED_SCHEMA_VERSION = 1;
export const CALCULATION_VERSION = 'wheel-v2';

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function text(value) {
  return typeof value === 'string' ? value : null;
}

function utcTimestamp(value, fallback) {
  const candidate = value ?? fallback;
  if (typeof candidate !== 'string') return fallback;
  const expanded = /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? `${candidate}T00:00:00.000Z` : candidate;
  const parsed = new Date(expanded);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

export function parseOccSymbol(raw) {
  const symbol = text(raw)?.replace(/\s/g, '').toUpperCase();
  if (!symbol) return null;
  const match = /^([A-Z0-9.]{1,6})(\d{6})([CP])(\d{8})$/.exec(symbol);
  if (!match) return null;
  const [, underlying, date, type, strikeDigits] = match;
  const year = 2000 + Number(date.slice(0, 2));
  const expiration = `${year}-${date.slice(2, 4)}-${date.slice(4, 6)}`;
  return {
    symbol,
    underlying,
    expiration,
    optionType: type === 'P' ? 'put' : 'call',
    strikeMinor: Math.round(Number(strikeDigits) / 10),
    multiplier: 100,
  };
}

function optionFrom(value) {
  if (!value) return null;
  if (typeof value === 'string') return parseOccSymbol(value);
  const original = value.symbol ?? value.raw_symbol ?? value.ticker ?? null;
  const parsed = parseOccSymbol(original);
  const underlying = value.underlying?.symbol ?? value.underlying_symbol?.symbol ??
    value.underlying ?? value.underlying_symbol ?? parsed?.underlying;
  const optionType = String(value.option_type ?? parsed?.optionType ?? '').toLowerCase();
  const strikeMinor = toMinor(value.strike_price) ?? parsed?.strikeMinor ?? null;
  return original && underlying && ['put', 'call'].includes(optionType)
    ? {
        symbol: original,
        underlying,
        expiration: value.expiration_date ?? parsed?.expiration ?? null,
        optionType,
        strikeMinor,
        multiplier: Number(value.multiplier ?? parsed?.multiplier ?? 100),
      }
    : parsed;
}

function activityAction(activity, option) {
  const explicit = String(activity.option_type ?? '').toUpperCase();
  if (explicit.includes('SELL_TO_OPEN')) return 'sell_to_open';
  if (explicit.includes('BUY_TO_CLOSE')) return 'buy_to_close';
  const type = String(activity.type ?? '').toUpperCase();
  if (type === 'SELL') return option ? 'sell_to_open' : 'sell_shares';
  if (type === 'BUY') return option ? 'buy_to_close' : 'buy_shares';
  if (type.includes('ASSIGN')) return 'assignment';
  if (type.includes('EXPIR')) return 'expiration';
  return type.toLowerCase() || 'unknown';
}

function normalizeActivity(accountId, activity, snapshot) {
  const option = optionFrom(activity.option_symbol ?? activity.symbol);
  const feeMinor = Math.abs(toMinor(activity.fee) ?? 0);
  const amountMinor = toMinor(activity.amount);
  const sourceId = activity.id ?? activity.external_reference_id ?? hash(activity);
  return {
    id: `snaptrade:activity:${accountId}:${sourceId}`,
    source: 'snaptrade',
    sourceType: 'activity',
    sourceId: String(sourceId),
    sourceHash: hash(activity),
    snapshotHash: snapshot.contentSha256,
    accountId,
    occurredAt: utcTimestamp(activity.trade_date ?? activity.settlement_date, snapshot.fetchedAt),
    action: activityAction(activity, option),
    description: activity.description ?? null,
    option,
    underlying: option?.underlying ?? activity.symbol?.symbol ?? text(activity.symbol) ?? null,
    quantity: Math.abs(Number(activity.units ?? activity.quantity ?? 0)),
    priceMinor: toMinor(activity.price),
    amountMinor,
    feeMinor,
    netCashMinor: amountMinor === null ? null : amountMinor - feeMinor,
    authoritative: true,
    needsReview: !option && String(activity.type ?? '').toUpperCase().includes('OPTION'),
  };
}

function normalizeOrder(accountId, order, snapshot) {
  const option = optionFrom(order.option_symbol);
  const sourceId = order.brokerage_order_id ?? order.id ?? hash(order);
  const action = String(order.action ?? '').toLowerCase();
  return {
    id: `snaptrade:order:${accountId}:${sourceId}`,
    source: 'snaptrade', sourceType: 'order', sourceId: String(sourceId),
    sourceHash: hash(order), snapshotHash: snapshot.contentSha256, accountId,
    occurredAt: utcTimestamp(order.time_executed ?? order.time_placed, snapshot.fetchedAt),
    action: action === 'sell_open' ? 'sell_to_open' : action === 'buy_close' ? 'buy_to_close' : action,
    description: null, option, underlying: option?.underlying ?? order.symbol?.symbol ?? null,
    quantity: Math.abs(Number(order.filled_quantity ?? 0)),
    priceMinor: toMinor(order.execution_price), amountMinor: null, feeMinor: null,
    netCashMinor: null, authoritative: false,
    needsReview: Number(order.filled_quantity ?? 0) > 0 && !option,
  };
}

function normalizePosition(accountId, position, snapshot) {
  const instrument = position.instrument ?? position.symbol;
  const option = optionFrom(instrument);
  const symbol = option?.underlying ?? instrument?.symbol ?? instrument?.raw_symbol ?? null;
  return {
    id: `snaptrade:position:${accountId}:${instrument?.id ?? option?.symbol ?? symbol}`,
    source: 'snaptrade', sourceHash: hash(position), snapshotHash: snapshot.contentSha256,
    accountId, symbol, option, quantity: Number(position.units ?? 0),
    priceMinor: toMinor(position.price), brokerCostBasisMinor: toMinor(position.cost_basis),
    currency: position.currency?.code ?? instrument?.currency?.code ?? 'USD',
  };
}

export function normalizeSnapshots(snapshots) {
  const events = [];
  const positions = [];
  const balances = [];
  for (const snapshot of snapshots) {
    const accountId = snapshot.accountId;
    if (snapshot.endpoint === 'activities') {
      for (const item of snapshot.payload?.data ?? snapshot.payload ?? []) events.push(normalizeActivity(accountId, item, snapshot));
    } else if (snapshot.endpoint === 'orders') {
      for (const item of snapshot.payload ?? []) events.push(normalizeOrder(accountId, item, snapshot));
    } else if (snapshot.endpoint === 'positions') {
      for (const item of snapshot.payload?.results ?? snapshot.payload ?? []) positions.push(normalizePosition(accountId, item, snapshot));
    } else if (snapshot.endpoint === 'balances') {
      for (const item of snapshot.payload ?? []) balances.push({
        accountId, currency: item.currency?.code ?? 'USD', cashMinor: toMinor(item.cash),
        buyingPowerMinor: toMinor(item.buying_power), snapshotHash: snapshot.contentSha256,
      });
    }
  }
  const uniqueEvents = [...new Map(events.map((event) => [event.id, event])).values()]
    .sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)) || a.id.localeCompare(b.id));
  return { schemaVersion: NORMALIZED_SCHEMA_VERSION, calculationVersion: CALCULATION_VERSION, events: uniqueEvents, positions, balances };
}
