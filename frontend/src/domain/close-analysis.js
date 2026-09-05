const DAY_MS = 86_400_000;
export const DEFAULT_CLOSING_FEE_PER_CONTRACT = 0.65;

function number(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 8) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function calendarDays(openedAt, now) {
  const opened = Date.parse(openedAt);
  if (!Number.isFinite(opened) || opened > now.getTime()) return null;
  return Math.max(1, Math.ceil((now.getTime() - opened) / DAY_MS));
}

function assignmentAlignment(optionType, goal) {
  if (goal === 'income' || !goal) return { status: 'neutral', reason: goal ? 'Income treats assignment as neutral.' : 'No goal is selected for this ticker.' };
  if (optionType === 'put' && goal === 'acquire') return { status: 'aligns', reason: 'Put assignment aligns with Plan Entry.' };
  if (optionType === 'call' && goal === 'exit') return { status: 'aligns', reason: 'Call assignment aligns with Plan Exit.' };
  if (optionType === 'call' && goal === 'protect') return { status: 'conflicts', reason: 'Call assignment conflicts with Keep Shares.' };
  return { status: 'neutral', reason: 'The selected goal does not define assignment intent for this contract.' };
}

function unavailableClose(reason, effective, quote = null, openingNetCredit = null) {
  const ask = number(quote?.ask);
  return {
    available: false,
    signal: null,
    unavailableReason: reason,
    metrics: null,
    conditions: [
      { key: 'openingNetCredit', actualValue: openingNetCredit, configuredValue: null, pass: openingNetCredit !== null && openingNetCredit > 0, settingsSource: 'positionHistory', decisive: false },
      { key: 'currentAsk', actualValue: ask, configuredValue: null, pass: ask !== null && ask > 0, settingsSource: 'provider', decisive: false },
      { key: 'premiumCapture', actualValue: null, configuredValue: effective.rules.closeAtProfitCapture, pass: null, settingsSource: effective.sourceMap.closeAtProfitCapture, decisive: true },
    ],
  };
}

