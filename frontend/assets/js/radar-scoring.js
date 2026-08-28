import { resolveRadarScoringConfig } from './radar-scoring-config.js';

const finite = (value) => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const rounded = (value, digits = 2) => Number(value.toFixed(digits));
const percentPoints = (fraction) => finite(fraction) == null ? null : rounded(finite(fraction) * 100, 10);

/** @typedef {'info'|'warning'|'critical'} WarningSeverity */
/** @typedef {{ type: string, severity: WarningSeverity, message: string, metric?: string, value?: number }} TradeWarning */
/** @typedef {{ type: string, title: string, message: string, priority: number, tone: 'positive'|'neutral'|'warning'|'critical' }} TradeReason */

function highIsGoodBand(value, thresholds, scores) {
  if (value >= thresholds.excellentMin) return { label: 'excellent', score: scores.excellent };
  if (value >= thresholds.goodMin) return { label: 'good', score: scores.good };
  if (value >= thresholds.fairMin) return { label: 'fair', score: scores.fair };
  return { label: 'poor', score: scores.poor };
}

function lowIsGoodBand(value, thresholds, scores) {
  if (value <= thresholds.excellentMax) return { label: 'excellent', score: scores.excellent };
  if (value <= thresholds.goodMax) return { label: 'good', score: scores.good };
  if (value <= thresholds.fairMax) return { label: 'fair', score: scores.fair };
  return { label: 'poor', score: scores.poor };
}

export function calculateSpreadPercent({ bid, ask }, config) {
  const cleanBid = finite(bid);
  const cleanAsk = finite(ask);
  if (cleanBid == null || cleanAsk == null) return { valid: false, value: null, reason: 'missing_quote' };
  if (cleanBid <= 0 || cleanAsk <= 0) return { valid: false, value: null, reason: 'nonpositive_quote' };
  if (cleanAsk < cleanBid) return { valid: false, value: null, reason: 'crossed_market' };
  const midpoint = (cleanBid + cleanAsk) / 2;
  if (midpoint < config.liquidity.minimumMidpoint) return { valid: false, value: null, reason: 'small_midpoint' };
  return { valid: true, value: ((cleanAsk - cleanBid) / midpoint) * 100, midpoint };
}

export function calculateLiquidity(market, config) {
  const spread = calculateSpreadPercent(market, config);
  const openInterest = finite(market.openInterest);
  const volume = finite(market.volume);
  const missing = [];
  if (!spread.valid) missing.push('bid/ask');
  if (openInterest == null) missing.push('open interest');
  if (volume == null) missing.push('volume');
  if (missing.length) {
    return {
      score: null,
      label: 'unknown',
      factors: {
        spread: { score: null, label: 'unknown', value: spread.value, valid: spread.valid, reason: spread.reason },
        openInterest: { score: null, label: 'unknown', value: openInterest },
        volume: { score: null, label: 'unknown', value: volume },
      },
      warnings: [{ type: 'missing_market_data', severity: 'warning', message: `Liquidity is unknown because ${missing.join(', ')} data is unavailable.` }],
    };
  }

  const scores = config.liquidity.componentScores;
  const spreadFactor = { ...lowIsGoodBand(spread.value, config.liquidity.spreadPercent, scores), value: spread.value, valid: true };
  const openInterestFactor = { ...highIsGoodBand(openInterest, config.liquidity.openInterest, scores), value: openInterest };
  const volumeFactor = { ...highIsGoodBand(volume, config.liquidity.volume, scores), value: volume };
  const weights = config.liquidity.weights;
  const score = rounded(spreadFactor.score * weights.spread + openInterestFactor.score * weights.openInterest + volumeFactor.score * weights.volume);
  const labels = config.liquidity.labels;
  let label = score >= labels.excellentMinScore ? 'excellent'
    : score >= labels.goodMinScore ? 'good'
      : score >= labels.fairMinScore ? 'fair' : 'poor';
  const warnings = [];

  if (spread.value > config.liquidity.spreadPercent.hardWarning && ['excellent', 'good'].includes(label)) label = 'fair';
  if (openInterest === 0 && label === 'excellent') label = 'good';
  if (spread.value > config.liquidity.spreadPercent.hardWarning) {
    warnings.push({ type: 'wide_spread', severity: 'critical', message: `${spread.value.toFixed(1)}% bid/ask spread may make execution difficult.`, metric: 'spreadPercent', value: spread.value });
  } else if (spread.value > config.liquidity.spreadPercent.goodMax) {
    warnings.push({ type: 'wide_spread', severity: 'warning', message: `${spread.value.toFixed(1)}% bid/ask spread may require careful limit pricing.`, metric: 'spreadPercent', value: spread.value });
  }
  if (openInterest < config.liquidity.openInterest.fairMin) {
    warnings.push({ type: 'low_open_interest', severity: openInterest === 0 ? 'critical' : 'warning', message: `${openInterest.toLocaleString('en-US')} open contracts provide limited market depth.`, metric: 'openInterest', value: openInterest });
  }
  if (volume < config.liquidity.volume.fairMin) {
    warnings.push({ type: 'low_volume', severity: 'info', message: `${volume.toLocaleString('en-US')} contracts traded today.`, metric: 'volume', value: volume });
  }
  return {
    score,
    label,
    factors: { spread: spreadFactor, openInterest: openInterestFactor, volume: volumeFactor },
    warnings,
  };
}

