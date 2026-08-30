export const GOAL_LABELS = {
  protect: "Keep Shares",
  income: "Earn Income",
  exit: "Plan Exit",
  acquire: "Plan Entry",
} as const;

export type Goal = keyof typeof GOAL_LABELS;
export type RollReviewState = "notNeeded" | "review" | "assignmentAligned" | "reassess" | "unavailable";

export interface RollReview {
  state: RollReviewState;
  urgency: "normal" | "soon" | "now";
  goal: Goal | null;
  label: string;
  reason: string;
  reasonCodes: string[];
  searchProfile: RollSearchProfile | null;
}

export interface RollSearchProfile {
  minDte: number;
  maxDte: number;
  deltaMin: number | null;
  deltaMax: number | null;
  strikeDirection: "higher" | "lower" | "nearSpot" | "goalRange";
  priceGuardMinor: number | null;
  priceGuardField: "minNetSalePriceMinor" | "maxNetPurchasePriceMinor";
}

interface RollReviewInput {
  trade: {
    type: "cc" | "csp";
    dte?: number | null;
  };
  management: {
    effectiveSettings?: {
      goal?: Goal | null;
      rules?: Record<string, number | null>;
      priceGuard?: { field?: string; valueMinor?: number | null };
    };
    close?: {
      available?: boolean;
      signal?: boolean | null;
      unavailableReason?: string | null;
      metrics?: {
        dte?: number | null;
        moneyState?: "ITM" | "OTM" | null;
        delta?: number | null;
        assignmentAlignment?: { status?: "aligns" | "conflicts" | "neutral"; reason?: string };
      } | null;
    };
  };
}

const finite = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function buildRollSearchProfile(effective: RollReviewInput["management"]["effectiveSettings"]): RollSearchProfile | null {
  const goal = effective?.goal ?? null;
  const rules = effective?.rules;
  if (!goal || !rules) return null;
  const priceGuardField = effective?.priceGuard?.field === "maxNetPurchasePriceMinor"
    ? "maxNetPurchasePriceMinor"
    : "minNetSalePriceMinor";
  return {
    minDte: finite(rules.minDte) ?? 1,
    maxDte: finite(rules.maxDte) ?? 45,
    deltaMin: finite(rules.targetDeltaMin),
    deltaMax: finite(rules.targetDeltaMax),
    strikeDirection: goal === "protect" ? "higher" : goal === "exit" ? "lower" : goal === "acquire" ? "nearSpot" : "goalRange",
    priceGuardMinor: finite(effective?.priceGuard?.valueMinor),
    priceGuardField,
  };
}

export function deriveRollReview({ trade, management }: RollReviewInput): RollReview {
  const close = management?.close;
  const goal = management?.effectiveSettings?.goal ?? null;
  const searchProfile = buildRollSearchProfile(management?.effectiveSettings);
  if (!close?.available || !close.metrics) {
    return {
      state: "unavailable", urgency: "normal", goal, label: "Review data",
      reason: close?.unavailableReason ?? "Current contract data is unavailable.",
      reasonCodes: ["closeDataUnavailable"], searchProfile,
    };
  }
  if (!goal || !searchProfile) {
    return {
      state: "notNeeded", urgency: "normal", goal: null, label: "No roll guidance",
      reason: "Choose a ticker goal in Settings before evaluating a roll.",
      reasonCodes: ["goalMissing"], searchProfile: null,
    };
  }

  const metrics = close.metrics;
  const dte = finite(metrics.dte ?? trade.dte);
  const timePressure = dte !== null && dte <= Math.min(10, searchProfile.minDte);
  const absoluteDelta = metrics.delta == null ? null : Math.abs(Number(metrics.delta));
  const deltaAboveGoal = absoluteDelta !== null && searchProfile.deltaMax !== null && absoluteDelta > searchProfile.deltaMax;
  const itm = metrics.moneyState === "ITM";
  const alignment = metrics.assignmentAlignment?.status ?? "neutral";
  const goalLabel = GOAL_LABELS[goal];

  if (itm && alignment === "aligns") {
    const outcome = trade.type === "csp" ? "buying the shares" : "selling the shares";
    return {
      state: "assignmentAligned", urgency: timePressure ? "soon" : "normal", goal,
      label: "Let assignment work",
      reason: `This contract is ITM. Assignment matches ${goalLabel} and would mean ${outcome}.`,
      reasonCodes: ["assignmentAligned", ...(timePressure ? ["expirationNear"] : [])], searchProfile,
    };
  }

  if (alignment === "conflicts" && (itm || deltaAboveGoal)) {
    return {
      state: "review", urgency: itm && timePressure ? "now" : "soon", goal,
      label: "Check roll choices",
      reason: itm
        ? `This contract is ITM and assignment conflicts with ${goalLabel}.`
        : `Assignment pressure is above the ${goalLabel} delta range.`,
      reasonCodes: [itm ? "assignmentConflict" : "deltaAboveGoal", ...(timePressure ? ["expirationNear"] : [])], searchProfile,
    };
  }

  if ((goal === "exit" || goal === "acquire") && !itm && timePressure) {
    const outcome = goal === "exit" ? "stock sale" : "share purchase";
    return {
      state: "review", urgency: "soon", goal, label: "Check roll choices",
      reason: `Expiration is near and the planned ${outcome} has not developed.`,
      reasonCodes: ["intendedAssignmentUnlikely", "expirationNear"], searchProfile,
    };
  }

  if (goal === "income" && close.signal === true) {
    return {
      state: "review", urgency: timePressure ? "soon" : "normal", goal,
      label: "Close or continue income",
      reason: "Your profit target is met. Compare a later contract before ending this income cycle.",
      reasonCodes: ["profitTargetMet", ...(timePressure ? ["expirationNear"] : [])], searchProfile,
    };
  }

  if (goal === "income" && timePressure) {
    return {
      state: "review", urgency: "soon", goal, label: "Check roll choices",
      reason: "Expiration is near. Compare a later contract that still fits Earn Income.",
      reasonCodes: ["expirationNear"], searchProfile,
    };
  }

  if (goal === "protect" && deltaAboveGoal) {
    return {
      state: "review", urgency: timePressure ? "soon" : "normal", goal, label: "Check roll choices",
      reason: "This call is above the Keep Shares delta range.",
      reasonCodes: ["deltaAboveGoal", ...(timePressure ? ["expirationNear"] : [])], searchProfile,
    };
  }

  return {
    state: "notNeeded", urgency: "normal", goal, label: close.signal ? "Close candidate" : "Hold",
    reason: "No roll condition is active.", reasonCodes: [], searchProfile,
  };
}

