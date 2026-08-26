import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { rootDirectory } from '../src/config/index.js';

const html = readFileSync(path.join(rootDirectory, 'frontend/index.html'), 'utf8');
const css = readFileSync(path.join(rootDirectory, 'frontend/assets/css/app.css'), 'utf8');
const settingsCss = readFileSync(path.join(rootDirectory, 'frontend/assets/css/settings.css'), 'utf8');
const js = readFileSync(path.join(rootDirectory, 'frontend/assets/js/app.js'), 'utf8');
const glossaryJs = readFileSync(path.join(rootDirectory, 'frontend/assets/js/glossary.js'), 'utf8');
const settingsJs = readFileSync(path.join(rootDirectory, 'frontend/assets/js/settings.js'), 'utf8');
const screenerJs = readFileSync(path.join(rootDirectory, 'frontend/assets/js/screener.js'), 'utf8');
const screenerCss = readFileSync(path.join(rootDirectory, 'frontend/assets/css/screener.css'), 'utf8');
const goalSelectorCss = readFileSync(path.join(rootDirectory, 'frontend/assets/css/goal-selector.css'), 'utf8');

describe('responsive dashboard shell', () => {
  it('has semantic landmarks, labels, live regions, and keyboard navigation support', () => {
    for (const token of ['<header', '<main', '<nav', '<dl', 'aria-live=', 'skip-link', '<label']) assert.match(html, new RegExp(token));
    assert.match(css, /:focus-visible/);
    assert.match(css, /prefers-reduced-motion/);
  });
  it('uses a mobile-native app shell, safe areas, and persistent bottom navigation', () => {
    assert.match(html, /viewport-fit=cover/);
    assert.match(html, /class="bottom-nav"/);
    assert.match(css, /min-width:320px/);
    assert.match(css, /env\(safe-area-inset-bottom\)/);
    assert.match(css, /width:min\(100%,560px\)/);
    assert.match(css, /min-width:44px;min-height:44px/);
    assert.match(css, /backdrop-filter:blur\(var\(--glass-blur\)\) saturate\(var\(--glass-saturation\)\)/);
  });
  it('uses the Wheely Nilly brand and logo assets', () => {
    assert.match(html, /<title>Wheely Nilly<\/title>/);
    assert.match(html, /class="brand-mark" src="\/assets\/images\/logo\.png"/);
    assert.match(html, /rel="icon"[^>]+href="\/assets\/images\/favicon\.png"/);
  });
  it('surfaces performance, collateral, conditional opportunities, and open trades from one dashboard projection', () => {
    for (const id of ['booked-profit', 'return-rate', 'annualized-return-rate', 'wheel-capital', 'open-csps', 'open-ccs', 'opportunity-list', 'open-trade-list']) {
      assert.match(html, new RegExp(`id="${id}"`));
    }
    assert.match(js, /\/api\/v1\/wheel\/dashboard/);
    assert.match(js, /Rollover comparison logic is the next feature/);
    assert.match(js, /tradeLabel.*since/s);
    assert.doesNotMatch(js, /closed trades included in returns/);
    assert.match(html, /id="opportunities-section"[^>]+hidden/);
    assert.match(js, /section\.hidden = !?false/);
    assert.doesNotMatch(html, /id="flow-cash"|class="capital-loop"/);
    assert.doesNotMatch(js, /Cash ready for puts/);
  });
  it('keeps the performance card hierarchy aligned around one full-width divider', () => {
    const performanceHero = html.match(/<section class="performance-hero"[\s\S]*?<\/section>/)?.[0] ?? '';
    assert.match(performanceHero, /class="profit-primary"[\s\S]*class="hero-label"[\s\S]*class="hero-total"/);
    assert.ok(performanceHero.indexOf('class="return-secondary"') < performanceHero.indexOf('class="quality-line"'));
    assert.match(css, /\.profit-primary\{[^}]*grid-row:2[^}]*align-self:end/);
    assert.match(css, /\.return-secondary\{[^}]*grid-row:2[^}]*align-self:end/);
    assert.match(css, /\.quality-line\{[^}]*grid-column:1\/-1[^}]*border-top:/);
  });
  it('keeps efficiency ahead of opportunities and open trades', () => {
    assert.ok(html.indexOf('id="efficiency-title"') < html.indexOf('id="opportunities-title"'));
    assert.ok(html.indexOf('id="efficiency-title"') < html.indexOf('id="open-trades-title"'));
  });
  it('keeps primary navigation to four clear destinations', () => {
    const navigation = html.match(/<nav class="bottom-nav"[\s\S]*?<\/nav>/)?.[0] ?? '';
    assert.equal((navigation.match(/<button/g) ?? []).length, 4);
    for (const label of ['Home', 'Trades', 'Radar', 'Settings']) assert.match(navigation, new RegExp(`>${label}<`));
  });
  it('provides a playbook-aware mobile opportunity workspace', () => {
    for (const id of ['open-monitor-add', 'monitor-add-dialog', 'screener-add-ticker', 'screener-add-symbol', 'monitor-leg-tabs', 'monitor-goal-tabs', 'owned-monitor-group', 'owned-monitor-targets', 'tracked-monitor-targets', 'monitor-open-settings']) {
      assert.match(html, new RegExp(`id="${id}"`));
    }
    assert.match(html, /<p>Radar<\/p>[\s\S]*?<h1 id="screener-title">Find your next wheel trade<\/h1>/);
    assert.match(html, /Find your next wheel trade/);
    assert.match(html, /value="cashSecuredPut"\s+checked/);
    assert.doesNotMatch(html, /id="screener-add-goal"|class="monitor-goal-field"/);
    assert.match(html, /You can customize monitoring configs for this ticker from the Settings page/);
    assert.match(html, /Search by ticker or company name/);
    assert.doesNotMatch(html, /selected-instrument|verified-mark|Add a valid instrument/);
    assert.doesNotMatch(html, /monitor-last-scan|monitor-freshness|monitor-target-count|Targets use current holdings|Edit playbook/);
    assert.doesNotMatch(html, /id="screener-form"|id="screener-body"/);
    for (const token of ['net_contract_credit', 'period_return', 'estimated_fees', 'theta_per_day', 'greek_source', 'implied_volatility', 'breakeven', 'strike_distance', 'annualized_return', 'candidate.bid', 'candidate.ask']) {
      assert.match(screenerJs, new RegExp(token.replace('.', '\\.')));
    }
    for (const token of ['Fits ', 'candidate-fit', 'contract_symbol', 'Option type', 'Quote time', 'gross_contract_credit', 'downside_buffer', 'quote_age_seconds', 'Applied rules', 'candidate-rules', 'Calculation assumptions', 'candidate-assumptions', 'Why other contracts were filtered', 'candidate-exclusions', 'exclusionsText']) {
      assert.doesNotMatch(screenerJs, new RegExp(token));
    }
    assert.doesNotMatch(screenerJs, /scanAll|scan-all/);
    assert.match(screenerJs, /state\.loading\.has/);
    assert.match(screenerJs, /\/api\/v1\/screens\/instruments\?query=/);
    assert.match(screenerJs, /Select a verified instrument from the results/);
    assert.match(screenerJs, /const sequence = \+\+state\.searchSequence/);
    assert.match(screenerJs, /results\.hidden = true;[\s\S]*?results\.replaceChildren\(\);/);
    assert.match(screenerJs, /input\.type = 'radio'; input\.name = 'goal'/);
    assert.match(screenerJs, /keepFocusInAddDialog/);
    assert.match(screenerJs, /setAttribute\('inert'/);
    assert.match(screenerJs, /owned-monitor-group'\)\.hidden = ownedTargets\.length === 0/);
    assert.match(screenerJs, /monitor-remove-button/);
    assert.match(screenerJs, /monitor-target-toggle/);
    assert.match(screenerJs, /state\.collapsed/);
    assert.match(screenerJs, /targetIdentity/);
    assert.match(screenerJs, /hydrateTargetIdentities/);
    assert.match(screenerJs, /exactInstrumentIdentity/);
    assert.match(screenerJs, /instrumentType/);
    assert.doesNotMatch(screenerJs, /Name unavailable|'Instrument'/);
    assert.doesNotMatch(screenerJs, /monitor-target-disclosure/);
    assert.match(screenerJs, /rememberTicker\(state\.selectedInstrument/);
    assert.match(screenerJs, /trashIcon/);
    assert.match(screenerJs, /Are you sure\?/);
    assert.match(screenerJs, /target\.manuallyTracked && !target\.owned/);
    assert.match(screenerJs, /async function removeTarget/);
    assert.match(screenerJs, /Yahoo Finance/);
    assert.match(screenerJs, /No match right now/);
    assert.doesNotMatch(screenerJs, /'Playbook'|provider-strip|Provider error:/);
    assert.match(settingsJs, /async function addTicker/);
    assert.match(settingsJs, /async function removeTicker/);
    assert.match(settingsJs, /function settingsWithTicker[\s\S]*?tickerPlaybooks\[symbol\]\[leg\]\.enabled = true/);
    assert.match(js, /getTrackedTickers:[\s\S]*?tickerPerformance[\s\S]*?screenedTickers/);
    assert.match(js, /name: typeof instrument === 'object' \? instrument\.name/);
    assert.match(js, /removeTicker: async[\s\S]*?forgetScreenedTicker\(symbol\)[\s\S]*?strategySettingsController\.refresh\(\)/);
    assert.match(screenerCss, /@media \(max-width: 360px\)/);
    assert.match(screenerCss, /prefers-reduced-motion: reduce/);
    assert.match(screenerCss, /backdrop-filter: blur\(22px\) saturate\(165%\)/);
    assert.match(html, /class="layer-tabs strategy-tabs" id="global-leg-tabs"/);
    assert.match(html, /class="layer-tabs strategy-tabs" id="monitor-leg-tabs"/);
    assert.match(settingsCss, /\.layer-tabs button,[\s\S]*?\.layer-tabs \.strategy-option > span/);
    assert.match(settingsCss, /\.layer-tabs button,\s*\.layer-tabs \.strategy-option > span\s*\{\s*min-height: 38px/);
    assert.match(settingsCss, /\.strategy-tabs > button,[\s\S]*?flex: 1 1 0/);
    assert.match(screenerCss, /\.instrument-search-results\[hidden\] \{ display: none; \}/);
    for (const goal of ['protect', 'income', 'exit', 'acquire']) assert.match(goalSelectorCss, new RegExp(`data-goal="${goal}"`));
    assert.match(goalSelectorCss, /#goal-preset-tabs[\s\S]*?#monitor-goal-tabs/);
    assert.match(goalSelectorCss, /backdrop-filter: blur\(12px\) saturate\(135%\)/);
    assert.doesNotMatch(goalSelectorCss, /linear-gradient|::before|::after|animation:/);
    assert.match(goalSelectorCss, /#goal-preset-tabs \.goal-chip\s*\{[^}]*min-width: 0[^}]*flex: 1 1 0/);
    assert.match(html, /class="layer-tabs goal-tabs goal-picker" id="goal-preset-tabs"/);
    assert.match(html, /class="goal-picker" id="monitor-goal-tabs"/);
    assert.match(screenerCss, /\.monitor-leg-picker legend, \.monitor-goal-picker legend \{[^}]*margin-bottom: 6px/);
    assert.match(goalSelectorCss, /prefers-reduced-transparency: reduce/);
    assert.match(screenerCss, /\.monitor-remove-button\.is-confirming/);
    assert.match(screenerCss, /\.monitor-symbol-mark \{[^}]*width: auto[^}]*white-space: nowrap/);
    assert.match(screenerCss, /\.monitor-target-body\[hidden\]/);
    assert.doesNotMatch(screenerCss, /\.monitor-target-disclosure/);
    assert.match(screenerCss, /\.candidate-open-label \{[^}]*min-width: 56px[^}]*grid-column: 1\/-1[^}]*grid-row: 3/);
    assert.match(screenerCss, /\.candidate-open-label::after \{[^}]*width: 4px[^}]*height: 4px[^}]*border-right: 1\.25px solid currentColor[^}]*transform: rotate\(45deg\)/);
    assert.match(screenerCss, /\.candidate-card\[open\] \.candidate-open-label::after \{ transform: rotate\(225deg\); \}/);
    assert.doesNotMatch(screenerCss, /content: "⌄"/);
    assert.doesNotMatch(screenerCss, /\.scan-all-button/);
    assert.match(screenerCss, /\.scan-source small/);
    assert.doesNotMatch(screenerCss, /\.provider-strip/);
    assert.doesNotMatch(screenerCss, /background:\s*(?:#000|black|rgba\(0,\s*0,\s*0)/i);
    assert.match(html, /href="\/assets\/css\/screener\.css"/);
    assert.match(html, /href="\/assets\/css\/goal-selector\.css"/);
    assert.match(js, /toast-mark/);
    assert.match(css, /\.toast\.is-success \.toast-mark/);
  });
  it('keeps strategy settings focused and opens the glossary in an accessible sheet', () => {
    const moreStart = html.indexOf('<section class="app-screen" id="more"');
    const more = html.slice(moreStart, html.indexOf('</main>', moreStart));
    assert.match(more, /<h1 id="more-title">Strategy settings<\/h1>/);
    assert.match(more, /id="open-glossary"[^>]+aria-haspopup="dialog"[^>]+aria-controls="glossary-dialog"/);
    assert.doesNotMatch(more, /id="glossary-title"|class="glossary-group"/);
    for (const id of ['strategy-settings-workspace', 'global-leg-tabs', 'goal-preset-tabs', 'settings-ticker-search', 'settings-ticker-count', 'ticker-playbook-list', 'settings-status']) {
      assert.match(more, new RegExp(`id="${id}"`));
    }
    assert.ok(more.indexOf('settings-global-title') < more.indexOf('settings-goals-title'));
    assert.ok(more.indexOf('settings-goals-title') < more.indexOf('settings-tickers-title'));
    assert.doesNotMatch(more, /settings-lineage|settings-scopes|data-settings-scope/);
    assert.match(more, /<h2 id="settings-global-title">Defaults<\/h2>/);
    assert.match(more, /Lighter values come\s+from Defaults/);
    assert.match(html, /href="\/assets\/css\/settings\.css"/);
    assert.match(more, /class="settings-edit"[^>]+title="Edit default settings"[\s\S]*?<svg/);
    assert.doesNotMatch(more, />\s*Edit\s*</);
    assert.match(more, /editable starting points, not trading recommendations/);
    assert.match(more, /class="settings-support"[^>]+aria-label="Support Wheely Nilly"/);
    assert.match(more, /href="https:\/\/ko-fi\.com\/asadhusain"[^>]+target="_blank"[^>]+rel="noopener noreferrer">leave a tip/);
    assert.doesNotMatch(more, /Buy Me a Chai|buymeachai|>Ko-fi</);
    for (const id of ['settings-editor-dialog', 'settings-editor-form', 'settings-reset-defaults', 'save-strategy-settings', 'settings-editor-drag-zone']) {
      assert.match(html, new RegExp(`id="${id}"`));
    }
    assert.match(html, /class="settings-editor-sheet"[^>]+role="dialog"[^>]+aria-modal="true"/);
    for (const token of ['Advanced rules', 'minNetSalePriceMinor', 'maxNetPurchasePriceMinor', 'Settings saved', 'window.confirm', '/api/v1/strategy-settings', 'getTrackedTickers', 'field-inherit-reset', 'BUILT_IN_GLOBAL', 'pointerdown']) {
      assert.match(settingsJs, new RegExp(token));
    }
    assert.doesNotMatch(settingsJs, /override-toggle|data-settings-scope/);
    assert.doesNotMatch(settingsJs, /Set here|↩/);
    assert.doesNotMatch(settingsJs, /Monitor this strategy|monitor-switch|Check the highlighted value|reportValidity/);
    assert.match(settingsJs, /function constrainNumericInput/);
    assert.match(settingsJs, /input\.inputMode = allowDecimal \? 'decimal' : 'numeric'/);
    assert.match(settingsJs, /\['e', 'E', '\+', '-'\]\.includes\(event\.key\)/);
    assert.match(settingsJs, /input\.min = '0';[\s\S]*?input\.step = '0\.01'/);
    assert.doesNotMatch(settingsJs, /input\.type = 'text'/);
    assert.match(settingsJs, /Object\.values\(model\.editor\.draft\.tickerPlaybooks\[model\.editor\.symbol\]\)[\s\S]*?settings\.enabled = true/);
    assert.match(settingsJs, /function resolveTickerGoal/);
    assert.match(settingsJs, /sorted\.slice\(0, 8\)/);
    assert.match(settingsJs, /b\.recency - a\.recency/);
    assert.match(settingsJs, /model\.tickerQuery/);
    assert.doesNotMatch(settingsJs, /Add ticker|openAddEditor|renderAddEditor|continueAdd|ticker-add-capsule/);
    assert.match(css, /\.settings-stack\{[^}]*display:grid/);
    assert.match(css, /\.rule-value\.is-inherited\{[^}]*color:/);
    assert.match(css, /\.settings-editor-sheet\{[^}]*height:min\(92dvh,900px\)/);
    assert.match(css, /prefers-reduced-motion:reduce\)[\s\S]*?\.settings-editor-sheet/);
    assert.match(settingsCss, /\.settings-layer\s*\{[^}]*backdrop-filter: blur\(22px\) saturate\(165%\)/);
    assert.match(settingsCss, /\.settings-edit\s*\{[^}]*background: transparent/);
    assert.match(settingsCss, /\.settings-layer-heading small\s*\{[^}]*font-size: 12px/);
    assert.match(settingsCss, /\.rule-value\.is-inherited\s*\{[^}]*color: #9a9a94/);
    assert.match(settingsCss, /\.ticker-leg-panel \.editor-rule-copy small\s*\{[^}]*color: rgba\(85, 85, 79, \.48\)[^}]*font-weight: 500/);
    assert.match(settingsJs, /goal-picker ticker-goal-picker/);
    assert.match(settingsJs, /tickerRules\.querySelector\('\.editor-rule-list'\)\.prepend\(priceGuard/);
    assert.doesNotMatch(settingsJs, /document\.createElement\('select'\)/);
    assert.match(settingsCss, /\.ticker-price-guard \.editor-rule-controls\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) 34px/);
    assert.match(settingsCss, /\.rule-separator\s*\{[^}]*color: inherit/);
    assert.match(settingsCss, /\.settings-rule-advanced > summary\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) 20px/);
    assert.match(settingsCss, /\.disclosure-icon\s*\{[^}]*justify-self: end/);
    assert.match(settingsCss, /\.settings-rule-advanced\[open\] > summary::after\s*\{[^}]*content: none/);
    assert.match(settingsCss, /\.settings-ticker-search\s*\{/);
    assert.match(settingsCss, /\.ticker-more\s*\{/);
    assert.match(settingsCss, /\.settings-support a\s*\{[^}]*min-height: 44px/);
    assert.match(settingsCss, /\.settings-stack::before,[\s\S]*?content: none/);
    assert.match(settingsCss, /\.settings-editor-sheet,[\s\S]*?backdrop-filter: blur\(30px\) saturate\(175%\)/);
    assert.match(js, /createStrategySettingsController/);
    assert.match(js, /getTrackedTickers:[\s\S]*?tickerPerformance/);
    assert.match(js, /SCREENED_TICKERS_KEY/);
    assert.match(js, /rememberScreenedTicker/);
    assert.match(js, /initializeGlossary/);
    assert.ok(html.indexOf('id="glossary-dialog"') > html.indexOf('</main>'));
    assert.match(html, /class="glossary-sheet"[^>]+role="dialog"[^>]+aria-modal="true"/);
    assert.match(html, /id="glossary-drag-zone"/);
    for (const id of ['glossary-search', 'glossary-search-status', 'glossary-results', 'glossary-empty']) {
      assert.match(html, new RegExp(`id="${id}"`));
    }
    const glossary = html.slice(html.indexOf('id="glossary-dialog"'), html.indexOf('<nav class="bottom-nav"'));
    for (const token of ['Escape', 'pointerdown', 'pointermove', 'pointerup', 'setBackgroundInert', 'lastFocused.focus', 'filterGlossary', 'entry.hidden', 'group.hidden', 'search.addEventListener']) {
      assert.match(glossaryJs, new RegExp(token));
    }
    assert.match(css, /\.glossary-sheet\{[^}]*height:min\(90dvh,860px\)/);
    assert.match(css, /prefers-reduced-motion:reduce\)[\s\S]*?\.glossary-sheet/);
    assert.match(settingsCss, /\.glossary-sheet\s*\{[^}]*grid-template-rows: auto auto minmax\(0, 1fr\)/);
    assert.match(settingsCss, /\.glossary-search\s*\{[^}]*border-radius: 999px/);
    assert.match(settingsCss, /\.glossary-search:focus-within/);
    assert.match(settingsCss, /\.glossary-search input::\-webkit-search-cancel-button\s*\{[^}]*display: none/);
    for (const term of ['Booked profit', 'Return on collateral', 'Annualized rate', 'Capital velocity', 'Premium capture', 'Wheel capital', 'CSP collateral', 'Contract multiplier', 'Opening credit', 'DTE', 'Delta', 'Open interest', 'Settings layers', 'Goal profiles', 'Moneyness', 'Target delta range', 'Liquidity rules', 'Maximum quote age', 'Minimum period return', 'Net price guard', 'Candidate rank', 'Strike price', 'Underlying price', 'Executable option price', 'Net contract credit', 'Period return', 'Net sale / purchase price', 'Implied volatility', 'Theta per day', 'Breakeven', 'Strike distance', 'Estimated fee', 'Radar calculation inputs']) {
      assert.match(glossary, new RegExp(term));
    }
    assert.equal((glossary.match(/<dt>Annualized/g) ?? []).length, 1);
    assert.match(glossary, /Dashboard: qualified booked profit × 365 ÷ Σ\(collateral × days held\)/);
    assert.match(glossary, /Radar: net premium ÷ return collateral × 365 ÷ DTE/);
    assert.match(glossary, /Moneyness = strike price ÷ stock price × 100%/);
    assert.match(glossary, /Spread % = \(ask − bid\) ÷ midpoint × 100/);
    assert.match(glossary, /Cash-secured put = net premium ÷ \(strike × 100 − net premium\)/);
    assert.match(glossary, /Put net purchase price = strike − net premium per share/);
    assert.doesNotMatch(more, /<table|CC holdings|Premium ledger|Alerts/);
    assert.doesNotMatch(js, /loadMore|loadAlerts|test-notification|\/api\/v1\/wheel\/(?:positions|premiums)/);
  });
  it('groups trades into searchable, expandable ticker histories', () => {
    for (const id of ['monthly-pnl-chart', 'monthly-pnl-tooltip', 'monthly-pnl-tooltip-label', 'monthly-pnl-tooltip-value', 'monthly-pnl-legend', 'ticker-filters', 'ticker-filter', 'ticker-status-filter', 'ticker-sort', 'ticker-sort-direction', 'ticker-sort-arrow', 'ticker-list']) {
      assert.match(html, new RegExp(`id="${id}"`));
    }
    assert.doesNotMatch(html, /monthly-chart-readout|Inspect a monthly bar/);
    assert.ok(html.indexOf('id="monthly-pnl-chart"') < html.indexOf('id="ticker-filters"'));
    assert.match(js, /tickerPerformance/);
    assert.match(js, /buildMonthlyTickerSeries/);
    assert.match(js, /filterMonthlyTickerSeries/);
    assert.match(js, /renderMonthlyPerformance/);
    assert.match(js, /positionMonthlyTooltip/);
    assert.match(js, /showMonthlyTooltip/);
    assert.match(js, /mouseenter/);
    assert.match(js, /aria-pressed/);
    assert.match(js, /createElementNS/);
    assert.match(js, /sortTickerPerformance/);
    assert.match(js, /tickerOpenedTimestamp/);
    assert.match(js, /tickerSort: 'date_desc'/);
    assert.match(js, /document\.createElement\(['"]details['"]\)/);
    assert.match(js, /Open now/);
    assert.match(js, /Past contracts/);
    for (const sort of ['date', 'pnl', 'capital', 'return']) {
      assert.match(html, new RegExp(`value="${sort}"`));
    }
    assert.equal((html.match(/<option value="(?:date|pnl|capital|return)"/g) ?? []).length, 4);
    assert.doesNotMatch(html, /value="(?:date|pnl|capital|return)_(?:asc|desc)"/);
    assert.doesNotMatch(html, /<optgroup/);
    assert.doesNotMatch(html, /ticker-sort-options|data-sort=/);
    assert.match(css, /\.monthly-chart-scroll\{[^}]*overflow-x:auto/);
    assert.match(css, /\.monthly-chart-tooltip\{/);
    assert.match(css, /\.ticker-key-item\.is-selected/);
    assert.doesNotMatch(css, /\.monthly-bar-segment\.is-muted/);
    assert.match(css, /\.ticker-key\{[^}]*overflow-x:auto/);
    assert.match(html, /class="ticker-search-icon"/);
    assert.match(css, /\.trades-filter-bar\{[^}]*grid-template-columns:minmax\(93px,1fr\) minmax\(62px,\.72fr\) minmax\(135px,1\.35fr\)/);
    assert.match(css, /\.trades-filter-bar select\{[^}]*appearance:none/);
    assert.match(css, /\.ticker-activity::after,\.ticker-order::after/);
    assert.match(css, /\.trades-filter-bar \.ticker-sort-direction\{/);
    assert.match(css, /\.trades-filter-bar \.ticker-activity select\{[^}]*background:var\(--card\);color:var\(--body\)/);
    assert.match(css, /\.ticker-sort-direction span\{[^}]*background:var\(--canvas\)/);
    assert.match(js, /toggleTickerSortDirection/);
    assert.match(js, /syncTickerSortDirection/);
    assert.match(js, /stockPriceTag/);
    assert.match(js, /trade\.stockPrice/);
    assert.match(js, /ticker\.stockPrice/);
    assert.match(css, /\.stock-price-tag\{/);
    assert.match(css, /\.ticker-kpis\{[^}]*grid-template-columns:repeat\(3,1fr\)/);
    assert.match(css, /\.ticker-kpis dd\{[^}]*font-size:12px[^}]*font-weight:500/);
    assert.doesNotMatch(js, /tickerKpi\('Contracts'/);
    assert.doesNotMatch(html, /id="cycles-body"/);
  });
});
