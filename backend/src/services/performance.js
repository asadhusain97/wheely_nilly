import { fromMinor, sumMinor } from '../lib/money.js';

const DAY_MS = 86_400_000;
const CLOSING_ACTIONS = new Set(['buy_to_close', 'expiration', 'assignment']);

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function eventQuantity(event, fallback = 1) {
  const quantity = Math.abs(Number(event.quantity ?? 0));
  return quantity > 0 ? quantity : fallback;
}

function buildOptionLots(events) {
  const queues = new Map();
  const closedTrades = [];
  let unmatchedCloseContracts = 0;
  const optionEvents = events.filter((event) => event.authoritative && event.option)
    .sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)) || a.id.localeCompare(b.id));

  for (const event of optionEvents) {
    const key = `${event.accountId}:${event.option.symbol}`;
    if (event.action === 'sell_to_open') {
      const quantity = eventQuantity(event);
      const queue = queues.get(key) ?? [];
      queue.push({
        option: event.option,
        openedAt: event.occurredAt,
        remainingQuantity: quantity,
        remainingOpeningNetMinor: Number.isSafeInteger(event.netCashMinor) ? event.netCashMinor : null,
      });
      queues.set(key, queue);
      continue;
    }
    if (!CLOSING_ACTIONS.has(event.action)) continue;

    const queue = queues.get(key) ?? [];
    const available = queue.reduce((total, lot) => total + lot.remainingQuantity, 0);
    let remainingQuantity = eventQuantity(event, available);
    let remainingClosingNetMinor = event.action === 'buy_to_close'
      ? (Number.isSafeInteger(event.netCashMinor) ? event.netCashMinor : null)
      : 0;
    const closingQuantity = remainingQuantity;

    while (remainingQuantity > 0 && queue.length) {
      const lot = queue[0];
      const matched = Math.min(remainingQuantity, lot.remainingQuantity);
      const openingNetMinor = lot.remainingOpeningNetMinor === null
        ? null
        : matched === lot.remainingQuantity
          ? lot.remainingOpeningNetMinor
          : Math.round((lot.remainingOpeningNetMinor / lot.remainingQuantity) * matched);
      const closingNetMinor = remainingClosingNetMinor === null
        ? null
        : matched === remainingQuantity
          ? remainingClosingNetMinor
          : Math.round((remainingClosingNetMinor / remainingQuantity) * matched);
      closedTrades.push({
        option: lot.option,
        quantity: matched,
        openedAt: lot.openedAt,
        closedAt: event.occurredAt,
        closeAction: event.action,
        openingNetMinor,
        closingNetMinor,
        profitMinor: openingNetMinor === null || closingNetMinor === null ? null : openingNetMinor + closingNetMinor,
      });
      lot.remainingQuantity -= matched;
      if (lot.remainingOpeningNetMinor !== null) lot.remainingOpeningNetMinor -= openingNetMinor;
      remainingQuantity -= matched;
      if (remainingClosingNetMinor !== null) remainingClosingNetMinor -= closingNetMinor;
      if (lot.remainingQuantity === 0) queue.shift();
    }
    unmatchedCloseContracts += remainingQuantity;
    if (closingQuantity === 0) unmatchedCloseContracts += 1;
  }

  return { closedTrades, openLots: [...queues.values()].flat(), unmatchedCloseContracts };
}

function collateralFor(option, quantity, equityBySymbol) {
  if (option.optionType === 'put') return option.strikeMinor * (option.multiplier || 100) * quantity;
  const equity = equityBySymbol.get(option.underlying);
  if (!Number.isSafeInteger(equity?.brokerCostBasisMinor)) return null;
  return equity.brokerCostBasisMinor * (option.multiplier || 100) * quantity;
}

function heldDays(openedAt, closedAt) {
  const opened = Date.parse(openedAt);
  const closed = Date.parse(closedAt);
  if (!Number.isFinite(opened) || !Number.isFinite(closed) || closed < opened) return null;
  return Math.max(1, Math.ceil((closed - opened) / DAY_MS));
}

