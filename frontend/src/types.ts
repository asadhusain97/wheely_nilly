export type RefreshStatus = "idle" | "refreshing" | "success" | "stale" | "error";

export interface SafeError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface RefreshSlice<T> {
  data: T | null;
  status: RefreshStatus;
  lastAttemptAt: string | null;
  lastSuccessfulRefresh: string | null;
  error: SafeError | null;
}

export interface WheelyNillyAccount {
  id: string;
  institution: string | null;
  name: string | null;
  numberSuffix: string | null;
  referenceLabel: string;
  syncStatus: string | null;
}

export interface OptionIdentity {
  symbol: string;
  underlying: string;
  optionType: "call" | "put";
  expiration: string;
  strike: number;
  multiplier: number;
}

export interface WheelyNillyPosition {
  id: string;
  accountId: string;
  symbol: string;
  quantity: number;
  price: number | null;
  costBasis: number | null;
  currency: string;
  option: OptionIdentity | null;
}

export interface BrokerageEvent {
  id: string;
  accountId: string;
  sourceType: "activity" | "order";
  occurredAt: string;
  action: string;
  symbol: string | null;
  option: OptionIdentity | null;
  quantity: number;
  priceMinor: number | null;
  amountMinor: number | null;
  feeMinor: number | null;
  authoritative: boolean;
  needsReview: boolean;
}

export interface BrokerageSnapshot {
  schemaVersion: 1;
  fetchedAt: string;
  accounts: WheelyNillyAccount[];
  positions: WheelyNillyPosition[];
  balances: Array<{
    accountId: string;
    currency: string;
    cash: number | null;
    buyingPower: number | null;
  }>;
  recentOrders: BrokerageEvent[];
  connections: Array<{
    id: string;
    brokerage: string | null;
    disabled: boolean;
    lastSuccessfulSync: string | null;
  }>;
  errors: Array<{ accountId: string | null; endpoint: string; error: SafeError }>;
}

export interface MarketQuote {
  symbol: string;
  price: number | null;
  bid: number | null;
  ask: number | null;
  quoteTime: string | null;
  fetchedAt: string;
  provider: "yfinance";
  unofficial: true;
}

export interface ExactContractQuote extends OptionIdentity {
  bid: number | null;
  ask: number | null;
  last: number | null;
  volume: number | null;
  openInterest: number | null;
  impliedVolatility: number | null;
  underlyingPrice: number | null;
  quoteTime: string | null;
  fetchedAt: string;
  provider: "yfinance";
}

export interface PortfolioDiff {
  addedPositionIds: string[];
  removedPositionIds: string[];
  changedPositionIds: string[];
  addedOrderIds: string[];
  affectedSymbols: string[];
  affectedContracts: string[];
}

export interface RefreshPolicy {
  marketIntervalMs: 60_000 | 120_000 | 300_000;
  brokerageIntervalMs: 900_000 | 1_800_000 | 3_600_000 | null;
  refreshBrokerageOnOpen: boolean;
  manualBrokerageCooldownMs: number;
}

export interface AppDataState {
  portfolio: RefreshSlice<BrokerageSnapshot>;
  market: RefreshSlice<{ quotes: MarketQuote[]; contracts: ExactContractQuote[] }>;
  radar: RefreshSlice<unknown[]> & { calculatedAt: string | null };
}
