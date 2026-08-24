# Normalized Ledger Schema v1

Phase 2 derives a deterministic ledger from the latest immutable snapshots. Raw files remain the source of truth; normalized records are reproducible projections and retain `sourceId`, `sourceHash`, and `snapshotHash`.

Activity ingestion requests the full transaction history known to SnapTrade and paginates every result. Orders remain a recent, non-authoritative execution aid; they do not limit the authoritative activity ledger.

## Records

- `events`: brokerage activities and orders with account, UTC occurrence time, action, option contract, quantity, integer minor-unit price/amount/fee/net cash, and review status. Activities are authoritative cash facts; orders are retained as non-authoritative execution context to prevent double counting.
- `positions`: latest broker-reported equity or option quantity, price, and broker cost basis.
- `quotes`: latest refresh-time brokerage equity quote by account and ticker, including last trade, bid, ask, and snapshot time. Quotes may be delayed by the brokerage and are never polled continuously.
- `balances`: latest cash and buying power by account and currency.
- `cycles`: derived lifecycle groupings with contracts, shares, premiums, adjusted basis, realized state, supported notes, and ambiguity flags.

Option contracts retain the original provider symbol and parsed underlying, put/call type, strike in minor units, expiration, and multiplier. OCC parsing never replaces the original identifier.

## Accounting conventions

Money is parsed from provider decimal strings into integer cents. Net option cash is gross activity amount less fees. Strategy-adjusted per-share basis is assignment acquisition cost less cycle premiums, divided by acquired shares. Broker cost basis remains a separate field and label.

Only unambiguous cycle events enter authoritative headline premium totals. Ambiguous events remain visible in the premium ledger with `includedInTotals: false`. The derived model reports source-to-ledger option cash reconciliation with a one-cent tolerance.

The dashboard projection selects the account using current option positions first, then option history and eligible share lots as deterministic fallbacks. It retains every option position and option-linked event in that account, including cash-secured puts on underlyings that are not currently owned. The covered-call holdings projection remains limited to equities with at least 100 shares. Each holding reports its total 100-share lots, active short-call contracts and expirations, and remaining lots available for a covered call.

Calculation version `wheel-v2` pairs short-option opens and closes FIFO by OCC contract and quantity. Booked option profit includes only matched, closed quantities after fees; credit attached to an open quantity remains unrealized. Put collateral is strike × multiplier × contracts. Covered-call return collateral uses broker per-share cost basis × multiplier × contracts and is excluded when that basis is unavailable. Aggregate return on collateral is qualified realized profit divided by summed entry collateral. Annualized return uses capital-days: qualified realized profit ÷ Σ(collateral × days held / 365). Same-day trades use a minimum holding period of one day. The dashboard projection also emits the same metrics per ticker, current CSP/share capital, current contracts, and FIFO-matched closed-contract history so ticker totals reconcile with Home. The API reports calculation coverage and unmatched close quantities rather than silently estimating missing inputs.

## Migration approach

`schemaVersion` and `calculationVersion` are independent. A future schema change adds a new normalizer and migrator rather than mutating raw snapshots. Calculation-only changes increment `calculationVersion`; both old and new calculations can be regenerated from retained source hashes for golden comparison before promotion.
