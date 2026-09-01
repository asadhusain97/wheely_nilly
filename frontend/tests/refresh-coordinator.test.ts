import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RefreshCoordinator, type RefreshCoordinatorDependencies } from "../src/refresh-coordinator";
import type { BrokerageSnapshot } from "../src/types";

const emptySnapshot = (fetchedAt = "2026-08-28T12:00:00.000Z"): BrokerageSnapshot => ({
  schemaVersion: 1,
  fetchedAt,
  accounts: [],
  positions: [],
  balances: [],
  recentOrders: [],
  connections: [],
  errors: [],
});

const dependencies = (overrides: Partial<RefreshCoordinatorDependencies> = {}): RefreshCoordinatorDependencies => ({
  refreshMarket: async () => undefined,
  refreshBrokerage: async () => emptySnapshot(),
  refreshAffectedMarket: async () => undefined,
  readPortfolio: () => null,
  writePortfolio: async () => undefined,
  onError: () => undefined,
  ...overrides,
});

describe("RefreshCoordinator", () => {
  it("deduplicates overlapping market and brokerage requests", async () => {
    let releaseMarket!: () => void;
    let releaseBrokerage!: () => void;
    let marketCalls = 0;
    let brokerageCalls = 0;
    const coordinator = new RefreshCoordinator(dependencies({
      refreshMarket: () => {
        marketCalls += 1;
        return new Promise<void>((resolve) => { releaseMarket = resolve; });
      },
      refreshBrokerage: () => {
        brokerageCalls += 1;
        return new Promise<BrokerageSnapshot>((resolve) => { releaseBrokerage = () => resolve(emptySnapshot()); });
      },
    }));

    const firstMarket = coordinator.refreshMarket();
    const secondMarket = coordinator.refreshMarket();
    const firstBrokerage = coordinator.refreshBrokerage();
    const secondBrokerage = coordinator.refreshBrokerage();
    assert.equal(marketCalls, 1);
    assert.equal(brokerageCalls, 1);
    releaseMarket();
    releaseBrokerage();
    await Promise.all([firstMarket, secondMarket, firstBrokerage, secondBrokerage]);
  });

  it("refreshes affected market data after a portfolio change", async () => {
    const previous = emptySnapshot();
    const next = {
      ...emptySnapshot("2026-08-28T12:30:00.000Z"),
      positions: [{
        id: "smr",
        accountId: "account-1",
        symbol: "SMR",
        quantity: 100,
        price: 45,
        costBasis: 40,
        currency: "USD",
        option: null,
      }],
    } satisfies BrokerageSnapshot;
    let current = previous;
    let affected: string[] = [];
    const coordinator = new RefreshCoordinator(dependencies({
      readPortfolio: () => current,
      writePortfolio: async (value) => { current = value; },
      refreshBrokerage: async () => next,
      refreshAffectedMarket: async (diff) => { affected = diff.affectedSymbols; },
    }));

    await coordinator.refreshBrokerage();
    assert.deepEqual(affected, ["SMR"]);
  });

  it("enforces the manual brokerage cooldown", async () => {
    let now = 1_000;
    const coordinator = new RefreshCoordinator(dependencies({ now: () => now }));
    await coordinator.refreshBrokerage({ manual: true });
    await assert.rejects(coordinator.refreshBrokerage({ manual: true }), /cooling down/);
    now += 300_000;
    await coordinator.refreshBrokerage({ manual: true });
  });

  it("allows an immediate manual retry after a failed refresh", async () => {
    let calls = 0;
    const coordinator = new RefreshCoordinator(dependencies({
      refreshBrokerage: async () => {
        calls += 1;
        if (calls === 1) throw new Error("temporary failure");
        return emptySnapshot();
      },
    }));

    await assert.rejects(coordinator.refreshBrokerage({ manual: true }), /temporary failure/);
    await coordinator.refreshBrokerage({ manual: true });
    assert.equal(calls, 2);
  });

  it("uses cached brokerage freshness on startup without delaying the market clock", async () => {
    const now = Date.parse("2026-08-28T12:10:00.000Z");
    const cached = emptySnapshot("2026-08-28T12:05:00.000Z");
    const events = new EventTarget() as EventTarget & { hidden: boolean };
    Object.defineProperty(events, "hidden", { value: false });
    let marketCalls = 0;
    let brokerageCalls = 0;
    const coordinator = new RefreshCoordinator(dependencies({
      document: events,
      now: () => now,
      readPortfolio: () => cached,
      refreshMarket: async () => { marketCalls += 1; },
      refreshBrokerage: async () => { brokerageCalls += 1; return cached; },
    }));

    coordinator.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    coordinator.stop();
    assert.equal(marketCalls, 1);
    assert.equal(brokerageCalls, 0);
  });
});
