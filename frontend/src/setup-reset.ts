import { localRepository } from "./storage";

const LEGACY_KEYS = [
  "wheely-nilly.screened-tickers.v1",
  "wheely-nilly.radar-scan-results.v1",
] as const;

export async function clearBrowserSetup(): Promise<void> {
  await localRepository.clearAllData();
  for (const key of LEGACY_KEYS) globalThis.localStorage?.removeItem(key);
}

export async function disconnectAndClearSetup(): Promise<void> {
  const response = await fetch("/api/auth/disconnect", {
    method: "POST",
    headers: { accept: "application/json" },
  });
  if (!response.ok && response.status !== 204) {
    throw new Error("Wheely Nilly could not disconnect SnapTrade");
  }
  await clearBrowserSetup();
}
