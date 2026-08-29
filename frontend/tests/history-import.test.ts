import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { historyImportIsDue, historyImportKey } from "../src/data-refresh-ui";

describe("account history import metadata", () => {
  it("uses a separate marker for each brokerage account", () => {
    assert.equal(historyImportKey("account-1"), "historyImported:account-1");
    assert.notEqual(historyImportKey("account-1"), historyImportKey("account-2"));
  });

  it("migrates stale boolean markers and refreshes completed imports daily", () => {
    const now = Date.parse("2026-08-29T18:00:00.000Z");
    assert.equal(historyImportIsDue(true, now), true);
    assert.equal(historyImportIsDue({ completedAt: "2026-08-29T17:00:00.000Z" }, now), false);
    assert.equal(historyImportIsDue({ completedAt: "2026-08-28T17:59:59.000Z" }, now), true);
  });
});
