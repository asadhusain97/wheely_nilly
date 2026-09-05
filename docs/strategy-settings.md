# Strategy Settings v3

Strategy settings provide the authoritative rules for Radar and Close. Radar resolves them for eligible new-trade targets. Close resolves them for every open short option, including untracked tickers and disabled legs. Neither feature places orders.

Goal profiles are editable starting points, not trading recommendations. Quotes and candidates must still be verified with a broker.

## Inheritance

Every effective rule is resolved in this order:

```text
selected goal and strategy profile
→ explicitly set ticker/leg override
```

Goal profiles are complete rule sets. Removing a ticker override restores the selected goal value. The effective resolver reports `goal` or `tickerOverride`.

Ticker playbooks store one goal for the ticker. Their two strategy legs keep separate enabled states, price guards, and partial rule overrides. This prevents open calls and puts on the same ticker from receiving conflicting intent labels. An unconfigured ticker remains disabled and has no price guard, but it still resolves a default goal profile. Stocks and unknown instrument types default to Earn Income. ETF and mutual-fund covered calls default to Keep Shares. A saved ticker goal wins for every open contract on that ticker. If that goal has no entry profile for the contract's strategy, position management keeps the ticker goal for assignment intent and uses the conservative system rule set.

The Settings UI populates its ticker collection from wheel-trade history, saved playbooks, and tickers added from Radar's circular plus action. Radar verifies the instrument, asks whether shares or cash collateral are available, then shows the goals compatible with the resulting covered call or cash-secured put. Nothing is selected initially. A newly created playbook enables only the selected leg; adding or editing a leg preserves the other leg's enabled state and settings. Its small recent-ticker hint is stored locally under `wheely-nilly.screened-tickers.v1` and contains the symbol, instrument identity, selected leg, starting goal, and last-used timestamp. Removing a ticker from Radar deletes this hint and its saved playbook. A ticker with trade history remains visible in Settings because history is an independent source. Capsules are ordered by most recent activity, show eight initially, and can be searched or expanded.

## Document shape

The editable document has `schemaVersion: 3` and two scopes:

- `goalProfiles.protect`, `income`, `exit`, and `acquire` contain complete rule sets keyed by compatible strategy leg. Earn Income has separate covered-call and cash-secured-put profiles.
- `tickerPlaybooks` is keyed by normalized uppercase symbols. Every playbook contains one `goal` plus `coveredCall` and `cashSecuredPut` settings.

Covered calls allow the Keep Shares, Earn Income, and Plan Exit goals and may set `minNetSalePriceMinor`. Cash-secured puts allow Earn Income and Plan Entry and may set `maxNetPurchasePriceMinor`. Price guards are nullable, nonnegative, safe integers in cents. The Settings UI is the dollar boundary and parses at most two decimal places without floating-point accounting.

Each complete rule set resolves all of these fields:

| Field | Meaning |
| --- | --- |
| `minDte`, `maxDte` | Inclusive days-to-expiration range |
| `minMoneyness`, `maxMoneyness` | Inclusive strike/spot ratio range |
| `targetDeltaMin`, `targetDeltaMax` | Nullable absolute-delta bounds |
| `maxSpreadPercent` | Maximum bid/ask spread as a decimal ratio |
| `minOpenInterest` | Minimum contract open interest |
| `minVolume` | Minimum contract volume |
| `minPeriodReturn` | Minimum estimated period return as a decimal ratio |
| `closeAtProfitCapture` | Close threshold as a decimal greater than 0 through 1 |
| `rollReviewDte` | Inclusive DTE threshold that starts near-expiration roll review; integer from 0 through 365 |

All objects reject unknown fields. Validation also rejects unsafe integers, malformed tickers, unknown goals, out-of-range values, and effective DTE, moneyness, or delta inversions.

## Recommended profiles

The presets are aggressive toward their stated intention, not toward raw premium in every case. Keep Shares aggressively avoids call-away. Earn Income accepts more assignment exposure for premium. Plan Exit favors a near-term stock sale. Plan Entry favors acquiring shares near the current price. These are product defaults, not universal trading recommendations.

| Goal | Applicable leg | DTE | Strike / stock | Absolute delta | Minimum period return |
| --- | --- | ---: | ---: | ---: | ---: |
| Keep Shares | Covered call | 30–60 | 105%–125% | 0.08–0.18 | 0.20% |
| Earn Income | Covered call | 14–35 | 100%–110% | 0.30–0.45 | 1.00% |
| Earn Income | Cash-secured put | 14–35 | 90%–100% | 0.30–0.45 | 1.00% |
| Plan Exit | Covered call | 7–21 | 95%–105% | 0.45–0.65 | 0.25% |
| Plan Entry | Cash-secured put | 7–28 | 97%–100% | 0.40–0.55 | 0.50% |

