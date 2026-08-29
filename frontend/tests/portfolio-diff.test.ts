import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diffPortfolio } from "../src/portfolio-diff";
import type { BrokerageSnapshot, WheelyNillyPosition } from "../src/types";

const equity = (id: string, symbol: string, quantity: number): WheelyNillyPosition => ({
  id,
  accountId: "account-1",
  symbol,
  quantity,
  price: 20,
  costBasis: 15,
  currency: "USD",
  option: null,
});

const option = (id: string, symbol: string, underlying: string): WheelyNillyPosition => ({
  id,
  accountId: "account-1",
  symbol,
  quantity: -1,
  price: 1.2,
  costBasis: 1.5,
  currency: "USD",
  option: {
    symbol,
    underlying,
    optionType: "put",
    expiration: "2026-09-18",
    strike: 30,
    multiplier: 100,
  },
});

const snapshot = (positions: WheelyNillyPosition[]): BrokerageSnapshot => ({
  schemaVersion: 1,
  fetchedAt: "2026-08-28T12:00:00.000Z",
  accounts: [],
  positions,
  balances: [],
  recentOrders: [],
  connections: [],
  errors: [],
});

describe("diffPortfolio", () => {
  it("detects new contracts and targets their symbol immediately", () => {
    const previous = snapshot([equity("rklb", "RKLB", 100)]);
    const current = snapshot([
      equity("rklb", "RKLB", 100),
      option("rklb-put", "RKLB260918P00030000", "RKLB"),
    ]);

    assert.deepEqual(diffPortfolio(previous, current), {
      addedPositionIds: ["rklb-put"],
      removedPositionIds: [],
      changedPositionIds: [],
      addedOrderIds: [],
      affectedSymbols: ["RKLB"],
      affectedContracts: ["RKLB260918P00030000"],
    });
  });

  it("detects quantity changes and removed positions", () => {
    const previous = snapshot([equity("smr", "SMR", 100), equity("voog", "VOOG", 200)]);
    const current = snapshot([equity("smr", "SMR", 200)]);
    const result = diffPortfolio(previous, current);

    assert.deepEqual(result.changedPositionIds, ["smr"]);
    assert.deepEqual(result.removedPositionIds, ["voog"]);
    assert.deepEqual(result.affectedSymbols, ["SMR", "VOOG"]);
  });
});
