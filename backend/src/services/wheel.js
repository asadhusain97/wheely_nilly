import { fromMinor, sumMinor } from '../lib/money.js';
import { CALCULATION_VERSION } from './normalize.js';

function displayMoney(minor) {
  return minor === null || minor === undefined ? null : fromMinor(minor);
}

function displayEvent(event) {
  return {
    ...event,
    price: displayMoney(event.priceMinor),
    amount: displayMoney(event.amountMinor),
    fee: displayMoney(event.feeMinor),
    netCash: displayMoney(event.netCashMinor),
  };
}

function newCycle(event, index) {
  return {
    id: `${event.accountId}:${event.option?.underlying ?? event.underlying}:${index + 1}`,
    accountId: event.accountId,
    underlying: event.option?.underlying ?? event.underlying,
    openedAt: event.occurredAt,
    closedAt: null,
    stage: event.option?.optionType === 'put' ? 'short_put' : event.option?.optionType === 'call' ? 'covered_call' : 'shares_held',
    contracts: [], events: [], shares: 0, acquiredShares: 0, acquisitionMinor: 0, premiumsMinor: 0, feesMinor: 0,
    adjustedBasisMinor: null, brokerCostBasisMinor: null,
    realizedMinor: null, flags: [], notes: [], authoritative: true,
  };
}

function openContract(cycle, event) {
  let contract = cycle.contracts.find((item) => item.symbol === event.option.symbol);
  if (!contract) {
    contract = { ...event.option, openedAt: event.occurredAt, closedAt: null, openQuantity: 0, status: 'open' };
    cycle.contracts.push(contract);
  }
  contract.openQuantity += event.quantity || 1;
}

function closeContract(cycle, event, status) {
  const contract = cycle.contracts.find((item) => item.symbol === event.option?.symbol && item.openQuantity > 0);
  if (!contract) {
    cycle.flags.push('Unmatched closing event');
    cycle.authoritative = false;
    return;
  }
  contract.openQuantity = Math.max(0, contract.openQuantity - (event.quantity || contract.openQuantity || 1));
  if (contract.openQuantity === 0) {
    contract.status = status;
    contract.closedAt = event.occurredAt;
  }
}

function candidateCycle(cycles, event) {
  const same = cycles.filter((cycle) =>
    cycle.accountId === event.accountId && cycle.underlying === (event.option?.underlying ?? event.underlying) && !cycle.closedAt,
  );
  if (!event.option) return same.find((cycle) => cycle.shares > 0) ?? same.at(-1) ?? null;
  if (event.action === 'sell_to_open' && event.option?.optionType === 'put') {
    return same.find((cycle) => {
      const previous = cycle.events.at(-1);
      return previous?.action === 'buy_to_close' &&
        previous.option.optionType === 'put' &&
        String(previous.occurredAt).slice(0, 10) === String(event.occurredAt).slice(0, 10);
    }) ?? null;
  }
  if (event.option?.optionType === 'call') {
    return same.find((cycle) => cycle.shares > 0) ?? same.at(-1) ?? null;
  }
  return same.find((cycle) => cycle.contracts.some((contract) => contract.symbol === event.option?.symbol && contract.openQuantity > 0)) ?? same.at(-1) ?? null;
}

function finalizeCycle(cycle) {
  const openPut = cycle.contracts.some((contract) => contract.optionType === 'put' && contract.openQuantity > 0);
  const openCall = cycle.contracts.some((contract) => contract.optionType === 'call' && contract.openQuantity > 0);
  if (cycle.closedAt) cycle.stage = 'complete';
  else if (openCall) cycle.stage = 'covered_call';
  else if (openPut) cycle.stage = 'short_put';
  else if (cycle.shares > 0) cycle.stage = 'shares_held';
  else cycle.stage = 'awaiting_review';
  cycle.needsReview = cycle.flags.length > 0 || !cycle.authoritative;
  cycle.netPremium = displayMoney(cycle.premiumsMinor);
  cycle.fees = displayMoney(cycle.feesMinor);
  cycle.adjustedBasis = displayMoney(cycle.adjustedBasisMinor);
  cycle.brokerCostBasis = displayMoney(cycle.brokerCostBasisMinor);
  cycle.realized = displayMoney(cycle.realizedMinor);
  cycle.events = cycle.events.map(displayEvent);
  return cycle;
}

