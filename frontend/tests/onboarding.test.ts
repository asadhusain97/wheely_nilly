import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { onboardingSyncView } from "../src/onboarding";

describe("onboarding sync state", () => {
  it("blocks setup until positions load", () => {
    const loading = onboardingSyncView(false, false, null);
    const failed = onboardingSyncView(false, false, { phase: "brokerage" });

    assert.equal(loading.canContinue, false);
    assert.equal(failed.canContinue, false);
    assert.equal(failed.tone, "error");
    assert.match(failed.status, /Try again/);
  });

  it("does not trap the user when only trade history is pending or fails", () => {
    const pending = onboardingSyncView(true, false, null);
    const failed = onboardingSyncView(true, false, { phase: "history" });

    assert.equal(pending.canContinue, true);
    assert.equal(failed.canContinue, true);
    assert.equal(failed.tone, "warning");
    assert.match(failed.status, /retry after setup/);
  });
});
