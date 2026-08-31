import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import authHandler from "../../api/auth";
import brokerageHandler from "../../api/brokerage";
import { mockBrokerageEnabled } from "../../api/_lib/brokerage-mode";
import {
  createMockAccountCatalog,
  createMockBrokerageSnapshot,
  createMockHistoryPage,
  MOCK_ACCOUNT_ID,
} from "../../api/_lib/mock-brokerage";

const originalEnvironment = {
  APP_ORIGIN: process.env.APP_ORIGIN,
  BROKERAGE_MODE: process.env.BROKERAGE_MODE,
  NODE_ENV: process.env.NODE_ENV,
  VERCEL_ENV: process.env.VERCEL_ENV,
};
const originalFetch = globalThis.fetch;

const restore = (name: keyof typeof originalEnvironment): void => {
  const value = originalEnvironment[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

const responseStub = () => {
  const headers = new Map<string, string | number | string[]>();
  let statusCode = 200;
  let body: unknown;
  let redirect: { status: number; url: string } | null = null;
  return {
    setHeader(name: string, value: string | string[]) { headers.set(name, value); return this; },
    getHeader(name: string) { return headers.get(name); },
    status(code: number) { statusCode = code; return this; },
    json(value: unknown) { body = value; return this; },
    redirect(status: number, url: string) { redirect = { status, url }; return this; },
    end() { return this; },
    result: () => ({ statusCode, body, redirect, headers }),
  };
};

beforeEach(() => {
  process.env.APP_ORIGIN = "http://127.0.0.1:3000";
  process.env.BROKERAGE_MODE = "mock";
  process.env.NODE_ENV = "development";
  process.env.VERCEL_ENV = "development";
});

afterEach(() => {
  restore("APP_ORIGIN");
  restore("BROKERAGE_MODE");
  restore("NODE_ENV");
  restore("VERCEL_ENV");
  globalThis.fetch = originalFetch;
});

describe("local mock brokerage", () => {
  it("can only be enabled in local development", () => {
    assert.equal(mockBrokerageEnabled(), true);
    process.env.NODE_ENV = "production";
    assert.equal(mockBrokerageEnabled(), true);
    process.env.VERCEL_ENV = "preview";
    assert.equal(mockBrokerageEnabled(), false);
    process.env.VERCEL_ENV = "production";
    assert.equal(mockBrokerageEnabled(), false);
    delete process.env.VERCEL_ENV;
    assert.equal(mockBrokerageEnabled(), false);
  });

  it("keeps the production auth API on the SnapTrade path", async () => {
    process.env.VERCEL_ENV = "production";
    const sessionResponse = responseStub();

    await authHandler({ method: "GET", url: "/api/auth/session", headers: {}, query: { path: "session" } }, sessionResponse as any);

    assert.deepEqual(sessionResponse.result().body, {
      connected: false,
      scope: null,
      expiresAt: null,
      brokerageMode: "snaptrade",
    });
    assert.equal(sessionResponse.result().headers.get("X-Wheely-Brokerage-Mode"), undefined);
  });

  it("returns browser OAuth failures to an actionable signup screen", async () => {
    process.env.VERCEL_ENV = "production";
    globalThis.fetch = async () => { throw new Error("provider unavailable"); };
    const response = responseStub();

    await authHandler({ method: "GET", url: "/api/auth/start", headers: {}, query: { path: "start" } }, response as any);

    assert.deepEqual(response.result().redirect, {
      status: 302,
      url: "http://127.0.0.1:3000/?oauth=unavailable",
    });
  });

  it("provides a representative account, snapshot, and authoritative history", () => {
    const now = new Date("2026-08-30T12:00:00.000Z");
    const catalog = createMockAccountCatalog(now);
    const snapshot = createMockBrokerageSnapshot([MOCK_ACCOUNT_ID], now);
    const history = createMockHistoryPage(MOCK_ACCOUNT_ID, 0, now);

    assert.equal(catalog.accounts[0].id, MOCK_ACCOUNT_ID);
    assert.ok(snapshot.positions.some((position) => position.option?.optionType === "call" && position.quantity < 0));
    assert.ok(snapshot.positions.some((position) => position.option?.optionType === "put" && position.quantity < 0));
    assert.ok(snapshot.positions.some((position) => position.symbol === "RKLB" && position.quantity === 200));
    assert.ok(snapshot.balances[0].buyingPower);
    assert.ok(history.events.some((event) => event.action === "buy_to_close" && event.authoritative));
    assert.ok(history.events.some((event) => event.option?.symbol === snapshot.positions.find((position) => position.option?.optionType === "call")?.option?.symbol));
  });

  it("serves auth and brokerage routes without a SnapTrade session", async () => {
    const sessionResponse = responseStub();
    await authHandler({ method: "GET", url: "/api/auth/session", headers: {}, query: { path: "session" } }, sessionResponse as any);
    assert.deepEqual(sessionResponse.result().body, { connected: true, scope: "mock", expiresAt: null, brokerageMode: "mock" });

    const startResponse = responseStub();
    await authHandler({ method: "GET", url: "/api/auth/start", headers: {}, query: { path: "start", returnTo: "/app?view=positions" } }, startResponse as any);
    assert.deepEqual(startResponse.result().redirect, {
      status: 302,
      url: "http://127.0.0.1:3000/app?view=positions&connected=1&brokerage=mock",
    });

    const accountsResponse = responseStub();
    await brokerageHandler({ method: "GET", url: "/api/brokerage/accounts", headers: {}, query: { path: "accounts" } }, accountsResponse as any);
    assert.equal((accountsResponse.result().body as ReturnType<typeof createMockAccountCatalog>).accounts[0].id, MOCK_ACCOUNT_ID);

    const refreshResponse = responseStub();
    await brokerageHandler({
      method: "POST",
      url: "/api/brokerage/refresh",
      headers: { origin: "http://127.0.0.1:3000" },
      query: { path: "refresh" },
      body: { accountIds: [MOCK_ACCOUNT_ID] },
    }, refreshResponse as any);
    assert.equal(refreshResponse.result().statusCode, 200);
    assert.equal((refreshResponse.result().body as ReturnType<typeof createMockBrokerageSnapshot>).schemaVersion, 1);
    assert.equal(refreshResponse.result().headers.get("X-Wheely-Brokerage-Mode"), "mock");

    const historyResponse = responseStub();
    await brokerageHandler({
      method: "GET",
      url: `/api/brokerage/history?accountId=${MOCK_ACCOUNT_ID}`,
      headers: {},
      query: { path: "history", accountId: MOCK_ACCOUNT_ID },
    }, historyResponse as any);
    assert.ok((historyResponse.result().body as ReturnType<typeof createMockHistoryPage>).events.length > 0);
  });
});
