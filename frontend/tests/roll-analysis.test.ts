import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { rollActionPresentation } from "../assets/js/rolls.js";
import { calculateAndRankRollCandidates, deriveRollReview, formatRollPlan } from "../src/roll-analysis";

const effective = (goal: "protect" | "income" | "exit" | "acquire", overrides: Record<string, unknown> = {}) => ({
  goal,
  rules: {
    minDte: goal === "protect" ? 30 : goal === "income" ? 14 : 7,
    maxDte: goal === "protect" ? 60 : goal === "income" ? 35 : goal === "exit" ? 21 : 28,
    targetDeltaMin: goal === "protect" ? 0.08 : goal === "income" ? 0.30 : goal === "exit" ? 0.45 : 0.40,
    targetDeltaMax: goal === "protect" ? 0.18 : goal === "income" ? 0.45 : goal === "exit" ? 0.65 : 0.55,
    rollReviewDte: goal === "protect" || goal === "income" ? 10 : 7,
    ...overrides,
  },
  priceGuard: { field: goal === "acquire" ? "maxNetPurchasePriceMinor" : "minNetSalePriceMinor", valueMinor: null },
});

const management = ({ goal = "protect" as const, moneyState = "ITM" as const, alignment = "conflicts" as const, dte = 4, delta = 0.7, signal = false } = {}) => ({
  effectiveSettings: effective(goal),
  close: { available: true, signal, metrics: { moneyState, dte, delta, assignmentAlignment: { status: alignment } } },
});

describe("goal-aware roll review", () => {
  it("waits for a usable current quote before enabling roll candidates", () => {
    const unavailable = rollActionPresentation({ state: "unavailable", reason: "exact contract has no usable ask" });
    const ready = rollActionPresentation({ state: "notNeeded" });

    assert.deepEqual(unavailable, {
      disabled: true,
      label: "Waiting for market data",
      title: "exact contract has no usable ask",
    });
    assert.equal(ready.disabled, false);
    assert.equal(ready.label, "Check roll candidates");
  });

  it("reviews an ITM covered call when assignment conflicts with Keep Shares", () => {
    const result = deriveRollReview({ trade: { type: "cc", dte: 4 }, management: management() });
    assert.equal(result.state, "review");
    assert.equal(result.urgency, "now");
    assert.match(result.reason, /conflicts with Keep Shares/);
  });

  it("lets aligned Plan Exit and Plan Entry assignments work", () => {
    const call = deriveRollReview({ trade: { type: "cc", dte: 4 }, management: management({ goal: "exit", alignment: "aligns" }) });
    const put = deriveRollReview({ trade: { type: "csp", dte: 4 }, management: management({ goal: "acquire", alignment: "aligns" }) });
    assert.equal(call.state, "assignmentAligned");
    assert.equal(put.state, "assignmentAligned");
  });

  it("reviews an OTM Plan Entry put when expiration is near", () => {
    const result = deriveRollReview({ trade: { type: "csp", dte: 6 }, management: management({ goal: "acquire", moneyState: "OTM", alignment: "neutral", dte: 6, delta: -0.2 }) });
    assert.equal(result.state, "review");
    assert.ok(result.reasonCodes.includes("intendedAssignmentUnlikely"));
  });

  it("offers an income continuation when the close target is met", () => {
    const result = deriveRollReview({ trade: { type: "cc", dte: 18 }, management: management({ goal: "income", moneyState: "OTM", alignment: "neutral", dte: 18, delta: 0.35, signal: true }) });
    assert.equal(result.label, "Close or continue income");
  });

  it("uses the saved per-goal and strategy roll review DTE", () => {
    const beforeWindow = management({ goal: "acquire", moneyState: "OTM", alignment: "neutral", dte: 6, delta: -0.2 });
    beforeWindow.effectiveSettings.rules.rollReviewDte = 3;
    assert.equal(deriveRollReview({ trade: { type: "csp", dte: 6 }, management: beforeWindow }).state, "notNeeded");

    const insideWindow = management({ goal: "acquire", moneyState: "OTM", alignment: "neutral", dte: 3, delta: -0.2 });
    insideWindow.effectiveSettings.rules.rollReviewDte = 3;
    assert.equal(deriveRollReview({ trade: { type: "csp", dte: 3 }, management: insideWindow }).state, "review");
  });
});

describe("roll candidate economics", () => {
  it("uses the current ask and replacement bid for a conservative roll estimate", () => {
    const result = calculateAndRankRollCandidates({
      trade: { type: "cc", strike: 100, expiration: "2026-09-18", contracts: 1, multiplier: 100, openingCredit: 250 },
      management: management(),
      currentQuote: { bid: 3.8, ask: 4 },
      candidates: [{
        contract_symbol: "XYZ261016C00110000", option_type: "call", expiration: "2026-10-16", dte: 32,
        strike: 110, bid: 4.5, ask: 4.7, delta: 0.16, spread_percent: 0.043, open_interest: 500, volume: 80,
      }],
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].closeDebit, 400.65);
    assert.equal(result[0].newOpenCredit, 449.35);
    assert.equal(result[0].naturalRollCash, 48.7);
    assert.equal(result[0].cumulativeOptionCash, 298.7);
    assert.equal(result[0].effectiveAssignmentPrice, 112.987);
    assert.equal(result[0].addedDays, 28);
  });

  it("rejects a candidate that breaks the cumulative Plan Entry purchase ceiling", () => {
    const acquire = management({ goal: "acquire", moneyState: "OTM", alignment: "neutral", dte: 6, delta: -0.2 });
    acquire.effectiveSettings.priceGuard = { field: "maxNetPurchasePriceMinor", valueMinor: 9_000 };
    const result = calculateAndRankRollCandidates({
      trade: { type: "csp", strike: 90, expiration: "2026-09-18", contracts: 1, openingCredit: 100 },
      management: acquire,
      currentQuote: { bid: 2.8, ask: 3 },
      candidates: [{ contract_symbol: "XYZ261016P00095000", option_type: "put", expiration: "2026-10-16", dte: 32, strike: 95, bid: 3.2, ask: 3.4 }],
    });
    assert.deepEqual(result, []);
  });

  it("formats a broker handoff with both option legs", () => {
    const candidate = {
      contractSymbol: "XYZ261016C00110000", optionType: "call" as const, expiration: "2026-10-16", dte: 32,
      strike: 110, bid: 4.5, ask: 4.7, delta: 0.16, spreadPercent: 0.043, openInterest: 500, volume: 80,
      periodReturn: 0.01, closeDebit: 400.65, newOpenCredit: 449.35, naturalRollCash: 48.7, midpointRollCash: 68.7,
      cumulativeOptionCash: 298.7, effectiveAssignmentPrice: 112.987, addedDays: 28,
      direction: "Up and out" as const, fitSummary: "Raises the call-away price.",
    };
    const plan = formatRollPlan({ symbol: "XYZ", strategy: "cc", quantity: 1, currentStrike: 100, currentExpiration: "2026-09-18", candidate, goal: "protect" });
    assert.match(plan, /Buy to close:\n1 2026-09-18 \$100\.00 call/);
    assert.match(plan, /Sell to open:\n1 2026-10-16 \$110\.00 call/);
    assert.match(plan, /\$48\.70 net credit/);
  });
});
