# Playbook-aware opportunity monitoring

Phase 2 changes Radar from a browser-configured, one-symbol form into an on-demand workspace. It discovers eligible targets, resolves saved strategy settings on the Node backend, and sends only validated snake_case rules to the Python sidecar. Results remain in browser memory and disappear on reload. There are no background scans, push notifications, orders, open-contract recommendations, roll evaluations, or historical comparisons.

## Target discovery

The backend builds one deduplicated record per symbol from:

- Current holdings with at least one uncovered 100-share lot.
- Saved ticker playbooks with covered calls enabled.
- Saved ticker playbooks with cash-secured puts enabled.

An owned symbol and a saved playbook merge into one target. Covered-call scans always receive the actual uncovered-share count from the dashboard projection; a tracked ticker without uncovered shares cannot pass share coverage. CSP scans receive current USD cash from that same projection, and each contract must fit the existing `strike × 100` cash-collateral convention.

The circular plus action in Radar opens a focused add sheet. A provider-backed search verifies the symbol and displays the instrument name and type before the user can continue. The user then chooses CC or CSP (CSP is the default) and a compatible goal. Adding writes the playbook immediately through the Phase 1 `PUT /api/v1/strategy-settings` document contract, so it appears in Settings without a second settings store. The selected leg is enabled; a newly created playbook leaves the other leg disabled. Detailed customization remains in Settings.

## Effective rules and trust boundary

For every symbol and leg, Node loads Phase 1 settings and applies global → selected goal preset → ticker override resolution. Browser requests identify only `symbol` and `leg`; browser-supplied thresholds are rejected. The resolved camelCase fields are translated to the sidecar's validated snake_case fields.

Each successful result includes the complete effective settings, per-field `sourceMap`, grouped source summary, applicable rules, price guard, option and underlying provider identities, unofficial/degraded flags, quote timestamp, cache state, assumptions, warning, and named exclusion counts.

## Credits, fees, and price guards

The executable option price is an estimated per-share midpoint and is used only after the spread gate passes. With the standard 100-share multiplier:

```text
gross contract credit = executable option price per share × 100
net contract credit = gross contract credit − estimated contract fee
net credit per share = net contract credit ÷ 100
covered-call net sale price = strike + net credit per share
CSP net purchase price = strike − net credit per share
```

`minNetSalePriceMinor` rejects a covered call when its net sale price is too low. `maxNetPurchasePriceMinor` rejects a CSP when its net purchase price is too high. Both use premium after estimated fees. Broker cost basis remains visible for context but is not an implicit minimum sale price. Without a configured guard, calls retain the safe out-of-the-money default. An Exit covered-call playbook may consider an ITM call only when it has an explicit minimum net sale guard, which the candidate must still pass.

`minPeriodReturn` is a hard gate after fees. Covered-call period return uses current value of 100 shares. CSP period return uses strike collateral less net contract credit. Annualized return is secondary and is not the primary opportunity label.

## Ranking

All hard gates run before ranking. Passing candidates use this deterministic order:

1. Usable delta before missing delta.
2. Absolute delta closest to the midpoint of the effective delta range.
3. DTE closest to the midpoint of the effective DTE range.
4. Higher period return.
5. Narrower bid/ask spread.
6. Expiration, strike, then contract symbol as stable tie-breakers.

There is no composite score.

## Provider and caching behavior

Scan all computes one compatible DTE envelope per symbol. The sidecar shares an in-flight fetch and cached snapshot for requests using that envelope, so covered-call and CSP evaluation reuse one chain. Existing TTL and stale-cache fallback behavior remain. Provider calls are bounded by the sidecar semaphore and backend scan workers. A failed symbol/leg returns an explicit error entry without candidates; successful targets remain visible and a failure is never converted to zero-valued metrics.

Alpha Vantage is the primary option-chain provider and receives one `REALTIME_OPTIONS` request per uncached fetch. Yahoo Finance supplies the underlying stock price. If Alpha Vantage cannot return a usable option chain, Yahoo Finance supplies both the fallback option chain and the underlying price.

## Displayed metrics and sources

| Metric | Meaning and source |
| --- | --- |
| Contract symbol, option type, expiration, DTE, strike | Provider contract identity; DTE is calculated from expiration and evaluation date. |
| Underlying price | Yahoo Finance snapshot. |
| Bid, ask, volume, open interest, IV | Provider quote fields. Missing volume/OI are evaluated as zero for hard gates and remain visibly unavailable. |
| Executable option price per share | Estimated bid/ask midpoint after the spread gate; not contract credit. |
| Gross contract credit | Executable per-share price × 100. |
| Estimated fees | Configured sidecar fee estimate; marked estimated. |
| Net contract credit | Gross contract credit less estimated fees; the primary credit displayed in collapsed results. |
| Period return | Calculated for the candidate's actual term and used as the primary return metric. |
| Annualized return | Simple period return × 365 ÷ DTE; shown only in expanded details. |
| Delta and theta/day | Provider Greeks when both are usable; otherwise Black–Scholes estimates, or explicitly unavailable. `greekSource` identifies which. |
| Spread percent | `(ask − bid) ÷ midpoint`. |
| Quote time and age | Provider quote timestamp and calculated elapsed seconds. Cache age is reported separately. |
| Breakeven | Put: net purchase price. Call: broker cost basis when available (otherwise current underlying price) less net credit per share. The basis is informational and is never a sale-price gate. |
| Downside buffer | `(underlying − strike) ÷ underlying`. |
| Strike distance | `(strike − underlying) ÷ underlying`. |
| Net sale / purchase price | Calculated from strike and net credit per share using the formulas above. |
| Applied rules and guard | Backend-resolved Phase 1 configuration, including source lineage. |
| Exclusion counts | Named hard-gate failures accumulated across evaluated contracts. |

The workspace distinguishes provider values, estimated execution/fees/Greeks, degraded or unofficial data, stale quotes/cache, and provider failures in plain wording.
