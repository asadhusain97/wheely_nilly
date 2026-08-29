import { installLocalFirstFetch } from "./local-first-fetch";
import { registerServiceWorker } from "./pwa";
import { initializeDataRefresh } from "./data-refresh-ui";
import { initializeOnboarding } from "./onboarding";

installLocalFirstFetch();
document.documentElement.dataset.localFirst = "ready";
void registerServiceWorker();
void initializeDataRefresh();
void initializeOnboarding();