function daysToExpiration(expiration, now) {
  const target = Date.parse(`${expiration}T00:00:00.000Z`);
  return Number.isFinite(target) ? Math.ceil((target - now.getTime()) / DAY_MS) : null;
}

function openingDetails(option, openLots) {
  const lots = openLots.filter((lot) => lot.option.symbol === option.symbol);
  return {
    quantity: lots.reduce((total, lot) => total + lot.remainingQuantity, 0),
    openingCreditMinor: lots.every((lot) => lot.remainingOpeningNetMinor !== null)
      ? sumMinor(lots.map((lot) => lot.remainingOpeningNetMinor))
      : null,
    openedAt: lots.map((lot) => lot.openedAt).filter(Boolean).sort()[0] ?? null,
  };
}

function performanceRates(trades) {
  const qualified = trades.filter((trade) => Number.isSafeInteger(trade.profitMinor)
    && Number.isSafeInteger(trade.collateralMinor) && trade.collateralMinor > 0 && trade.days);
  const profitMinor = sumMinor(qualified.map((trade) => trade.profitMinor));
  const collateralMinor = sumMinor(qualified.map((trade) => trade.collateralMinor));
  const collateralDaysMinor = qualified.reduce((total, trade) => total + trade.collateralMinor * trade.days, 0);
  return {
    qualified,
    profitMinor,
    collateralMinor,
    collateralDaysMinor,
    returnRate: collateralMinor ? round(profitMinor / collateralMinor) : null,
    annualizedReturnRate: collateralDaysMinor ? round((profitMinor * 365) / collateralDaysMinor) : null,
  };
}

function buildTickerPerformance({ closedTrades, openTrades, holdings, stockPriceBySymbol }) {
  const symbols = new Set([
    ...closedTrades.map((trade) => trade.option.underlying),
    ...openTrades.map((trade) => trade.symbol),
    ...holdings.map((holding) => holding.symbol),
  ].filter(Boolean));

  return [...symbols].map((symbol) => {
    const holding = holdings.find((item) => item.symbol === symbol) ?? null;
    const tickerClosedTrades = closedTrades.filter((trade) => trade.option.underlying === symbol);
    const tickerOpenTrades = openTrades.filter((trade) => trade.symbol === symbol);
    const rates = performanceRates(tickerClosedTrades);
    const bookedProfitMinor = sumMinor(tickerClosedTrades.map((trade) => trade.profitMinor));
    const closedCollateralMinor = sumMinor(tickerClosedTrades.map((trade) => trade.collateralMinor));
    const closedCspContracts = tickerClosedTrades.filter((trade) => trade.option.optionType === 'put')
      .reduce((total, trade) => total + trade.quantity, 0);
    const closedCcContracts = tickerClosedTrades.filter((trade) => trade.option.optionType === 'call')
      .reduce((total, trade) => total + trade.quantity, 0);
    const openCspContracts = tickerOpenTrades.filter((trade) => trade.type === 'csp')
      .reduce((total, trade) => total + trade.contracts, 0);
    const openCcContracts = tickerOpenTrades.filter((trade) => trade.type === 'cc')
      .reduce((total, trade) => total + trade.contracts, 0);

    const pastTrades = tickerClosedTrades.map((trade, index) => {
      const qualified = Number.isSafeInteger(trade.profitMinor) && Number.isSafeInteger(trade.collateralMinor)
        && trade.collateralMinor > 0 && trade.days;
      return {
        id: `${trade.option.symbol}:${trade.closedAt}:${index}`,
        type: trade.option.optionType === 'put' ? 'csp' : 'cc',
        contractSymbol: trade.option.symbol,
        contracts: trade.quantity,
        strike: fromMinor(trade.option.strikeMinor),
        expiration: trade.option.expiration,
        openedAt: trade.openedAt,
        closedAt: trade.closedAt,
        daysHeld: trade.days,
        closeAction: trade.closeAction,
        openingCredit: fromMinor(trade.openingNetMinor),
        closingCashFlow: fromMinor(trade.closingNetMinor),
        profit: fromMinor(trade.profitMinor),
        collateral: fromMinor(trade.collateralMinor),
        returnRate: qualified ? round(trade.profitMinor / trade.collateralMinor) : null,
        annualizedReturnRate: qualified ? round((trade.profitMinor * 365) / (trade.collateralMinor * trade.days)) : null,
        needsReview: !qualified,
      };
    }).sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt)) || a.contractSymbol.localeCompare(b.contractSymbol));

    return {
      symbol,
      instrumentType: holding?.instrumentType ?? null,
      stockPrice: fromMinor(stockPriceBySymbol.get(symbol)),
      bookedProfit: fromMinor(bookedProfitMinor),
      returnRate: rates.returnRate,
      annualizedReturnRate: rates.annualizedReturnRate,
      capitalInvolved: fromMinor(closedCollateralMinor),
      closedContracts: closedCspContracts + closedCcContracts,
      closedCspContracts,
      closedCcContracts,
      openContracts: openCspContracts + openCcContracts,
      openCspContracts,
      openCcContracts,
      openTrades: tickerOpenTrades,
      pastTrades,
      quality: {
        returnTradesIncluded: rates.qualified.length,
        returnTradesExcluded: tickerClosedTrades.length - rates.qualified.length,
        capitalNeedsReview: tickerClosedTrades.some((trade) => !Number.isSafeInteger(trade.collateralMinor)),
      },
    };
  }).sort((a, b) => Number(b.openContracts > 0) - Number(a.openContracts > 0) || a.symbol.localeCompare(b.symbol));
}

