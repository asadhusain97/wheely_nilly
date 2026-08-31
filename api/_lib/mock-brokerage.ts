import {
  normalizeAccount,
  normalizeBalances,
  normalizeConnection,
  normalizeEvent,
  normalizePosition,
} from "./snaptrade.js";

export const MOCK_ACCOUNT_ID = "mock-wheel-account";
const MOCK_CONNECTION_ID = "mock-brokerage-connection";
const DAY_MS = 86_400_000;

const isoDaysAgo = (now: Date, days: number): string => new Date(Date.UTC(
  now.getUTCFullYear(),
  now.getUTCMonth(),
  now.getUTCDate() - days,
  15,
  30,
)).toISOString();

const dateText = (date: Date): string => date.toISOString().slice(0, 10);

const thirdFriday = (year: number, month: number): Date => {
  const first = new Date(Date.UTC(year, month, 1));
  const firstFriday = 1 + ((5 - first.getUTCDay() + 7) % 7);
  return new Date(Date.UTC(year, month, firstFriday + 14));
};

const nextMonthlyExpiration = (now: Date): string => {
  for (let monthsAhead = 1; monthsAhead <= 4; monthsAhead += 1) {
    const candidateMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthsAhead, 1));
    const candidate = thirdFriday(candidateMonth.getUTCFullYear(), candidateMonth.getUTCMonth());
    if ((candidate.getTime() - now.getTime()) / DAY_MS >= 28) return dateText(candidate);
  }
  throw new Error("Unable to create a mock option expiration");
};

const occSymbol = (underlying: string, expiration: string, optionType: "call" | "put", strike: number): string => {
  const date = expiration.replaceAll("-", "").slice(2);
  const strikeDigits = String(Math.round(strike * 1000)).padStart(8, "0");
  return `${underlying}${date}${optionType === "call" ? "C" : "P"}${strikeDigits}`;
};

const optionInstrument = (underlying: string, expiration: string, optionType: "call" | "put", strike: number) => ({
  kind: "option",
  id: `mock-${underlying.toLowerCase()}-${optionType}`,
  symbol: occSymbol(underlying, expiration, optionType, strike),
  option_type: optionType.toUpperCase(),
  strike_price: String(strike),
  expiration_date: expiration,
  multiplier: 100,
  underlying: { kind: "stock", symbol: underlying },
});

const mockAccount = () => normalizeAccount({
  id: MOCK_ACCOUNT_ID,
  display_name: "Mock Wheel Portfolio",
  institution_name: "Local Brokerage",
  number: "****4242",
  sync_status: { transactions: { initial_sync_completed: true } },
});

const mockConnection = (now: Date) => normalizeConnection({
  id: MOCK_CONNECTION_ID,
  brokerage: { name: "Local Brokerage" },
  disabled: false,
  updated_date: now.toISOString(),
});

const mockInstruments = (now: Date) => {
  const expiration = nextMonthlyExpiration(now);
  return {
    expiration,
    rklbCall: optionInstrument("RKLB", expiration, "call", 70),
    sofiPut: optionInstrument("SOFI", expiration, "put", 8),
    closedRklbCall: optionInstrument("RKLB", expiration, "call", 65),
  };
};

const rawHistory = (now: Date) => {
  const { rklbCall, sofiPut, closedRklbCall } = mockInstruments(now);
  return [
    {
      id: "mock-rklb-shares",
      type: "BUY",
      symbol: "RKLB",
      trade_date: isoDaysAgo(now, 90),
      units: 200,
      price: 55,
      amount: -11_000,
      fee: 0,
    },
    {
      id: "mock-rklb-call-closed-open",
      option_symbol: closedRklbCall,
      option_type: "SELL_TO_OPEN",
      trade_date: isoDaysAgo(now, 45),
      units: 1,
      price: 2.1,
      amount: 210,
      fee: 0.03,
    },
    {
      id: "mock-rklb-call-closed-close",
      option_symbol: closedRklbCall,
      option_type: "BUY_TO_CLOSE",
      trade_date: isoDaysAgo(now, 24),
      units: 1,
      price: 0.75,
      amount: -75,
      fee: 0.03,
    },
    {
      id: "mock-rklb-call-open",
      option_symbol: rklbCall,
      option_type: "SELL_TO_OPEN",
      trade_date: isoDaysAgo(now, 10),
      units: 1,
      price: 1.85,
      amount: 185,
      fee: 0.03,
    },
    {
      id: "mock-sofi-put-open",
      option_symbol: sofiPut,
      option_type: "SELL_TO_OPEN",
      trade_date: isoDaysAgo(now, 7),
      units: 1,
      price: 0.64,
      amount: 64,
      fee: 0.03,
    },
  ];
};

export const createMockAccountCatalog = (now = new Date()) => ({
  fetchedAt: now.toISOString(),
  accounts: [mockAccount()],
  connections: [mockConnection(now)],
  errors: [],
});

export const createMockBrokerageSnapshot = (selectedAccountIds: string[], now = new Date()) => {
  if (!selectedAccountIds.includes(MOCK_ACCOUNT_ID)) {
    throw Object.assign(new Error("Selected mock brokerage account is unavailable"), {
      status: 409,
      code: "ACCOUNT_SELECTION_REQUIRED",
    });
  }
  const { rklbCall, sofiPut } = mockInstruments(now);
  const recent = rawHistory(now).filter((item) => ["mock-rklb-call-open", "mock-sofi-put-open"].includes(item.id));
  return {
    schemaVersion: 1 as const,
    fetchedAt: now.toISOString(),
    accounts: [mockAccount()],
    positions: [
      normalizePosition(MOCK_ACCOUNT_ID, {
        instrument: { kind: "stock", id: "mock-rklb-stock", symbol: "RKLB" },
        units: 200,
        price: 68,
        cost_basis: 55,
        currency: { code: "USD" },
      }),
      normalizePosition(MOCK_ACCOUNT_ID, {
        instrument: rklbCall,
        units: -1,
        price: 1.45,
        cost_basis: 1.85,
        currency: { code: "USD" },
      }),
      normalizePosition(MOCK_ACCOUNT_ID, {
        instrument: sofiPut,
        units: -1,
        price: 0.42,
        cost_basis: 0.64,
        currency: { code: "USD" },
      }),
    ],
    balances: normalizeBalances(MOCK_ACCOUNT_ID, [{
      currency: { code: "USD" },
      cash: 12_500.25,
      buying_power: 25_000.5,
    }]),
    recentOrders: recent.map((item) => normalizeEvent(MOCK_ACCOUNT_ID, item, "order")),
    connections: [mockConnection(now)],
    errors: [],
  };
};

export const createMockHistoryPage = (accountId: string, offset: number, now = new Date()) => {
  if (accountId !== MOCK_ACCOUNT_ID) {
    throw Object.assign(new Error("Mock brokerage account is unavailable"), {
      status: 409,
      code: "ACCOUNT_SELECTION_REQUIRED",
    });
  }
  const pageSize = 1000;
  const history = rawHistory(now).map((item) => normalizeEvent(accountId, item, "activity"));
  const events = history.slice(offset, offset + pageSize);
  const nextOffset = offset + events.length;
  return {
    events,
    nextCursor: nextOffset < history.length ? `${accountId}:${nextOffset}` : null,
  };
};
