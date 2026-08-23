# Wheel Strategy Dashboard Development Plan

Development is strictly sequential. Work on a phase begins only after the previous phase's acceptance criteria pass on both a development machine and the target Raspberry Pi. Each phase must preserve immutable source data, keep secrets server-side, and include tests before it becomes an input to the next phase.

## Cross-Phase Rules

- Do not build calculations against guessed payloads when a sanitized real SnapTrade fixture can be captured in Phase 1.
- Do not send SnapTrade, Robinhood, Alpha Vantage, or ntfy credentials to the browser.
- Do not log raw financial payloads, account numbers, authorization headers, user secrets, or provider tokens.
- Store timestamps in UTC and attach an explicit source/provider to every imported record.
- Make ingestion and scheduled jobs idempotent so retries cannot duplicate trades, premiums, or alerts.
- Use integer minor units or a decimal library for money. Binary floating-point values are acceptable for display-only market statistics, not accounting ledgers.
- Use synthetic and sanitized fixtures in version control. Real payloads remain under ignored local storage.
- Document provider assumptions and surface stale, missing, delayed, or estimated data in the UI.
- Keep the dashboard loopback-bound until application authentication and a secure remote-access layer exist.

## Phase 1: Environment, SnapTrade Authentication, and Raw Portfolio Data

> Status: Phase 1 implementation is complete locally: validated config, retrying SnapTrade adapter (Personal/Commercial), paginated activity ingestion, immutable globally hash-deduplicated snapshots, explicit account pinning, lifecycle utilities, freshness-aware APIs, cron overlap protection, and sanitized portfolio fixtures. Raspberry Pi Docker and live smoke verification remain the final platform acceptance gate.
>
> Endpoint notes (Robinhood, verified 2026-08-23): `getUserHoldings` returns HTTP 410 for accounts created after 2026-05-11 — use `getAllAccountPositions` (payload `{results, data_freshness}`; option instruments carry `option_type/strike_price/expiration_date/multiplier/underlying`). `balances` returns an array; `orders` an array (option orders identified via `option_symbol`); `activities` returns `{data, pagination}` and ingestion follows `total` until all pages are collected.

### Objective

Establish a secure, observable connection to the intended Robinhood account through SnapTrade and fetch reproducible raw balances, holdings, positions, and options-related payloads without adding wheel calculations.

### Scope

1. Runtime configuration
   - Validate required environment variables at process startup with `zod`.
   - Fail fast with variable names but never secret values.
   - Centralize timeouts, retry limits, schedule settings, account IDs, and log redaction.
   - Keep development, test, and production configuration explicit.
2. SnapTrade client and user lifecycle
   - Wrap `snaptrade-typescript-sdk` in one server-side service.
   - Add an explicit one-time user registration command; never register users automatically on boot.
   - Persist the returned `SNAPTRADE_USER_SECRET` outside source control.
   - Generate the SnapTrade connection portal URL and complete Robinhood authorization.
   - List brokerage authorizations and accounts, then select and persist the intended Robinhood identifiers.
3. Raw data ingestion
   - Fetch account balances, holdings/positions, orders, option positions, and relevant transaction/activity history supported by the connected account.
   - Capture request time, provider response time when available, account/authorization ID, endpoint, SDK version, and a schema version with every snapshot.
   - Write immutable raw snapshots under `data/raw/` using restrictive permissions and atomic file replacement.
   - Add a manual refresh route and a conservative scheduled refresh job with overlap prevention.
4. API and observability
   - Expose local-only raw endpoints grouped under `/api/v1/snaptrade/`.
   - Return structured upstream, authentication, validation, and rate-limit errors without leaking secrets.
   - Add request IDs, duration, last-success timestamps, and stale-data status.
   - Use bounded exponential backoff with jitter only for retry-safe failures.
5. Tests and documentation
   - Unit-test configuration validation, redaction, account selection, retry behavior, and snapshot naming.
   - Add integration tests using SDK mocks and sanitized fixtures.
   - Record which SnapTrade endpoints and payload fields are actually available for Robinhood options data.
   - Document credential creation, connection recovery, rate limits, and user deletion/re-registration consequences.

### Deliverables

