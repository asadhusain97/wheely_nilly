import { buildDerivedModel } from "../../backend/src/services/wheel.js";
import { localRepository } from "./storage";
import type { BrokerageEvent, BrokerageSnapshot, MarketQuote, WheelyNillyPosition } from "./types";
import { builtInSettingsDocument, SYSTEM_RULES } from "../assets/js/settings.js";
import { calculateCloseResult } from "../../backend/src/services/position-management.js";
import { buildRollSearchProfile, calculateAndRankRollCandidates, GOAL_LABELS } from "./roll-analysis";

const minor = (value: number | null): number | null => value === null || !Number.isFinite(value) ? null : Math.round(value * 100);

const normalizedOption = (option: NonNullable<WheelyNillyPosition["option"]>) => ({
  symbol: option.symbol,
  underlying: option.underlying,
  expiration: option.expiration,
  optionType: option.optionType,
  strikeMinor: Math.round(option.strike * 100),
  multiplier: option.multiplier,
});

const normalizedEvent = (event: BrokerageEvent) => ({
  ...event,
  source: "snaptrade",
  sourceId: event.id,
  underlying: event.option?.underlying ?? event.symbol,
  option: event.option ? normalizedOption(event.option) : null,
  netCashMinor: event.amountMinor === null ? null : event.amountMinor - (event.feeMinor ?? 0),
});

export function scopeLocalAccount(normalized: any) {
  const scores = new Map<string, { options: number; events: number; lots: number }>();
  const score = (id: string) => {
    if (!scores.has(id)) scores.set(id, { options: 0, events: 0, lots: 0 });
    return scores.get(id)!;
  };
  for (const position of normalized.positions) {
    if (position.option && position.quantity !== 0) score(position.accountId).options += Math.abs(position.quantity);
    else if (!position.option && position.quantity >= 100) score(position.accountId).lots += Math.floor(position.quantity / 100);
  }
  for (const event of normalized.events) if (event.option) score(event.accountId).events += 1;
  const accountId = [...scores.entries()].sort((a, b) => b[1].options - a[1].options || b[1].events - a[1].events || b[1].lots - a[1].lots)[0]?.[0] ?? null;
  if (!accountId) return { ...normalized, events: [], positions: [], holdings: [], optionPositions: [], balances: [], quotes: [] };
  const accountPositions = normalized.positions.filter((position: any) => position.accountId === accountId);
  const equities = accountPositions.filter((position: any) => !position.option && position.quantity >= 100);
  const optionPositions = accountPositions.filter((position: any) => position.option && position.quantity !== 0);
  const symbols = new Set([...equities.map((position: any) => position.symbol), ...optionPositions.map((position: any) => position.option.underlying)]);
  const holdings = equities.map((position: any) => {
    const calls = optionPositions.filter((candidate: any) => candidate.option.underlying === position.symbol && candidate.option.optionType === "call" && candidate.quantity < 0);
    const contracts = calls.reduce((total: number, call: any) => total + Math.abs(call.quantity), 0);
    const totalLots = Math.floor(position.quantity / 100);
    return { ...position, coveredCall: { status: contracts ? "open" : "available", contracts, expirations: [...new Set(calls.map((call: any) => call.option.expiration))].sort(), availableLots: Math.max(0, totalLots - contracts), totalLots } };
  });
  return {
    ...normalized,
    events: normalized.events.filter((event: any) => event.accountId === accountId && (event.option || symbols.has(event.underlying))),
    positions: accountPositions.filter((position: any) => symbols.has(position.option?.underlying ?? position.symbol)),
    holdings,
    optionPositions,
    balances: normalized.balances.filter((balance: any) => balance.accountId === accountId),
    quotes: normalized.quotes.filter((quote: any) => symbols.has(quote.symbol)),
  };
}

