import { localRepository } from "./storage";
import type { BrokerageSnapshot, SafeError, WheelyNillyAccount } from "./types";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

interface AccountCatalog {
  accounts: WheelyNillyAccount[];
  errors: Array<{ error: SafeError }>;
}

const steps = ["welcome", "accounts", "tickers", "install"] as const;

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
  const selectedAccountIds = selection?.value ?? [];
  if (complete?.value && selectedAccountIds.length) return;

  const session = await fetch("/api/auth/session", { headers: { accept: "application/json" } })
    .then((response) => response.ok ? response.json() as Promise<{ connected: boolean }> : { connected: false })
    .catch(() => ({ connected: false }));
  if (!session.connected) return;

  let index = 0;
  let installPrompt: BeforeInstallPromptEvent | null = null;
  let loadingAccounts = false;
  const next = root.querySelector<HTMLButtonElement>("[data-onboarding-next]")!;
  const back = root.querySelector<HTMLButtonElement>("[data-onboarding-back]")!;
  const progress = root.querySelector<HTMLElement>("[data-onboarding-progress]")!;
  const tickerList = root.querySelector<HTMLElement>("[data-onboarding-tickers]")!;
  const accountList = root.querySelector<HTMLElement>("[data-onboarding-accounts]")!;
  const installButton = root.querySelector<HTMLButtonElement>("[data-onboarding-install]")!;
  const installCopy = root.querySelector<HTMLElement>("[data-onboarding-install-copy]")!;

  const chosenAccountId = () => accountList.querySelector<HTMLInputElement>('input[name="brokerage-account"]:checked')?.value ?? null;
  const updateNext = () => {
    next.disabled = steps[index] === "accounts" && (loadingAccounts || !chosenAccountId());
  };
  const renderTickers = (snapshot: BrokerageSnapshot | null) => {
    const symbols = [...new Set((snapshot?.positions ?? [])
      .map((position) => position.option?.underlying ?? position.symbol)
      .filter(Boolean))].sort();
    tickerList.replaceChildren(...(symbols.length
      ? symbols.map((symbol) => Object.assign(document.createElement("span"), { textContent: symbol }))
      : [Object.assign(document.createElement("span"), { textContent: "Waiting for the selected account to align…" })]));
  };
  const saved = await localRepository.get<BrokerageSnapshot>("portfolioSnapshot", "current").catch(() => null);
  renderTickers(saved?.value ?? null);
  document.addEventListener("wheely-brokerage-updated", (event) => {
    renderTickers((event as CustomEvent<BrokerageSnapshot>).detail);
  });

  const render = () => {
    root.querySelectorAll<HTMLElement>("[data-onboarding-step]").forEach((node) => {
      node.hidden = node.dataset.onboardingStep !== steps[index];
    });
    progress.textContent = `${index + 1} of ${steps.length}`;
    back.hidden = index === 0;
    next.textContent = index === steps.length - 1 ? "Open Radar" : "Continue";
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
        const parts = [account.institution, account.numberSuffix ? `•••• ${account.numberSuffix}` : null].filter(Boolean);
        const detail = Object.assign(document.createElement("small"), {
          textContent: parts.join(" · ") || "SnapTrade account",
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

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event as BeforeInstallPromptEvent;
    installButton.hidden = false;
  });
  installButton.addEventListener("click", async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    installButton.hidden = true;
  });
  if (/iPad|iPhone|iPod/.test(navigator.userAgent) && !matchMedia("(display-mode: standalone)").matches) {
    installCopy.textContent = "In Safari, tap Share, then Add to Home Screen. Your saved portfolio will open even when you are offline.";
  }
  next.addEventListener("click", async () => {
    if (steps[index] === "accounts") {
      const accountId = chosenAccountId();
      if (!accountId) return;
      await localRepository.put("appSettings", "selectedAccountIds", [accountId]);
      document.dispatchEvent(new CustomEvent("wheely-account-selection-changed", { detail: { accountIds: [accountId] } }));
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
