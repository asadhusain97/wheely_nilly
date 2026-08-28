# Position management and binary Close guidance

The home page evaluates every derived open short call and put in place. It does not build a second position list or match opening lots again. The backend uses the dashboard's existing open-trade projection, including its aggregate opening net credit and earliest matched opening date.

Close is guidance only. The card explains the calculation and never places or prepares an order. Roll calculations are outside this contract and the card does not imply that roll guidance exists.

The collapsed card is a decision summary. Its order is contract identity, recommendation, position state, three economics metrics, premium-capture progress, and a centered disclosure chevron. Identity includes ticker, strategy, strike, option type, expiration, DTE, and quantity. The existing binary Close result maps to `Hold` when the target is not met, `Close candidate` when it is met, and `Review now` when the required inputs are unavailable. The visible reason always states the actual premium capture and configured target, or the backend's unavailable reason.

The economics row promotes estimated P/L if closed, premium captured, and earned per day. A progress bar marks the effective `closeAtProfitCapture` setting and turns green only when the existing Close signal passes. ITM receives an amber attention treatment; OTM and raw values remain neutral. The expanded area does not repeat collapsed values. It contains two balanced groups. Trade shows premium received, buyback estimate, collateral, and breakeven. Market shows the underlying price, bid/ask with spread context, delta, and implied volatility. The last refresh time sits at the bottom. Empty optional metrics are omitted. Metric labels continue to open the glossary where a matching term exists.

## Binary rule

When the opening net credit and a numeric current ask are available, the only Close decision is:

```text
close.signal = premiumCapture >= effectiveRules.closeAtProfitCapture
```

Assignment intent, Greeks, liquidity, moneyness, and timestamps are informational. No score, voting rule, assignment override, or quote-freshness gate can change the boolean. Without opening credit or a usable positive ask, `close.available` is false, `close.signal` is null, and `unavailableReason` explains which input is missing. Zero and crossed asks are provider-data failures, not executable buyback prices.

## Exact-contract quotes

Node sends every current OCC identity to `POST /v1/contracts/quotes` on the loopback sidecar. The sidecar groups identities by underlying symbol and requests one expiration envelope per symbol through the existing chain cache. It matches the normalized OCC contract symbol exactly. Entry DTE, moneyness, delta, liquidity, and quote-age filters do not run on current positions. Today-expiring contracts and contracts outside the entry DTE range remain eligible for lookup.

Each result returns the identity, bid, ask, underlying price, strike, expiration, option type, volume, open interest, IV, estimated delta and theta when possible, the option trade time, the underlying bar time, the provider fetch time, and cache metadata. A symbol-level provider failure produces unavailable results only for that symbol. Contract and underlying timestamps pass through as data and are never Close conditions.

Cboe delayed data is the primary exact-contract source, with Yahoo Finance as a fallback. The option trade time is the available contract timestamp, not a guaranteed live quote time. The current ask is an estimated immediate buyback input and should be confirmed with a broker.

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

## Refresh and scheduling

The top-right refresh runs one ordered workflow: SnapTrade refresh, dashboard reload, Close scan, Radar scan, then render. Each step reports partial failure. A Close failure does not replace dashboard or Radar data with invented values.

Scheduled Close evaluation uses the existing market-hours Radar cron and timezone. It does not add another cron task. Scheduled Close and Radar failures are caught independently, so one cannot suppress the other.
