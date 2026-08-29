import crypto from "node:crypto";

export const payloadItems = (payload: unknown, key?: string): unknown[] => {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  if (key && Array.isArray(record[key])) return record[key] as unknown[];
  for (const candidate of ["data", "results", "result", "authorizations", "accounts", "positions", "balances", "orders", "activities"]) {
    if (Array.isArray(record[candidate])) return record[candidate] as unknown[];
  }
  for (const candidate of ["data", "result"]) {
    if (record[candidate] && typeof record[candidate] === "object") {
      const nested = payloadItems(record[candidate], key);
      if (nested.length) return nested;
    }
  }
  return [];
};

export const payloadPagination = (payload: unknown): Record<string, unknown> | null => {
  const queue: unknown[] = [payload];
  const visited = new Set<object>();
  while (queue.length) {
    const candidate = queue.shift();
    if (!candidate || typeof candidate !== "object" || visited.has(candidate)) continue;
    visited.add(candidate);
    const record = candidate as Record<string, unknown>;
    if (record.pagination && typeof record.pagination === "object") {
      return record.pagination as Record<string, unknown>;
    }
    for (const key of ["data", "result", "structuredContent"]) {
      if (record[key] && typeof record[key] === "object") queue.push(record[key]);
    }
  }
  return null;
};

const asRecord = (value: unknown): Record<string, any> => value && typeof value === "object" ? value as Record<string, any> : {};
const finite = (value: unknown): number | null => Number.isFinite(Number(value)) ? Number(value) : null;
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const referenceSuffix = (value: unknown): string | null => {
  const candidate = typeof value === "number" ? String(value) : text(value);
  if (!candidate) return null;
  const compact = candidate.replace(/[^A-Za-z0-9]/g, "");
  return compact ? compact.slice(-4).toUpperCase() : null;
};

export const parseOccSymbol = (raw: unknown) => {
  const symbol = String(raw ?? "").replace(/\s/g, "").toUpperCase();
  const match = /^([A-Z0-9.]{1,6})(\d{6})([CP])(\d{8})$/.exec(symbol);
  if (!match) return null;
  const [, underlying, date, optionType, strike] = match;
  return {
    symbol,
    underlying,
    expiration: `20${date.slice(0, 2)}-${date.slice(2, 4)}-${date.slice(4, 6)}`,
    optionType: optionType === "C" ? "call" as const : "put" as const,
    strike: Number(strike) / 1000,
    multiplier: 100,
  };
};

const optionIdentity = (value: unknown) => {
  const item = asRecord(value);
  const raw = item.symbol ?? item.raw_symbol ?? item.ticker ?? value;
  const parsed = parseOccSymbol(raw);
  if (parsed) return parsed;
  const underlying = text(item.underlying?.symbol ?? item.underlying_symbol?.symbol ?? item.underlying ?? item.underlying_symbol);
  const optionType = String(item.option_type ?? "").toLowerCase();
  const strike = finite(item.strike_price ?? item.strike);
  const symbol = text(raw);
  if (!symbol || !underlying || !["call", "put"].includes(optionType) || strike === null) return null;
  return { symbol, underlying, expiration: text(item.expiration_date) ?? "", optionType: optionType as "call" | "put", strike, multiplier: finite(item.multiplier) ?? 100 };
};

export const normalizeAccount = (value: unknown) => {
  const account = asRecord(value);
  const numberSuffix = referenceSuffix(account.number ?? account.account_number ?? account.masked_number ?? account.number_suffix);
  const institutionSuffix = referenceSuffix(account.institution_account_id ?? account.institutionAccountId);
  const snapTradeSuffix = referenceSuffix(account.id);
  return {
    id: String(account.id ?? ""),
    institution: text(account.institution_name ?? account.institution?.name ?? account.meta?.institution_name),
    name: text(account.name ?? account.display_name),
    numberSuffix,
    referenceLabel: numberSuffix
      ? `Account •••• ${numberSuffix}`
      : institutionSuffix
        ? `Institution ID •••• ${institutionSuffix}`
        : `SnapTrade ID …${snapTradeSuffix ?? "unknown"}`,
    syncStatus: text(account.sync_status ?? account.status),
  };
};

export const normalizePosition = (accountId: string, value: unknown) => {
  const position = asRecord(value);
  const instrument = asRecord(position.instrument ?? position.symbol);
  const option = optionIdentity(instrument);
  const symbol = option?.underlying ?? text(instrument.symbol ?? instrument.raw_symbol) ?? "UNKNOWN";
  return {
    id: `${accountId}:${text(instrument.id) ?? option?.symbol ?? symbol}`,
    accountId,
    symbol,
    quantity: finite(position.units ?? position.quantity) ?? 0,
    price: finite(position.price),
    costBasis: finite(position.cost_basis),
    currency: text(position.currency?.code ?? position.currency ?? instrument.currency?.code ?? instrument.currency) ?? "USD",
    option,
  };
};

export const normalizeBalances = (accountId: string, payload: unknown) => payloadItems(payload).map((value) => {
  const balance = asRecord(value);
  return {
    accountId,
    currency: text(balance.currency?.code) ?? "USD",
    cash: finite(balance.cash),
    buyingPower: finite(balance.buying_power),
  };
});

export const normalizeEvent = (accountId: string, value: unknown, sourceType: "activity" | "order") => {
  const item = asRecord(value);
  const option = optionIdentity(item.option_symbol ?? item.symbol);
  const sourceId = text(item.id ?? item.external_reference_id ?? item.brokerage_order_id) ?? crypto.createHash("sha256").update(JSON.stringify(item)).digest("hex").slice(0, 24);
  const rawAction = String(item.option_type ?? item.action ?? item.type ?? "unknown").toLowerCase();
  const action = rawAction.includes("sell_to_open") || rawAction === "sell_open" || (rawAction === "sell" && option) ? "sell_to_open"
    : rawAction.includes("buy_to_close") || rawAction === "buy_close" || (rawAction === "buy" && option) ? "buy_to_close"
      : rawAction.includes("assign") ? "assignment"
        : rawAction.includes("expir") ? "expiration"
          : rawAction === "sell" ? "sell_shares"
            : rawAction === "buy" ? "buy_shares"
              : rawAction;
  const occurredAt = text(item.trade_date ?? item.settlement_date ?? item.time_executed ?? item.time_placed) ?? new Date().toISOString();
  return {
    id: `snaptrade:${sourceType}:${accountId}:${sourceId}`,
    accountId,
    sourceType,
    occurredAt,
    action,
    symbol: option?.underlying ?? text(item.symbol?.symbol ?? item.symbol),
    option,
    quantity: Math.abs(finite(item.units ?? item.quantity ?? item.filled_quantity) ?? 0),
    priceMinor: finite(item.price ?? item.execution_price) === null ? null : Math.round(Number(item.price ?? item.execution_price) * 100),
    amountMinor: finite(item.amount) === null ? null : Math.round(Number(item.amount) * 100),
    feeMinor: finite(item.fee) === null ? null : Math.round(Math.abs(Number(item.fee)) * 100),
    authoritative: sourceType === "activity",
    needsReview: Boolean(!option && rawAction.includes("option")),
  };
};

export const normalizeConnection = (value: unknown) => {
  const connection = asRecord(value);
  return {
    id: String(connection.id ?? ""),
    brokerage: text(connection.brokerage?.name ?? connection.name),
    disabled: Boolean(connection.disabled),
    lastSuccessfulSync: text(connection.holdings?.last_successful_sync ?? connection.updated_date),
  };
};