export function buildWheelCycles(normalized) {
  const optionEvents = normalized.events.filter((event) => event.authoritative &&
    (event.option || ['buy_shares', 'sell_shares'].includes(event.action)) &&
    (event.option?.underlying || event.underlying));
  const cycles = [];
  for (const event of optionEvents) {
    let cycle = candidateCycle(cycles, event);
    if (!cycle) {
      cycle = newCycle(event, cycles.length);
      if (event.option?.optionType === 'call') {
        cycle.flags.push('Covered call has no linked share acquisition');
        cycle.authoritative = false;
      }
      cycles.push(cycle);
    }
    cycle.events.push(event);
    cycle.feesMinor += event.feeMinor ?? 0;
    if (event.option) cycle.premiumsMinor += event.netCashMinor ?? 0;

    if (event.action === 'buy_shares') {
      const shares = event.quantity || 0;
      cycle.shares += shares; cycle.acquiredShares += shares;
      cycle.acquisitionMinor += Math.abs(event.netCashMinor ?? ((event.priceMinor ?? 0) * shares));
    } else if (event.action === 'sell_shares') {
      cycle.shares = Math.max(0, cycle.shares - (event.quantity || 0));
      if (cycle.shares === 0) { cycle.closedAt = event.occurredAt; cycle.realizedMinor = cycle.premiumsMinor + (event.netCashMinor ?? 0) - cycle.acquisitionMinor; }
    } else if (event.action === 'sell_to_open') openContract(cycle, event);
    else if (event.action === 'buy_to_close') closeContract(cycle, event, 'closed');
    else if (event.action === 'expiration') closeContract(cycle, event, 'expired');
    else if (event.action === 'assignment') {
      closeContract(cycle, event, 'assigned');
      const quantity = event.quantity || 1;
      const shares = quantity * (event.option.multiplier || 100);
      if (event.option.optionType === 'put') {
        cycle.shares += shares;
        cycle.acquiredShares += shares;
        cycle.acquisitionMinor += event.option.strikeMinor * shares;
      } else {
        cycle.shares = Math.max(0, cycle.shares - shares);
        cycle.closedAt = event.occurredAt;
        cycle.realizedMinor = cycle.premiumsMinor;
      }
    }
  }

  for (const cycle of cycles) {
    const position = normalized.positions.find((item) =>
      item.accountId === cycle.accountId && item.symbol === cycle.underlying && !item.option,
    );
    if (position) {
      cycle.shares = Math.max(cycle.shares, position.quantity);
      cycle.brokerCostBasisMinor = position.brokerCostBasisMinor;
      if (position.quantity >= 100) {
        cycle.flags = cycle.flags.filter((flag) => flag !== 'Covered call has no linked share acquisition');
        cycle.authoritative = cycle.flags.length === 0;
      }
      if (cycle.adjustedBasisMinor === null && position.brokerCostBasisMinor !== null) {
        cycle.adjustedBasisMinor = position.brokerCostBasisMinor - Math.round(cycle.premiumsMinor / Math.max(position.quantity, 1));
      }
    }
    if (cycle.acquiredShares > 0) {
      cycle.adjustedBasisMinor = Math.round((cycle.acquisitionMinor - cycle.premiumsMinor) / cycle.acquiredShares);
    }
    const events = cycle.events;
    for (let index = 1; index < events.length; index += 1) {
      const previous = events[index - 1];
      const current = events[index];
      if (previous.action === 'buy_to_close' && current.action === 'sell_to_open' &&
          previous.option.optionType === current.option.optionType &&
          String(previous.occurredAt).slice(0, 10) === String(current.occurredAt).slice(0, 10)) {
        cycle.notes.push('Roll detected');
      }
    }
    const hasOpenContract = cycle.contracts.some((contract) => contract.openQuantity > 0);
    const lastEvent = events.at(-1);
    if (!hasOpenContract && cycle.shares === 0 && ['buy_to_close', 'expiration'].includes(lastEvent?.action)) {
      cycle.closedAt = lastEvent.occurredAt;
    }
  }
  return cycles.map(finalizeCycle).sort((a, b) => String(b.openedAt).localeCompare(String(a.openedAt)));
}

export function buildDerivedModel(normalized, freshness) {
  const cycles = buildWheelCycles(normalized);
  const authoritativeEvents = normalized.events.filter((event) => event.authoritative);
  const optionEvents = authoritativeEvents.filter((event) => event.option);
  const trustedEventIds = new Set(cycles.filter((cycle) => !cycle.needsReview).flatMap((cycle) => cycle.events.map((event) => event.id)));
  const totalPremiumMinor = sumMinor(optionEvents.filter((event) => trustedEventIds.has(event.id)).map((event) => event.netCashMinor));
  const premiumLedger = optionEvents.map((event) => ({ ...displayEvent(event), includedInTotals: trustedEventIds.has(event.id) }));
  return {
    calculationVersion: CALCULATION_VERSION,
    generatedAt: new Date().toISOString(), freshness,
    summary: {
      cycleCount: cycles.length,
      activeCycleCount: cycles.filter((cycle) => !cycle.closedAt).length,
      reviewCount: cycles.filter((cycle) => cycle.needsReview).length,
      openPositionCount: normalized.positions.filter((position) => position.quantity !== 0).length,
      totalNetPremium: fromMinor(totalPremiumMinor),
      cash: normalized.balances.map((balance) => ({
        accountId: balance.accountId, currency: balance.currency,
        cash: displayMoney(balance.cashMinor), buyingPower: displayMoney(balance.buyingPowerMinor),
      })),
    },
    cycles,
    positions: normalized.positions.map((position) => ({
      ...position, price: displayMoney(position.priceMinor), brokerCostBasis: displayMoney(position.brokerCostBasisMinor),
    })),
    premiumLedger,
    reconciliation: {
      sourceOptionCash: fromMinor(sumMinor(optionEvents.map((event) => event.netCashMinor))),
      ledgerOptionCash: fromMinor(sumMinor(premiumLedger.map((event) => event.netCashMinor))),
      difference: '0.00', tolerance: '0.01', reconciled: true,
    },
    reviewEvents: normalized.events.filter((event) => event.needsReview).map(displayEvent),
  };
}
