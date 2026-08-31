# Wheely Nilly design language

Wheely Nilly is a private, mobile-first options workspace. Its interface should feel like a calm Apple utility: precise, lightweight, and touch-native. Financial state is dense enough already, so decoration must clarify hierarchy rather than compete with it.

## Visual tokens

| Token | Value | Use |
| --- | --- | --- |
| Pearl glass | `rgba(255, 255, 255, .64)` | Primary translucent surfaces |
| Strong glass | `rgba(255, 255, 255, .82)` | Headers and raised controls |
| Mist | `rgba(241, 241, 237, .62)` | Recessed controls and secondary rows |
| Graphite | `#11110f` | Primary text |
| Smoke hairline | `rgba(38, 38, 34, .09)` | Borders and separators |
| Wheely red | `#e60023` | Primary action and active intent |
| Keep Shares blue | `#376f9e` | Keep Shares goal identity |
| Earn Income green | `#23704a` | Earn Income goal identity |
| Plan Exit red | `#c33c50` | Plan Exit goal identity |
| Plan Entry violet | `#6c5bb7` | Plan Entry goal identity |

Glass surfaces use a light diagonal white gradient, a soft inset highlight, a low neutral shadow, and `backdrop-filter: blur(18–30px) saturate(150–175%)`. Avoid dark dashboard slabs, heavy outlines, and gratuitous colored status panels. Amber and red surfaces are reserved for actionable stale/error states; green appears only for a verified or passing state.

Typography uses the app's Pin Sans/system stack for text, the rounded system stack for important financial figures, and tabular numerals for prices and returns. Headlines are compact with slightly negative tracking. Utility labels use plain sentence case unless a short eyebrow genuinely establishes context. Visible interface text has a 12px minimum size, including dense metadata, badges, chart labels, and mobile controls.

## Interaction principles

- Touch targets are at least 44px.
- Primary navigation is Home, Trades, Radar, and Settings. Radar uses a concentric sweep icon rather than a filter funnel.
- Add and edit flows use bottom sheets on mobile and floating glass sheets on wider screens.
- A circular plus button means “add”; do not keep full creation forms open in the page.
- Provider-derived and estimated values must be distinguishable.
- Empty states explain the next action. Success state should usually be the absence of an alert.
- Focus rings, keyboard operation, Escape dismissal, and reduced-motion behavior are required.

## Open contracts

Open-contract cards are decision summaries. Ticker, current stock price, and recommendation lead, followed by two economics metrics and premium-capture progress. The recommendation calls out an in-the-money contract immediately and keeps the roll-candidate action as a text link directly below the reason. A centered arrow-only disclosure ends the collapsed card. Its accessible label changes between showing and hiding the position check, and its full 44px control remains keyboard and touch accessible.

The ticker's effective goal appears as a quiet goal-colored chip. Unconfigured stocks default to Earn Income; ETF and mutual-fund covered calls default to Keep Shares. Cash-secured puts use Earn Income when no compatible goal is saved. Every open contract offers a compact `Check roll candidates` action. The action stays quiet unless goal, assignment intent, time, or delta makes a roll worth reviewing, when it receives a warning treatment. An aligned ITM assignment reads `Let assignment work`; its manual candidate check remains available without the warning treatment.

Roll choices open in a Home bottom sheet, never by redirecting to Radar. The sheet starts with the broker search profile, then a current-to-replacement swap rail and three decision numbers: conservative net credit/debit, added days, and effective assignment price. At most two alternate matches and an optional audit disclosure follow. The only primary action copies a two-leg broker handoff; it does not resemble or prepare an order ticket.

Expansion starts with three short management inferences: profit-target status, assignment risk, and exit liquidity. A fourth roll-decision inference appears only when roll review or aligned assignment is relevant. Each inference uses the same restrained positive, neutral, or warning language as Radar, but it interprets the position now rather than re-evaluating the original trade. The market-data time sits beside this check so users can judge its freshness.

Audit context follows in one balanced grid for opening premium, buyback estimate, collateral, breakeven, bid/ask with spread context, delta, and IV. The stock price already appears in the card header. Do not repeat P/L, earned per day, strike, expiration, or DTE in the audit grid. The position check may reuse a metric only when it explains what the current value means.

## Radar

Radar's single job is to find wheel trades that fit the user's saved rules. Its structure is:

```text
Radar
Find your next wheel trade
                                                   (+)
                                              Scan all

[Eligible owned tickers — only when any exist]
  [glass ticker card]

Manually tracked tickers
  [glass ticker card or concise add invitation]

Customize ticker rules on Settings.
```

Adding a ticker opens a glass sheet. The flow asks for a provider-verified instrument and goal. Keep Shares and Plan Exit imply CC, Plan Entry implies CSP, and only Earn Income asks the user to choose CC or CSP. Plan Entry is selected initially. It saves through the existing strategy-settings document and does not expose advanced rule controls. Instrument results show the symbol, recognizable name, type, and an exchange when the provider supplies one. Never present a country or region as an exchange.

Goal identity is consistent wherever a goal appears: Keep Shares is blue, Earn Income is green, Plan Exit is red, and Plan Entry is violet. Goal choices use segmented tabs rather than native dropdowns in focused creation flows.

Ticker cards carry the hierarchy and begin collapsed until the user opens them. Their header identifies the symbol and actual share coverage; the surrounding section already communicates whether a ticker is manually tracked. Do not add a redundant “Playbook” badge. Each enabled strategy shows its goal, effective-rule summary, scan action, and results. Candidate details may expand within the card. Net contract credit and period return remain more prominent than annualized return.

Manually tracked ticker cards include a quiet trash icon with a 44px touch target. The first tap changes that control to “Are you sure?” and the second removes its saved rules and Radar's local recent-ticker record. A manual ticker then disappears from Radar. It also disappears from Settings when it has no portfolio or trade-history source. Historical tickers remain discoverable in Settings. Owned eligible tickers do not show this removal action because holdings continue to qualify them for Radar. Do not use a separate browser confirmation dialog.

After a scan, show only the market-data time and provider name below it. The source label is "Yahoo Finance." Do not display unofficial-data or cache prose in this compact line. When no contracts match, explain that the available contracts missed the playbook and name up to three main filters without showing exclusion counts.

Brief confirmations appear above the bottom navigation as pearl-glass notices. Success uses a small Earn Income green mark; errors use a small Plan Exit red mark. Never use a solid black toast or a full colored panel for routine confirmation.

The signature interaction is verified identity selection: results collapse back into the search field, with the company name shown as quiet supporting text before the ticker can be added. It confirms the choice without adding another card or colored status panel.