export function calculateReturnMetrics(candidate) {
  const netCredit = finite(candidate.net_contract_credit);
  const dte = finite(candidate.dte);
  const canonicalRoc = percentPoints(candidate.period_return);
  const roc = canonicalRoc ?? (() => {
    const strike = finite(candidate.strike);
    if (netCredit == null || strike == null) return null;
    const capital = candidate.option_type === 'put' ? strike * 100 - netCredit : finite(candidate.underlying_price) * 100;
    return capital > 0 ? (netCredit / capital) * 100 : null;
  })();
  const capitalRequired = netCredit != null && roc != null && roc > 0 ? netCredit / (roc / 100) : null;
  return {
    netCredit,
    roc,
    rocPerDay: roc != null && dte > 0 ? rounded(roc / dte, 10) : null,
    annualizedReturn: percentPoints(candidate.annualized_return) ?? (roc != null && dte > 0 ? roc * 365 / dte : null),
    capitalRequired,
  };
}

export function calculateStrikeDistance({ optionType, strike, currentPrice }) {
  const cleanStrike = finite(strike);
  const cleanPrice = finite(currentPrice);
  if (cleanStrike == null || cleanPrice == null || cleanPrice <= 0) return { percent: null, label: 'Unavailable' };
  const distance = optionType === 'call'
    ? ((cleanStrike - cleanPrice) / cleanPrice) * 100
    : ((cleanPrice - cleanStrike) / cleanPrice) * 100;
  const absolute = Math.abs(distance).toFixed(1);
  const label = optionType === 'call'
    ? (distance >= 0 ? `${absolute}% upside` : `${absolute}% below spot`)
    : (distance >= 0 ? `${absolute}% cushion` : `${absolute}% above spot`);
  return { percent: distance, label };
}

function targetWithBounds(preferred, minimum, maximum) {
  if (minimum != null && maximum != null) return clamp(preferred ?? (minimum + maximum) / 2, minimum, maximum);
  if (minimum != null) return Math.max(preferred ?? minimum, minimum);
  if (maximum != null) return Math.min(preferred ?? maximum, maximum);
  return preferred;
}

export function calculateTargetFit(value, range, config) {
  const cleanValue = finite(value);
  const minimum = finite(range.min);
  const maximum = finite(range.max);
  const target = finite(range.target);
  if (cleanValue == null || target == null) return { score: config.targetFit.missingScore, target, position: 'missing' };
  if (minimum != null && cleanValue < minimum) return { score: config.targetFit.missingScore, target, position: 'below' };
  if (maximum != null && cleanValue > maximum) return { score: config.targetFit.missingScore, target, position: 'above' };
  const edge = cleanValue <= target ? minimum : maximum;
  if (edge == null || edge === target) return { score: config.targetFit.idealScore, target, position: 'inside' };
  const ratio = clamp(Math.abs(cleanValue - target) / Math.abs(edge - target), 0, 1);
  const score = config.targetFit.idealScore - ratio * (config.targetFit.idealScore - config.targetFit.boundaryScore);
  return { score: rounded(score), target, position: 'inside' };
}

