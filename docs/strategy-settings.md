# Strategy Settings v2

Strategy settings provide the authoritative rules for Radar and Close. Radar resolves them for eligible new-trade targets. Close resolves them for every open short option, including untracked tickers and disabled legs. Neither feature places orders.

Goal profiles are editable starting points, not trading recommendations. Quotes and candidates must still be verified with a broker.

## Inheritance

Every effective rule is resolved in this order:

```text
selected goal and strategy profile
→ explicitly set ticker/leg override
```

Goal profiles are complete rule sets. Removing a ticker override restores the selected goal value. The effective resolver reports `goal` or `tickerOverride`.

Ticker playbooks contain both strategy legs. Each leg has its own enabled state, compatible goal, price guard, and partial rule overrides. An unconfigured ticker remains disabled and has no price guard, but it still resolves a goal profile. Stocks and unknown instrument types default to Earn Income. ETF and mutual-fund covered calls default to Keep Shares. Cash-secured puts default to Earn Income because Keep Shares is not compatible with puts. A saved ticker goal always wins.

The Settings UI populates its ticker collection from wheel-trade history, saved playbooks, and tickers added from Radar's circular plus action. Radar verifies the instrument and asks for the goal first. Keep Shares and Plan Exit infer CC. Plan Entry infers CSP. Earn Income reveals the CC/CSP choice. Plan Entry is the initial goal. A newly created playbook enables only the selected leg; adding or editing a leg preserves the other leg's enabled state and settings. Its small recent-ticker hint is stored locally under `wheely-nilly.screened-tickers.v1` and contains the symbol, instrument identity, selected leg, starting goal, and last-used timestamp. Removing a ticker from Radar deletes this hint and its saved playbook. A ticker with trade history remains visible in Settings because history is an independent source. Capsules are ordered by most recent activity, show eight initially, and can be searched or expanded.

## Document shape

The editable document has `schemaVersion: 2` and two scopes:

- `goalProfiles.protect`, `income`, `exit`, and `acquire` contain complete rule sets keyed by compatible strategy leg. Earn Income has separate covered-call and cash-secured-put profiles.
- `tickerPlaybooks` is keyed by normalized uppercase symbols. Every playbook contains `coveredCall` and `cashSecuredPut` settings.

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

All objects reject unknown fields. Validation also rejects unsafe integers, malformed tickers, unsupported goal/leg pairs, out-of-range values, and effective DTE, moneyness, or delta inversions.

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
| Keep Shares | Covered call | 10 DTE |
| Earn Income | Covered call | 10 DTE |
| Earn Income | Cash-secured put | 10 DTE |
| Plan Exit | Covered call | 7 DTE |
| Plan Entry | Cash-secured put | 7 DTE |

The choices follow the strategy mechanics rather than treating one delta or expiration as universally ideal. Higher out-of-the-money covered-call strikes retain more upside but collect less premium; an acceptable covered-call strike plus premium should also be an acceptable liquidation price. A cash-secured put is an acquisition strategy whose seller should be willing to own the shares at the strike. Shorter expirations usually require more management. Sources: [OIC covered call](https://www.optionseducation.org/strategies/all-strategies/covered-call-buy-write), [OIC cash-secured put](https://www.optionseducation.org/strategies/all-strategies/cash-secured-put), and [Fidelity on selecting a strike and expiration](https://www.fidelity.com/learning-center/investment-products/options/selecting-strike-price-expiration-date).

Radar ranks delta and DTE against the midpoint of the saved goal range. A complete profile therefore controls both eligibility and fit ranking. The generic 0.25 delta and 30 DTE scoring targets apply only when a complete range is unavailable.

Plan Exit may admit a below-spot call only when the ticker has a minimum net sale price. The price guard prevents richer premium from making an unacceptable sale price look attractive. Plan Entry never admits an in-the-money put. Its maximum net purchase price remains the ticker-specific acquisition ceiling.

Settings displays `closeAtProfitCapture` as `Close when premium captured` and edits it as a percentage. It displays `rollReviewDte` as `Review rolls at or below DTE`. The lower Keep Shares close threshold removes assignment exposure sooner after much of the credit is earned. The high Exit and Entry thresholds avoid having the Close signal routinely fight an assignment-oriented goal.

If no saved file exists, the service returns a fresh deterministic copy of these profiles with `persistence.persisted: false`.

Saved profiles that still exactly match the former built-ins are upgraded to the current defaults when loaded. A profile with any customized metric remains untouched. Choosing `Reset to recommended` in the goal editor applies the current preset to that goal and leg.

The loader accepts persisted version 1 documents and migrates them in memory. It merges each strategy's saved global rules with every compatible goal preset, producing complete version 2 profiles while preserving ticker overrides and the saved timestamp. It also accepts saved version 2 documents that predate `closeAtProfitCapture` or `rollReviewDte`. Missing Close thresholds become 0.50. A missing roll threshold becomes the former decision rule, `min(10, minDte)`, for that saved profile. Every saved current field remains intact. The retired `maxQuoteAgeSeconds` strategy-setting field is removed during compatibility loading. Radar retains its provider-side freshness behavior, but quote freshness is not user-configurable and never affects Close. The next save writes the current version 2 shape.

## Persistence

The service stores the normalized document at `data/config/strategy-settings.json`. It creates `data/config/` with mode `0700`, writes a unique mode-`0600` temporary file, and atomically renames it over the destination. Writes are serialized within the backend process. `updatedAt` is generated by the server and stored beside the editable document; clients cannot supply it.

`data/` remains ignored by Git. Strategy settings contain no brokerage credentials or other secrets, but should still be included in the encrypted runtime-data backup.

## API

All endpoints are same-origin, versioned, non-cacheable, and use the existing `{ error: { code, message } }` error envelope.

### `GET /api/v1/strategy-settings`

Returns:

```json
{
  "settings": { "schemaVersion": 2, "goalProfiles": {}, "tickerPlaybooks": {} },
  "persistence": { "persisted": false, "updatedAt": null }
}
```

The abbreviated objects above are populated in the real response.

### `PUT /api/v1/strategy-settings`

Accepts one complete editable document and atomically replaces the prior settings after validation. It returns the normalized document in `settings` plus server-controlled persistence metadata. The shared JSON parser limits request bodies to 100 KB.

### `GET /api/v1/strategy-settings/effective?symbol=VOOG&leg=coveredCall`

`leg` must be `coveredCall` or `cashSecuredPut`. The response includes the normalized symbol and leg, complete `rules`, `enabled`, `goal`, the applicable `priceGuard`, and a per-rule `sourceMap`.
