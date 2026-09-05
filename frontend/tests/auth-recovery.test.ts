import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { fetchWithAuthRecovery } from "../src/auth-recovery";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  else delete (globalThis as { navigator?: Navigator }).navigator;
});

describe("SnapTrade auth recovery", () => {
  it("quietly retries one rejected request so a concurrent refresh can update the cookie", async () => {
    let requests = 0;
    globalThis.window = { setTimeout, clearTimeout } as any;
    globalThis.fetch = async () => {
      requests += 1;
      return requests === 1
        ? Response.json({ error: { code: "AUTH_REQUIRED" } }, { status: 401 })
        : Response.json({ connected: true });
    };

    const response = await fetchWithAuthRecovery("/api/brokerage/refresh", {}, 0);

    assert.equal(response.status, 200);
    assert.equal(requests, 2);
  });

  it("does not retry unrelated failures", async () => {
    let requests = 0;
    globalThis.window = { setTimeout, clearTimeout } as any;
    globalThis.fetch = async () => {
      requests += 1;
      return Response.json({ error: { code: "BROKERAGE_UNAVAILABLE" } }, { status: 502 });
    };

    const response = await fetchWithAuthRecovery("/api/brokerage/refresh", {}, 0);

    assert.equal(response.status, 502);
    assert.equal(requests, 1);
  });

  it("serializes brokerage requests across tabs when browser locks are available", async () => {
    let activeRequests = 0;
    let maxActiveRequests = 0;
    let tail = Promise.resolve<unknown>(undefined);
    const locks = {
      request: (_name: string, optionsOrCallback: unknown, callback?: () => Promise<Response>) => {
        const run = typeof optionsOrCallback === "function" ? optionsOrCallback as () => Promise<Response> : callback!;
        const result = tail.then(run);
        tail = result.catch(() => undefined);
        return result;
      },
    };
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks } });
    globalThis.fetch = async () => {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeRequests -= 1;
      return Response.json({ ok: true });
    };

    await Promise.all([
      fetchWithAuthRecovery("/api/brokerage/refresh"),
      fetchWithAuthRecovery("/api/brokerage/history"),
    ]);

    assert.equal(maxActiveRequests, 1);
  });
});
