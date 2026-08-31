import { installLocalFirstFetch } from "./local-first-fetch";
import { registerServiceWorker } from "./pwa";
import { initializeDataRefresh } from "./data-refresh-ui";
import { initializeOnboarding } from "./onboarding";
import { startApp } from "./startup-order";

installLocalFirstFetch();
document.documentElement.dataset.localFirst = "ready";
void registerServiceWorker();
void startApp(initializeDataRefresh, initializeOnboarding).catch(() => {
  const alert = document.querySelector<HTMLElement>("[data-brokerage-alert]");
  const title = document.querySelector<HTMLElement>("[data-brokerage-alert-title]");
  const copy = document.querySelector<HTMLElement>("[data-brokerage-alert-copy]");
  const retry = document.querySelector<HTMLButtonElement>("[data-retry-alignment]");
  if (alert) alert.hidden = false;
  if (title) title.textContent = "Setup could not start.";
  if (copy) copy.textContent = "Reload this page. If it happens again, allow site storage and close other Wheely Nilly tabs.";
  if (retry) {
    retry.hidden = false;
    retry.textContent = "Reload";
    retry.addEventListener("click", () => location.reload(), { once: true });
  }
});