- Validated configuration module.
- SnapTrade adapter and explicit user registration/connection workflow.
- Robinhood account discovery with unambiguous account selection.
- Manual and scheduled raw snapshot ingestion.
- Sanitized fixture set representing stocks, cash, a short put, a short call, and option activity.
- Local API documentation for raw payload and refresh/status endpoints.

### Acceptance Criteria

- The backend starts on ARM64 and reports healthy with valid configuration, and fails safely when a required SnapTrade variable is absent.
- A single stable SnapTrade user can reconnect after a container restart without registration or loss of the Robinhood authorization.
- The intended Robinhood account is selected explicitly rather than by array order or display-name guesswork.
- Raw balances, equity holdings, option positions, and relevant activity can be fetched manually and by schedule.
- Repeating the same ingestion does not create duplicate snapshots or duplicate normalized source records.
- Logs and API errors contain no Consumer Key, User Secret, authorization header, full account number, or raw payload.
- Mocked tests pass without network access, and a manual smoke test passes on the Raspberry Pi.

### Explicit Non-Goals

- No adjusted cost basis, premium totals, wheel-state inference, screener recommendations, or alerts.
- No direct Robinhood credential collection.
- No public or LAN exposure of financial endpoints.

## Phase 2: Wheel Lifecycle Normalization and Frontend Visualization

### Entry Gate

Phase 1 fixtures and raw snapshots are stable, and the fields required to identify option contracts, activities, quantities, multipliers, prices, fees, and timestamps have been documented.

### Objective

Transform immutable brokerage payloads into an auditable event ledger and visualize each wheel cycle from cash-secured put through assignment, covered call, and exit.

### Scope

1. Canonical data model
   - Define normalized accounts, underlyings, option contracts, executions, cash movements, positions, and wheel cycles.
   - Parse OCC symbols while retaining the provider's original symbol and identifiers.
   - Represent option side, put/call type, strike, expiration, multiplier, opening/closing effect, quantity, price, commission, and fees explicitly.
   - Keep source-event identifiers and hashes for idempotent reprocessing.
2. Event and lifecycle engine
   - Pair opening and closing executions without assuming every order fills once.
   - Model a roll as closing the existing contract and opening a new contract.
   - Detect put sale, put close/expiration/assignment, share acquisition, call sale, call close/expiration/assignment, and share call-away events.
   - Support partial fills, multiple lots, partial assignment, early assignment, manual share transactions, and concurrent contracts on one underlying.
   - Mark ambiguous cycles for review rather than silently guessing.
3. Accounting
   - Calculate gross premium, fees, and net premium using the contract multiplier.
   - Track open premium, realized option profit/loss, and total net premiums without double counting rolls or repeated imports.
   - Calculate an adjusted share basis from acquisition cost, allocable fees, and premiums assigned to the cycle.
   - Keep tax-lot cost basis, broker-reported basis, and strategy-adjusted basis as distinct concepts.
   - Reconcile normalized cash effects against source activity totals within an explicit rounding tolerance.
4. Node API
   - Add versioned summary, cycle, position, premium-ledger, and data-freshness endpoints.
   - Validate query parameters and bound date ranges and response sizes.
   - Return calculation version and source freshness with every derived response.
5. Frontend
   - Build a responsive lifecycle view for desktop and mobile using semantic HTML, CSS, and vanilla modules.
   - Show cycle stage, underlying, contracts, collateral or shares, expiration, strikes, premium ledger, adjusted basis, unrealized state, and realized outcome.
   - Add filters for symbol, account, state, and date range.
   - Clearly distinguish broker facts, application-derived values, stale data, and records requiring manual review.
   - Provide accessible tables, keyboard operation, non-color-only status cues, and useful empty/error/loading states.
6. Tests
   - Add fixture-driven lifecycle tests for expiration, buy-to-close, assignment, call-away, roll, partial fill, early assignment, and duplicate ingestion.
   - Add golden tests for premium and basis calculations.
   - Add browser smoke tests at mobile and desktop widths.

### Deliverables

- Versioned normalized schema and migration approach.
- Deterministic event ledger and wheel-cycle state machine.
- Reconciled premium and adjusted-basis calculations.
- Versioned derived-data API.
- Responsive wheel lifecycle dashboard.

