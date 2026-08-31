import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { startApp } from "../src/startup-order";

describe("app startup", () => {
  it("installs refresh listeners before onboarding can emit a selection", async () => {
    const calls: string[] = [];
    await startApp(
      async () => { calls.push("refresh:start"); await Promise.resolve(); calls.push("refresh:ready"); },
      async () => { calls.push("onboarding"); },
    );
    assert.deepEqual(calls, ["refresh:start", "refresh:ready", "onboarding"]);
  });
});
