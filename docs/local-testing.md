# Local testing

Use the mock brokerage to work on onboarding, account selection, portfolio refreshes, and trade-history behavior without connecting a SnapTrade account. Yahoo Finance remains active, so quotes and option lookups still use current market data.

## Setup

Install the JavaScript dependencies:

```bash
npm install
```

The full local app also needs Python 3.12 and `uv` 0.9.25 or newer. The repository pins the Python version in `.python-version`.

Create `.env.local` from the example and set mock mode:

```env
APP_ORIGIN=http://127.0.0.1:3000
BROKERAGE_MODE=mock
```

Mock mode does not need `SESSION_SEAL_KEY` or a SnapTrade connection. Restart the dev server after changing either environment value.

Start the frontend and API functions together:

```bash
npm run dev:local
```

Open <http://127.0.0.1:3000> and click **Get started**. The app should continue directly to the mock account setup instead of opening SnapTrade authorization.

## Verify the local APIs

With the dev server running, check the session:

```bash
curl -s http://127.0.0.1:3000/api/auth/session
```

Expected result:

```json
{"connected":true,"scope":"mock","expiresAt":null,"brokerageMode":"mock"}
```

Check the mock account and the real market-data service:

```bash
curl -s http://127.0.0.1:3000/api/brokerage/accounts
curl -s http://127.0.0.1:3000/api/market/health
```

The first response should contain `mock-wheel-account`. The market health response should report `"provider":"yfinance"`.

Run the automated checks before committing:

```bash
npm run typecheck
npm test
npm run build
```

## Change the test scenario

The mock account, positions, balances, recent orders, and activity history live in `api/_lib/mock-brokerage.ts`. The default scenario includes:

- 200 RKLB shares
- One short RKLB covered call
- One short SOFI cash-secured put
- A completed RKLB option trade in account history
- Cash and buying power

Keep real ticker symbols if the UI under test needs Yahoo Finance quotes. Add or update assertions in `tests/api/mock-brokerage.test.ts` when changing the mock response shape.

## Production isolation

`BROKERAGE_MODE=mock` is a local-only switch. `api/_lib/brokerage-mode.ts` enables it only when Vercel reports `VERCEL_ENV=development`, or when a non-Vercel process is not running with `NODE_ENV=production`. Preview and production deployments follow the normal SnapTrade authorization and brokerage paths, even if someone accidentally adds `BROKERAGE_MODE=mock` to their environment variables.

Do not add `BROKERAGE_MODE=mock` to the Vercel project settings. Production only needs the variables listed in the deployment section of the README.

## Troubleshooting

If `/api/auth/session` returns no response, stop old dev processes and restart with `npm run dev:local`. Use that command instead of calling `npx vercel dev` directly. The launcher keeps Vercel's Python dependency builder and local Python function runtime on the same pinned interpreter.

If Vercel reports that `uv` is too old, update it to 0.9.25 or newer, then restart the server.