export function calculateDeltaFit(delta, rules, config) {
  const value = finite(delta);
  const absolute = value == null ? null : Math.abs(value);
  const configuredMinimum = finite(rules?.targetDeltaMin);
  const configuredMaximum = finite(rules?.targetDeltaMax);
  const minimum = configuredMinimum ?? 0;
  const maximum = configuredMaximum ?? 1;
  const target = targetWithBounds(config.targets.preferredDelta, minimum, maximum);
  return { value: absolute, ...calculateTargetFit(absolute, { min: minimum, target, max: maximum }, config) };
}

export function calculateDteFit(dte, rules, config) {
  const minimum = finite(rules?.minDte);
  const maximum = finite(rules?.maxDte);
  const target = targetWithBounds(config.targets.preferredDte, minimum, maximum);
  return { value: finite(dte), ...calculateTargetFit(dte, { min: minimum, target, max: maximum }, config) };
}

function calculateReturnFit(returnMetrics, minimumRoc, config) {
  if (returnMetrics.roc == null || returnMetrics.rocPerDay == null) return { score: config.targetFit.missingScore, label: 'unknown' };
  const minimum = percentPoints(minimumRoc) ?? 0;
  if (minimum > 0) {
    const ratio = returnMetrics.roc / minimum;
    const score = ratio >= 1
      ? config.premiumEfficiency.configuredMinimumScore + Math.min(1, ratio - 1) * (config.targetFit.idealScore - config.premiumEfficiency.configuredMinimumScore)
      : ratio * config.premiumEfficiency.configuredMinimumScore;
    return { score: rounded(score), label: ratio >= 1 ? 'meets_minimum' : 'below_minimum', minimumRoc: minimum };
  }
  const band = highIsGoodBand(returnMetrics.rocPerDay, config.premiumEfficiency.rocPerDay, config.liquidity.componentScores);
  return { ...band, minimumRoc: minimum };
}

function strikePreferenceRange(optionType, rules) {
  const minimumMoneyness = finite(rules?.minMoneyness);
  const maximumMoneyness = finite(rules?.maxMoneyness);
  if (optionType === 'put' && minimumMoneyness != null && minimumMoneyness <= 1) {
    return { min: 0, target: ((1 - minimumMoneyness) * 100) / 2, max: (1 - minimumMoneyness) * 100 };
  }
  if (optionType === 'call' && maximumMoneyness != null && maximumMoneyness >= 1) {
    return { min: 0, target: ((maximumMoneyness - 1) * 100) / 2, max: (maximumMoneyness - 1) * 100 };
  }
  return null;
}

function calculateStrikeCushionFit(distance, optionType, rules, config) {
  if (distance == null) return { score: config.targetFit.missingScore, label: 'unknown' };
  const preference = strikePreferenceRange(optionType, rules);
  if (preference) return { ...calculateTargetFit(distance, preference, config), label: 'configured_target' };
  return highIsGoodBand(distance, config.strikeCushion, config.liquidity.componentScores);
}

export function fitLabel(score, config) {
  if (score >= config.fit.labels.excellentMin) return 'excellent';
  if (score >= config.fit.labels.strongMin) return 'strong';
  if (score >= config.fit.labels.goodMin) return 'good';
  return 'marginal';
}

function nearBoundary(value, minimum, maximum, ratio) {
  if (value == null || minimum == null || maximum == null || maximum <= minimum) return false;
  const boundaryDistance = Math.min(value - minimum, maximum - value);
  return boundaryDistance >= 0 && boundaryDistance <= (maximum - minimum) * ratio;
}

