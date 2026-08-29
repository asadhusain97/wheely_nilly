# Playbook-aware opportunity monitoring

Radar discovers eligible targets, resolves saved strategy settings on the Node backend, and sends only validated snake_case rules to the Python sidecar. The browser keeps the latest successful result for each ticker and strategy leg across reloads, then replaces it after a successful scan. A failed refresh retains and labels the previous result. Results for targets that are no longer eligible are removed. When alerts are enabled, the backend also runs market-hours scans and sends deduplicated ntfy notifications for the top passing candidate in each symbol and leg. It does not place orders, create open-contract recommendations, evaluate rolls, or compare historical scans.

## Target discovery

The backend builds one deduplicated record per symbol from:

- Current holdings with at least one uncovered 100-share lot.
- Saved ticker playbooks with covered calls enabled.
- Saved ticker playbooks with cash-secured puts enabled.

An owned symbol and a saved playbook merge into one target. Covered-call scans always receive the actual uncovered-share count from the dashboard projection; a tracked ticker without uncovered shares cannot pass share coverage. CSP scans receive current USD cash from that same projection, and each contract must fit the existing `strike × 100` cash-collateral convention.

The circular plus action in Radar opens a focused add sheet. A provider-backed search verifies the symbol and displays the instrument name and type before the user can continue. The user chooses a goal first. Keep Shares and Plan Exit infer CC, Plan Entry infers CSP, and Earn Income reveals a CC/CSP choice. Plan Entry is selected initially. Adding writes the playbook immediately through the Phase 1 `PUT /api/v1/strategy-settings` document contract, so it appears in Settings without a second settings store. The selected leg is enabled; a newly created playbook leaves the other leg disabled. Detailed customization remains in Settings.

## Effective rules and trust boundary

For every symbol and leg, Node loads Phase 1 settings and applies selected goal profile → ticker override resolution. Browser requests identify only `symbol` and `leg`; browser-supplied thresholds are rejected. The resolved camelCase fields are translated to the sidecar's validated snake_case fields.

Each successful result includes the complete effective settings, per-field `sourceMap`, grouped source summary, applicable rules, price guard, provider identity, unofficial-data flag, quote timestamp, cache state, assumptions, and named exclusion counts.

## Credits, fees, and price guards

The executable option price is an estimated per-share midpoint and is used only after the spread gate passes. With the standard 100-share multiplier:

```text
gross contract credit = executable option price per share × 100
net contract credit = gross contract credit − estimated contract fee
net credit per share = net contract credit ÷ 100
covered-call net sale price = strike + net credit per share
CSP breakeven price = strike − net credit per share
```

`minNetSalePriceMinor` rejects a covered call when its net sale price is too low. `maxNetPurchasePriceMinor` rejects a CSP when its breakeven price is too high. Both use premium after estimated fees. Broker cost basis remains visible for context but is not an implicit minimum sale price. Without a configured guard, calls retain the safe out-of-the-money default. A Plan Exit covered-call playbook may consider an ITM call only when it has an explicit minimum net sale guard, which the candidate must still pass.

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

Scan all computes one compatible DTE envelope per symbol. The sidecar shares an in-flight fetch and cached snapshot for requests using that envelope, so covered-call and CSP evaluation reuse one chain. Cache entries are used only within their TTL. Provider calls are bounded by the sidecar semaphore and backend scan workers. A failed symbol/leg returns an explicit error entry without candidates; successful targets remain visible and a failure is never converted to zero-valued metrics. A chain whose relevant contracts have no usable, timely bid-ask quote is unavailable rather than a successful empty result.

Yahoo Finance supplies option chains, underlying snapshots, and instrument search through the market-data provider boundary. Responses identify the provider that supplied each snapshot.

## Displayed metrics and sources

| Metric | Meaning and source |
| --- | --- |
| Contract symbol, option type, expiration, DTE, strike | Provider contract identity; DTE is calculated from expiration and evaluation date. |
| Underlying price | Yahoo Finance provider snapshot. |
| Bid, ask, volume, open interest, IV | Provider quote fields. Missing volume/OI remain unavailable. A missing field passes when its minimum is zero and is conservatively excluded when its configured minimum is positive. |
| Executable option price per share | Estimated bid/ask midpoint after the spread gate; not contract credit. |
| Gross contract credit | Executable per-share price × 100. |
| Estimated fees | Configured sidecar fee estimate; marked estimated. |
| Net contract credit | Gross contract credit less estimated fees; the primary credit displayed in collapsed results. |
| Period return | Calculated for the candidate's actual term and used as the primary return metric. |
| Annualized return | Simple period return × 365 ÷ DTE; shown only in expanded details. |
| Delta and theta/day | Black–Scholes estimates when the provider supplies usable IV, otherwise explicitly unavailable. `greekSource` identifies which. |
| Spread percent | `(ask − bid) ÷ midpoint`. |
| Underlying price and displayed time | Provider underlying price and trade timestamp in Eastern Time, labeled `ET`. The displayed time is market-data time, not scan time. |
| Option quote time and age | Provider option trade time, aged against the underlying market-data timestamp. The closing data clock remains fixed until the provider publishes the next session's data. A missing trade date is stale. Cache age is reported separately. |
| Breakeven | Put: strike less net credit per share. Call: broker cost basis when available (otherwise current underlying price) less net credit per share. The basis is informational and is never a sale-price gate. |
| Downside buffer | `(underlying − strike) ÷ underlying`. |
| Strike distance | `(strike − underlying) ÷ underlying`. |
| Net sale / breakeven price | Calculated from strike and net credit per share using the formulas above. |
| Applied rules and guard | Backend-resolved Phase 1 configuration, including source lineage. |
| Exclusion counts | Named hard-gate failures accumulated across evaluated contracts. |

The workspace distinguishes provider values, estimated execution/fees/Greeks, delayed data, stale quotes, and provider failures in plain wording.