interface RollMarketCandidate {
  contract_symbol: string;
  option_type: "call" | "put";
  expiration: string;
  dte: number;
  strike: number;
  bid: number;
  ask: number;
  delta?: number | null;
  spread_percent?: number | null;
  open_interest?: number | null;
  volume?: number | null;
  period_return?: number | null;
  [key: string]: unknown;
}

interface RollCandidateInput {
  trade: { type: "cc" | "csp"; strike: number; expiration: string; contracts: number; multiplier?: number | null; openingCredit: number };
  management: RollReviewInput["management"];
  currentQuote: { bid?: number | null; ask?: number | null };
  candidates: RollMarketCandidate[];
  estimatedFeePerContract?: number;
}

export interface RollCandidateView {
  contractSymbol: string;
  optionType: "call" | "put";
  expiration: string;
  dte: number;
  strike: number;
  bid: number;
  ask: number;
  delta: number | null;
  spreadPercent: number | null;
  openInterest: number | null;
  volume: number | null;
  periodReturn: number | null;
  closeDebit: number;
  newOpenCredit: number;
  naturalRollCash: number;
  midpointRollCash: number | null;
  cumulativeOptionCash: number;
  effectiveAssignmentPrice: number;
  addedDays: number;
  direction: "Up and out" | "Down and out" | "Straight out";
  fitSummary: string;
}

function utcDay(value: string): number {
  return Date.parse(`${value}T00:00:00Z`) / 86_400_000;
}

const roundMoney = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

