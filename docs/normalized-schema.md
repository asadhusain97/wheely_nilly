# Normalized Ledger Schema v1

Phase 2 derives a deterministic ledger from the latest immutable snapshots. Raw files remain the source of truth; normalized records are reproducible projections and retain `sourceId`, `sourceHash`, and `snapshotHash`.

## Records

- `events`: brokerage activities and orders with account, UTC occurrence time, action, option contract, quantity, integer minor-unit price/amount/fee/net cash, and review status. Activities are authoritative cash facts; orders are retained as non-authoritative execution context to prevent double counting.
- `positions`: latest broker-reported equity or option quantity, price, and broker cost basis.
- `balances`: latest cash and buying power by account and currency.
- `cycles`: derived lifecycle groupings with contracts, shares, premiums, adjusted basis, realized state, supported notes, and ambiguity flags.

Option contracts retain the original provider symbol and parsed underlying, put/call type, strike in minor units, expiration, and multiplier. OCC parsing never replaces the original identifier.

## Accounting conventions

Money is parsed from provider decimal strings into integer cents. Net option cash is gross activity amount less fees. Strategy-adjusted per-share basis is assignment acquisition cost less cycle premiums, divided by acquired shares. Broker cost basis remains a separate field and label.

Only unambiguous cycle events enter authoritative headline premium totals. Ambiguous events remain visible in the premium ledger with `includedInTotals: false`. The derived model reports source-to-ledger option cash reconciliation with a one-cent tolerance.

The dashboard projection selects the account with open option positions and includes only its equity holdings with at least 100 shares. Each holding reports its total 100-share lots, active short-call contracts and expirations, and remaining lots available for a covered call. Cycles, ledger events, balances, and headline totals are scoped to that account and those eligible underlying symbols; other accounts and smaller holdings remain retained only in immutable raw snapshots.

## Migration approach

`schemaVersion` and `calculationVersion` are independent. A future schema change adds a new normalizer and migrator rather than mutating raw snapshots. Calculation-only changes increment `calculationVersion`; both old and new calculations can be regenerated from retained source hashes for golden comparison before promotion.
