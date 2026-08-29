import { localRepository } from "./storage";
import type { BrokerageSnapshot } from "./types";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const steps = ["welcome", "preference", "tickers", "install"] as const;

export async function initializeOnboarding(): Promise<void> {
  const root = document.querySelector<HTMLElement>("[data-onboarding]");
  if (!root) return;
  const complete = await localRepository.get<boolean>("appSettings", "onboardingComplete").catch(() => null);
  if (complete?.value) return;
  const session = await fetch("/api/auth/session", { headers: { accept: "application/json" } })
    .then((response) => response.ok ? response.json() as Promise<{ connected: boolean }> : { connected: false })
    .catch(() => ({ connected: false }));
  if (!session.connected) return;

  let index = 0;
  let installPrompt: BeforeInstallPromptEvent | null = null;
  const next = root.querySelector<HTMLButtonElement>("[data-onboarding-next]")!;
  const back = root.querySelector<HTMLButtonElement>("[data-onboarding-back]")!;
  const progress = root.querySelector<HTMLElement>("[data-onboarding-progress]")!;
  const tickerList = root.querySelector<HTMLElement>("[data-onboarding-tickers]")!;
  const installButton = root.querySelector<HTMLButtonElement>("[data-onboarding-install]")!;
  const installCopy = root.querySelector<HTMLElement>("[data-onboarding-install-copy]")!;

  const renderTickers = (snapshot: BrokerageSnapshot | null) => {
    const symbols = [...new Set((snapshot?.positions ?? []).map((position) => position.option?.underlying ?? position.symbol).filter(Boolean))].sort();
    tickerList.replaceChildren(...(symbols.length
      ? symbols.map((symbol) => Object.assign(document.createElement("span"), { textContent: symbol }))
      : [Object.assign(document.createElement("span"), { textContent: "No positions detected yet. Radar will update when brokerage sync finishes." })]));
  };
  const saved = await localRepository.get<BrokerageSnapshot>("portfolioSnapshot", "current").catch(() => null);
  renderTickers(saved?.value ?? null);
  document.addEventListener("wheely-brokerage-updated", (event) => renderTickers((event as CustomEvent<BrokerageSnapshot>).detail));

  const render = () => {
    root.querySelectorAll<HTMLElement>("[data-onboarding-step]").forEach((node) => { node.hidden = node.dataset.onboardingStep !== steps[index]; });
    progress.textContent = `${index + 1} of ${steps.length}`;
    back.hidden = index === 0;
    next.textContent = index === steps.length - 1 ? "Open Radar" : "Continue";
  };
  const finish = async () => {
    const style = root.querySelector<HTMLInputElement>('input[name="wheel-style"]:checked')?.value ?? "balanced";
    await Promise.all([
      localRepository.put("userPreferences", "wheelStyle", style),
      localRepository.put("appSettings", "onboardingComplete", true),
    ]);
    root.hidden = true;
    document.body.classList.remove("has-modal");
    document.querySelector<HTMLButtonElement>('.bottom-nav button[data-target="screener"]')?.click();
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
  next.addEventListener("click", () => { if (index === steps.length - 1) void finish(); else { index += 1; render(); } });
  back.addEventListener("click", () => { index = Math.max(0, index - 1); render(); });
  root.hidden = false;
  document.body.classList.add("has-modal");
  render();
}
