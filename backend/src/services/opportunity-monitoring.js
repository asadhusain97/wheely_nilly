import { z } from 'zod';

import { fromMinor } from '../lib/money.js';
import { resolveEffectiveSettings, tickerSymbolSchema } from './strategy-settings.js';

const targetInputSchema = z.object({
  symbol: tickerSymbolSchema,
  leg: z.enum(['coveredCall', 'cashSecuredPut']),
}).strict();

const SIDECAR_LEG = { coveredCall: 'covered_call', cashSecuredPut: 'cash_secured_put' };
const RULE_MAP = {
  minDte: 'min_dte', maxDte: 'max_dte', minMoneyness: 'min_moneyness', maxMoneyness: 'max_moneyness',
  targetDeltaMin: 'target_delta_min', targetDeltaMax: 'target_delta_max', maxSpreadPercent: 'max_spread_percent',
  minOpenInterest: 'min_open_interest', minVolume: 'min_volume',
  minPeriodReturn: 'min_period_return',
};

export class OpportunityMonitoringError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'OpportunityMonitoringError'; this.status = status; }
}

function sourceSummary(sourceMap) {
  return Object.entries(sourceMap).reduce((summary, [field, source]) => {
    summary[source].push(field);
    return summary;
  }, { system: [], goal: [], tickerOverride: [] });
}

export function toSidecarRequest(effective, portfolio, chainRange = null) {
  const request = { symbol: effective.symbol, leg: SIDECAR_LEG[effective.leg] };
  for (const [camel, snake] of Object.entries(RULE_MAP)) request[snake] = effective.rules[camel];
  request.cash_available = Number(portfolio.cashAvailable ?? 0);
  request.covered_shares = Number(portfolio.coveredShares ?? 0);
  request.adjusted_basis_per_share = portfolio.adjustedBasisPerShare == null ? null : Number(portfolio.adjustedBasisPerShare);
  request.min_net_sale_price = effective.leg === 'coveredCall' && effective.priceGuard.valueMinor != null
    ? Number(fromMinor(effective.priceGuard.valueMinor)) : null;
  request.max_net_purchase_price = effective.leg === 'cashSecuredPut' && effective.priceGuard.valueMinor != null
    ? Number(fromMinor(effective.priceGuard.valueMinor)) : null;
  request.allow_itm_calls = effective.leg === 'coveredCall' && effective.goal === 'exit' && request.min_net_sale_price != null;
  if (chainRange) {
    request.chain_min_dte = chainRange.minDte;
    request.chain_max_dte = chainRange.maxDte;
  }
  return request;
}

