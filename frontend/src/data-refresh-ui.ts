import { RefreshCoordinator, DEFAULT_REFRESH_POLICY } from "./refresh-coordinator";
import { localRepository } from "./storage";
import type { BrokerageEvent, BrokerageSnapshot, ExactContractQuote, MarketQuote, PortfolioDiff, RefreshPolicy } from "./types";
import { buildLocalCloseResults, buildLocalTargets, scanAllLocalTargets } from "./local-analysis";

const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, { ...init, headers: { accept: "application/json", ...(init?.headers ?? {}) } });
  if (!response.ok) throw Object.assign(new Error(`Request failed with ${response.status}`), { status: response.status });
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
};

const relativeTime = (iso: string | null): string => {
  if (!iso) return "Not yet";
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 10) return "Just now";
  if (seconds < 60) return `${seconds} sec ago`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} min ago` : new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
};

const optionContracts = (snapshot: BrokerageSnapshot | null) => [...new Map(
  (snapshot?.positions ?? []).flatMap((position) => position.option ? [[position.option.symbol, position.option] as const] : []),
).values()];
const portfolioSymbols = (snapshot: BrokerageSnapshot | null) => [...new Set((snapshot?.positions ?? []).map((position) => position.option?.underlying ?? position.symbol).filter(Boolean))];

const mergeEventLedger = async (events: BrokerageEvent[]): Promise<void> => {
  const existing = (await localRepository.get<BrokerageEvent[]>("eventLedger", "all").catch(() => null))?.value ?? [];
  const merged = [...new Map([...existing, ...events].map((event) => [event.id, event])).values()]
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id));
  await localRepository.put("eventLedger", "all", merged);
};

export async function initializeDataRefresh(): Promise<void> {
  let currentSnapshot = (await localRepository.get<BrokerageSnapshot>("portfolioSnapshot", "current").catch(() => null))?.value ?? null;
  const storedPolicy = (await localRepository.get<RefreshPolicy>("appSettings", "refreshPolicy").catch(() => null))?.value;
  let policy = storedPolicy ?? DEFAULT_REFRESH_POLICY;
  let marketUpdatedAt = (await localRepository.get<string>("refreshMetadata", "marketUpdatedAt").catch(() => null))?.value ?? null;
  let brokerageUpdatedAt = currentSnapshot?.fetchedAt ?? null;

  const marketStatus = document.querySelector<HTMLElement>("[data-market-freshness]");
  const brokerageStatus = document.querySelector<HTMLElement>("[data-brokerage-freshness]");
  const brokerageLastSync = document.querySelector<HTMLElement>("[data-brokerage-last-sync]");
  const connectionCard = document.querySelector<HTMLElement>("[data-connection-card]");
  const onlineState = document.querySelector<HTMLElement>("[data-online-state]");

  const renderFreshness = () => {
    if (marketStatus) marketStatus.textContent = marketUpdatedAt ? relativeTime(marketUpdatedAt) : navigator.onLine ? "Waiting" : "Saved view";
    if (brokerageStatus) brokerageStatus.textContent = brokerageUpdatedAt ? relativeTime(brokerageUpdatedAt) : "Not synced";
    if (brokerageLastSync) brokerageLastSync.textContent = relativeTime(brokerageUpdatedAt);
    if (onlineState) onlineState.textContent = navigator.onLine ? "Online" : "Offline · showing saved data";
  };

  const fetchMarket = async (symbols: string[], contracts = optionContracts(currentSnapshot), signal?: AbortSignal) => {
    const [quotesResult, contractsResult] = await Promise.all([
      symbols.length ? json<{ quotes: MarketQuote[] }>("/api/market/quotes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbols }), signal }) : { quotes: [] },
      contracts.length ? json<{ results: ExactContractQuote[] }>("/api/market/contracts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ contracts: contracts.map((contract) => ({ contract_symbol: contract.symbol, symbol: contract.underlying, option_type: contract.optionType, expiration: contract.expiration, strike: contract.strike })) }), signal }) : { results: [] },
    ]);
    const existing = (await localRepository.get<{ quotes: MarketQuote[]; contracts: ExactContractQuote[] }>("marketCache", "current").catch(() => null))?.value;
    const mergedQuotes = [...new Map([...(existing?.quotes ?? []), ...quotesResult.quotes].map((quote) => [quote.symbol, quote])).values()];
    const contractKey = (item: any) => item.contract?.contract_symbol ?? item.contractSymbol ?? item.symbol;
    const mergedContracts = [...new Map([...(existing?.contracts ?? []), ...(contractsResult.results ?? [])].map((item) => [contractKey(item), item])).values()];
    marketUpdatedAt = new Date().toISOString();
    await Promise.all([
      localRepository.put("marketCache", "current", { quotes: mergedQuotes, contracts: mergedContracts }),
      localRepository.put("refreshMetadata", "marketUpdatedAt", marketUpdatedAt),
    ]);
    const closeResults = await buildLocalCloseResults(mergedContracts);
    await localRepository.put("marketCache", "closeResults", closeResults);
    const radar = await scanAllLocalTargets(fetch).catch(() => null);
    if (radar) {
      await localRepository.put("radarCache", "current", radar);
      document.dispatchEvent(new CustomEvent("wheely-radar-updated", { detail: radar }));
    }
    renderFreshness();
    document.dispatchEvent(new CustomEvent("wheely-market-updated", { detail: { quotes: mergedQuotes, contracts: mergedContracts } }));
  };

  const importHistory = async (snapshot: BrokerageSnapshot) => {
    const complete = await localRepository.get<boolean>("refreshMetadata", "historyImported").catch(() => null);
    if (complete?.value) return;
    const events: BrokerageEvent[] = [];
    for (const account of snapshot.accounts) {
      let cursor: string | null = null;
      do {
        const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : `?accountId=${encodeURIComponent(account.id)}`;
        const page: { events: BrokerageEvent[]; nextCursor: string | null } = await json(`/api/brokerage/history${suffix}`);
        events.push(...page.events);
        cursor = page.nextCursor;
      } while (cursor);
    }
    const deduped = [...new Map(events.map((event) => [event.id, event])).values()];
    await mergeEventLedger(deduped);
    await localRepository.put("refreshMetadata", "historyImported", true);
    document.dispatchEvent(new CustomEvent("wheely-history-updated"));
  };

  const coordinator = new RefreshCoordinator({
    document,
    readPortfolio: () => currentSnapshot,
    writePortfolio: async (snapshot) => {
      currentSnapshot = snapshot;
      brokerageUpdatedAt = snapshot.fetchedAt;
      await localRepository.put("portfolioSnapshot", "current", snapshot);
      await mergeEventLedger(snapshot.recentOrders ?? []);
      void importHistory(snapshot).catch(() => undefined);
      renderFreshness();
      document.dispatchEvent(new CustomEvent("wheely-brokerage-updated", { detail: snapshot }));
    },
    refreshBrokerage: (signal) => json<BrokerageSnapshot>("/api/brokerage/snapshot", { signal }),
    refreshMarket: async (signal) => {
      const targets = await buildLocalTargets().catch(() => ({ targets: [] as Array<{ symbol: string }> }));
      const symbols = [...new Set([...portfolioSymbols(currentSnapshot), ...targets.targets.map((target) => target.symbol)])];
      await fetchMarket(symbols, optionContracts(currentSnapshot), signal);
    },
    refreshAffectedMarket: async (diff: PortfolioDiff, signal) => {
      const contracts = optionContracts(currentSnapshot).filter((contract) => diff.affectedContracts.includes(contract.symbol));
      await fetchMarket(diff.affectedSymbols, contracts, signal);
    },
    onError: (slice, error) => {
      const node = slice === "market" ? marketStatus : brokerageStatus;
      if (node) node.textContent = navigator.onLine ? "Update failed · saved data" : "Offline · saved data";
      document.dispatchEvent(new CustomEvent("wheely-refresh-error", { detail: { slice, error } }));
    },
  }, policy);

  const savedRadar = await localRepository.get<unknown>("radarCache", "current").catch(() => null);
  if (savedRadar) document.dispatchEvent(new CustomEvent("wheely-radar-updated", { detail: savedRadar.value }));

  const session = await json<{ connected: boolean }>("/api/auth/session").catch(() => ({ connected: false }));
  if (connectionCard) connectionCard.hidden = session.connected || Boolean(currentSnapshot);
  if (session.connected) coordinator.start();
  else renderFreshness();

  const marketSelect = document.querySelector<HTMLSelectElement>("[data-market-interval]");
  const brokerageSelect = document.querySelector<HTMLSelectElement>("[data-brokerage-interval]");
  if (marketSelect) marketSelect.value = String(policy.marketIntervalMs);
  if (brokerageSelect) brokerageSelect.value = policy.brokerageIntervalMs === null ? policy.refreshBrokerageOnOpen ? "open" : "manual" : String(policy.brokerageIntervalMs);

  const savePolicy = async () => {
    const brokerageValue = brokerageSelect?.value ?? "1800000";
    policy = {
      ...policy,
      marketIntervalMs: Number(marketSelect?.value ?? 120000) as RefreshPolicy["marketIntervalMs"],
      brokerageIntervalMs: /^\d+$/.test(brokerageValue) ? Number(brokerageValue) as RefreshPolicy["brokerageIntervalMs"] : null,
      refreshBrokerageOnOpen: brokerageValue !== "manual",
    };
    await localRepository.put("appSettings", "refreshPolicy", policy);
    coordinator.stop();
    location.reload();
  };
  marketSelect?.addEventListener("change", () => void savePolicy());
  brokerageSelect?.addEventListener("change", () => void savePolicy());

  document.querySelector<HTMLButtonElement>("[data-refresh-brokerage]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    button.textContent = "Syncing…";
    try { await coordinator.refreshBrokerage({ manual: true }); }
    catch { if (brokerageStatus) brokerageStatus.textContent = "Try again in a few minutes"; }
    finally { button.disabled = false; button.textContent = "Refresh brokerage now"; }
  });

  document.querySelector<HTMLButtonElement>("[data-disconnect]")?.addEventListener("click", async () => {
    if (!window.confirm("Disconnect SnapTrade? Your saved snapshot will stay on this device.")) return;
    await json("/api/auth/disconnect", { method: "POST" });
    coordinator.stop();
    location.assign("/");
  });
  document.querySelector<HTMLButtonElement>("[data-erase-local]")?.addEventListener("click", async () => {
    if (!window.confirm("Erase the saved portfolio, market cache, Radar results, and refresh history from this browser?")) return;
    await localRepository.clearFinancialData();
    location.reload();
  });
  window.addEventListener("online", () => {
    renderFreshness();
    void json<{ connected: boolean }>("/api/auth/session").then((current) => { if (current.connected) coordinator.start(); }).catch(() => undefined);
  });
  window.addEventListener("offline", renderFreshness);
  window.setInterval(renderFreshness, 15_000);
  renderFreshness();
}