export function calculateCloseResult({ trade, quote, effectiveSettings, now = new Date(), estimatedClosingFeePerContract = DEFAULT_CLOSING_FEE_PER_CONTRACT }) {
  const openingNetCredit = number(trade.openingCredit);
  const askPerShare = number(quote?.ask);
  const bidPerShare = number(quote?.bid);
  if (openingNetCredit === null || openingNetCredit <= 0) {
    return unavailableClose('Opening net credit is unavailable, so premium capture cannot be calculated.', effectiveSettings, quote, openingNetCredit);
  }
  if (askPerShare === null || askPerShare <= 0 || (bidPerShare !== null && askPerShare < bidPerShare)) {
    return unavailableClose('A usable current ask is unavailable, so the estimated buyback cannot be calculated.', effectiveSettings, quote, openingNetCredit);
  }

  const contracts = Math.abs(number(trade.contracts) ?? 0);
  const multiplier = number(trade.multiplier) ?? 100;
  const estimatedClosingFees = estimatedClosingFeePerContract * contracts;
  const estimatedBuybackDebit = askPerShare * multiplier * contracts + estimatedClosingFees;
  const profitIfClosed = openingNetCredit - estimatedBuybackDebit;
  const premiumCapture = profitIfClosed / openingNetCredit;
  const closeTarget = effectiveSettings.rules.closeAtProfitCapture;
  const signal = premiumCapture >= closeTarget;

  const underlyingPrice = number(quote?.underlying_price ?? trade.stockPrice);
  const strike = number(trade.strike);
  const dte = Number.isInteger(trade.dte) ? trade.dte : null;
  const daysHeld = calendarDays(trade.openedAt, now);
  const intrinsicPerShare = underlyingPrice === null || strike === null
    ? null
    : trade.type === 'csp' ? Math.max(strike - underlyingPrice, 0) : Math.max(underlyingPrice - strike, 0);
  const remainingExtrinsic = intrinsicPerShare === null ? null : Math.max(askPerShare - intrinsicPerShare, 0) * multiplier * contracts;
  const capitalAtRisk = underlyingPrice === null || strike === null
    ? null
    : (trade.type === 'csp' ? strike : underlyingPrice) * multiplier * contracts;
  const remainingReturnOnCapital = remainingExtrinsic === null || !capitalAtRisk ? null : remainingExtrinsic / capitalAtRisk;
  const openingNetCreditPerShare = contracts && multiplier ? openingNetCredit / (multiplier * contracts) : null;
  const shareCollateral = number(trade.collateral);
  const shareBasisPerShare = trade.type === 'cc' && contracts && multiplier && shareCollateral !== null
    ? shareCollateral / (multiplier * contracts)
    : null;
  const callBreakevenBasis = shareBasisPerShare && shareBasisPerShare > 0 ? shareBasisPerShare : underlyingPrice;
  const breakevenPrice = openingNetCreditPerShare === null || (trade.type === 'csp' && strike === null)
    ? null
    : trade.type === 'csp'
      ? strike - openingNetCreditPerShare
      : callBreakevenBasis === null ? null : callBreakevenBasis - openingNetCreditPerShare;
  const effectiveAssignmentPrice = strike === null || openingNetCreditPerShare === null
    ? null
    : trade.type === 'csp' ? strike - openingNetCreditPerShare : strike + openingNetCreditPerShare;
  const assignmentDistance = underlyingPrice === null || effectiveAssignmentPrice === null
    ? null
    : trade.type === 'csp' ? underlyingPrice - effectiveAssignmentPrice : effectiveAssignmentPrice - underlyingPrice;
  const itm = intrinsicPerShare !== null && intrinsicPerShare > 0;
  const bid = bidPerShare;
  const spread = bid === null ? null : askPerShare - bid;
  const midpoint = bid === null ? null : (askPerShare + bid) / 2;

  const metrics = {
    openingNetCredit: round(openingNetCredit),
    openingNetCreditPerShare: round(openingNetCreditPerShare),
    askPerShare: round(askPerShare),
    estimatedClosingFees: round(estimatedClosingFees),
    estimatedBuybackDebit: round(estimatedBuybackDebit),
    profitIfClosed: round(profitIfClosed),
    premiumCapture: round(premiumCapture),
    intrinsicPerShare: round(intrinsicPerShare),
    intrinsicValue: round(intrinsicPerShare === null ? null : intrinsicPerShare * multiplier * contracts),
    remainingExtrinsic: round(remainingExtrinsic),
    daysHeld,
    earnedPerDay: round(daysHeld ? profitIfClosed / daysHeld : null),
    remainingExtrinsicPerDay: round(remainingExtrinsic === null || dte === null ? null : remainingExtrinsic / Math.max(dte, 1)),
    capitalAtRisk: round(capitalAtRisk),
    remainingReturnOnCapital: round(remainingReturnOnCapital),
    remainingAnnualizedReturn: round(remainingReturnOnCapital === null || dte === null ? null : remainingReturnOnCapital * 365 / Math.max(dte, 1)),
    dte,
    moneyState: intrinsicPerShare === null ? null : (itm ? 'ITM' : 'OTM'),
    moneyAmountPerShare: round(intrinsicPerShare === null || underlyingPrice === null || strike === null ? null : Math.abs(underlyingPrice - strike)),
    moneyAmount: round(intrinsicPerShare === null || underlyingPrice === null || strike === null ? null : Math.abs(underlyingPrice - strike) * multiplier * contracts),
    moneyness: round(underlyingPrice && strike !== null ? strike / underlyingPrice : null),
    distanceFromStrike: round(underlyingPrice === null || strike === null ? null : underlyingPrice - strike),
    distanceFromStrikePercent: round(underlyingPrice && strike !== null ? (underlyingPrice - strike) / underlyingPrice : null),
    breakevenPrice: round(breakevenPrice),
    effectiveAssignmentPrice: round(effectiveAssignmentPrice),
    assignmentDistance: round(assignmentDistance),
    assignmentDistancePercent: round(underlyingPrice && assignmentDistance !== null ? assignmentDistance / underlyingPrice : null),
    assignmentDistanceLabel: trade.type === 'csp' ? 'breakevenCushion' : 'salePriceDistance',
    assignmentAlignment: assignmentAlignment(trade.type === 'csp' ? 'put' : 'call', effectiveSettings.goal),
    underlyingPrice: round(underlyingPrice),
    delta: number(quote?.delta),
    thetaPerDay: number(quote?.theta_per_day),
    impliedVolatility: number(quote?.implied_volatility),
    bidPerShare: bid,
    spreadPerShare: round(spread),
    spreadPercent: round(midpoint && spread !== null ? spread / midpoint : null),
    openInterest: number(quote?.open_interest),
    volume: number(quote?.volume),
  };
  return {
    available: true,
    signal,
    unavailableReason: null,
    metrics,
    conditions: [
      { key: 'openingNetCredit', actualValue: metrics.openingNetCredit, configuredValue: null, pass: true, settingsSource: 'positionHistory', decisive: false },
      { key: 'currentAsk', actualValue: metrics.askPerShare, configuredValue: null, pass: true, settingsSource: 'provider', decisive: false },
      { key: 'premiumCapture', actualValue: metrics.premiumCapture, configuredValue: closeTarget, pass: signal, settingsSource: effectiveSettings.sourceMap.closeAtProfitCapture, decisive: true },
    ],
  };
}
