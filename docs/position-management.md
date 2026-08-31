# Position management, Close guidance, and roll review

The home page evaluates every derived open short call and put in place. It does not build a second position list or match opening lots again. The backend uses the dashboard's existing open-trade projection, including its aggregate opening net credit and earliest matched opening date.

Close and roll guidance are analysis only. The card explains the current decision and never places or prepares an order. Roll review stays on Home because it manages an existing contract; Radar remains dedicated to finding a new wheel trade.

The collapsed card is a decision summary. Its order is contract identity, current stock price, effective goal, recommendation with a roll-candidate link below its reason, two economics metrics, premium-capture progress, and a centered disclosure chevron. Identity includes ticker, strategy, strike, option type, expiration, DTE, quantity, and goal. The binary Close result maps to `Hold` when the target is not met, `Close candidate` when it is met, and `Review now` when the required inputs are unavailable. A goal-aware roll state can replace that label only when a roll condition is active. The visible reason states why the decision applies.

The economics row promotes estimated P/L if closed and earned per day. A progress bar marks the effective `closeAtProfitCapture` setting and turns green only when the existing Close signal passes. The expanded area does not repeat collapsed values. It starts with profit-target, assignment-risk, exit-liquidity, and conditional roll-decision interpretations. One audit grid then shows premium received, buyback estimate, collateral, breakeven, bid/ask with spread context, delta, and implied volatility. Empty optional metrics are omitted. Metric labels continue to open the glossary where a matching term exists.

## Goal-aware roll review

Roll conditions are derived locally from the current position, its exact-contract metrics, and the effective ticker goal. `Check roll candidates` remains available in every recommendation state. It receives the warning treatment only for `review`:

- **Keep Shares:** review a covered call when assignment conflicts with the goal and the call is ITM or above the saved delta ceiling. Candidate preference is up and out within the saved contract range.
- **Earn Income:** review when the profit target is met or expiration is near. Candidate preference stays near the saved delta and DTE targets, then favors a better conservative credit.
- **Plan Exit:** let an aligned ITM covered call proceed. If an OTM call nears expiration, review lower or later calls that preserve any saved minimum effective sale price.
- **Plan Entry:** let an aligned ITM put proceed. If an OTM put nears expiration, review a later put near spot that preserves any saved maximum effective purchase price.

“Let assignment work” is a positive management decision, not a roll recommendation. The card still allows a manual candidate check, but keeps that action visually quiet because the current assignment already matches the ticker goal.

The near-expiration window comes from the effective `rollReviewDte` rule. Its built-in value is 10 DTE for Keep Shares and both Earn Income legs, and 7 DTE for Plan Exit and Plan Entry. Roll review can also activate earlier when delta and assignment intent conflict. A credit alone never activates or validates a roll.

The exact decision order is:

1. Missing exact-contract data returns `unavailable`.
2. A missing goal returns `notNeeded`.
3. An ITM contract whose assignment aligns with Plan Exit or Plan Entry returns `assignmentAligned`, even inside the review window.
4. Assignment conflict returns `review` when the contract is ITM or its absolute delta exceeds `targetDeltaMax`.
5. An OTM Plan Exit call or Plan Entry put returns `review` at or below `rollReviewDte` because the intended assignment has not developed.
6. Earn Income returns `review` when `close.signal` passes `closeAtProfitCapture`, or at or below `rollReviewDte`.
7. Keep Shares returns `review` when absolute delta exceeds `targetDeltaMax`.
8. Otherwise the state is `notNeeded`.

Settings lists `rollReviewDte`, `targetDeltaMax`, and `closeAtProfitCapture` inside each compatible goal and strategy profile. These numeric thresholds can differ between the Earn Income covered-call and cash-secured-put profiles. Assignment alignment and conflict remain defined by the selected goal rather than separate switches. Disabling those semantics would make Plan Exit, Plan Entry, or Keep Shares contradict its own name.

## Roll choices and broker handoff

Every open-contract card with a resolved goal includes `Check roll candidates` below the recommendation copy. The button looks like a text link, stays quiet when no roll condition is active, and uses the warning color when the decision rules return `review`. Running the check never changes the recommendation and never places or prepares an order.

Opening the Home sheet requests the exact current contract and later candidate expirations in one chain snapshot. The browser keeps the opening credit, position size, goal, and price guard local. The market bridge receives only the technical contract identity and screening limits.

Candidates must expire after the current contract and pass the saved DTE, moneyness, delta, liquidity, quote-age, and return rules. A usable, fresh ask is required for the current buyback. The shortlist contains at most three goal-ranked replacements. It does not redirect to Radar.

The primary estimate is deliberately conservative:

```text
closeDebit = current ask × multiplier × contracts + closing fees
newOpenCredit = replacement bid × multiplier × contracts − opening fees
naturalRollCash = newOpenCredit − closeDebit
cumulativeOptionCash = original opening credit + naturalRollCash

CC effective sale price = replacement strike + cumulativeOptionCash per share
CSP effective purchase price = replacement strike − cumulativeOptionCash per share
```

