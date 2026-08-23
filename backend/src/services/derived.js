import { normalizeSnapshots } from './normalize.js';
import { buildDerivedModel } from './wheel.js';

export const MIN_VISIBLE_EQUITY_SHARES = 100;

export function scopeToOptionsAccount(normalized) {
  const optionCounts = new Map();
  for (const position of normalized.positions) {
    if (position.option && position.quantity !== 0) {
      optionCounts.set(position.accountId, (optionCounts.get(position.accountId) ?? 0) + 1);
    }
  }
  const scopedAccountId = [...optionCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
  if (!scopedAccountId) {
    return { ...normalized, events: [], positions: [], balances: [], scope: { accountId: null, symbols: [], minimumSharesInclusive: MIN_VISIBLE_EQUITY_SHARES } };
  }
  const eligibleEquities = normalized.positions
    .filter((position) => position.accountId === scopedAccountId && !position.option && position.quantity >= MIN_VISIBLE_EQUITY_SHARES);
  const symbols = new Set(eligibleEquities
    .map((position) => position.symbol));
  const positions = eligibleEquities.map((position) => {
    const shortCalls = normalized.positions.filter((candidate) =>
      candidate.accountId === scopedAccountId && candidate.option?.underlying === position.symbol &&
      candidate.option.optionType === 'call' && candidate.quantity < 0);
    const coveredCallContracts = shortCalls.reduce((total, call) => total + Math.abs(call.quantity), 0);
    const totalLots = Math.floor(position.quantity / 100);
    return {
      ...position,
      coveredCall: {
        status: coveredCallContracts > 0 ? 'open' : 'available',
        contracts: coveredCallContracts,
        expirations: [...new Set(shortCalls.map((call) => call.option.expiration).filter(Boolean))].sort(),
        availableLots: Math.max(0, totalLots - coveredCallContracts),
        totalLots,
      },
    };
  });
  return {
    ...normalized,
    events: normalized.events.filter((event) => event.accountId === scopedAccountId && symbols.has(event.underlying)),
    positions,
    balances: normalized.balances.filter((balance) => balance.accountId === scopedAccountId),
    scope: { accountId: scopedAccountId, symbols: [...symbols].sort(), minimumSharesInclusive: MIN_VISIBLE_EQUITY_SHARES },
  };
}

export function createDerivedService({ snapshots, config }) {
  async function load() {
    const index = await snapshots.list({ limit: 10000 });
    const latest = new Map();
    for (const item of index) {
      const key = `${item.accountId}:${item.endpoint}`;
      if (!latest.has(key)) latest.set(key, item);
    }
    const envelopes = await Promise.all([...latest.values()].map((item) => snapshots.readRaw(item.relativePath)));
    const freshness = await snapshots.status({ staleAfterMs: config.ingest.staleAfterMs });
    const normalized = scopeToOptionsAccount(normalizeSnapshots(envelopes));
    const model = buildDerivedModel(normalized, freshness);
    return { ...model, scope: normalized.scope };
  }
  return { load };
}
