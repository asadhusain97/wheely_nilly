import { localRepository } from "./storage";
import type { BrokerageSnapshot, SafeError, WheelyNillyAccount } from "./types";
import { disconnectAndClearSetup } from "./setup-reset";

interface AccountCatalog {
  accounts: WheelyNillyAccount[];
  errors: Array<{ error: SafeError }>;
}

const steps = ["welcome", "accounts", "tickers", "install"] as const;
const historyKey = (accountId: string) => `historyImported:${accountId}`;
type SyncFailure = { phase: "brokerage" | "history"; status?: number; code?: string } | null;

export const onboardingSyncView = (portfolioReady: boolean, historyReady: boolean, failure: SyncFailure) => {
  if (failure?.phase === "brokerage") return {
    canContinue: false,
    status: "Wheely Nilly could not load positions from this account. Try again or go back and choose another account.",
    tone: "error" as const,
  };
  if (!portfolioReady) return {
    canContinue: false,
    status: "Finding positions in the selected account…",
    tone: "normal" as const,
  };
  if (failure?.phase === "history") return {
    canContinue: true,
    status: "Positions are ready. Trade history did not finish, but it can retry after setup.",
    tone: "warning" as const,
  };
  if (!historyReady) return {
    canContinue: true,
    status: "Positions are ready. Trade history is still loading and can finish after setup.",
    tone: "normal" as const,
  };
  return { canContinue: true, status: "Portfolio and trade history are ready.", tone: "normal" as const };
};