The sheet shows the current and replacement contracts, estimated net credit or debit, added days, and effective assignment price. Midpoint, liquidity, and quote context stay behind “Show how this was chosen.” “Copy roll plan” creates a two-leg text handoff for the broker. The user must confirm both contracts, a net limit price, fees, buying-power effects, and live quotes with the broker.

## Binary rule

When the opening net credit and a numeric current ask are available, the only Close decision is:

```text
close.signal = premiumCapture >= effectiveRules.closeAtProfitCapture
```

Assignment intent, Greeks, liquidity, moneyness, and timestamps are informational. No score, voting rule, assignment override, or quote-freshness gate can change the boolean. Without opening credit or a usable positive ask, `close.available` is false, `close.signal` is null, and `unavailableReason` explains which input is missing. Zero and crossed asks are provider-data failures, not executable buyback prices.

## Exact-contract quotes

Node sends every current OCC identity to `POST /v1/contracts/quotes` on the loopback sidecar. The sidecar groups identities by underlying symbol and requests one expiration envelope per symbol through the existing chain cache. It matches the normalized OCC contract symbol exactly. Entry DTE, moneyness, delta, liquidity, and quote-age filters do not run on current positions. Today-expiring contracts and contracts outside the entry DTE range remain eligible for lookup.

Each result returns the identity, bid, ask, underlying price, strike, expiration, option type, volume, open interest, IV, estimated delta and theta when possible, the option trade time, the underlying bar time, the provider fetch time, and cache metadata. A symbol-level provider failure produces unavailable results only for that symbol. Contract and underlying timestamps pass through as data and are never Close conditions.

Yahoo Finance is the exact-contract source. The option trade time is the available contract timestamp, not a guaranteed live quote time. The current ask is an estimated immediate buyback input and should be confirmed with a broker.

## Backend formulas

Values remain numeric in the API. The browser supplies currency and percentage formatting.

The built-in closing-fee estimate is $0.65 per contract, matching the sidecar's existing option-fee assumption. Tests can inject another assumption, including zero for calculation fixtures.

```text
estimatedBuybackDebit = askPerShare × multiplier × contracts + estimatedClosingFees
profitIfClosed = openingNetCredit − estimatedBuybackDebit
premiumCapture = profitIfClosed ÷ openingNetCredit

put intrinsicPerShare = max(strike − underlyingPrice, 0)
call intrinsicPerShare = max(underlyingPrice − strike, 0)
remainingExtrinsic = max(askPerShare − intrinsicPerShare, 0) × multiplier × contracts

daysHeld = max(calendar days since opening, 1)
earnedPerDay = profitIfClosed ÷ daysHeld
remainingExtrinsicPerDay = remainingExtrinsic ÷ max(DTE, 1)

CSP capitalAtRisk = strike × multiplier × contracts
CC capitalAtRisk = underlyingPrice × multiplier × contracts
remainingReturnOnCapital = remainingExtrinsic ÷ capitalAtRisk
remainingAnnualizedReturn = remainingReturnOnCapital × 365 ÷ max(DTE, 1)

CSP breakevenPrice = strike − openingNetCreditPerShare
CC breakevenPrice = (brokerShareBasisPerShare or underlyingPrice) − openingNetCreditPerShare
```

The service also returns ITM or OTM state and distance, strike/spot moneyness, signed distance from strike, effective assignment price, and assignment distance. A CSP's effective purchase price is strike minus opening net credit per share. Its breakeven cushion is spot minus that purchase price. A covered call's effective sale price is strike plus opening net credit per share. Its sale-price distance is that price minus spot. Both percentages use spot as the denominator.

Assignment alignment follows the saved goal identifier. `acquire` aligns with CSP assignment. `exit` aligns with covered-call assignment. `protect` conflicts with covered-call assignment. `income` and an unconfigured ticker are neutral.

## Node API

`GET /api/v1/position-management` returns the latest in-memory batch and performs the first scan if no scheduled or manual result exists. `POST /api/v1/position-management/scan` performs a new scan. Both endpoints are private and non-cacheable.

Each result contains:

- Contract identity and position size.
- Scan, contract quote, underlying quote, and provider-fetch timestamps.
- Provider identity.
- Effective goal, rules, price guard, enabled state, and per-field `sourceMap`.
- `close.available`, nullable binary `close.signal`, numeric `close.metrics`, and `unavailableReason`.
- A stable conditions list with actual value, configured value, pass status, source, and a `decisive` marker. Only `premiumCapture` is decisive.

In the local-first browser path, `POST /api/v1/position-management/rolls` accepts one open OCC contract symbol. It resolves the position and settings from IndexedDB, calls `POST /api/market/rolls` for one sanitized market snapshot, and calculates cumulative roll economics locally.

## Refresh and scheduling

The top-right refresh runs one ordered workflow: SnapTrade refresh, dashboard reload, Close scan, Radar scan, then render. Each step reports partial failure. A Close failure does not replace dashboard or Radar data with invented values.

Scheduled Close evaluation uses the existing market-hours Radar cron and timezone. It does not add another cron task. Scheduled Close and Radar failures are caught independently, so one cannot suppress the other.