### Acceptance Criteria

- Every displayed number links conceptually to normalized events and retained source snapshots.
- Fixture calculations reconcile by hand for puts, calls, assignments, expirations, closes, rolls, fees, and contract multipliers.
- Re-ingesting the same source payload leaves cycle and premium totals unchanged.
- Ambiguous or unsupported events are visible and excluded from authoritative totals until resolved.
- Broker cost basis and strategy-adjusted basis are labeled separately.
- The dashboard remains usable at 360 px width and on desktop, with keyboard-accessible controls.
- Phase 2 tests pass in Docker on the Raspberry Pi.

### Explicit Non-Goals

- No external options-chain screening.
- No automated trade placement or recommendation engine.
- No push notifications.

## Phase 3: Options Screener Sidecar

### Entry Gate

Phase 2 reliably identifies each cycle's current state, underlying, available cash collateral or covered shares, adjusted basis, and existing expirations.

### Objective

Add an internal Python service that retrieves options chains, evaluates candidate expirations and strikes, and returns transparent yield and Greek metrics to the Node API.

### Scope

1. Internal API contract
   - Define a versioned request/response schema between Node and FastAPI.
   - Accept an underlying, strategy leg, expiration/DTE bounds, strike or moneyness bounds, collateral/basis inputs, and liquidity thresholds.
   - Keep the sidecar unexposed to the host network and validate request size and values.
2. Provider adapters
   - Implement a provider interface with `yfinance` first and an Alpha Vantage adapter only if its current options endpoint and plan satisfy requirements.
   - Normalize expirations, calls, puts, bid, ask, last, volume, open interest, implied volatility, quote time, and provider metadata.
   - Add explicit timeouts, rate limiting, short-lived caching, bounded concurrency, and stale-response handling.
   - Mark `yfinance` as unofficial and degrade gracefully when Yahoo changes or throttles responses.
3. Candidate selection
   - Fetch future expirations within configurable minimum and maximum DTE.
   - For cash-secured puts, screen strikes by target delta, moneyness, collateral, liquidity, and annualized return on cash at risk.
   - For covered calls, screen strikes relative to market price and adjusted basis, available covered shares, target delta, and annualized return on the documented denominator.
   - Exclude crossed/empty quotes, impossible spreads, expired contracts, insufficient coverage, and candidates outside configured liquidity limits.
4. Metrics
   - Use a documented executable-price assumption, with midpoint used only when the spread passes a configured quality threshold.
   - Calculate net premium after estimated fees, simple period return, annualized simple return, breakeven, downside buffer, and distance from strike.
   - For cash-secured puts, define return denominator as strike collateral less net premium, or use a separately labeled collateral convention selected in configuration.
   - For covered calls, report yield on adjusted basis and yield on current market value separately; never mix denominators.
   - Calculate delta and theta from provider Greeks when reliable. Otherwise derive estimates from implied volatility with a documented Black-Scholes model, risk-free rate, dividend assumption, units, and timestamp.
   - Label calculated Greeks as estimates and return `null` instead of fabricating values when inputs are invalid.
5. Integration and UI
   - Add a Node adapter with timeout, circuit-breaker behavior, schema validation, and cache metadata.
   - Display ranked candidates, provider, quote age, assumptions, liquidity, yields, Greeks, and exclusion reasons.
   - Keep screening informational; do not place or pre-stage orders.
6. Tests and benchmarks
   - Unit-test formulas against known examples and an independent calculator within stated tolerances.
   - Contract-test Node/Python schemas.
   - Test stale, empty, malformed, throttled, and partially missing chains.
   - Measure memory, cold start, and response time on the Raspberry Pi using representative chains.

### Deliverables

- Containerized FastAPI sidecar and provider adapter interface.
- Normalized options-chain schema and cache.
- Candidate filtering/ranking with documented formulas.
- Node integration and screener dashboard view.
- Formula, contract, provider-failure, and ARM64 performance tests.

### Acceptance Criteria

