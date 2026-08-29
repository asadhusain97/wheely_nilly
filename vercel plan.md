# Wheely Nilly Vercel migration plan

  ## Summary

  Migrate incrementally. Keep the current interface and tested wheel logic, move the browser code to Vite and
  TypeScript, replace filesystem persistence with IndexedDB, and run one Vercel project with:

  - Static PWA frontend
  - TypeScript Vercel Function for SnapTrade OAuth and normalized brokerage data
  - Python FastAPI Function for Yahoo/yfinance market data
  - No database, cron jobs, background workers, or permanent server storage

  Use SnapTrade OAuth so each public user authorizes read-only access without creating a Wheely Nilly account.
  Store OAuth credentials in an encrypted, HttpOnly, Secure, SameSite=Lax session cookie. Store portfolio data and
  settings in IndexedDB.

  The current Cboe integration will be removed before public deployment. It automates a delayed-quotes endpoint
  whose published terms prohibit automated downloading. Yahoo/yfinance becomes the sole V1 provider behind the
  existing provider abstraction. Cboe notice

  Repository baseline:

  - Existing frontend is vanilla HTML/CSS/JavaScript, not React.
  - Express owns SnapTrade access, filesystem snapshots, settings, schedulers, derived calculations, and static
    hosting.

  - FastAPI already wraps the market-data provider and screener.
  - Current production assumptions include local disk, long-running processes, cron, loopback networking, Docker,
    and systemd.

  - Baseline tests pass: 174 Node tests and 31 Python tests. The Python test command currently needs PYTHONPATH=..

  ## Phased implementation

  ### Phase 1: Vercel-compatible foundation

  - Add a root Vite and TypeScript build while retaining the current HTML, CSS, layout, and DOM behavior.
  - Convert frontend modules incrementally. Move pure scoring and wheel calculations first so golden comparisons
    can prove output parity.

  - Add one root build pipeline, vercel.json, Python dependency configuration, and local development commands.
  - Package the brokerage and market services as separate functions in the same Vercel project and under the
    same /api origin.

  - Remove production dependencies on Express static hosting, loopback ports, sidecar URLs, writable data
    directories, Docker, systemd, and process lifecycle handlers.

  - Disable and then remove the scheduler, filesystem snapshot store, server-side strategy settings, ntfy outbox,
    and background scans. Keep them in Git until replacement tests pass.

  - Deploy a fixture-only preview before adding SnapTrade credentials.

  Completion gate: Vercel preview serves the existing application and both health endpoints from one deployment,
  with no financial credentials configured.

  ### Phase 2: Local-first data and offline PWA

  - Introduce one versioned IndexedDB repository with these stores:
    preferences, tickerStrategies, radarConfig, portfolioSnapshot, eventLedger, marketCache, radarCache,
    watchlists, dismissedCandidates, appSettings, and refreshMetadata.

  - Reserve localStorage for tiny non-sensitive bootstrap flags only. Remove scattered storage calls from feature
    modules.

  - Define migrations by storage schema version even though this release starts fresh and does not import
    Raspberry Pi data.

  - Add an app-state store that loads IndexedDB before any remote request and feeds Portfolio, Wheel Trades, Open
    Contracts, Radar, and Settings.

  - Add a manifest, production icons, install metadata, and a service worker that precaches the hashed application
    shell and provides a navigation fallback for /app.

  - Keep normalized financial snapshots in IndexedDB, not Cache Storage. Never cache API responses containing
    OAuth or financial payloads through the service worker.

  - Render cached state before starting refresh work. A missing cache renders useful empty/onboarding state, not a
    blocking spinner.

  - Use an explicit “Update available” action for service-worker upgrades so an update cannot interrupt analysis.

  Completion gate: after one successful visit, an installed PWA opens in airplane mode and shows the shell plus
  the latest local portfolio and Radar state without making startup depend on a request.

  ### Phase 3: Stateless SnapTrade OAuth and brokerage snapshots

  - Replace the current single Personal API key flow with SnapTrade OAuth for public, read-only access. SnapTrade
    identifies OAuth as the supported path for applications used by other Personal users. SnapTrade guidance

  - Implement authorization-code flow with PKCE, state validation, callback validation, token rotation, and a
    sealed session cookie. No OAuth token enters IndexedDB or frontend JavaScript.

  - Request read-only access only. Do not request trading or webhook scope.
  - Normalize accounts, balances, positions, option positions, recent orders, activities, and connection health
    into Wheely Nilly domain objects.

  - On first connection, retrieve all available activity history through bounded pagination and persist the
    normalized event ledger locally. Deduplicate by stable source ID and hash.

  - During normal 30-minute refreshes, retrieve accounts, balances, positions, connections, and recent orders.
    Check activities at most once daily because SnapTrade recommends conservative activity polling. SnapTrade
    launch guidance

  - Preserve partial successes with per-account and per-endpoint errors. One broken brokerage connection must not
    erase valid cached data.

  - Implement manual brokerage refresh under Settings with a 5-minute cooldown recorded in both local metadata and
    the sealed session.

  - Disconnect clears the session cookie and offers a separate, explicit action to erase local financial data.

  Completion gate: two different browsers can authorize different SnapTrade Personal accounts, receive only their
  own normalized data, and leave no portfolio or user record on Vercel.

  ### Phase 4: Market service and two-speed refresh engine

  - Keep the MarketDataProvider interface, implement Yahoo/yfinance as the sole V1 provider, and remove Cboe code
    and dependencies.

  - Expose batched, validated market APIs:
      - POST /api/market/quotes
      - POST /api/market/chains
      - POST /api/market/contracts
      - GET /api/market/expirations?ticker=...
      - GET /api/market/instruments?query=...

  - Put portfolio symbol and contract lists in POST bodies so hosting access logs do not record them in query
    strings.

  - Return normalized provider-independent objects with provider, quote time, fetch time, delayed/unofficial
    flags, and nullable fields for unavailable metrics.

  - Move Radar ranking, wheel calculations, Close guidance, annualized returns, liquidity interpretation,
    preference filtering, and strategy resolution into tested client-side TypeScript modules.

  - Add one RefreshCoordinator outside UI components:
      - Render local state first.
      - Start market and brokerage refreshes independently and in parallel.
      - Refresh market data every 2 minutes while visible.
      - Refresh brokerage data every 30 minutes while visible.
      - Stop both timers while hidden.
      - Immediately refresh stale slices when visibility returns.
      - Deduplicate in-flight symbol, chain, and contract requests.
      - Cancel obsolete work with AbortController.
      - Apply bounded retries only to transient failures and respect 429 retry guidance.

  - Diff each new brokerage snapshot against the previous local snapshot. Detect positions, quantities, contracts,
    orders, and symbols by stable normalized identity.

  - Immediately request affected quotes/contracts/chains after a portfolio change, then recompute Open Contracts
    and Radar without waiting for the next market interval.

  - Maintain separate market and brokerage freshness states: idle, refreshing, success, stale, and error.

  Completion gate: fake-timer and browser tests prove independent clocks, visibility suspension, request
  deduplication, targeted refresh after portfolio changes, and preservation of cached data after failures.

  ### Phase 5: Homepage, onboarding, and settings

  - Make / the public product homepage and /app the installable application start URL.
  - Build the restrained homepage narrative from the supplied copy: product purpose, read-only behavior, no Wheely
    account, local preferences, SnapTrade source, and installability.

  - Add the onboarding sequence:
    Welcome → Authorize SnapTrade → Detect accounts → Choose defaults → Review tickers → Optional ticker strategy
    → Install PWA → Radar.

  - Use sensible defaults and defer detailed strategy controls to Settings.
  - Add platform-aware install guidance and use beforeinstallprompt where supported.
  - Add separate Market and Brokerage freshness indicators. Do not restore the current prominent combined refresh
    button.

  - Add Settings → Data & Refresh with allowed market intervals of 1, 2, or 5 minutes and brokerage intervals of
    15, 30, 60 minutes, app-open-only, or manual-only.

  - Add offline, Yahoo unavailable, SnapTrade unavailable, disabled connection, partial account, expired session,
    and storage-unavailable states.

  Completion gate: a new user can understand the privacy model, authorize SnapTrade, reach Radar with defaults,
  install the PWA, and continue opening the last snapshot offline.

  ### Phase 6: Cutover and cleanup

  - Run current and migrated calculation modules against the same sanitized fixtures and require equivalent
    results before retiring old paths.

  - Remove Express server startup, cron packages, local snapshots, server settings persistence, notifications,
    Docker images, Compose, systemd units, and Pi-only setup scripts.

  - Keep a simple local development launcher for Vite plus the two functions.
  - Add production headers: CSP, HSTS, Referrer-Policy, Permissions-Policy, X-Content-Type-Options, and no-store
    rules for financial APIs.

  - Verify logs contain request IDs, route, duration, status, and sanitized error codes only. Exclude bodies,
    tokens, account identifiers, positions, tickers, and financial values.

  - Validate the complete production flow on the Vercel domain before moving DNS.
  - Retire the Raspberry Pi only after the Vercel deployment passes the offline, OAuth, brokerage, market, and
    calculation-parity gates.

  ## Public interfaces and state

  Key TypeScript contracts:

  - BrokerageSnapshot: accounts, balances, positions, option positions, recent orders, connection state, endpoint
    errors, and retrieval timestamps.

  - BrokerageEvent: normalized activity or order with source identity, OCC identity, quantities, integer minor-
    unit money, and authority/review flags.

  - MarketSnapshot: quotes, chains, exact contracts, provider metadata, and timestamps.
  - PortfolioDiff: added, removed, and changed equities, options, orders, and affected symbols/contracts.
  - RefreshSlice<T>: data, last attempt, last success, status, stale reason, and sanitized error.
  - AppDataState: portfolio, market, radar, local settings, and session state.
  - RefreshPolicy: selected intervals, visibility behavior, startup freshness thresholds, timeout, and cooldown.

  OAuth and brokerage APIs:

  - GET /api/auth/start
  - GET /api/auth/callback
  - GET /api/auth/session
  - POST /api/auth/disconnect
  - GET /api/brokerage/snapshot
  - GET /api/brokerage/history?cursor=...
  - POST /api/brokerage/refresh

  All financial endpoints return Cache-Control: private, no-store and a common sanitized error envelope. API
  schemas are versioned independently from IndexedDB and calculation versions.

  ## Verification and regression controls

  - Preserve the existing 174 Node and 31 Python tests throughout migration.
  - Add golden tests for wheel cycles, performance totals, Radar ranking, Close guidance, option identity, money
    precision, and settings precedence.

  - Add unit tests for IndexedDB migrations, snapshot replacement, event deduplication, portfolio diffing, refresh
    state transitions, visibility handling, cooldowns, request coalescing, cancellation, and partial failures.

  - Add OAuth tests for state/PKCE validation, sealed-cookie tampering, expiration, disconnect, callback
    allowlists, CSRF protection, and token redaction.

  - Add FastAPI tests for input bounds, Yahoo normalization, timeouts, rate limits, missing fields, batch limits,
    and per-symbol partial errors.

  - Add browser tests proving:
      - Cached shell and data render offline.
      - No remote request gates the first usable render.
      - Market refresh does not wait for brokerage.
      - Hidden pages stop polling.
      - Returning pages refresh immediately.
      - A new option position triggers an exact-contract refresh.
      - Failed refreshes retain and label prior data.

  - Add a Vercel preview smoke test for static routing, both runtimes, function bundle size, security headers, and
    API timeouts.

  ## What you will do in Vercel and SnapTrade

  Do these only when the corresponding implementation phase is ready:

  1. Import the existing Git repository as one Vercel project with the repository root as the project root.
  2. Use the committed build settings: root npm ci, npm run build, and dist output. Do not create separate
     frontend and backend projects.

  3. Keep Fluid Compute enabled. The Python runtime supports FastAPI and currently allows a 500 MB uncompressed
     function bundle. We will still set a 30-second application timeout and fail gracefully sooner. Vercel Python
     runtime, function limits

  4. In SnapTrade, register a read-only OAuth application for other Personal users. Do not use the current
  5. Add the stable Vercel project URL and later https://wheelynilly.com/api/auth/callback to SnapTrade’s exact
     redirect allowlist.

  6. Add the committed environment-variable names to Vercel Preview and Production:
      - SESSION_SEAL_KEY
      - APP_ORIGIN

  7. Enter secret values directly in Vercel. Do not send them through chat, commit them, or expose them with a
     public frontend prefix.
  9. Test first on the stable .vercel.app domain. Attach wheelynilly.com and update DNS only after the production
     checklist passes.

  10. Complete SnapTrade’s production review before opening the app broadly.

  ## Assumptions

  - V1 is public and read-only through SnapTrade OAuth.
  - Wheely Nilly has no user database or application accounts.
  - OAuth session material may use a sealed browser cookie because it keeps credentials out of JavaScript while
    preserving stateless servers.

  - Existing Raspberry Pi settings and snapshots will not be imported.
  - First connection imports all available brokerage activity into the local browser ledger.
  - Yahoo/yfinance is the only V1 market provider. A licensed provider can be added later through
    MarketDataProvider.

  - Background alerts, ntfy, webhooks, trading, cloud sync, and closed-app refresh are outside this release.
  - The first implementation batch is Phase 1 only. It creates the Vercel-compatible build and fixture preview
    without touching production credentials or Raspberry Pi operation.