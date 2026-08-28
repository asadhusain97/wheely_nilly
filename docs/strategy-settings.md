# Strategy Settings v2

Strategy settings provide the authoritative rules for Radar and Close. Radar resolves them for eligible new-trade targets. Close resolves them for every open short option, including untracked tickers and disabled legs. Neither feature places orders.

Goal profiles are editable starting points, not trading recommendations. Quotes and candidates must still be verified with a broker.

## Inheritance

Every effective rule is resolved in this order:

```text
selected goal and strategy profile
→ explicitly set ticker/leg override
```

Goal profiles are complete rule sets. Removing a ticker override restores the selected goal value. The effective resolver reports `goal` or `tickerOverride` for configured tickers. Direct requests for an unconfigured ticker use the private system fallback and report `system`.

Ticker playbooks contain both strategy legs. Each leg has its own enabled state, compatible goal, price guard, and partial rule overrides. An unconfigured ticker resolves to the system fallback with `enabled: false`, `goal: null`, and no price guard.

The Settings UI populates its ticker collection from wheel-trade history, saved playbooks, and tickers added from Radar's circular plus action. Radar verifies the instrument and asks for the goal first. Keep Shares and Plan Exit infer CC. Plan Entry infers CSP. Earn Income reveals the CC/CSP choice. Plan Entry is the initial goal. A newly created playbook enables only the selected leg; adding or editing a leg preserves the other leg's enabled state and settings. Its small recent-ticker hint is stored locally under `wheely-nilly.screened-tickers.v1` and contains only the symbol, selected leg, starting goal, and last-used timestamp. Removing a ticker from Radar deletes this hint and its saved playbook. A ticker with trade history remains visible in Settings because history is an independent source. Capsules are ordered by most recent activity, show eight initially, and can be searched or expanded.

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

All objects reject unknown fields. Validation also rejects unsafe integers, malformed tickers, unsupported goal/leg pairs, out-of-range values, and effective DTE, moneyness, or delta inversions.

## Recommended profiles

Every recommended profile starts with 0.80–1.20 moneyness, 0.20 maximum spread, 10 minimum open interest, 0 minimum volume, 0 minimum period return, and a 0.50 Close threshold. The goal supplies DTE and delta values. Settings displays `closeAtProfitCapture` as `Close when premium captured` and edits it as a percentage in the existing rule editor.

The recommended profiles are:

| Preset | Applicable leg | DTE | Delta |
| --- | --- | --- | --- |
| Keep Shares | Covered call | 30–60 | 0.10–0.20 |
| Earn Income | Covered call | 21–45 | 0.20–0.35 |
| Earn Income | Cash-secured put | 21–45 | 0.20–0.35 |
| Plan Exit | Covered call | 7–30 | 0.35–0.70 |
| Plan Entry | Cash-secured put | 21–45 | 0.20–0.35 |

If no saved file exists, the service returns a fresh deterministic copy of these profiles with `persistence.persisted: false`.

The loader accepts persisted version 1 documents and migrates them in memory. It merges each strategy's saved global rules with every compatible goal preset, producing complete version 2 profiles while preserving ticker overrides and the saved timestamp. It also accepts saved version 2 documents that predate `closeAtProfitCapture`, supplies the 0.50 default, and preserves every saved current field. The retired `maxQuoteAgeSeconds` strategy-setting field is removed during compatibility loading. Radar retains its provider-side freshness behavior, but quote freshness is not user-configurable and never affects Close. The next save writes the current version 2 shape.

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
