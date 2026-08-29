import { localRepository } from "./storage";
import type { BrokerageSnapshot, SafeError, WheelyNillyAccount } from "./types";

interface AccountCatalog {
  accounts: WheelyNillyAccount[];
  errors: Array<{ error: SafeError }>;
}

const steps = ["welcome", "accounts", "tickers", "install"] as const;
const historyKey = (accountId: string) => `historyImported:${accountId}`;

const json = async <T>(path: string): Promise<T> => {
  const response = await fetch(path, { headers: { accept: "application/json" } });
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

  const session = await fetch("/api/auth/session", { headers: { accept: "application/json" } })
    .then((response) => response.ok ? response.json() as Promise<{ connected: boolean }> : { connected: false })
    .catch(() => ({ connected: false }));
  if (!session.connected) return;

  let index = 0;
  let loadingAccounts = false;
  let portfolioReady = false;
  let historyReady = false;
  let syncFailed = false;
  const next = root.querySelector<HTMLButtonElement>("[data-onboarding-next]")!;
  const back = root.querySelector<HTMLButtonElement>("[data-onboarding-back]")!;
  const progress = root.querySelector<HTMLElement>("[data-onboarding-progress]")!;
  const tickerList = root.querySelector<HTMLElement>("[data-onboarding-tickers]")!;
  const syncStatus = root.querySelector<HTMLElement>("[data-onboarding-sync-status]")!;
  const accountList = root.querySelector<HTMLElement>("[data-onboarding-accounts]")!;
  const installCopy = root.querySelector<HTMLElement>("[data-onboarding-install-copy]")!;
  const installSteps = root.querySelector<HTMLOListElement>("[data-onboarding-install-steps]")!;

  const chosenAccountId = () => accountList.querySelector<HTMLInputElement>('input[name="brokerage-account"]:checked')?.value ?? null;
  const selectedSnapshot = (snapshot: BrokerageSnapshot | null) => Boolean(snapshot
    && selectedAccountIds.length === 1
    && snapshot.accounts.some((account) => account.id === selectedAccountIds[0]));
  const renderSyncStatus = () => {
    syncStatus.classList.toggle("is-error", syncFailed);
    syncStatus.textContent = syncFailed
      ? "The account did not finish loading. Go back and try this account again."
      : !portfolioReady
        ? "Finding positions in the selected account…"
        : !historyReady
          ? "Positions found. Loading trade history and booked results…"
          : "Portfolio and trade history are ready.";
  };
  const updateNext = () => {
    const step = steps[index];
    next.disabled = step === "accounts"
      ? loadingAccounts || !chosenAccountId()
      : step === "tickers"
        ? !portfolioReady || !historyReady || syncFailed
        : false;
    next.textContent = step === "install"
      ? "Open Radar"
      : step === "tickers" && !portfolioReady
        ? "Finding positions…"
        : step === "tickers" && !historyReady
          ? "Loading history…"
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
    syncFailed = false;
    renderTickers(snapshot);
    renderSyncStatus();
    updateNext();
  });
  document.addEventListener("wheely-history-updated", () => {
    historyReady = true;
    syncFailed = false;
    renderSyncStatus();
    updateNext();
  });
  document.addEventListener("wheely-refresh-error", (event) => {
    const detail = (event as CustomEvent<{ slice?: string }>).detail;
    if (detail?.slice !== "brokerage") return;
    syncFailed = true;
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
    document.querySelector<HTMLButtonElement>('.bottom-nav button[data-target="screener"]')?.click();
  };

  const loadAccounts = async (): Promise<void> => {
    loadingAccounts = true;
    accountList.replaceChildren(Object.assign(document.createElement("p"), { textContent: "Checking SnapTrade for accounts…" }));
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
          textContent: [account.institution, account.referenceLabel].filter(Boolean).join(" · "),
        });
        const text = document.createElement("span");
        text.append(title, detail);
        const label = document.createElement("label");
        label.append(input, text);
        return label;
      });
      accountList.replaceChildren(...choices);
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "SnapTrade is connected, but Wheely Nilly could not read the account list yet.";
      const copy = Object.assign(document.createElement("p"), { textContent: message });
      const actions = Object.assign(document.createElement("div"), { className: "onboarding-account-actions" });
      const retry = Object.assign(document.createElement("button"), { type: "button", textContent: "Try again" });
      const dashboard = Object.assign(document.createElement("a"), {
        href: "https://dashboard.snaptrade.com",
        target: "_blank",
        rel: "noreferrer",
        textContent: "Open SnapTrade",
      });
      retry.addEventListener("click", () => void loadAccounts());
      actions.append(retry, dashboard);
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
    installSteps.innerHTML = "<li>Open this page in Safari.</li><li>Tap <strong>Share</strong>.</li><li>Choose <strong>Add to Home Screen</strong>, then tap <strong>Add</strong>.</li>";
  } else if (isAndroid) {
    installCopy.textContent = "Install from Chrome so Wheely Nilly can open from your home screen with its saved snapshot.";
    installSteps.innerHTML = "<li>Open Chrome's menu.</li><li>Choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.</li><li>Tap <strong>Install</strong>.</li>";
  }

  next.addEventListener("click", async () => {
    if (steps[index] === "accounts") {
      const accountId = chosenAccountId();
      if (!accountId) return;
      selectedAccountIds = [accountId];
      portfolioReady = false;
      historyReady = false;
      syncFailed = false;
      renderTickers(null);
      renderSyncStatus();
      await localRepository.put("appSettings", "selectedAccountIds", selectedAccountIds);
      document.dispatchEvent(new CustomEvent("wheely-account-selection-changed", { detail: { accountIds: selectedAccountIds } }));
    }
    if (index === steps.length - 1) await finish();
    else {
      index += 1;
      render();
    }
  });
  back.addEventListener("click", () => {
    index = Math.max(0, index - 1);
    render();
  });
  root.hidden = false;
  document.body.classList.add("has-modal");
  render();
  void loadAccounts();
}
