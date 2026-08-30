import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scopeLocalAccount } from "../src/local-analysis";

const option = (symbol: string, underlying: string) => ({
  symbol,
  underlying,
  expiration: "2026-09-18",
  optionType: "put",
  strikeMinor: 5000,
  multiplier: 100,
});

describe("local account analysis scope", () => {
  it("keeps closed option history for tickers that are no longer held", () => {
    const scoped = scopeLocalAccount({
      positions: [{ accountId: "selected", symbol: "CURRENT", option: null, quantity: 100 }],
      events: [
        { id: "past-open", accountId: "selected", underlying: "PAST", option: option("PAST260918P00050000", "PAST") },
        { id: "past-close", accountId: "selected", underlying: "PAST", option: option("PAST260918P00050000", "PAST") },
        { id: "unrelated-stock", accountId: "selected", underlying: "OTHER", option: null },
        { id: "other-account", accountId: "other", underlying: "PAST", option: option("PAST260918P00050000", "PAST") },
      ],
      balances: [{ accountId: "selected" }, { accountId: "other" }],
      quotes: [],
    });

    assert.deepEqual(scoped.events.map((event: { id: string }) => event.id), ["past-open", "past-close"]);
    assert.deepEqual(scoped.balances, [{ accountId: "selected" }]);
  });
});