| Goal | Maximum spread | Minimum open interest | Minimum volume | Close at capture |
| --- | ---: | ---: | ---: | ---: |
| Keep Shares | 8% | 100 | 20 | 35% |
| Earn Income, both legs | 8% | 100 | 20 | 50% |
| Plan Exit | 10% | 50 | 10 | 90% |
| Plan Entry | 10% | 50 | 10 | 85% |

| Goal | Applicable leg | Roll review starts at |
| --- | --- | ---: |
| Keep Shares | Covered call | 21 DTE |
| Earn Income | Covered call | 21 DTE |
| Earn Income | Cash-secured put | 21 DTE |
| Plan Exit | Covered call | 7 DTE |
| Plan Entry | Cash-secured put | 7 DTE |

The choices follow the strategy mechanics rather than treating one delta or expiration as universally ideal. Keep Shares and Earn Income start review at 21 DTE because near-expiration gamma rises while time decay accelerates, so a review at three weeks leaves time to compare choices. Plan Exit and Plan Entry wait until 7 DTE because assignment serves those goals; review is still available earlier when price, delta, or intent conflicts. These are review reminders, not automatic roll signals. Sources: [OIC on near-expiration gamma and theta](https://www.optionseducation.org/news/april-office-hours-faqs-options-strategy-time-decay-and-market-mechanics), [OIC covered call](https://www.optionseducation.org/strategies/all-strategies/covered-call-buy-write), [OIC cash-secured put](https://www.optionseducation.org/strategies/all-strategies/cash-secured-put), and [Fidelity on rolling covered calls](https://www.fidelity.com/learning-center/investment-products/options/rolling-covered-calls).

Radar ranks delta and DTE against the midpoint of the saved goal range. A complete profile therefore controls both eligibility and fit ranking. The generic 0.25 delta and 30 DTE scoring targets apply only when a complete range is unavailable.

Plan Exit may admit a below-spot call only when the ticker has a minimum net sale price. The price guard prevents richer premium from making an unacceptable sale price look attractive. Plan Entry never admits an in-the-money put. Its maximum net purchase price remains the ticker-specific acquisition ceiling.

Settings displays `closeAtProfitCapture` as `Close when premium captured` and edits it as a percentage. It displays `rollReviewDte` as `Review rolls at or below DTE`. The lower Keep Shares close threshold removes assignment exposure sooner after much of the credit is earned. The high Exit and Entry thresholds avoid having the Close signal routinely fight an assignment-oriented goal.

If IndexedDB has no saved document, the browser creates a deterministic copy of these profiles.

Saved profiles that still exactly match the former built-ins are upgraded to the current defaults when loaded. A profile with any customized metric remains untouched. Choosing `Reset to recommended` in the goal editor applies the current preset to that goal and leg.

The browser migrates version 2 documents to version 3 before Settings renders or validates. Missing Close thresholds become 0.50. Missing roll thresholds receive the current goal default, and untouched former 10-DTE defaults move to the current 21-DTE review window. Version 2 per-leg goals collapse into one ticker goal. When only one leg was enabled, that leg's goal wins. Conflicting enabled goals resolve to Earn Income when present because it supports both strategies. Ticker overrides, price guards, and timestamps remain intact. The retired `maxQuoteAgeSeconds` field is removed during compatibility loading.

## Persistence

The browser stores the normalized document in the `tickerStrategies` IndexedDB store under the `document` key. The repository has no server-side settings file or settings database. Erasing saved financial data from Settings clears this document with the other local portfolio data.

## Browser-local request contract

The UI retains its versioned request shape, but the local-first fetch adapter handles these requests inside the browser. They are not deployed Vercel endpoints.

### `GET /api/v1/strategy-settings`

Returns:

```json
{
  "settings": { "schemaVersion": 3, "goalProfiles": {}, "tickerPlaybooks": {} },
  "persistence": { "persisted": true, "storage": "indexeddb", "updatedAt": "..." }
}
```

The abbreviated objects above are populated in the real response.

### `PUT /api/v1/strategy-settings`

Accepts one complete editable document, normalizes it, and replaces the prior IndexedDB value. It returns the normalized document in `settings` plus browser-generated persistence metadata.

Effective settings are resolved directly in the browser for Radar and position management. The result includes the normalized symbol and leg, complete `rules`, `enabled`, `goal`, the applicable `priceGuard`, and a per-rule `sourceMap`.
