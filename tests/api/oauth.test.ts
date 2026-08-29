import assert from "node:assert/strict";
import crypto from "node:crypto";
import { before, describe, it } from "node:test";
import { readSession, seal, unseal, validReturnTo } from "../../api/_lib/oauth";

before(() => {
  process.env.SESSION_SEAL_KEY = crypto.randomBytes(32).toString("base64url");
  process.env.APP_ORIGIN = "http://127.0.0.1:3000";
});

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
});