export async function buildLocalModel() {
  const [snapshotRecord, eventsRecord, marketRecord] = await Promise.all([
    localRepository.get<BrokerageSnapshot>("portfolioSnapshot", "current").catch(() => null),
    localRepository.get<BrokerageEvent[]>("eventLedger", "all").catch(() => null),
    localRepository.get<{ quotes: MarketQuote[] }>("marketCache", "current").catch(() => null),
  ]);
  const snapshot = snapshotRecord?.value ?? null;
  const positions = (snapshot?.positions ?? []).map((position) => ({
    ...position,
    priceMinor: minor(position.price),
    brokerCostBasisMinor: minor(position.costBasis),
    option: position.option ? normalizedOption(position.option) : null,
  }));
  const history = eventsRecord?.value ?? [];
  const orderIds = new Set(history.map((event) => event.id));
  const events = [...history, ...(snapshot?.recentOrders ?? []).filter((event) => !orderIds.has(event.id))]
    .map(normalizedEvent)
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  const accountId = snapshot?.accounts[0]?.id ?? "local";
  const quotes = (marketRecord?.value.quotes ?? []).map((quote) => ({ accountId, symbol: quote.symbol, lastTradePriceMinor: minor(quote.price), bidPriceMinor: minor(quote.bid), askPriceMinor: minor(quote.ask), asOf: quote.quoteTime ?? quote.fetchedAt }));
  const normalized = scopeLocalAccount({
    schemaVersion: 1,
    calculationVersion: "wheel-v2",
    positions,
    events,
    balances: (snapshot?.balances ?? []).map((balance) => ({ ...balance, cashMinor: minor(balance.cash), buyingPowerMinor: minor(balance.buyingPower) })),
    quotes,
  });
  const ageMs = snapshot ? Date.now() - Date.parse(snapshot.fetchedAt) : Number.POSITIVE_INFINITY;
  return buildDerivedModel(normalized, { lastSuccessAt: snapshot?.fetchedAt ?? null, stale: ageMs > 30 * 60_000, ageMs });
}

const sourceSummary = (sourceMap: Record<string, string>) => Object.entries(sourceMap).reduce((result, [field, source]) => {
  (result[source] ??= []).push(field);
  return result;
}, { system: [], goal: [], tickerOverride: [] } as Record<string, string[]>);

const defaultGoal = (leg: "coveredCall" | "cashSecuredPut", instrumentType: unknown) => {
  const kind = String(instrumentType ?? "").toLowerCase();
  const isFund = kind.includes("etf") || (kind.includes("mutual") && kind.includes("fund"));
  return leg === "coveredCall" && isFund ? "protect" : "income";
};

const effectiveSettings = (settings: any, symbol: string, leg: "coveredCall" | "cashSecuredPut", instrumentType: unknown = null) => {
  const legSettings = settings.tickerPlaybooks?.[symbol]?.[leg] ?? null;
  const goal = legSettings?.goal ?? defaultGoal(leg, instrumentType);
  const goalRules = settings.goalProfiles?.[goal]?.[leg] ?? SYSTEM_RULES;
  const rules = { ...goalRules, ...(legSettings?.overrides ?? {}) };
  const sourceMap = Object.fromEntries(Object.keys(rules).map((field) => [
    field,
    Object.hasOwn(legSettings?.overrides ?? {}, field) ? "tickerOverride" : "goal",
  ]));
  const priceField = leg === "coveredCall" ? "minNetSalePriceMinor" : "maxNetPurchasePriceMinor";
  return {
    symbol,
    leg,
    rules,
    enabled: legSettings?.enabled ?? false,
    goal,
    goalDefaulted: !legSettings,
    priceGuard: { field: priceField, valueMinor: legSettings?.[priceField] ?? null },
    sourceMap,
    sourceSummary: sourceSummary(sourceMap),
  };
};

export async function buildLocalTargets() {
  const [model, settingsRecord] = await Promise.all([
    buildLocalModel(),
    localRepository.get<any>("tickerStrategies", "document").catch(() => null),
  ]);
  const settings = settingsRecord?.value ?? builtInSettingsDocument();
  const bySymbol = new Map<string, any>();
  for (const holding of model.dashboard.opportunities.coveredCalls ?? []) {
    bySymbol.set(holding.symbol, {
      symbol: holding.symbol,
      stockPrice: holding.price ?? null,
      owned: true,
      manuallyTracked: false,
      uncoveredLots: Number(holding.availableLots),
      adjustedBasisPerShare: holding.brokerCostBasis ?? null,
      legs: ["coveredCall"],
    });
  }
  for (const [symbol, playbook] of Object.entries<any>(settings.tickerPlaybooks ?? {})) {
    const target = bySymbol.get(symbol) ?? { symbol, stockPrice: null, owned: false, manuallyTracked: true, uncoveredLots: 0, legs: [] };
    target.manuallyTracked = true;
    for (const leg of ["coveredCall", "cashSecuredPut"] as const) if (playbook[leg]?.enabled && !target.legs.includes(leg)) target.legs.push(leg);
    bySymbol.set(symbol, target);
  }
  const targets = [...bySymbol.values()].filter((target) => target.legs.length).sort((a, b) => a.symbol.localeCompare(b.symbol)).map((target) => ({
    ...target,
    legs: target.legs.map((leg: "coveredCall" | "cashSecuredPut") => {
      const effective = effectiveSettings(settings, target.symbol, leg, target.instrumentType);
      return { leg, goal: effective.goal, effectiveSettings: effective };
    }),
  }));
  return { generatedAt: model.generatedAt, freshness: model.freshness, targets };
}