export function calculateAndRankRollCandidates({ trade, management, currentQuote, candidates, estimatedFeePerContract = 0.65 }: RollCandidateInput): RollCandidateView[] {
  const goal = management.effectiveSettings?.goal ?? null;
  const profile = buildRollSearchProfile(management.effectiveSettings);
  const quantity = Math.abs(Number(trade.contracts));
  const multiplier = Number(trade.multiplier ?? 100);
  const currentAsk = finite(currentQuote.ask);
  if (!goal || !profile || !Number.isFinite(quantity) || quantity <= 0 || currentAsk === null || currentAsk <= 0) return [];
  const currentBid = finite(currentQuote.bid);
  const closeDebit = roundMoney(currentAsk * multiplier * quantity + estimatedFeePerContract * quantity);
  const currentMidpoint = currentBid !== null && currentBid > 0 ? (currentBid + currentAsk) / 2 : null;

  const views = candidates.flatMap((candidate): RollCandidateView[] => {
    const bid = finite(candidate.bid);
    const ask = finite(candidate.ask);
    if (bid === null || ask === null || bid <= 0 || ask < bid || utcDay(candidate.expiration) <= utcDay(trade.expiration)) return [];
    const newOpenCredit = roundMoney(bid * multiplier * quantity - estimatedFeePerContract * quantity);
    const naturalRollCash = roundMoney(newOpenCredit - closeDebit);
    const candidateMidpoint = (bid + ask) / 2;
    const midpointRollCash = currentMidpoint === null
      ? null
      : roundMoney((candidateMidpoint - currentMidpoint) * multiplier * quantity - estimatedFeePerContract * quantity * 2);
    const cumulativeOptionCash = roundMoney(Number(trade.openingCredit) + naturalRollCash);
    const perShareCash = cumulativeOptionCash / (multiplier * quantity);
    const effectiveAssignmentPrice = trade.type === "cc" ? candidate.strike + perShareCash : candidate.strike - perShareCash;
    if (profile.priceGuardMinor !== null) {
      const guard = profile.priceGuardMinor / 100;
      if (profile.priceGuardField === "minNetSalePriceMinor" && effectiveAssignmentPrice < guard) return [];
      if (profile.priceGuardField === "maxNetPurchasePriceMinor" && effectiveAssignmentPrice > guard) return [];
    }
    const direction = candidate.strike > trade.strike ? "Up and out" : candidate.strike < trade.strike ? "Down and out" : "Straight out";
    const delta = finite(candidate.delta);
    const hasPriceGuard = profile.priceGuardMinor !== null;
    const fitSummary = goal === "protect"
      ? `${direction} raises the call-away price and ${delta === null ? "fits the saved contract range" : `moves delta to ${Math.abs(delta).toFixed(2)}`}.`
      : goal === "exit"
        ? hasPriceGuard ? `${direction} keeps the planned sale above the saved floor.` : `${direction} moves the call toward the intended stock sale.`
        : goal === "acquire"
          ? hasPriceGuard ? `${direction} keeps the planned purchase below the saved ceiling.` : `${direction} moves the put toward the intended share purchase.`
          : `${direction} continues the income cycle inside the saved contract range.`;
    return [{
      contractSymbol: candidate.contract_symbol, optionType: candidate.option_type, expiration: candidate.expiration,
      dte: candidate.dte, strike: candidate.strike, bid, ask, delta, spreadPercent: finite(candidate.spread_percent),
      openInterest: finite(candidate.open_interest), volume: finite(candidate.volume), periodReturn: finite(candidate.period_return),
      closeDebit, newOpenCredit, naturalRollCash, midpointRollCash, cumulativeOptionCash, effectiveAssignmentPrice,
      addedDays: Math.max(1, Math.round(utcDay(candidate.expiration) - utcDay(trade.expiration))), direction, fitSummary,
    }];
  });

  const rules = management.effectiveSettings?.rules ?? {};
  const deltaMidpoint = profile.deltaMin === null || profile.deltaMax === null ? null : (profile.deltaMin + profile.deltaMax) / 2;
  const dteMidpoint = (profile.minDte + profile.maxDte) / 2;
  return views.sort((left, right) => {
    if (goal === "protect") {
      const strikeOrder = right.strike - left.strike;
      if (strikeOrder) return strikeOrder;
      const deltaOrder = (Math.abs(left.delta ?? 1) - Math.abs(right.delta ?? 1));
      if (deltaOrder) return deltaOrder;
    }
    if (goal === "exit") {
      const deltaOrder = Math.abs(Math.abs(left.delta ?? 0) - (deltaMidpoint ?? 0.55)) - Math.abs(Math.abs(right.delta ?? 0) - (deltaMidpoint ?? 0.55));
      if (deltaOrder) return deltaOrder;
      if (left.strike !== right.strike) return left.strike - right.strike;
    }
    if (goal === "acquire") {
      const spot = finite((candidates[0] as Record<string, unknown> | undefined)?.underlying_price);
      if (spot !== null) {
        const strikeOrder = Math.abs(left.strike - spot) - Math.abs(right.strike - spot);
        if (strikeOrder) return strikeOrder;
      }
    }
    const deltaOrder = deltaMidpoint === null ? 0
      : Math.abs(Math.abs(left.delta ?? deltaMidpoint) - deltaMidpoint) - Math.abs(Math.abs(right.delta ?? deltaMidpoint) - deltaMidpoint);
    if (deltaOrder) return deltaOrder;
    const dteOrder = Math.abs(left.dte - dteMidpoint) - Math.abs(right.dte - dteMidpoint);
    if (dteOrder) return dteOrder;
    const creditOrder = right.naturalRollCash - left.naturalRollCash;
    if (creditOrder) return creditOrder;
    return (left.spreadPercent ?? Number.POSITIVE_INFINITY) - (right.spreadPercent ?? Number.POSITIVE_INFINITY);
  }).slice(0, Math.min(3, finite(rules.limit) ?? 3));
}

export function formatRollPlan(input: {
  symbol: string;
  strategy: "cc" | "csp";
  quantity: number;
  currentStrike: number;
  currentExpiration: string;
  candidate: RollCandidateView;
  goal: Goal;
  quoteTimestamp?: string | null;
}): string {
  const kind = input.strategy === "cc" ? "call" : "put";
  const cash = input.candidate.naturalRollCash;
  const estimate = `$${Math.abs(cash).toFixed(2)} net ${cash >= 0 ? "credit" : "debit"}`;
  const timestamp = input.quoteTimestamp ? `, based on ${new Date(input.quoteTimestamp).toLocaleString("en-US")}` : "";
  return [
    `${input.symbol} ${input.strategy === "cc" ? "covered-call" : "cash-secured-put"} roll`, "",
    "Buy to close:", `${input.quantity} ${input.currentExpiration} $${input.currentStrike.toFixed(2)} ${kind}`, "",
    "Sell to open:", `${input.quantity} ${input.candidate.expiration} $${input.candidate.strike.toFixed(2)} ${kind}`, "",
    "Estimated roll:", `${estimate}${timestamp}`, "",
    "Goal:", GOAL_LABELS[input.goal], "",
    "Confirm the contracts, net price, fees, and buying-power effect with your broker.",
  ].join("\n");
}
