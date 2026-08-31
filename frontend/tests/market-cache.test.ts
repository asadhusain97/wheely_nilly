import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mergeMarketCache } from "../src/data-refresh-ui";
import type { ExactContractQuote } from "../src/types";

const contract = (available: boolean, ask: number | null, fetchedAt: string): ExactContractQuote => ({
  contract: {
    contract_symbol: "SOFI261016P00008000",
    symbol: "SOFI",
    option_type: "put",
    expiration: "2026-10-16",
    strike: 8,
  },
  available,
  unavailable_reason: available ? null : "exact contract has no usable ask",
  bid: available ? 0.61 : null,
  ask,
  contract_quote_time: fetchedAt,
  fetched_at: fetchedAt,
  provider: "yfinance",
});

describe("market quote cache", () => {
  it("keeps the latest response separate from the last usable contract quote", () => {
    const usable = contract(true, 0.64, "2026-08-28T19:59:00.000Z");
    const unavailable = contract(false, null, "2026-08-31T13:05:00.000Z");
    const result = mergeMarketCache(
      { quotes: [], contracts: [usable] },
      [],
      [unavailable],
      [usable.contract.contract_symbol],
    );

    assert.equal(result.contracts[0].available, false);
    assert.equal(result.lastUsableContracts[0].ask, 0.64);
  });

  it("replaces the saved quote only after another usable quote arrives", () => {
    const previous = contract(true, 0.64, "2026-08-28T19:59:00.000Z");
    const current = contract(true, 0.71, "2026-08-31T14:00:00.000Z");
    const result = mergeMarketCache(
      { quotes: [], contracts: [], lastUsableContracts: [previous] },
      [],
      [current],
      [current.contract.contract_symbol],
    );

    assert.equal(result.contracts[0].ask, 0.71);
    assert.equal(result.lastUsableContracts[0].ask, 0.71);
  });

  it("drops quotes for contracts that are no longer open", () => {
    const previous = contract(true, 0.64, "2026-08-28T19:59:00.000Z");
    const result = mergeMarketCache(
      { quotes: [], contracts: [previous], lastUsableContracts: [previous] },
      [],
      [],
      [],
    );

    assert.deepEqual(result.contracts, []);
    assert.deepEqual(result.lastUsableContracts, []);
  });
});