const ruleMap: Record<string, string> = {
  minDte: "min_dte", maxDte: "max_dte", minMoneyness: "min_moneyness", maxMoneyness: "max_moneyness",
  targetDeltaMin: "target_delta_min", targetDeltaMax: "target_delta_max", maxSpreadPercent: "max_spread_percent",
  minOpenInterest: "min_open_interest", minVolume: "min_volume", minPeriodReturn: "min_period_return",
};

async function marketScreen(fetcher: typeof fetch, target: any, targetLeg: any, chainRange: { minDte: number; maxDte: number } | null = null, localModel: any = null) {
  const model = localModel ?? await buildLocalModel();
  const effective = targetLeg.effectiveSettings;
  const request: Record<string, unknown> = { symbol: target.symbol, leg: targetLeg.leg === "coveredCall" ? "covered_call" : "cash_secured_put" };
  for (const [client, api] of Object.entries(ruleMap)) request[api] = effective.rules[client];
  request.cash_available = model.dashboard.opportunities.cashAvailable ?? 0;
  request.covered_shares = target.uncoveredLots * 100;
  request.adjusted_basis_per_share = target.adjustedBasisPerShare ?? null;
  request.min_net_sale_price = targetLeg.leg === "coveredCall" && effective.priceGuard.valueMinor !== null ? effective.priceGuard.valueMinor / 100 : null;
  request.max_net_purchase_price = targetLeg.leg === "cashSecuredPut" && effective.priceGuard.valueMinor !== null ? effective.priceGuard.valueMinor / 100 : null;
  request.allow_itm_calls = targetLeg.leg === "coveredCall" && effective.goal === "exit" && request.min_net_sale_price !== null;
  if (chainRange) {
    request.chain_min_dte = chainRange.minDte;
    request.chain_max_dte = chainRange.maxDte;
  }
  const response = await fetcher("/api/market/screens", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(request) });
  if (!response.ok) throw Object.assign(new Error("Market scan unavailable"), { status: response.status });
  return { ...(await response.json()), effectiveSettings: effective };
}

export async function scanLocalTarget(fetcher: typeof fetch, input: { symbol: string; leg: string }) {
  const context = await buildLocalTargets();
  const target = context.targets.find((item) => item.symbol === input.symbol);
  const targetLeg = target?.legs.find((item: any) => item.leg === input.leg);
  if (!target || !targetLeg) throw Object.assign(new Error("Ticker and strategy are not an eligible monitoring target"), { status: 400 });
  return marketScreen(fetcher, target, targetLeg);
}

export async function scanAllLocalTargets(fetcher: typeof fetch) {
  const [context, model] = await Promise.all([buildLocalTargets(), buildLocalModel()]);
  const jobs = context.targets.flatMap((target) => target.legs.map((leg: any) => ({ target, leg })));
  const ranges = new Map(context.targets.map((target) => {
    const rules = target.legs.map((leg: any) => leg.effectiveSettings.rules);
    return [target.symbol, {
      minDte: Math.min(...rules.map((item: any) => item.minDte)),
      maxDte: Math.max(...rules.map((item: any) => item.maxDte)),
    }];
  }));
  const results = Array<any>(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const index = next++;
      const { target, leg } = jobs[index];
      try { results[index] = { symbol: target.symbol, leg: leg.leg, status: "success", result: await marketScreen(fetcher, target, leg, ranges.get(target.symbol) ?? null, model) }; }
      catch (error) { results[index] = { symbol: target.symbol, leg: leg.leg, status: "error", error: { code: "SCREENER_UNAVAILABLE", message: error instanceof Error ? error.message : "Market scan unavailable" } }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, worker));
  return { scannedAt: new Date().toISOString(), freshness: context.freshness, targets: context.targets, results };
}

const marketNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  return value === null || value === undefined || !Number.isFinite(parsed) ? null : parsed;
};

const lastUsableQuoteView = (quote: any) => quote ? {
  bidPerShare: marketNumber(quote.bid),
  askPerShare: marketNumber(quote.ask),
  underlyingPrice: marketNumber(quote.underlying_price),
  quoteTimestamp: quote.contract_quote_time ?? quote.underlying_quote_time ?? quote.fetched_at ?? null,
  fetchedAt: quote.fetched_at ?? null,
  provider: quote.provider ?? null,
} : null;