export function generateTradeWarnings({ candidate, rules, liquidity, returnMetrics, strikeDistance }, config) {
  const warnings = [...liquidity.warnings];
  const delta = finite(candidate.delta) == null ? null : Math.abs(finite(candidate.delta));
  const deltaMin = finite(rules?.targetDeltaMin);
  const deltaMax = finite(rules?.targetDeltaMax);
  if (delta == null) warnings.push({ type: 'missing_market_data', severity: 'warning', message: 'Delta is unavailable for this contract.' });
  else if ((deltaMin != null && delta < deltaMin) || (deltaMax != null && delta > deltaMax)) {
    warnings.push({ type: 'outside_preferred_delta', severity: 'warning', message: `${delta.toFixed(2)} delta is outside your configured range.` });
  } else if (nearBoundary(delta, deltaMin, deltaMax, config.warnings.nearBoundaryRatio)) {
    warnings.push({ type: 'near_delta_boundary', severity: 'info', message: `${delta.toFixed(2)} delta is near the edge of your configured range.` });
  }
  const dte = finite(candidate.dte);
  if ((finite(rules?.minDte) != null && dte < finite(rules.minDte)) || (finite(rules?.maxDte) != null && dte > finite(rules.maxDte))) {
    warnings.push({ type: 'outside_preferred_dte', severity: 'warning', message: `${dte} DTE is outside your configured window.` });
  }
  const minimumRoc = percentPoints(rules?.minPeriodReturn);
  if (minimumRoc != null && returnMetrics.roc != null && returnMetrics.roc < minimumRoc) {
    warnings.push({ type: 'low_return', severity: 'warning', message: `${returnMetrics.roc.toFixed(2)}% ROC is below your ${minimumRoc.toFixed(2)}% minimum.` });
  }
  if (strikeDistance.percent != null && strikeDistance.percent < config.strikeCushion.fairMin) {
    warnings.push({ type: 'low_strike_cushion', severity: 'info', message: `${strikeDistance.label} leaves less room than the general ${config.strikeCushion.fairMin}% reference band.` });
  }
  return [...new Map(warnings.map((warning) => [`${warning.type}:${warning.message}`, warning])).values()];
}

export function generateTradeReasons({ candidate, symbol, rules, deltaFit, dteFit, returnMetrics, returnFit, strikeDistance, liquidity, warnings }, config) {
  const reasons = [];
  const delta = deltaFit.value;
  if (delta != null) {
    const min = finite(rules?.targetDeltaMin);
    const max = finite(rules?.targetDeltaMax);
    const range = min != null && max != null ? ` inside your ${min.toFixed(2)}–${max.toFixed(2)} range` : ` near your preferred ${deltaFit.target.toFixed(2)} delta`;
    reasons.push({ type: 'delta', title: 'Delta', message: `${delta.toFixed(2)} is${range}.`, priority: 100, tone: 'positive' });
  }
  if (returnMetrics.roc != null) {
    const minimum = returnFit.minimumRoc ?? 0;
    const message = minimum > 0
      ? `${returnMetrics.roc.toFixed(2)}% ROC ${returnMetrics.roc >= minimum ? 'clears' : 'falls below'} your ${minimum.toFixed(2)}% minimum.`
      : `${returnMetrics.roc.toFixed(2)}% ROC over ${candidate.dte} days.`;
    reasons.push({ type: 'return', title: 'Return', message, priority: 95, tone: returnFit.score >= config.fit.labels.goodMin ? 'positive' : 'neutral' });
  }
  if (strikeDistance.percent != null) {
    const side = candidate.option_type === 'put' ? 'below' : strikeDistance.percent >= 0 ? 'above' : 'below';
    reasons.push({ type: 'cushion', title: candidate.option_type === 'put' ? 'Cushion' : 'Strike room', message: `Strike sits ${Math.abs(strikeDistance.percent).toFixed(1)}% ${side} ${symbol}'s current price.`, priority: 85, tone: 'positive' });
  }
  const openInterest = finite(candidate.open_interest);
  if (openInterest != null && openInterest >= config.liquidity.openInterest.goodMin) {
    reasons.push({ type: 'market_interest', title: 'Market interest', message: `${openInterest.toLocaleString('en-US')} open contracts provide healthy depth.`, priority: 75, tone: 'positive' });
  }
  if (dteFit.score >= config.fit.labels.strongMin) {
    reasons.push({ type: 'dte', title: 'Timing', message: `${candidate.dte} DTE is close to your preferred ${dteFit.target}-day term.`, priority: 65, tone: 'positive' });
  }
  const warningReasons = warnings.map((warning) => ({
    type: warning.type,
    title: warning.type === 'wide_spread' ? 'Execution' : warning.type === 'missing_market_data' ? 'Market data' : 'Caution',
    message: warning.message,
    priority: warning.severity === 'critical' ? 110 : warning.severity === 'warning' ? 90 : 55,
    tone: warning.severity === 'critical' ? 'critical' : 'warning',
  })).slice(0, config.explanations.maxWarnings);
  return [...reasons, ...warningReasons]
    .sort((left, right) => right.priority - left.priority || left.type.localeCompare(right.type))
    .slice(0, config.explanations.maxItems);
}

