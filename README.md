# Wheely Nilly

Wheely Nilly is a local-first options wheel workspace. It reads brokerage data through SnapTrade, fetches market data through Yahoo Finance, and keeps portfolio snapshots, strategy settings, watchlists, and Radar results in the user's browser.

There is no Wheely Nilly account, user database, portfolio database, Redis instance, background worker, or permanent server storage. Closing the app stops all refresh activity.

## Current architecture

```text
wheelynilly.com
├── Vite frontend and installable PWA
│   ├── IndexedDB local state
│   ├── cached application shell
│   └── client refresh coordinator
└── /api
    ├── TypeScript SnapTrade OAuth and brokerage bridge
    └── Python Yahoo Finance market bridge
```

The app renders its cached shell and browser data first. Market and brokerage refreshes then run independently. Market data defaults to every 2 minutes while visible. Brokerage data defaults to every 30 minutes while visible. Returning to the app triggers a market refresh. Brokerage refresh waits until it is due.

The previous Raspberry Pi server remains in `backend/` as a migration reference and local fallback. Vercel does not run its filesystem snapshots, cron jobs, notification outbox, Docker files, or process launcher.

## Requirements

- Node.js 22 or newer
- Python 3.12 or newer
- A SnapTrade OAuth application with the `read` scope
- A Vercel account for deployment

SnapTrade OAuth applications require a confidential client and PKCE. SnapTrade may need to enable OAuth for an eligible Commercial Pay-As-You-Go application. Confirm this in the SnapTrade dashboard or with SnapTrade support before relying on the public connection flow.

## Local development

Install the frontend dependencies:

```bash
npm install
```

Create local environment values:

```bash
cp .env.example .env.local
```

Generate a session seal key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Set `APP_ORIGIN=http://127.0.0.1:3000` and register this local callback with SnapTrade:

```text
http://127.0.0.1:3000/api/auth/callback
```

Install the Vercel CLI, then run the full project:

```bash
npx vercel dev --listen 3000
```

`npm run dev` runs only the Vite frontend. Use it for layout work that does not need API functions.

## Checks

```bash
npm run typecheck
npm run build
npm test
npm --prefix backend test
PYTHONPATH=sidecar sidecar/.venv/bin/pytest -q sidecar/tests
```

`npm run test:all` runs the JavaScript and Python suites together after the Python environment exists.

## Vercel deployment

### 1. Create the project

In Vercel, choose **Add New > Project**, import this repository, and keep the repository root as the project root. Vercel reads `vercel.json`, runs `npm run build`, publishes `dist/`, and deploys the TypeScript and Python functions under `/api`.

Set the Node.js version to 22 in Project Settings if Vercel does not select it from `package.json`.

### 2. Add production environment variables

In **Project Settings > Environment Variables**, add these values for Production:

| Name | Value |
| --- | --- |
| `APP_ORIGIN` | `https://wheelynilly.com` |
| `SNAPTRADE_OAUTH_CLIENT_ID` | OAuth client ID from SnapTrade |
| `SNAPTRADE_OAUTH_CLIENT_SECRET` | OAuth client secret from SnapTrade |
| `SESSION_SEAL_KEY` | One generated 32-byte base64url key |
| `MARKET_TIMEOUT_SECONDS` | `15` |

Keep the same `SESSION_SEAL_KEY` across production deployments. Changing it signs every user out, but it does not delete local portfolio data.

Do not expose these as `VITE_` variables. Vite variables enter the browser bundle.

Vercel may also detect variables referenced by the retained Raspberry Pi backend. Do not configure `SNAPTRADE_CLIENT_ID`, `SNAPTRADE_CONSUMER_KEY`, `SNAPTRADE_ACCOUNT_IDS`, `OPPORTUNITY_SCAN_CRON`, `OPPORTUNITY_SCAN_TIMEZONE`, or `DASHBOARD_PUBLIC_URL` for the Vercel application. They are not used by the new deployment.

### 3. Configure SnapTrade

In the SnapTrade OAuth application:

- Add `https://wheelynilly.com/api/auth/callback` as an exact redirect URI.
- Enable only the `read` scope.
- Keep the app confidential.
- Do not enable trading or webhook scopes for this release.

Preview deployments have changing domains. Use a separate fixed preview domain and OAuth client if preview OAuth testing is required. Do not add wildcard callback URLs.

### 4. Attach the domain

In **Project Settings > Domains**, add `wheelynilly.com` and the preferred `www` behavior. Apply the DNS records Vercel shows. After HTTPS is active, confirm that `APP_ORIGIN` exactly matches the canonical origin and redeploy if it changed.

### 5. Deploy and verify

Push the branch connected to Production or choose **Deploy** in Vercel. Then verify:

1. `/` shows the product homepage.
2. `/app` opens and offers a SnapTrade connection.
3. OAuth returns to `/app?connected=1`.
4. Market and brokerage freshness appear separately.
5. Manual brokerage refresh exists only under Settings.
6. The browser's Application panel reports a valid manifest and service worker.
7. After one successful online app load, switch the browser offline and reopen `/app`. The shell and last saved view should appear without a network wait.

## Local browser data

IndexedDB separates data into these stores:

```text
userPreferences
tickerStrategies
radarConfig
portfolioSnapshot
eventLedger
marketCache
radarCache
appSettings
watchlists
dismissedCandidates
refreshMetadata
```

Settings contains an **Erase saved financial data** action. Disconnecting SnapTrade revokes access and clears the sealed OAuth cookie. It leaves the local snapshot in place until the user erases it.

## Security and privacy

- SnapTrade tokens live in encrypted, authenticated, HttpOnly cookies on the user's device.
- OAuth uses authorization code flow, PKCE S256, state validation, rotating refresh tokens, and exact callback URLs.
- API responses use `private, no-store`.
- Server functions do not write portfolio data to disk or a database.
- Production code does not log credentials or financial payloads.
- Market data and brokerage errors return short sanitized messages.
- All remote calls use HTTPS and bounded timeouts.

Wheely Nilly provides analysis. It does not place trades and is not investment advice.