export async function buildLocalCloseResults(contractResults: any[], lastUsableContractResults: any[] = []) {
  const [model, settingsRecord] = await Promise.all([
    buildLocalModel(),
    localRepository.get<any>("tickerStrategies", "document").catch(() => null),
  ]);
  const settings = settingsRecord?.value ?? builtInSettingsDocument();
  const quotes = new Map(contractResults.map((item) => [item.contract?.contract_symbol, item]));
  const lastUsableQuotes = new Map(lastUsableContractResults.map((item) => [item.contract?.contract_symbol, item]));
  const scanTimestamp = new Date().toISOString();
  const results = model.dashboard.openTrades.map((trade: any) => {
    const leg = trade.type === "csp" ? "cashSecuredPut" : "coveredCall";
    const effective = effectiveSettings(settings, trade.symbol, leg, trade.instrumentType);
    const quote = quotes.get(trade.contractSymbol) ?? null;
    const currentQuoteUsable = quote?.available === true && marketNumber(quote.ask) !== null && Number(quote.ask) > 0;
    const close = calculateCloseResult({ trade, quote, effectiveSettings: effective, now: new Date(scanTimestamp) });
    return {
      contract: { accountId: trade.accountId, contractSymbol: trade.contractSymbol, symbol: trade.symbol, optionType: leg === "cashSecuredPut" ? "put" : "call", strategy: trade.type, strike: trade.strike, expiration: trade.expiration, contracts: trade.contracts, multiplier: trade.multiplier ?? 100, openedAt: trade.openedAt },
      scanTimestamp,
      quoteTimestamps: { contract: quote?.contract_quote_time ?? null, underlying: quote?.underlying_quote_time ?? null, providerFetchedAt: quote?.fetched_at ?? null },
      provider: quote?.provider ?? null,
      lastUsableQuote: currentQuoteUsable ? null : lastUsableQuoteView(lastUsableQuotes.get(trade.contractSymbol)),
      effectiveSettings: effective,
      close,
    };
  });
  return { scanTimestamp, quoteScanTimestamp: scanTimestamp, positionGeneratedAt: model.generatedAt, results, failures: results.filter((item: any) => !item.close.available).length };
}

export async function buildLocalRollResults(fetcher: typeof fetch, contractSymbol: string) {
  const [model, settingsRecord] = await Promise.all([
    buildLocalModel(),
    localRepository.get<any>("tickerStrategies", "document").catch(() => null),
  ]);
  const trade = model.dashboard.openTrades.find((item: any) => item.contractSymbol === contractSymbol);
  if (!trade) throw Object.assign(new Error("This contract is no longer open"), { status: 409 });
  const settings = settingsRecord?.value ?? builtInSettingsDocument();
  const leg = trade.type === "csp" ? "cashSecuredPut" : "coveredCall";
  const effective = effectiveSettings(settings, trade.symbol, leg, trade.instrumentType);
  const profile = buildRollSearchProfile(effective);
  if (!effective.goal || !profile) throw Object.assign(new Error("Choose a ticker goal before evaluating a roll"), { status: 400 });
  const rules = effective.rules;
  const request = {
    current_contract: {
      contract_symbol: trade.contractSymbol,
      symbol: trade.symbol,
      option_type: trade.type === "csp" ? "put" : "call",
      expiration: trade.expiration,
      strike: trade.strike,
    },
    min_dte: rules.minDte,
    max_dte: rules.maxDte,
    min_moneyness: rules.minMoneyness,
    max_moneyness: rules.maxMoneyness,
    min_open_interest: rules.minOpenInterest,
    min_volume: rules.minVolume,
    max_spread_percent: rules.maxSpreadPercent,
    target_delta_min: rules.targetDeltaMin,
    target_delta_max: rules.targetDeltaMax,
    min_period_return: rules.minPeriodReturn,
    allow_itm_calls: leg === "coveredCall" && effective.goal === "exit",
    limit: 20,
  };
  const response = await fetcher("/api/market/rolls", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(request),
  });
  const market = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = market?.detail;
    throw Object.assign(new Error(detail?.message ?? detail?.code ?? "Roll quotes unavailable"), { status: response.status });
  }
  const management = { effectiveSettings: effective };
  const candidates = market.current_quote?.available
    ? calculateAndRankRollCandidates({ trade, management, currentQuote: market.current_quote, candidates: market.candidates ?? [] })
    : [];
  return {
    contractSymbol: trade.contractSymbol,
    symbol: trade.symbol,
    strategy: trade.type,
    quantity: Math.abs(Number(trade.contracts)),
    currentStrike: trade.strike,
    currentExpiration: trade.expiration,
    goal: effective.goal,
    goalLabel: GOAL_LABELS[effective.goal as keyof typeof GOAL_LABELS],
    searchProfile: profile,
    provider: market.provider,
    quoteTimestamp: market.quote_timestamp,
    fetchedAt: market.fetched_at,
    underlyingPrice: market.underlying_price,
    currentQuote: market.current_quote,
    candidates,
    exclusions: market.exclusions ?? {},
  };
}
