import { registerServiceWorker } from "./pwa";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let installPrompt: BeforeInstallPromptEvent | null = null;
const installButton = document.querySelector<HTMLButtonElement>("[data-install]");
const openApp = document.querySelector<HTMLAnchorElement>("[data-open-app]");
const installCopy = document.querySelector<HTMLElement>("[data-install-copy]");

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event as BeforeInstallPromptEvent;
  if (installButton) installButton.hidden = false;
  if (openApp) openApp.hidden = true;
});

installButton?.addEventListener("click", async () => {
  if (!installPrompt) return;
  await installPrompt.prompt();
  const choice = await installPrompt.userChoice;
  if (choice.outcome === "accepted") {
    installButton.hidden = true;
    if (openApp) openApp.hidden = false;
  }
  installPrompt = null;
});

const appleMobile = /iPad|iPhone|iPod/.test(navigator.userAgent);
if (appleMobile && !window.matchMedia("(display-mode: standalone)").matches && installCopy) {
  installCopy.textContent = "In Safari, tap Share, then Add to Home Screen. Your latest saved view remains available offline.";
}

window.setTimeout(() => {
  const status = document.querySelector<HTMLElement>("[data-market-status]");
  if (status) status.textContent = "Updated just now";
  document.querySelector(".status-dot.is-market")?.classList.remove("is-market");
}, 1600);

void registerServiceWorker();
