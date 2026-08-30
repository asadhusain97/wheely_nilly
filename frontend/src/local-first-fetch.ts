import { localRepository, type StorageDomain } from "./storage";
import { buildLocalModel, buildLocalRollResults, buildLocalTargets, scanAllLocalTargets, scanLocalTarget } from "./local-analysis";
import { builtInSettingsDocument } from "../assets/js/settings.js";

const nativeFetch = globalThis.fetch.bind(globalThis);

const cacheDomain = (url: URL): StorageDomain | null => {
  if (url.pathname.includes("/wheel/dashboard") || url.pathname.includes("/brokerage/snapshot")) return "portfolioSnapshot";
  if (url.pathname.includes("/screens")) return "radarCache";
  if (url.pathname.includes("/market/")) return "marketCache";
  return null;
};

async function cacheResponse(domain: StorageDomain, key: string, response: Response): Promise<void> {
  if (!response.ok) return;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return;
  const payload = await response.clone().json();
  await localRepository.put(domain, key, payload);
  document.dispatchEvent(new CustomEvent("wheely-data-updated", { detail: { key, payload } }));
}

export function installLocalFirstFetch(): void {
  globalThis.fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url, location.origin);
    if (url.origin !== location.origin) return nativeFetch(request);
    if (url.pathname === "/api/v1/strategy-settings") {
      if (request.method === "PUT") {
        const settings = await request.clone().json();
        await localRepository.put("tickerStrategies", "document", settings);
        return Response.json({ settings, persistence: { persisted: true, storage: "indexeddb", updatedAt: new Date().toISOString() } });
      }
      if (request.method === "GET") {
        const saved = await localRepository.get<unknown>("tickerStrategies", "document").catch(() => null);
        if (saved) return Response.json({ settings: saved.value, persistence: { persisted: true, storage: "indexeddb", updatedAt: saved.updatedAt } });
        const settings = builtInSettingsDocument();
        await localRepository.put("tickerStrategies", "document", settings).catch(() => undefined);
        return Response.json({ settings, persistence: { persisted: true, storage: "indexeddb", updatedAt: new Date().toISOString() } });
      }
    }
    if (request.method === "GET" && url.pathname === "/api/v1/wheel/dashboard") {
      const model = await buildLocalModel();
      return Response.json({ ...model.dashboard, freshness: model.freshness, generatedAt: model.generatedAt }, { headers: { "x-wheely-source": "local" } });
    }
    if (request.method === "GET" && url.pathname === "/api/v1/position-management") {
      const saved = await localRepository.get<unknown>("marketCache", "closeResults").catch(() => null);
      return Response.json(saved?.value ?? { scanTimestamp: null, results: [], failures: 0 }, { headers: { "x-wheely-source": "local" } });
    }
    if (request.method === "GET" && url.pathname === "/api/v1/screens/targets") {
      return Response.json(await buildLocalTargets(), { headers: { "x-wheely-source": "local" } });
    }
    if (request.method === "GET" && url.pathname === "/api/v1/screens/instruments") {
      const marketUrl = new URL("/api/market/instruments", location.origin);
      marketUrl.search = url.search;
      return nativeFetch(marketUrl, { headers: request.headers });
    }
    if (request.method === "POST" && url.pathname === "/api/v1/screens") {
      try { return Response.json(await scanLocalTarget(nativeFetch, await request.json())); }
      catch (error) { return Response.json({ error: { code: "SCAN_FAILED", message: error instanceof Error ? error.message : "Scan failed" } }, { status: (error as { status?: number }).status ?? 502 }); }
    }
    if (request.method === "POST" && url.pathname === "/api/v1/screens/scan-all") {
      return Response.json(await scanAllLocalTargets(nativeFetch));
    }
    if (request.method === "POST" && url.pathname === "/api/v1/position-management/rolls") {
      try {
        const body = await request.json() as { contractSymbol?: unknown };
        if (typeof body.contractSymbol !== "string" || !/^[A-Z0-9.]{1,6}\d{6}[CP]\d{8}$/.test(body.contractSymbol)) {
          return Response.json({ error: { code: "INVALID_CONTRACT", message: "Choose a valid open contract" } }, { status: 400 });
        }
        return Response.json(await buildLocalRollResults(nativeFetch, body.contractSymbol));
      } catch (error) {
        return Response.json({ error: { code: "ROLL_SCAN_FAILED", message: error instanceof Error ? error.message : "Roll quotes unavailable" } }, { status: (error as { status?: number }).status ?? 502 });
      }
    }
    if (request.method !== "GET") return nativeFetch(request);
    const domain = cacheDomain(url);
    if (!domain) return nativeFetch(request);
    const key = `${url.pathname}${url.search}`;
    const cached = await localRepository.get<unknown>(domain, key).catch(() => null);
    if (cached) {
      const age = Date.now() - Date.parse(cached.updatedAt);
      const ttl = domain === "portfolioSnapshot" ? 30 * 60_000 : 2 * 60_000;
      if (age >= ttl) void nativeFetch(request).then((response) => cacheResponse(domain, key, response).then(() => response)).catch(() => undefined);
      return Response.json(cached.value, {
        headers: { "x-wheely-source": "local", "x-wheely-cached-at": cached.updatedAt },
      });
    }
    const response = await nativeFetch(request);
    void cacheResponse(domain, key, response).catch(() => undefined);
    return response;
  };
}