function strategySummary(label, returnFit, warnings, config) {
  if (warnings.some((warning) => warning.severity === 'critical')) return 'Fits parts of your strategy, but execution needs review.';
  if (['excellent', 'strong'].includes(label) && returnFit.score >= config.fit.labels.goodMin) return 'Good premium for your configured target risk.';
  if (label === 'good') return 'A reasonable match with a few trade-offs.';
  return 'Eligible, but farther from your preferred setup.';
}

export function createRadarCandidateViewModel(candidate, result, index = 0, overrides = {}) {
  const leg = result.leg === 'covered_call' || candidate.option_type === 'call' ? 'coveredCall' : 'cashSecuredPut';
  const config = resolveRadarScoringConfig({ leg, symbol: result.symbol, ...overrides });
  const rules = result.effectiveSettings?.rules ?? {};
  const returnMetrics = calculateReturnMetrics(candidate);
  const strikeDistance = calculateStrikeDistance({ optionType: candidate.option_type, strike: candidate.strike, currentPrice: candidate.underlying_price ?? result.underlying_price });
  const liquidity = calculateLiquidity({ bid: candidate.bid, ask: candidate.ask, openInterest: candidate.open_interest, volume: candidate.volume }, config);
  const deltaFit = calculateDeltaFit(candidate.delta, rules, config);
  const dteFit = calculateDteFit(candidate.dte, rules, config);
  const returnFit = calculateReturnFit(returnMetrics, rules.minPeriodReturn, config);
  const strikeCushionFit = calculateStrikeCushionFit(strikeDistance.percent, candidate.option_type, rules, config);
  const components = {
    delta: deltaFit.score,
    dte: dteFit.score,
    return: returnFit.score,
    strikeCushion: strikeCushionFit.score,
    liquidity: liquidity.score ?? config.liquidity.unknownFitScore,
  };
  const score = rounded(Object.entries(config.fit.weights).reduce((total, [key, weight]) => total + components[key] * weight, 0));
  const label = fitLabel(score, config);
  const warnings = generateTradeWarnings({ candidate, rules, liquidity, returnMetrics, strikeDistance }, config);
  const reasons = generateTradeReasons({ candidate, symbol: result.symbol, rules, deltaFit, dteFit, returnMetrics, returnFit, strikeDistance, liquidity, warnings }, config);
  return {
    rank: index + 1,
    originalIndex: index,
    symbol: result.symbol,
    strike: candidate.strike,
    optionType: candidate.option_type,
    expiration: candidate.expiration,
    dte: candidate.dte,
    reward: returnMetrics,
    risk: { delta: deltaFit.value, strikeDistancePercent: strikeDistance.percent, strikeDistanceLabel: strikeDistance.label },
    execution: { liquidityScore: liquidity.score, liquidityLabel: liquidity.label, factors: liquidity.factors },
    strategyFit: { score, label, components, summary: strategySummary(label, returnFit, warnings, config) },
    tradeQuality: { premiumEfficiency: returnFit, liquidity },
    reasons,
    warnings,
    rawMetrics: { ...candidate },
  };
}

export function prepareRadarCandidates(result, overrides = {}) {
  return (result.candidates ?? [])
    .map((candidate, index) => createRadarCandidateViewModel(candidate, result, index, overrides))
    .sort((left, right) => right.strategyFit.score - left.strategyFit.score
      || left.originalIndex - right.originalIndex
      || String(left.rawMetrics.contract_symbol).localeCompare(String(right.rawMetrics.contract_symbol)))
    .map((viewModel, index) => ({ ...viewModel, rank: index + 1 }));
}