export function buildPerformanceDashboard(normalized, { now = new Date() } = {}) {
  const holdings = normalized.holdings ?? normalized.positions.filter((position) => !position.option && position.quantity >= 100);
  const optionPositions = normalized.optionPositions ?? normalized.positions.filter((position) => position.option && position.quantity !== 0);
  const shortOptions = optionPositions.filter((position) => position.quantity < 0 && ['put', 'call'].includes(position.option.optionType));
  const authoritativeOptionEvents = normalized.events.filter((event) => event.authoritative && event.option);
  const optionEventDates = authoritativeOptionEvents.map((event) => event.occurredAt).filter(Boolean).sort();
  const equityBySymbol = new Map(holdings.map((position) => [position.symbol, position]));
  const stockPriceBySymbol = new Map(holdings
    .filter((position) => Number.isSafeInteger(position.priceMinor))
    .map((position) => [position.symbol, position.priceMinor]));
  for (const quote of normalized.quotes ?? []) {
    if (Number.isSafeInteger(quote.lastTradePriceMinor)) stockPriceBySymbol.set(quote.symbol, quote.lastTradePriceMinor);
  }
  const { closedTrades, openLots, unmatchedCloseContracts } = buildOptionLots(normalized.events);

  const bookedProfitMinor = sumMinor(closedTrades.map((trade) => trade.profitMinor));
  const closedTradesWithMetrics = closedTrades.map((trade) => {
    const collateralMinor = collateralFor(trade.option, trade.quantity, equityBySymbol);
    const days = heldDays(trade.openedAt, trade.closedAt);
    return { ...trade, collateralMinor, days };
  });
  const rates = performanceRates(closedTradesWithMetrics);
  const openingCreditMinor = sumMinor(closedTrades.map((trade) => trade.openingNetMinor > 0 ? trade.openingNetMinor : 0));

  const cspPositions = shortOptions.filter((position) => position.option.optionType === 'put');
  const ccPositions = shortOptions.filter((position) => position.option.optionType === 'call');
  const cspCollateralMinor = sumMinor(cspPositions.map((position) => collateralFor(position.option, Math.abs(position.quantity), equityBySymbol)));
  const shareCapitalMinor = sumMinor(holdings.map((position) => Number.isSafeInteger(position.brokerCostBasisMinor)
    ? position.brokerCostBasisMinor * Math.floor(position.quantity / 100) * 100
    : null));

  const openTrades = shortOptions.map((position) => {
    const contracts = Math.abs(position.quantity);
    const opening = openingDetails(position.option, openLots);
    const openingMatchesPosition = opening.quantity === contracts;
    const collateralMinor = collateralFor(position.option, contracts, equityBySymbol);
    return {
      id: position.option.symbol,
      accountId: position.accountId,
      symbol: position.option.underlying,
      instrumentType: equityBySymbol.get(position.option.underlying)?.instrumentType ?? null,
      stockPrice: fromMinor(stockPriceBySymbol.get(position.option.underlying)),
      contractSymbol: position.option.symbol,
      type: position.option.optionType === 'put' ? 'csp' : 'cc',
      contracts,
      multiplier: position.option.multiplier || 100,
      strike: fromMinor(position.option.strikeMinor),
      expiration: position.option.expiration,
      dte: daysToExpiration(position.option.expiration, now),
      openedAt: opening.openedAt,
      openingCredit: fromMinor(openingMatchesPosition ? opening.openingCreditMinor : null),
      collateral: fromMinor(collateralMinor),
      needsReview: !openingMatchesPosition || opening.openingCreditMinor === null || collateralMinor === null,
    };
  }).sort((a, b) => String(a.expiration).localeCompare(String(b.expiration)) || a.type.localeCompare(b.type) || a.symbol.localeCompare(b.symbol));
  const tickerPerformance = buildTickerPerformance({
    closedTrades: closedTradesWithMetrics,
    openTrades,
    holdings,
    stockPriceBySymbol,
  });

  const coveredCallOpportunities = holdings.filter((position) => position.coveredCall.availableLots > 0)
    .map((position) => ({
      symbol: position.symbol,
      name: position.name,
      instrumentType: position.instrumentType,
      shares: position.quantity,
      availableLots: position.coveredCall.availableLots,
      price: fromMinor(position.priceMinor),
      brokerCostBasis: fromMinor(position.brokerCostBasisMinor),
    }));
  const cashAvailableMinor = sumMinor(normalized.balances.filter((balance) => balance.currency === 'USD').map((balance) => balance.cashMinor));
  const buyingPowerMinor = sumMinor(normalized.balances.filter((balance) => balance.currency === 'USD').map((balance) => balance.buyingPowerMinor));

  return {
    kpis: {
      bookedProfit: fromMinor(bookedProfitMinor),
      returnRate: rates.returnRate,
      annualizedReturnRate: rates.annualizedReturnRate,
      capitalVelocity: rates.collateralDaysMinor ? round((rates.profitMinor / rates.collateralDaysMinor) * 30 * 1000, 2) : null,
      premiumCaptureRate: openingCreditMinor ? round(bookedProfitMinor / openingCreditMinor) : null,
      wheelCapital: fromMinor(cspCollateralMinor + shareCapitalMinor),
      cspCollateral: fromMinor(cspCollateralMinor),
      shareCapital: fromMinor(shareCapitalMinor),
      openCspContracts: cspPositions.reduce((total, position) => total + Math.abs(position.quantity), 0),
      openCcContracts: ccPositions.reduce((total, position) => total + Math.abs(position.quantity), 0),
      nextExpiration: openTrades.map((trade) => trade.expiration).filter(Boolean).sort()[0] ?? null,
      contractsExpiringSoon: openTrades.filter((trade) => trade.dte !== null && trade.dte >= 0 && trade.dte <= 7)
        .reduce((total, trade) => total + trade.contracts, 0),
    },
    opportunities: {
      cashAvailable: fromMinor(cashAvailableMinor),
      buyingPower: fromMinor(buyingPowerMinor),
      coveredCalls: coveredCallOpportunities,
    },
    openTrades,
    tickerPerformance,
    quality: {
      optionEvents: authoritativeOptionEvents.length,
      historyStartsAt: optionEventDates[0] ?? null,
      historyEndsAt: optionEventDates.at(-1) ?? null,
      closedTrades: closedTrades.length,
      profitTradesIncluded: closedTrades.filter((trade) => Number.isSafeInteger(trade.profitMinor)).length,
      returnTradesIncluded: rates.qualified.length,
      returnTradesExcluded: closedTrades.length - rates.qualified.length,
      unmatchedCloseContracts,
    },
  };
}