const json = async <T>(path: string, timeoutMs = 58_000): Promise<T> => {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(path, { headers: { accept: "application/json" }, signal: controller.signal });
  } catch (error) {
    if ((error as { name?: string }).name === "AbortError") {
      throw Object.assign(new Error("SnapTrade took too long to return the account list. Try again."), { code: "REQUEST_TIMEOUT" });
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
  const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
  if (!response.ok) {
    throw Object.assign(new Error(payload?.error?.message ?? `Request failed with ${response.status}`), {
      status: response.status,
      code: payload?.error?.code,
    });
  }
  return payload as T;
};

export async function initializeOnboarding(): Promise<void> {
  const root = document.querySelector<HTMLElement>("[data-onboarding]");
  if (!root) return;

  await localRepository.delete("userPreferences", "wheelStyle").catch(() => undefined);
  const [complete, selection] = await Promise.all([
    localRepository.get<boolean>("appSettings", "onboardingComplete").catch(() => null),
    localRepository.get<string[]>("appSettings", "selectedAccountIds").catch(() => null),
  ]);
  let selectedAccountIds = selection?.value ?? [];
  if (complete?.value && selectedAccountIds.length) return;

  const session = await json<{ connected: boolean }>("/api/auth/session", 12_000)
    .catch(() => ({ connected: false }));
  if (!session.connected) return;

  let index = 0;
  let loadingAccounts = false;
  let transitioning = false;
  let portfolioReady = false;
  let historyReady = false;
  let syncFailure: SyncFailure = null;
  const next = root.querySelector<HTMLButtonElement>("[data-onboarding-next]")!;
  const back = root.querySelector<HTMLButtonElement>("[data-onboarding-back]")!;
  const startOver = root.querySelector<HTMLButtonElement>("[data-onboarding-start-over]")!;
  const notice = root.querySelector<HTMLElement>("[data-onboarding-notice]")!;
  const progress = root.querySelector<HTMLElement>("[data-onboarding-progress]")!;
  const tickerList = root.querySelector<HTMLElement>("[data-onboarding-tickers]")!;
  const syncStatus = root.querySelector<HTMLElement>("[data-onboarding-sync-status]")!;
  const syncActions = root.querySelector<HTMLElement>("[data-onboarding-sync-actions]")!;
  const retrySync = root.querySelector<HTMLButtonElement>("[data-onboarding-retry]")!;
  const reconnectSync = root.querySelector<HTMLAnchorElement>("[data-onboarding-reconnect]")!;
  const accountList = root.querySelector<HTMLElement>("[data-onboarding-accounts]")!;
  const installCopy = root.querySelector<HTMLElement>("[data-onboarding-install-copy]")!;
  const installSteps = root.querySelector<HTMLOListElement>("[data-onboarding-install-steps]")!;

  const showNotice = (message: string | null) => {
    notice.hidden = !message;
    notice.textContent = message ?? "";
  };

  const chosenAccountId = () => accountList.querySelector<HTMLInputElement>('input[name="brokerage-account"]:checked')?.value ?? null;
  const selectedSnapshot = (snapshot: BrokerageSnapshot | null) => Boolean(snapshot
    && selectedAccountIds.length === 1
    && snapshot.accounts.some((account) => account.id === selectedAccountIds[0]));
  const renderSyncStatus = () => {
    const view = onboardingSyncView(portfolioReady, historyReady, syncFailure);
    const authorizationExpired = syncFailure?.status === 401 || syncFailure?.code === "AUTH_REQUIRED";
    syncStatus.classList.toggle("is-error", view.tone === "error");
    syncStatus.classList.toggle("is-warning", view.tone === "warning");
    syncStatus.textContent = view.status;
    syncActions.hidden = !syncFailure;
    retrySync.hidden = !syncFailure;
    reconnectSync.hidden = !authorizationExpired;
  };
  const updateNext = () => {
    const step = steps[index];
    const syncView = onboardingSyncView(portfolioReady, historyReady, syncFailure);
    next.disabled = transitioning || (step === "accounts"
      ? loadingAccounts || !chosenAccountId()
      : step === "tickers"
        ? !syncView.canContinue
        : false);
    back.disabled = transitioning;
    startOver.disabled = transitioning;
    next.textContent = step === "install"
      ? "Open Home"
      : step === "tickers" && syncFailure?.phase === "brokerage"
        ? "Retry required"
      : step === "tickers" && !syncView.canContinue
        ? "Finding positions…"
        : "Continue";
  };
  const renderTickers = (snapshot: BrokerageSnapshot | null) => {
    const symbols = [...new Set((snapshot?.positions ?? [])
      .map((position) => position.option?.underlying ?? position.symbol)
      .filter(Boolean))].sort();
    tickerList.replaceChildren(...(symbols.length
      ? symbols.map((symbol) => Object.assign(document.createElement("span"), { textContent: symbol }))
      : [Object.assign(document.createElement("span"), {
        textContent: portfolioReady ? "No positions found in this account." : "Checking the selected account…",
      })]));
  };

  const saved = await localRepository.get<BrokerageSnapshot>("portfolioSnapshot", "current").catch(() => null);
  if (selectedSnapshot(saved?.value ?? null)) {
    portfolioReady = true;
    historyReady = Boolean((await localRepository.get<unknown>("refreshMetadata", historyKey(selectedAccountIds[0])).catch(() => null))?.value);
  }
  renderTickers(portfolioReady ? saved?.value ?? null : null);
  renderSyncStatus();

  document.addEventListener("wheely-brokerage-updated", (event) => {
    const snapshot = (event as CustomEvent<BrokerageSnapshot>).detail;
    if (!selectedSnapshot(snapshot)) return;
    portfolioReady = true;
    if (syncFailure?.phase === "brokerage") syncFailure = null;
    renderTickers(snapshot);
    renderSyncStatus();
    updateNext();
  });
  document.addEventListener("wheely-history-updated", () => {
    historyReady = true;
    if (syncFailure?.phase === "history") syncFailure = null;
    renderSyncStatus();
    updateNext();
  });
  document.addEventListener("wheely-refresh-error", (event) => {
    const detail = (event as CustomEvent<{ slice?: string; phase?: string; error?: { status?: number; code?: string } }>).detail;
    if (detail?.slice !== "brokerage") return;
    syncFailure = {
      phase: detail.phase === "history" ? "history" : "brokerage",
      status: detail.error?.status,
      code: detail.error?.code,
    };
    if (syncFailure.phase === "brokerage") {
      tickerList.replaceChildren(Object.assign(document.createElement("span"), { textContent: "Positions could not be loaded." }));
    }
    renderSyncStatus();
    updateNext();
  });

  const render = () => {
    root.querySelectorAll<HTMLElement>("[data-onboarding-step]").forEach((node) => {
      node.hidden = node.dataset.onboardingStep !== steps[index];
    });
    progress.textContent = `${index + 1} of ${steps.length}`;
    back.hidden = index === 0;
    updateNext();
  };
  const finish = async () => {
    await localRepository.put("appSettings", "onboardingComplete", true);
    root.hidden = true;
    document.body.classList.remove("has-modal");
    document.querySelector<HTMLButtonElement>('.bottom-nav button[data-target="overview"]')?.click();
  };

  const loadAccounts = async (): Promise<void> => {
    if (loadingAccounts) return;
    loadingAccounts = true;
    showNotice(null);
    accountList.replaceChildren(Object.assign(document.createElement("p"), { textContent: "Checking SnapTrade for accounts… The first connection can take up to a minute." }));
    updateNext();
    try {
      const catalog = await json<AccountCatalog>("/api/brokerage/accounts");
      if (!catalog.accounts.length) {
        throw Object.assign(new Error("No brokerage accounts were returned. Connect Robinhood in SnapTrade, then try again."), { code: "NO_ACCOUNTS" });
      }
      const choices = catalog.accounts.map((account) => {
        const input = document.createElement("input");
        input.type = "radio";
        input.name = "brokerage-account";
        input.value = account.id;
        input.checked = selectedAccountIds.includes(account.id);
        input.addEventListener("change", updateNext);

        const title = Object.assign(document.createElement("strong"), {
          textContent: account.name ?? account.institution ?? "Brokerage account",
        });
        const detail = Object.assign(document.createElement("small"), {
          textContent: account.institution,
        });
        const accountNumber = Object.assign(document.createElement("em"), {
          className: "onboarding-account-number",
          textContent: account.referenceLabel,
        });
        const text = document.createElement("span");
        text.append(title, accountNumber, detail);
        const label = document.createElement("label");
        label.append(input, text);
        return label;
      });
      accountList.replaceChildren(...choices);
    } catch (error) {
      const requestError = error as { status?: number; code?: string; message?: string };
      const authorizationExpired = requestError.status === 401 || requestError.code === "AUTH_REQUIRED";
      const message = authorizationExpired
        ? "SnapTrade could not confirm access. Try again once, then reconnect if it still fails."
        : !navigator.onLine
          ? "You’re offline. Reconnect, then try again."
        : error instanceof Error
          ? error.message
          : "SnapTrade is connected, but Wheely Nilly could not read the account list yet.";
      const copy = Object.assign(document.createElement("p"), { textContent: message });
      const actions = Object.assign(document.createElement("div"), { className: "onboarding-account-actions" });
      const retry = Object.assign(document.createElement("button"), { type: "button", textContent: "Try again" });
      retry.addEventListener("click", () => void loadAccounts());
      actions.append(retry);
      if (authorizationExpired) {
        actions.append(Object.assign(document.createElement("a"), {
          href: "/api/auth/start?returnTo=/app",
          textContent: "Reconnect SnapTrade",
        }));
      } else {
        const dashboard = Object.assign(document.createElement("a"), {
          href: "https://dashboard.snaptrade.com",
          target: "_blank",
          rel: "noreferrer",
          textContent: "Open SnapTrade",
        });
        actions.append(dashboard);
      }
      accountList.replaceChildren(copy, actions);
    } finally {
      loadingAccounts = false;
      updateNext();
    }
  };

  const isAppleMobile = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/.test(navigator.userAgent);
  if (isAppleMobile) {
    installCopy.textContent = "Install from Safari so Wheely Nilly can open from your home screen with its saved snapshot.";
    installSteps.innerHTML = "<li><span>Open this page in Safari.</span></li><li><span>Tap <strong>Share</strong>.</span></li><li><span>Choose <strong>Add to Home Screen</strong>, then tap <strong>Add</strong>.</span></li>";
  } else if (isAndroid) {
    installCopy.textContent = "Install from Chrome so Wheely Nilly can open from your home screen with its saved snapshot.";
    installSteps.innerHTML = "<li><span>Open Chrome's menu.</span></li><li><span>Choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.</span></li><li><span>Tap <strong>Install</strong>.</span></li>";
  }

  next.addEventListener("click", async () => {
    if (transitioning) return;
    transitioning = true;
    showNotice(null);
    updateNext();
    try {
      if (steps[index] === "accounts") {
        const accountId = chosenAccountId();
        if (!accountId) return;
        selectedAccountIds = [accountId];
        portfolioReady = false;
        historyReady = false;
        syncFailure = null;
        renderTickers(null);
        renderSyncStatus();
        await localRepository.put("appSettings", "selectedAccountIds", selectedAccountIds);
        document.dispatchEvent(new CustomEvent("wheely-account-selection-changed", { detail: { accountIds: selectedAccountIds } }));
      }
      if (index === steps.length - 1) await finish();
      else index += 1;
    } catch {
      showNotice("This browser could not save setup. Allow site storage, close other Wheely Nilly tabs, leave private browsing if needed, then try again.");
    } finally {
      transitioning = false;
      render();
    }
  });
  back.addEventListener("click", () => {
    if (transitioning) return;
    showNotice(null);
    index = Math.max(0, index - 1);
    render();
  });
  startOver.addEventListener("click", async () => {
    if (transitioning || !window.confirm("Start over? This disconnects SnapTrade and clears all Wheely Nilly data and settings saved in this browser.")) return;
    transitioning = true;
    showNotice("Disconnecting SnapTrade and clearing this browser…");
    updateNext();
    try {
      await disconnectAndClearSetup();
      location.assign("/?setup=restarted");
    } catch {
      transitioning = false;
      showNotice(navigator.onLine
        ? "The connection could not be restarted. Try again in a moment."
        : "You’re offline. Reconnect, then try again.");
      updateNext();
    }
  });
  retrySync.addEventListener("click", () => {
    const phase = syncFailure?.phase ?? "brokerage";
    syncFailure = null;
    if (phase === "brokerage") renderTickers(null);
    renderSyncStatus();
    updateNext();
    document.dispatchEvent(new CustomEvent("wheely-brokerage-retry-requested", { detail: { phase } }));
  });
  root.hidden = false;
  document.body.classList.add("has-modal");
  render();
  void loadAccounts();
}