- The sidecar is reachable from Node but has no published host port.
- Candidate expirations and strikes obey all configured DTE, moneyness, coverage, and liquidity constraints.
- ROI, annualization, breakeven, delta, and theta match documented test vectors within stated tolerances.
- Every result includes provider, quote timestamp, cache age, calculation assumptions, and calculation version.
- Missing or stale market data produces explicit degraded results rather than plausible-looking zeros.
- Repeated screening respects provider rate limits and does not trigger unbounded parallel calls.
- Representative screens complete within the agreed memory and latency budget on the Raspberry Pi.

### Explicit Non-Goals

- No order placement, autonomous strategy selection, or claim of real-time executable pricing.
- No alert delivery; Phase 3 only produces validated candidates and metrics.

## Phase 4: ntfy Notifications and Risk Alerts

### Entry Gate

Phase 2 lifecycle state and Phase 3 screener output are versioned, tested, freshness-aware, and reliable enough to drive notifications without manual data repair.

### Objective

Deliver actionable, deduplicated push notifications for expirations, assignment-risk indicators, and high-yield screener candidates through hosted or self-hosted ntfy.

### Scope

1. ntfy client
   - Implement server-side HTTP POST delivery with configurable base URL, topic, token, timeout, and retry policy.
   - Use a private, hard-to-guess topic and token-based access when supported.
   - Never include account IDs, secrets, or unnecessary portfolio values in notification text.
   - Treat delivery as at-least-once and attach an application event ID for deduplication and audit.
2. Expiration reminders
   - Schedule configurable reminders by exchange calendar and the user's timezone.
   - Notify at selected DTE thresholds and on expiration day for open contracts.
   - Reconcile position state immediately before sending so closed or rolled contracts do not alert.
3. Assignment-risk indicators
   - Define transparent indicators using moneyness, DTE, delta, extrinsic value, and data freshness.
   - Distinguish an elevated-risk estimate from a confirmed assignment.
   - Escalate severity by configured thresholds and suppress repeated messages until the state materially changes.
4. Screener alerts
   - Alert only when a candidate passes configured yield, delta, liquidity, spread, DTE, quote-age, and coverage rules.
   - Add cooldowns, daily caps, and material-change thresholds to avoid notification floods.
   - Include symbol, strategy leg, expiration, strike, estimated executable premium, annualized yield, delta, quote age, and a dashboard link.
5. Reliability and operations
   - Persist alert rules, event fingerprints, attempts, delivery result, and last-sent state locally.
   - Use an outbox so transient ntfy failures do not block ingestion jobs.
   - Retry bounded transient failures with jitter; do not retry permanent authentication or validation failures indefinitely.
   - Add a dry-run mode, test-notification endpoint, health status, and per-rule enable/disable controls.
6. Tests
   - Mock ntfy responses for success, timeout, rate limit, authentication failure, and server failure.
   - Test deduplication across process/container restarts.
   - Test expiration boundaries, timezone changes, stale data, closed positions, rolls, and alert cooldowns.

### Deliverables

- Authenticated ntfy adapter with redacted structured logs.
- Persistent outbox and notification audit trail.
- Expiration, assignment-risk, and screener alert rules.
- Dashboard controls for thresholds, cooldowns, dry-run mode, and test delivery.
- Operational documentation for hosted and self-hosted ntfy.

### Acceptance Criteria

- A test notification reaches the subscribed device without exposing credentials or account identifiers.
- The same event is not sent twice across retries or container restarts.
- Closed, expired, or rolled-away positions do not produce stale reminders after reconciliation.
- Assignment-risk alerts state that risk is estimated and include the source quote time.
- Screener alerts fire only when every configured threshold passes and remain within cooldown and daily limits.
- ntfy downtime does not interrupt brokerage ingestion or corrupt alert state.
- All alert tests pass in Docker on the Raspberry Pi, including timezone and restart scenarios.

### Explicit Non-Goals

- No trade execution, automated order creation, SMS fallback, or guarantee that an alert arrives before a market event.
- No notification may be treated as a substitute for checking the broker's official positions and orders.

## Completion Definition

The project reaches its initial complete state only when all four phases meet their acceptance criteria on the target Raspberry Pi, the recovery procedure has been tested from encrypted backups, calculations reconcile against documented fixtures, and the dashboard remains private behind an approved access method.
