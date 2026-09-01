import { RefreshCoordinator, DEFAULT_REFRESH_POLICY } from "./refresh-coordinator";
import { localRepository } from "./storage";
import type { BrokerageEvent, BrokerageSnapshot, ExactContractQuote, MarketCache, MarketQuote, PortfolioDiff, RefreshPolicy } from "./types";
import { buildLocalCloseResults, buildLocalTargets, scanAllLocalTargets } from "./local-analysis";
import { clearBrowserSetup, disconnectAndClearSetup } from "./setup-reset";

const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, { ...init, headers: { accept: "application/json", ...(init?.headers ?? {}) } });
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
  if (!response.ok) {
    throw Object.assign(new Error(payload?.error?.message ?? `Request failed with ${response.status}`), {
      status: response.status,
      code: payload?.error?.code,
    });
  }
  return payload as T;
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
const contractKey = (item: ExactContractQuote): string => item.contract.contract_symbol;
const usableContractQuote = (item: ExactContractQuote): boolean => item.available === true
  && typeof item.ask === "number"
  && Number.isFinite(item.ask)
  && item.ask > 0;

export const mergeMarketCache = (
  existing: Partial<MarketCache> | null | undefined,
  incomingQuotes: MarketQuote[],
  incomingContracts: ExactContractQuote[],
  activeContractSymbols?: string[],
): MarketCache => {
  const active = activeContractSymbols ? new Set(activeContractSymbols) : null;
  const keepActive = (item: ExactContractQuote) => !active || active.has(contractKey(item));
  const contracts = [...new Map([...(existing?.contracts ?? []), ...incomingContracts]
    .map((item) => [contractKey(item), item])).values()].filter(keepActive);
  const lastUsableContracts = [...new Map([
    ...(existing?.lastUsableContracts ?? []),
    ...(existing?.contracts ?? []).filter(usableContractQuote),
    ...incomingContracts.filter(usableContractQuote),
  ].map((item) => [contractKey(item), item])).values()].filter(keepActive);
  return {
    quotes: [...new Map([...(existing?.quotes ?? []), ...incomingQuotes].map((quote) => [quote.symbol, quote])).values()],
    contracts,
    lastUsableContracts,
  };
};

const HISTORY_REFRESH_INTERVAL_MS = 24 * 60 * 60_000;
export const HISTORY_IMPORT_VERSION = 3;
export const historyImportKey = (accountId: string) => `historyImported:${accountId}`;
export const historyImportIsDue = (value: unknown, now = Date.now()): boolean => {
  if (!value || typeof value !== "object") return true;
  const marker = value as { version?: unknown; completedAt?: unknown };
  if (marker.version !== HISTORY_IMPORT_VERSION) return true;
  const completedAt = Date.parse(String(marker.completedAt ?? ""));
  return !Number.isFinite(completedAt) || now - completedAt >= HISTORY_REFRESH_INTERVAL_MS;
};

const mergeEventLedger = async (events: BrokerageEvent[]): Promise<void> => {
  const existing = (await localRepository.get<BrokerageEvent[]>("eventLedger", "all").catch(() => null))?.value ?? [];
  const merged = [...new Map([...existing, ...events].map((event) => [event.id, event])).values()]
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id));
  await localRepository.put("eventLedger", "all", merged);
};

