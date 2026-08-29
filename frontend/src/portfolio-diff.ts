import type { BrokerageSnapshot, PortfolioDiff, WheelyNillyPosition } from "./types";

const comparablePosition = (position: WheelyNillyPosition): string => JSON.stringify({
  quantity: position.quantity,
  price: position.price,
  costBasis: position.costBasis,
  option: position.option,
});

export function diffPortfolio(previous: BrokerageSnapshot | null, current: BrokerageSnapshot): PortfolioDiff {
  const before = new Map((previous?.positions ?? []).map((position) => [position.id, position]));
  const after = new Map(current.positions.map((position) => [position.id, position]));
  const previousOrders = new Set((previous?.recentOrders ?? []).map((order) => order.id));
  const addedPositionIds = [...after.keys()].filter((id) => !before.has(id));
  const removedPositionIds = [...before.keys()].filter((id) => !after.has(id));
  const changedPositionIds = [...after.entries()]
    .filter(([id, position]) => before.has(id) && comparablePosition(before.get(id)!) !== comparablePosition(position))
    .map(([id]) => id);
  const changedIds = new Set([...addedPositionIds, ...removedPositionIds, ...changedPositionIds]);
  const changedPositions = [...(previous?.positions ?? []), ...current.positions].filter((position) => changedIds.has(position.id));
  return {
    addedPositionIds: addedPositionIds.sort(),
    removedPositionIds: removedPositionIds.sort(),
    changedPositionIds: changedPositionIds.sort(),
    addedOrderIds: current.recentOrders.map((order) => order.id).filter((id) => !previousOrders.has(id)).sort(),
    affectedSymbols: [...new Set(changedPositions.map((position) => position.option?.underlying ?? position.symbol).filter(Boolean))].sort(),
    affectedContracts: [...new Set(changedPositions.map((position) => position.option?.symbol).filter((symbol): symbol is string => Boolean(symbol)))].sort(),
  };
}
