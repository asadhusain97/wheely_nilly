import assert from "node:assert/strict";
import crypto from "node:crypto";
import { afterEach, before, describe, it } from "node:test";
import { readSession, seal, unseal, validReturnTo, withAccessToken } from "../../api/_lib/oauth";

const originalFetch = globalThis.fetch;

before(() => {
  process.env.SESSION_SEAL_KEY = crypto.randomBytes(32).toString("base64url");
  process.env.APP_ORIGIN = "http://127.0.0.1:3000";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const expiredSessionCookie = () => `wheely_session=${encodeURIComponent(seal({
  accessToken: "expired-access",
  refreshToken: "expired-refresh",
  expiresAt: Date.now() - 60_000,
  scope: "read",
  sub: null,
  clientId: "client-1",
}))}`;

const responseStub = () => {
  const headers = new Map<string, string | string[]>();
  return {
    getHeader: (name: string) => headers.get(name),
    setHeader: (name: string, value: string | string[]) => { headers.set(name, value); },
    headers,
  };
};

describe("stateless OAuth session sealing", () => {
  it("round-trips session data and rejects tampering", () => {
    const encrypted = seal({ accessToken: "access", refreshToken: "refresh" });
    assert.deepEqual(unseal(encrypted), { accessToken: "access", refreshToken: "refresh" });
    const parts = encrypted.split(".");
    parts[2] = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
    assert.equal(unseal(parts.join(".")), null);
  });

  it("allows only same-site return paths", () => {
    assert.equal(validReturnTo("/app?connected=1"), "/app?connected=1");
    assert.equal(validReturnTo("https://example.com"), "/app");
    assert.equal(validReturnTo("//example.com"), "/app");
  });

  it("rejects sessions created by the retired static OAuth flow", () => {
    const oldSession = seal({ accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 60_000, scope: "read" });
    assert.equal(readSession({ headers: { cookie: `wheely_session=${encodeURIComponent(oldSession)}` }, query: {} }), null);
  });

  it("keeps the session cookie when token refresh is rejected so a concurrent refresh cannot erase a newer session", async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes(".well-known")) {
        return Response.json({
          authorization_endpoint: "https://snaptrade.test/authorize",
          token_endpoint: "https://snaptrade.test/token",
          revocation_endpoint: "https://snaptrade.test/revoke",
          registration_endpoint: "https://snaptrade.test/register",
        });
      }
      if (url === "https://snaptrade.test/token") return Response.json({ error: "invalid_grant" }, { status: 400 });
      throw new Error(`Unexpected request: ${url}`);
    };
    const response = responseStub();

    await assert.rejects(
      () => withAccessToken({ headers: { cookie: expiredSessionCookie() }, query: {} }, response as any, async () => "unused"),
      (error: any) => error.status === 401 && error.code === "AUTH_REQUIRED",
    );
    assert.equal(response.headers.get("Set-Cookie"), undefined);
  });

  it("keeps the saved session when token refresh fails transiently", async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url === "https://snaptrade.test/token") return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
      throw new Error(`Unexpected request: ${url}`);
    };
    const response = responseStub();

    await assert.rejects(
      () => withAccessToken({ headers: { cookie: expiredSessionCookie() }, query: {} }, response as any, async () => "unused"),
      (error: any) => error.status === 503 && error.code === "OAUTH_TOKEN_REQUEST_FAILED",
    );
    assert.equal(response.headers.get("Set-Cookie"), undefined);
  });
});