export async function initializeDataRefresh(): Promise<void> {
  let currentSnapshot = (await localRepository.get<BrokerageSnapshot>("portfolioSnapshot", "current").catch(() => null))?.value ?? null;
  let selectedAccountIds = (await localRepository.get<string[]>("appSettings", "selectedAccountIds").catch(() => null))?.value ?? [];
  const storedPolicy = (await localRepository.get<RefreshPolicy>("appSettings", "refreshPolicy").catch(() => null))?.value;
  const policy = storedPolicy ?? DEFAULT_REFRESH_POLICY;
  let marketUpdatedAt = (await localRepository.get<string>("refreshMetadata", "marketUpdatedAt").catch(() => null))?.value ?? null;
  let brokerageUpdatedAt = currentSnapshot?.fetchedAt ?? null;
  const savedSnapshotMatchesSelection = Boolean(currentSnapshot
    && selectedAccountIds.length
    && selectedAccountIds.every((accountId) => currentSnapshot?.accounts.some((account) => account.id === accountId)));
  if (currentSnapshot && !savedSnapshotMatchesSelection) {
    await localRepository.clearFinancialData().catch(() => undefined);
    currentSnapshot = null;
    marketUpdatedAt = null;
    brokerageUpdatedAt = null;
  }
  let retryMode: "brokerage" | "history" = "brokerage";
  let historyRetryTimer: number | null = null;

  const marketStatus = document.querySelector<HTMLElement>("[data-market-freshness]");
  const brokerageStatus = document.querySelector<HTMLElement>("[data-brokerage-freshness]");
  const connectionCard = document.querySelector<HTMLElement>("[data-connection-card]");
  const brokerageAlert = document.querySelector<HTMLElement>("[data-brokerage-alert]");
  const brokerageAlertEyebrow = document.querySelector<HTMLElement>("[data-brokerage-alert-eyebrow]");
  const brokerageAlertTitle = document.querySelector<HTMLElement>("[data-brokerage-alert-title]");
  const brokerageAlertCopy = document.querySelector<HTMLElement>("[data-brokerage-alert-copy]");
  const retryAlignment = document.querySelector<HTMLButtonElement>("[data-retry-alignment]");
  const reconnectAlignment = document.querySelector<HTMLAnchorElement>("[data-reconnect-alignment]");
  const brokerageContent = document.querySelector<HTMLElement>("[data-brokerage-content]");

  const showBrokerageContent = (visible: boolean) => {
    if (brokerageContent) brokerageContent.hidden = !visible;
  };
  const hideBrokerageAlert = () => {
    if (brokerageAlert) brokerageAlert.hidden = true;
    if (retryAlignment) retryAlignment.hidden = true;
    if (reconnectAlignment) reconnectAlignment.hidden = true;
  };
  const showBrokerageAlignment = (state: "reading" | "history" | "error", error?: unknown) => {
    if (!brokerageAlert) return;
    brokerageAlert.hidden = false;
    if (brokerageAlertEyebrow) brokerageAlertEyebrow.textContent = "Brokerage alignment";
    if (state === "reading") {
      retryMode = "brokerage";
      if (brokerageAlertTitle) brokerageAlertTitle.textContent = "Reading your selected account…";
      if (brokerageAlertCopy) brokerageAlertCopy.textContent = currentSnapshot
        ? "Your saved view remains available while SnapTrade responds."
        : "This can take a moment. Portfolio data will appear as soon as SnapTrade responds.";
      if (retryAlignment) retryAlignment.hidden = true;
      if (reconnectAlignment) reconnectAlignment.hidden = true;
      return;
    }
    if (state === "history") {
      retryMode = "history";
      if (brokerageAlertTitle) brokerageAlertTitle.textContent = "Positions found. Loading trade history…";
      if (brokerageAlertCopy) brokerageAlertCopy.textContent = "Booked profit, past trades, and opening contract details will appear when this finishes.";
      if (retryAlignment) retryAlignment.hidden = true;
      if (reconnectAlignment) reconnectAlignment.hidden = true;
      return;
    }
    const requestError = error as { status?: number; code?: string; message?: string };
    const historyFailure = (requestError as { phase?: string }).phase === "history";
    retryMode = historyFailure ? "history" : "brokerage";
    if (brokerageAlertTitle) brokerageAlertTitle.textContent = historyFailure
      ? "Positions loaded, but trade history did not."
      : "We couldn’t align this account.";
    if (brokerageAlertCopy) brokerageAlertCopy.textContent = historyFailure
      ? "Booked results and opening contract details are incomplete. Try the history import again."
      : requestError.status === 401
        ? "SnapTrade could not confirm access. Your saved view is unchanged. Try again once, then reconnect if it still fails."
        : requestError.status === 409
          ? "Choose an available brokerage account to continue."
          : "SnapTrade is connected, but Wheely Nilly could not read the selected account. Your saved view is unchanged.";
    const authorizationExpired = requestError.status === 401;
    if (retryAlignment) retryAlignment.hidden = false;
    if (reconnectAlignment) reconnectAlignment.hidden = !authorizationExpired;
  };

  showBrokerageContent(Boolean(currentSnapshot));

  const renderFreshness = () => {
    if (marketStatus) marketStatus.textContent = marketUpdatedAt ? relativeTime(marketUpdatedAt) : navigator.onLine ? "Waiting" : "Saved";
    if (brokerageStatus) brokerageStatus.textContent = brokerageUpdatedAt ? relativeTime(brokerageUpdatedAt) : "Not synced";
  };

  const fetchMarket = async (symbols: string[], contracts = optionContracts(currentSnapshot), signal?: AbortSignal) => {
    const [quotesResult, contractsResult] = await Promise.all([
      symbols.length ? json<{ quotes: MarketQuote[] }>("/api/market/quotes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbols }), signal }) : { quotes: [] },
      contracts.length ? json<{ results: ExactContractQuote[] }>("/api/market/contracts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ contracts: contracts.map((contract) => ({ contract_symbol: contract.symbol, symbol: contract.underlying, option_type: contract.optionType, expiration: contract.expiration, strike: contract.strike })) }), signal }) : { results: [] },
    ]);
    const existing = (await localRepository.get<MarketCache>("marketCache", "current").catch(() => null))?.value;
    const merged = mergeMarketCache(
      existing,
      quotesResult.quotes,
      contractsResult.results ?? [],
      optionContracts(currentSnapshot).map((contract) => contract.symbol),
    );
    marketUpdatedAt = new Date().toISOString();
    await Promise.all([
      localRepository.put("marketCache", "current", merged),
      localRepository.put("refreshMetadata", "marketUpdatedAt", marketUpdatedAt),
    ]);
    const closeResults = await buildLocalCloseResults(merged.contracts, merged.lastUsableContracts);
    await localRepository.put("marketCache", "closeResults", closeResults);
    const radar = await scanAllLocalTargets(fetch).catch(() => null);
    if (radar) {
      await localRepository.put("radarCache", "current", radar);
      document.dispatchEvent(new CustomEvent("wheely-radar-updated", { detail: radar }));
    }
    renderFreshness();
    document.dispatchEvent(new CustomEvent("wheely-market-updated", { detail: merged }));
  };

  let historyRequest: Promise<void> | null = null;
  const importHistory = (snapshot: BrokerageSnapshot): Promise<void> => {
    if (historyRequest) return historyRequest;
    historyRequest = (async () => {
      const importStates = await Promise.all(snapshot.accounts.map((account) => localRepository
        .get<unknown>("refreshMetadata", historyImportKey(account.id))
        .catch(() => null)));
      const accountsDue = snapshot.accounts.filter((_, index) => historyImportIsDue(importStates[index]?.value));
      if (!accountsDue.length) {
        hideBrokerageAlert();
        document.dispatchEvent(new CustomEvent("wheely-history-updated"));
        return;
      }
      showBrokerageAlignment("history");
      document.dispatchEvent(new CustomEvent("wheely-history-loading"));
      let transactionSyncPending = false;
      for (const account of accountsDue) {
        const events: BrokerageEvent[] = [];
        let cursor: string | null = null;
        do {
          const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : `?accountId=${encodeURIComponent(account.id)}`;
          const page: { events: BrokerageEvent[]; nextCursor: string | null } = await json(`/api/brokerage/history${suffix}`);
          events.push(...page.events);
          cursor = page.nextCursor;
        } while (cursor);
        const deduped = [...new Map(events.map((event) => [event.id, event])).values()];
        await mergeEventLedger(deduped);
        if (account.transactionSyncComplete === false) {
          transactionSyncPending = true;
          continue;
        }
        await localRepository.put("refreshMetadata", historyImportKey(account.id), {
          version: HISTORY_IMPORT_VERSION,
          completedAt: new Date().toISOString(),
        });
      }
      if (transactionSyncPending) {
        if (historyRetryTimer === null) {
          historyRetryTimer = window.setTimeout(() => {
            historyRetryTimer = null;
            void coordinator.refreshBrokerage().catch(() => undefined);
          }, 30_000);
        }
        return;
      }
      if (historyRetryTimer !== null) {
        window.clearTimeout(historyRetryTimer);
        historyRetryTimer = null;
      }
      hideBrokerageAlert();
      document.dispatchEvent(new CustomEvent("wheely-history-updated"));
    })().catch((error) => {
      Object.assign(error as object, { phase: "history" });
      showBrokerageAlignment("error", error);
      if (brokerageStatus) brokerageStatus.textContent = "History update failed · positions saved";
      document.dispatchEvent(new CustomEvent("wheely-refresh-error", { detail: { slice: "brokerage", phase: "history", error } }));
      throw error;
    }).finally(() => {
      historyRequest = null;
    });
    return historyRequest;
  };

  const coordinator = new RefreshCoordinator({
    document,
    readPortfolio: () => currentSnapshot,
    writePortfolio: async (snapshot) => {
      currentSnapshot = snapshot;
      brokerageUpdatedAt = snapshot.fetchedAt;
      await localRepository.put("portfolioSnapshot", "current", snapshot);
      await mergeEventLedger(snapshot.recentOrders ?? []);
      showBrokerageContent(true);
      renderFreshness();
      document.dispatchEvent(new CustomEvent("wheely-brokerage-updated", { detail: snapshot }));
      void importHistory(snapshot).catch(() => undefined);
    },
    refreshBrokerage: (signal) => {
      if (!selectedAccountIds.length) {
        return Promise.reject(Object.assign(new Error("Choose a brokerage account first"), {
          status: 409,
          code: "ACCOUNT_SELECTION_REQUIRED",
        }));
      }
      showBrokerageAlignment("reading");
      return json<BrokerageSnapshot>("/api/brokerage/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountIds: selectedAccountIds }),
        signal,
      });
    },
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
      if (slice === "brokerage") showBrokerageAlignment("error", error);
      document.dispatchEvent(new CustomEvent("wheely-refresh-error", { detail: { slice, error } }));
    },
  }, policy);

  const savedRadar = await localRepository.get<unknown>("radarCache", "current").catch(() => null);
  if (savedRadar) document.dispatchEvent(new CustomEvent("wheely-radar-updated", { detail: savedRadar.value }));

  const sessionController = new AbortController();
  const sessionTimeout = window.setTimeout(() => sessionController.abort(), 12_000);
  const session = await json<{ connected: boolean }>("/api/auth/session", { signal: sessionController.signal })
    .catch(() => ({ connected: false }))
    .finally(() => window.clearTimeout(sessionTimeout));
  if (connectionCard) connectionCard.hidden = session.connected || Boolean(currentSnapshot);
  if (session.connected && selectedAccountIds.length) {
    if (!currentSnapshot) showBrokerageAlignment("reading");
    coordinator.start();
    const snapshotMatchesSelection = currentSnapshot?.accounts.some((account) => selectedAccountIds.includes(account.id));
    if (currentSnapshot && snapshotMatchesSelection) void importHistory(currentSnapshot).catch(() => undefined);
  } else {
    renderFreshness();
  }

  document.addEventListener("wheely-account-selection-changed", async (event) => {
    const accountIds = (event as CustomEvent<{ accountIds?: string[] }>).detail?.accountIds ?? [];
    const nextAccountIds = accountIds.filter((accountId) => typeof accountId === "string" && accountId.length > 0);
    if (!nextAccountIds.length) return;
    const currentAccountIds = currentSnapshot?.accounts.map((account) => account.id) ?? [];
    const sameSnapshot = currentAccountIds.length === nextAccountIds.length
      && currentAccountIds.every((accountId) => nextAccountIds.includes(accountId));
    selectedAccountIds = nextAccountIds;
    if (!sameSnapshot) {
      if (historyRetryTimer !== null) {
        window.clearTimeout(historyRetryTimer);
        historyRetryTimer = null;
      }
      await localRepository.clearFinancialData().catch(() => undefined);
      currentSnapshot = null;
      marketUpdatedAt = null;
      brokerageUpdatedAt = null;
      showBrokerageContent(false);
      renderFreshness();
    }
    showBrokerageAlignment("reading");
    coordinator.start();
    void coordinator.refreshBrokerage().catch(() => undefined);
  });
  document.addEventListener("wheely-brokerage-retry-requested", (event) => {
    const phase = (event as CustomEvent<{ phase?: string }>).detail?.phase;
    if (phase === "history" && currentSnapshot) void importHistory(currentSnapshot).catch(() => undefined);
    else void coordinator.refreshBrokerage().catch(() => undefined);
  });
  retryAlignment?.addEventListener("click", async () => {
    retryAlignment.disabled = true;
    showBrokerageAlignment(retryMode === "history" ? "history" : "reading");
    try {
      if (retryMode === "history" && currentSnapshot) await importHistory(currentSnapshot);
      else await coordinator.refreshBrokerage();
    } catch {
      // The coordinator presents the safe alignment error.
    } finally {
      retryAlignment.disabled = false;
    }
  });

  document.querySelector<HTMLButtonElement>("[data-refresh-brokerage]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const label = button.querySelector<HTMLElement>("span");
    button.disabled = true;
    if (label) label.textContent = "Refreshing…";
    try { await coordinator.refreshBrokerage({ manual: true }); }
    catch { /* The coordinator keeps the saved view and presents the recovery action. */ }
    finally {
      button.disabled = false;
      if (label) label.textContent = "Refresh data";
    }
  });
  const setupStatus = document.querySelector<HTMLElement>("[data-setup-action-status]");
  const showSetupStatus = (message: string | null) => {
    if (!setupStatus) return;
    setupStatus.hidden = !message;
    setupStatus.textContent = message ?? "";
  };
  document.querySelector<HTMLButtonElement>("[data-reset-setup]")?.addEventListener("click", async (event) => {
    if (!window.confirm("Choose another account? This clears saved portfolio data, trade history, Radar results, and strategy choices from this browser. SnapTrade stays connected.")) return;
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    showSetupStatus(null);
    coordinator.stop();
    if (historyRetryTimer !== null) window.clearTimeout(historyRetryTimer);
    try {
      await clearBrowserSetup();
      location.assign("/app");
    } catch {
      button.disabled = false;
      showSetupStatus("This browser could not clear setup. Close other Wheely Nilly tabs, allow site storage, and try again.");
      coordinator.start();
    }
  });
  document.querySelector<HTMLButtonElement>("[data-restart-connection]")?.addEventListener("click", async (event) => {
    if (!window.confirm("Restart the connection? This disconnects SnapTrade and clears all Wheely Nilly data and settings saved in this browser.")) return;
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    showSetupStatus("Disconnecting SnapTrade and clearing this browser…");
    coordinator.stop();
    if (historyRetryTimer !== null) window.clearTimeout(historyRetryTimer);
    try {
      await disconnectAndClearSetup();
      location.assign("/?setup=restarted");
    } catch {
      button.disabled = false;
      showSetupStatus(navigator.onLine
        ? "The connection could not be restarted. Try again in a moment."
        : "You’re offline. Reconnect, then try again.");
      coordinator.start();
    }
  });
  window.addEventListener("online", () => {
    renderFreshness();
    void json<{ connected: boolean }>("/api/auth/session")
      .then((current) => { if (current.connected && selectedAccountIds.length) coordinator.start(); })
      .catch(() => undefined);
  });
  window.addEventListener("offline", renderFreshness);
  window.setInterval(renderFreshness, 15_000);
  renderFreshness();
}
