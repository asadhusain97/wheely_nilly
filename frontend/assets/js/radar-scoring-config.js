/**
 * @typedef {'excellent'|'good'|'fair'|'poor'|'unknown'} LiquidityLabel
 * @typedef {'excellent'|'strong'|'good'|'marginal'} FitLabel
 * @typedef {'cashSecuredPut'|'coveredCall'} RadarLeg
 * @typedef {{ preferredDelta: number, preferredDte: number }} StrategyTargets
 * @typedef {{ excellent: number, good: number, fair: number, poor: number }} ComponentScores
 * @typedef {{ excellentMax: number, goodMax: number, fairMax: number, hardWarning: number }} SpreadThresholds
 * @typedef {{ excellentMin: number, goodMin: number, fairMin: number }} MinimumThresholds
 * @typedef {{ spread: number, openInterest: number, volume: number }} LiquidityWeights
 * @typedef {{ excellentMinScore: number, goodMinScore: number, fairMinScore: number }} LiquidityLabels
 * @typedef {{
 *   minimumMidpoint: number,
 *   spreadPercent: SpreadThresholds,
 *   openInterest: MinimumThresholds,
 *   volume: MinimumThresholds,
 *   weights: LiquidityWeights,
 *   labels: LiquidityLabels,
 *   componentScores: ComponentScores,
 *   unknownFitScore: number,
 * }} LiquidityConfig
 * @typedef {{ delta: number, dte: number, return: number, strikeCushion: number, liquidity: number }} FitWeights
 * @typedef {{ excellentMin: number, strongMin: number, goodMin: number }} FitLabels
 * @typedef {{
 *   liquidity: LiquidityConfig,
 *   premiumEfficiency: { rocPerDay: MinimumThresholds, configuredMinimumScore: number },
 *   strikeCushion: MinimumThresholds,
 *   targetFit: { idealScore: number, boundaryScore: number, missingScore: number },
 *   fit: { weights: FitWeights, labels: FitLabels },
 *   warnings: { nearBoundaryRatio: number },
 *   explanations: { maxItems: number, maxWarnings: number },
 *   strategyDefaults: Record<RadarLeg, StrategyTargets>,
 *   tickerOverrides: Record<string, object>,
 *   userPreferences: object,
 * }} RadarScoringConfig
 */

/**
 * Initial product defaults for Radar interpretation and ranking.
 *
 * These values express product behavior, not universal claims about option quality.
 * Keep eligibility rules in strategy settings. This config interprets and ranks the
 * contracts that already passed those rules.
 */
/** @satisfies {RadarScoringConfig} */
export const radarScoringConfig = Object.freeze({
  liquidity: Object.freeze({
    minimumMidpoint: 0.01,
    spreadPercent: Object.freeze({ excellentMax: 2, goodMax: 5, fairMax: 10, hardWarning: 15 }),
    openInterest: Object.freeze({ excellentMin: 2_000, goodMin: 500, fairMin: 100 }),
    volume: Object.freeze({ excellentMin: 500, goodMin: 100, fairMin: 20 }),
    weights: Object.freeze({ spread: 0.55, openInterest: 0.30, volume: 0.15 }),
    labels: Object.freeze({ excellentMinScore: 80, goodMinScore: 60, fairMinScore: 35 }),
    componentScores: Object.freeze({ excellent: 100, good: 75, fair: 45, poor: 15 }),
    unknownFitScore: 15,
  }),
  premiumEfficiency: Object.freeze({
    rocPerDay: Object.freeze({ excellentMin: 0.15, goodMin: 0.10, fairMin: 0.05 }),
    configuredMinimumScore: 70,
  }),
  strikeCushion: Object.freeze({ excellentMin: 10, goodMin: 7, fairMin: 4 }),
  targetFit: Object.freeze({ idealScore: 100, boundaryScore: 55, missingScore: 0 }),
  fit: Object.freeze({
    weights: Object.freeze({ delta: 0.25, dte: 0.15, return: 0.25, strikeCushion: 0.15, liquidity: 0.20 }),
    labels: Object.freeze({ excellentMin: 85, strongMin: 70, goodMin: 55 }),
  }),
  warnings: Object.freeze({ nearBoundaryRatio: 0.15 }),
  explanations: Object.freeze({ maxItems: 5, maxWarnings: 2 }),
  strategyDefaults: Object.freeze({
    cashSecuredPut: Object.freeze({ preferredDelta: 0.25, preferredDte: 30 }),
    coveredCall: Object.freeze({ preferredDelta: 0.25, preferredDte: 30 }),
  }),
  tickerOverrides: Object.freeze({}),
  userPreferences: Object.freeze({}),
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeConfig(base, override) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    merged[key] = isPlainObject(value) && isPlainObject(base?.[key])
      ? mergeConfig(base[key], value)
      : value;
  }
  return merged;
}

/**
 * Resolves the planned override order without coupling UI components to it.
 * Callers may pass ticker or user overrides before those settings have a persisted UI.
 *
 * @param {{ leg: RadarLeg, symbol?: string, tickerConfig?: object, userPreferences?: object }} input
 */
export function resolveRadarScoringConfig({ leg, symbol = '', tickerConfig = {}, userPreferences = {} }) {
  const withStrategy = mergeConfig(radarScoringConfig, {
    targets: radarScoringConfig.strategyDefaults[leg],
  });
  const configuredTicker = radarScoringConfig.tickerOverrides[symbol] ?? {};
  return mergeConfig(mergeConfig(mergeConfig(withStrategy, configuredTicker), tickerConfig),
    mergeConfig(radarScoringConfig.userPreferences, userPreferences));
}