export function discoverOpportunityTargets(settings, dashboard) {
  const bySymbol = new Map();
  const stockPriceBySymbol = new Map((dashboard.tickerPerformance ?? [])
    .map((ticker) => [ticker.symbol, ticker.stockPrice]));
  const target = (symbol) => {
    if (!bySymbol.has(symbol)) bySymbol.set(symbol, {
      symbol, stockPrice: stockPriceBySymbol.get(symbol) ?? null,
      owned: false, manuallyTracked: false, uncoveredLots: 0, legs: [],
    });
    return bySymbol.get(symbol);
  };
  for (const holding of dashboard.opportunities?.coveredCalls ?? []) {
    Object.assign(target(holding.symbol), {
      owned: true, name: holding.name ?? null, instrumentType: holding.instrumentType ?? null,
      stockPrice: stockPriceBySymbol.get(holding.symbol) ?? holding.price ?? null,
      uncoveredLots: Number(holding.availableLots),
      adjustedBasisPerShare: holding.brokerCostBasis == null ? null : Number(holding.brokerCostBasis),
    });
  }
  for (const [symbol, playbook] of Object.entries(settings.tickerPlaybooks)) {
    const item = target(symbol);
    item.manuallyTracked = true;
    for (const leg of ['coveredCall', 'cashSecuredPut']) {
      if (playbook[leg].enabled && !item.legs.includes(leg)) item.legs.push(leg);
    }
  }
  for (const item of bySymbol.values()) {
    if (item.owned && item.uncoveredLots > 0 && !item.legs.includes('coveredCall')) item.legs.unshift('coveredCall');
    item.legs.sort((a, b) => ['coveredCall', 'cashSecuredPut'].indexOf(a) - ['coveredCall', 'cashSecuredPut'].indexOf(b));
  }
  return [...bySymbol.values()].filter((item) => item.legs.length).sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function portfolioFor(target, dashboard) {
  return {
    cashAvailable: dashboard.opportunities?.cashAvailable ?? 0,
    coveredShares: target?.uncoveredLots ? target.uncoveredLots * 100 : 0,
    adjustedBasisPerShare: target?.adjustedBasisPerShare ?? null,
  };
}

function decorateTarget(target, settings, dashboard) {
  return {
    ...target,
    legs: target.legs.map((leg) => {
      const effectiveSettings = resolveEffectiveSettings(settings, {
        symbol: target.symbol,
        leg,
        instrumentType: target.instrumentType,
      });
      return { leg, goal: effectiveSettings.goal, effectiveSettings: { ...effectiveSettings, sourceSummary: sourceSummary(effectiveSettings.sourceMap) } };
    }),
  };
}

export function createOpportunityMonitoringService({ derived, strategySettings, screener, maxConcurrency = 3 }) {
  const latestStockPrices = new Map();
  const withLatestStockPrice = (target) => ({
    ...target,
    stockPrice: latestStockPrices.get(target.symbol) ?? target.stockPrice,
  });

  async function context() {
    const [{ settings }, model] = await Promise.all([strategySettings.load(), derived.load()]);
    const targets = discoverOpportunityTargets(settings, model.dashboard)
      .map((item) => decorateTarget(item, settings, model.dashboard))
      .map(withLatestStockPrice);
    return { model, targets };
  }

  async function targets() {
    const current = await context();
    return {
      generatedAt: current.model.generatedAt,
      freshness: current.model.freshness,
      targets: current.targets,
    };
  }

  async function instruments(query) {
    return screener.searchInstruments(query);
  }

  async function runResolved(effective, target, dashboard, chainRange = null) {
    const sidecarRequest = toSidecarRequest(effective, portfolioFor(target, dashboard), chainRange);
    const result = await screener.screen(sidecarRequest);
    if (result.underlying_price != null) latestStockPrices.set(target.symbol, result.underlying_price);
    return {
      ...result,
      effectiveSettings: { ...effective, sourceSummary: sourceSummary(effective.sourceMap) },
    };
  }

  async function scan(input) {
    const parsed = targetInputSchema.safeParse(input);
    if (!parsed.success) throw new OpportunityMonitoringError(`Invalid scan target: ${parsed.error.issues[0].message}`);
    const current = await context();
    const target = current.targets.find((item) => item.symbol === parsed.data.symbol);
    const targetLeg = target?.legs.find((item) => item.leg === parsed.data.leg);
    if (!target || !targetLeg) throw new OpportunityMonitoringError('Ticker and strategy are not an eligible monitoring target');
    return runResolved(targetLeg.effectiveSettings, target, current.model.dashboard);
  }

  async function scanAll() {
    const current = await context();
    const jobs = current.targets.flatMap((target) => target.legs.map((leg) => ({ target, leg })));
    const ranges = new Map(current.targets.map((target) => {
      const rules = target.legs.map((leg) => leg.effectiveSettings.rules);
      return [target.symbol, { minDte: Math.min(...rules.map((item) => item.minDte)), maxDte: Math.max(...rules.map((item) => item.maxDte)) }];
    }));
    const results = Array(jobs.length);
    let next = 0;
    async function worker() {
      while (next < jobs.length) {
        const index = next++;
        const { target, leg } = jobs[index];
        try {
          results[index] = { symbol: target.symbol, leg: leg.leg, status: 'success', result: await runResolved(leg.effectiveSettings, target, current.model.dashboard, ranges.get(target.symbol)) };
        } catch (error) {
          results[index] = { symbol: target.symbol, leg: leg.leg, status: 'error', error: { code: 'SCREENER_UNAVAILABLE', message: error.message } };
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(maxConcurrency, jobs.length) }, worker));
    return {
      scannedAt: new Date().toISOString(), freshness: current.model.freshness,
      targets: current.targets.map(withLatestStockPrice), results,
    };
  }

  return { targets, instruments, scan, scanAll };
}
