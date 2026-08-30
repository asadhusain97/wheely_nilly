import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { rootDirectory } from '../src/config/index.js';

const html = readFileSync(path.join(rootDirectory, 'frontend/app.html'), 'utf8');
const css = readFileSync(path.join(rootDirectory, 'frontend/assets/css/app.css'), 'utf8');
const settingsCss = readFileSync(path.join(rootDirectory, 'frontend/assets/css/settings.css'), 'utf8');
const js = readFileSync(path.join(rootDirectory, 'frontend/assets/js/app.js'), 'utf8');
const glossaryJs = readFileSync(path.join(rootDirectory, 'frontend/assets/js/glossary.js'), 'utf8');
const settingsJs = readFileSync(path.join(rootDirectory, 'frontend/assets/js/settings.js'), 'utf8');
const screenerJs = readFileSync(path.join(rootDirectory, 'frontend/assets/js/screener.js'), 'utf8');
const radarScoringJs = readFileSync(path.join(rootDirectory, 'frontend/assets/js/radar-scoring.js'), 'utf8');
const radarScoringConfigJs = readFileSync(path.join(rootDirectory, 'frontend/assets/js/radar-scoring-config.js'), 'utf8');
const screenerCss = readFileSync(path.join(rootDirectory, 'frontend/assets/css/screener.css'), 'utf8');
const goalSelectorCss = readFileSync(path.join(rootDirectory, 'frontend/assets/css/goal-selector.css'), 'utf8');
const onboardingTs = readFileSync(path.join(rootDirectory, 'frontend/src/onboarding.ts'), 'utf8');
const dataRefreshTs = readFileSync(path.join(rootDirectory, 'frontend/src/data-refresh-ui.ts'), 'utf8');
const storageTs = readFileSync(path.join(rootDirectory, 'frontend/src/storage.ts'), 'utf8');
const serviceWorker = readFileSync(path.join(rootDirectory, 'frontend/public/sw.js'), 'utf8');

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
  it('prevents app text selection while preserving editable field behavior', () => {
    assert.match(css, /\.app-shell\{[^}]*-webkit-user-select:none[^}]*user-select:none[^}]*-webkit-touch-callout:none/);
    assert.match(css, /\.app-shell :is\(input,textarea,\[contenteditable="true"\]\)\{[^}]*-webkit-user-select:text[^}]*user-select:text[^}]*-webkit-touch-callout:default/);
  });
  it('uses the Wheely Nilly brand and logo assets', () => {
    assert.match(html, /<title>Wheely Nilly<\/title>/);
    assert.match(html, /class="brand-mark" src="\/assets\/images\/logo\.png"/);
    assert.match(html, /rel="icon"[^>]+href="\/assets\/images\/favicon\.png"/);
  });
  it('waits for the selected account and history before completing onboarding', () => {
    assert.match(html, /data-onboarding-sync-status/);
    assert.match(html, /data-onboarding-install-steps/);
    assert.match(onboardingTs, /account\.referenceLabel/);
    assert.match(onboardingTs, /!portfolioReady \|\| !historyReady \|\| syncFailed/);
    assert.match(onboardingTs, /Loading trade history and booked results/);
    assert.match(onboardingTs, /"Open Home"/);
    assert.match(onboardingTs, /data-target="overview"/);
    assert.doesNotMatch(onboardingTs, /"Open Radar"/);
    assert.match(html, /onboarding-install-steps[\s\S]*?<li><span>Choose <strong>Install<\/strong>/);
    assert.match(css, /\.onboarding-install-steps li>span\{min-width:0\}/);
    assert.match(css, /\.onboarding footer button:disabled/);
    assert.doesNotMatch(css, /\.onboarding>section\{[^}]*min-height:470px/);
  });
  it('loads the current app shell online and keeps the saved shell as an offline fallback', () => {
    assert.match(serviceWorker, /fetch\("\/app\.html", \{ cache: "no-cache" \}\)/);
    assert.match(serviceWorker, /caches\.match\("\/app\.html"\)/);
    assert.ok(serviceWorker.indexOf('fetch("/app.html", { cache: "no-cache" })') < serviceWorker.indexOf('caches.match("/app.html")'));
  });
  it('can clear browser state and rerun account setup without disconnecting SnapTrade', () => {
    assert.match(html, /data-reset-setup><span>Run setup again<\/span>/);
    assert.match(html, /Choose a different brokerage account/);
    assert.match(html, /data-refresh-brokerage/);
    assert.doesNotMatch(html, /data-market-interval|data-brokerage-interval|data-disconnect|data-erase-local/);
    assert.match(dataRefreshTs, /\[data-reset-setup\]/);
    assert.match(dataRefreshTs, /localRepository\.clearAllData\(\)/);
    assert.match(storageTs, /async clearAllData\(\)/);
  });
  it('surfaces performance, collateral, conditional opportunities, and open trades from one dashboard projection', () => {
    for (const id of ['booked-profit', 'return-rate', 'annualized-return-rate', 'wheel-capital', 'open-csps', 'open-ccs', 'opportunity-list', 'open-trade-list']) {
      assert.match(html, new RegExp(`id="${id}"`));
    }
    assert.match(js, /\/api\/v1\/wheel\/dashboard/);
    assert.match(js, /function contractDetails/);
    assert.doesNotMatch(js, /Rollover comparison logic|Find roll|Roll over now/);
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
    for (const [id, term] of [
      ['open-csps-label', 'Open CSPs / open CCs'],
      ['open-ccs-label', 'Open CSPs / open CCs'],
      ['capital-velocity-label', 'Capital velocity'],
      ['premium-capture-label', 'Premium capture'],
    ]) {
      assert.match(html, new RegExp(`id="${id}"`));
      assert.match(js, new RegExp(`\\['#${id}', '${term}'\\]`));
    }
    assert.match(js, /function initializeHomeGlossaryTerms/);
    assert.match(js, /createGlossaryTerm\(metricName\.textContent\.trim\(\), term, 'home-glossary-label'\)/);
    assert.match(css, /\.home-glossary-label\{display:inline;vertical-align:baseline\}/);
  });
  it('rounds dollar totals to whole dollars while retaining market-price precision', () => {
    assert.match(js, /const money = \(value, \{ sign = false, maximumFractionDigits = 0 \} = \{\}\)/);
    assert.match(js, /const marketPrice = \(value\) => money\(value, \{ maximumFractionDigits: 2 \}\)/);
    assert.match(js, /marketPrice\(trade\.strike\)/);
    assert.match(js, /marketPrice\(value\)/);
    assert.match(screenerJs, /const money = \(value, maximumFractionDigits = 0\)/);
    assert.match(screenerJs, /const marketPrice = \(value\) => money\(value, 2\)/);
    assert.match(screenerJs, /marketPrice\(viewModel\.strike\)/);
    assert.match(screenerJs, /money\(viewModel\.reward\.netCredit\)/);
  });
  it('turns binary Close guidance into a compact decision-first contract card', () => {
    for (const component of ['contractHeader', 'recommendationSummary', 'positionState', 'economicsSummary', 'premiumCaptureProgress', 'contractDetails']) {
      assert.match(js, new RegExp(`function ${component}`));
    }
    const cardSource = js.slice(js.indexOf('function renderOpenTrades'), js.indexOf('function renderDashboard'));
    const hierarchy = ['contractHeader(trade)', 'recommendationSummary(management)', 'positionState(management)', 'economicsSummary(management)', 'premiumCaptureProgress(management)', 'details.footer', 'details.panel'];
    for (let index = 1; index < hierarchy.length; index += 1) {
      assert.ok(cardSource.indexOf(hierarchy[index - 1]) < cardSource.indexOf(hierarchy[index]));
    }

    assert.match(js, /label: 'Review now'/);
    assert.match(js, /label: 'Close candidate'/);
    assert.match(js, /label: 'Hold'/);
    assert.match(js, /management\.effectiveSettings\.rules\.closeAtProfitCapture/);
    assert.match(js, /meeting your \$\{target\} close target/);
    assert.doesNotMatch(cardSource, /weighted score|majority|assignment override|quoteAge|Roll over now/);

    for (const metric of ['P/L if closed', 'Premium captured', 'Earned / day']) assert.match(js, new RegExp(metric.replace('/', '\\/')));
    assert.match(css, /\.trade-economics\{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
    assert.match(js, /--capture-progress/);
    assert.match(js, /--capture-target/);
    assert.match(js, /role', 'progressbar'/);
    assert.match(js, /aria-valuetext/);
    assert.match(css, /\.premium-progress\.is-met \.premium-progress-fill\{background:var\(--green\)\}/);

    assert.match(js, /const control = el\('button', 'contract-details-control'\)/);
    assert.doesNotMatch(js, /contract-details-control', 'Details'/);
    assert.match(js, /control\.setAttribute\('aria-expanded', 'false'\)/);
    assert.match(js, /control\.setAttribute\('aria-controls', panelId\)/);
    assert.match(js, /panel\.hidden = !expanded/);
    assert.match(js, /panel\.setAttribute\('role', 'region'\)/);
    assert.match(js, /panel\.setAttribute\('aria-labelledby', control\.id\)/);
    assert.match(css, /\.contract-details-control:focus-visible/);
    assert.match(css, /\.contract-details-footer\{height:36px;display:grid;place-items:center/);
    assert.match(css, /\.contract-details-control::after\{[^}]*border-right:1px solid currentColor[^}]*rotate\(45deg\)/);
    assert.match(css, /\.contract-details\[hidden\]\{display:none\}/);

    const detailsSource = js.slice(js.indexOf('function contractDetails'), js.indexOf('function renderDashboard'));
    assert.ok(detailsSource.indexOf("detailGroup('Trade'") < detailsSource.indexOf("detailGroup('Market'"));
    for (const term of ['Premium received', 'Buyback estimate', 'Collateral', 'Breakeven price', 'Underlying price', 'Bid / ask', 'Delta', 'Implied volatility']) {
      assert.match(detailsSource, new RegExp(term.replace('/', '\\/')));
    }
    for (const duplicate of ['Profit if closed', 'Premium captured', 'Earned per day', 'Strike price', 'Position state', 'Strike distance', 'Moneyness', 'Expiration', 'DTE', 'Days held', 'Theta / day', 'Extrinsic per day', 'Remaining annualized return', 'Open interest / volume']) {
      assert.doesNotMatch(detailsSource, new RegExp(duplicate.replace('/', '\\/')));
    }
    assert.match(detailsSource, /Last refreshed/);
    assert.doesNotMatch(detailsSource, /Cboe delayed|Yahoo Finance/);
    assert.match(css, /\.contract-detail-grid\{[^}]*gap:10px 20px/);
    assert.match(css, /\.contract-detail-refresh\{margin:12px 0 0;padding-top:9px/);
    assert.match(js, /money-state-badge is-\$\{moneyState\.toLowerCase\(\)\}/);
    assert.match(css, /\.money-state-badge\.is-itm\{[^}]*var\(--warning\)/);
    assert.match(css, /\.recommendation-summary\.is-close \.recommendation-label\{color:var\(--green\)\}/);
    assert.match(css, /\.recommendation-summary\.is-review \.recommendation-label\{color:var\(--warning\)\}/);
    assert.match(html, /Moneyness = strike price ÷ stock price × 100%/);
    assert.match(js, /tradesGlossaryLabel\(labelText, glossaryTerm\)/);
    assert.match(css, /prefers-reduced-motion/);
    assert.match(js, /closeMetricsStatus: 'loading'/);
    assert.match(js, /const metricsMissing = !management/);
    assert.match(js, /contract-metrics-loading/);
    assert.match(css, /\.trade-card\.is-metrics-loading/);
  });
  it('removes the prominent combined refresh control', () => {
    assert.doesNotMatch(html, /id="refresh-button"/);
    assert.doesNotMatch(js, /\/api\/v1\/snaptrade\/refresh/);
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
    for (const token of ['net_contract_credit', 'period_return', 'theta_per_day', 'implied_volatility', 'annualized_return', 'candidate.bid', 'candidate.ask']) {
      assert.match(`${screenerJs}\n${radarScoringJs}`, new RegExp(token.replace('.', '\\.')));
    }
    for (const token of ['Option type', 'Quote time', 'Applied rules', 'candidate-rules', 'Calculation assumptions', 'candidate-assumptions', 'Why other contracts were filtered', 'candidate-exclusions', 'exclusionsText']) {
      assert.doesNotMatch(screenerJs, new RegExp(token));
    }
    assert.match(screenerJs, /async function scanAll/);
    assert.match(screenerJs, /\/api\/v1\/screens\/scan-all/);
    assert.match(screenerJs, /target\.stockPrice = entry\.result\.underlying_price/);
    assert.match(screenerJs, /target\.stockPrice = result\.underlying_price/);
    assert.match(screenerJs, /return \{ initialize, loadTargets, scanTarget, scanAll \}/);
    assert.doesNotMatch(html, /id="refresh-button"/);
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
    assert.match(screenerJs, /seenTargets: new Set/);
    assert.match(screenerJs, /if \(!state\.seenTargets\.has\(target\.symbol\)\)[\s\S]*?state\.collapsed\.add\(target\.symbol\)/);
    assert.match(screenerJs, /targetIdentity/);
    assert.match(screenerJs, /stockPriceTag\(target\.stockPrice\)/);
    assert.match(js, /createScreenerController\(\{[\s\S]*?stockPriceTag,/);
    assert.match(screenerJs, /createGlossaryTerm/);
    assert.match(screenerJs, /function glossaryLabel/);
    assert.match(screenerJs, /function rulesSummary/);
    const candidateCardSource = screenerJs.slice(screenerJs.indexOf('function candidateCard'), screenerJs.indexOf('function scanResultView'));
    const collapsedHierarchy = [
      "node('div', 'candidate-header')", "node('div', 'candidate-reward')", "node('div', 'candidate-signals')",
      '`candidate-fit is-${viewModel.strategyFit.label}`', "node('span', 'candidate-disclosure')",
    ];
    for (let index = 1; index < collapsedHierarchy.length; index += 1) {
      assert.ok(candidateCardSource.indexOf(collapsedHierarchy[index - 1]) < candidateCardSource.indexOf(collapsedHierarchy[index]));
    }
    assert.match(candidateCardSource, /summary\.append\(header, reward, signals, fit, disclosure\)/);
    assert.match(candidateCardSource, /whyTrade\(viewModel\.reasons\)/);
    assert.ok(candidateCardSource.indexOf("detailSection('Execution'") < candidateCardSource.indexOf("detailSection('Additional detail'"));
    for (const hiddenUntilExpanded of ['Theta per day', 'Annualized return', 'Implied volatility', 'Bid / ask', 'Spread', 'Market activity']) {
      assert.ok(candidateCardSource.indexOf(hiddenUntilExpanded) > candidateCardSource.indexOf("const detail = node('div', 'candidate-detail')"));
    }
    for (const repeatedMetric of ['Net credit', 'Return on capital', 'Return / day', 'Strike', 'Underlying price', 'Strike distance', 'Approx. |delta|', 'DTE', 'Executable option price', 'Liquidity rating']) {
      assert.doesNotMatch(candidateCardSource, new RegExp(`detailRow\\('${repeatedMetric.replace(/[|]/g, '\\$&')}'`));
    }
    assert.match(candidateCardSource, /detailRow\('Bid \/ ask'/);
    assert.match(candidateCardSource, /detailRow\('Market activity'/);
    assert.match(candidateCardSource, /glossaryLabel\('ROC', 'Return on capital'\)/);
    assert.match(screenerJs, /metricName\.append\(glossaryLabel\(label, term\)\);[\s\S]*?node\('dd', '', value\)/);
    assert.match(screenerJs, /document\.createTextNode\(`\$\{rules\.minDte\}–\$\{rules\.maxDte\} `\)[\s\S]*?glossaryLabel\('DTE', 'DTE range'\)/);
    assert.match(screenerJs, /document\.createTextNode\(`≥ \$\{percent\(rules\.minPeriodReturn\)\} `\)[\s\S]*?glossaryLabel\('term return', 'Minimum return'\)/);
    for (const term of ['Net contract credit', 'Return on capital', 'DTE range', 'Target delta range', 'Minimum return', 'Delta', 'Bid-ask spread', 'Open interest / volume', 'Implied volatility', 'Theta per day', 'Annualized return']) {
      assert.match(screenerJs, new RegExp(term.replace(/[|/]/g, '\\$&')));
    }
    assert.match(screenerJs, /prepareRadarCandidates\(result\)/);
    for (const fn of ['calculateLiquidity', 'calculateReturnMetrics', 'calculateStrikeDistance', 'calculateDeltaFit', 'calculateDteFit', 'generateTradeReasons', 'generateTradeWarnings']) {
      assert.match(radarScoringJs, new RegExp(`function ${fn}`));
    }
    for (const token of ['spread: 0.55', 'openInterest: 0.30', 'volume: 0.15', 'delta: 0.25', 'dte: 0.15', 'return: 0.25', 'strikeCushion: 0.15', 'liquidity: 0.20']) {
      assert.match(radarScoringConfigJs, new RegExp(token.replace('.', '\\.')));
    }
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
    assert.doesNotMatch(html, /id="goal-leg-tabs"/);
    assert.match(settingsJs, /className = 'layer-tabs strategy-tabs goal-inline-strategy-tabs'/);
    assert.match(html, /class="layer-tabs strategy-tabs" id="monitor-leg-tabs"/);
    assert.ok(html.indexOf('id="monitor-goal-tabs"') < html.indexOf('id="monitor-leg-tabs"'));
    assert.match(html, /id="monitor-leg-picker" hidden/);
    assert.match(screenerJs, /legForGoal/);
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
    assert.match(screenerCss, /\.monitor-leg-picker\[hidden\] \{ display: none; \}/);
    assert.match(settingsCss, /\.goal-inline-strategy-tabs\s*\{[^}]*width: 108px[^}]*flex: 0 0 108px[^}]*margin: 0/);
    assert.match(settingsCss, /\.goal-inline-strategy-tabs > button\s*\{[^}]*min-height: 32px[^}]*font-size: 10px/);
    assert.match(goalSelectorCss, /prefers-reduced-transparency: reduce/);
    assert.match(screenerCss, /\.monitor-remove-button\.is-confirming/);
    assert.match(screenerCss, /\.monitor-symbol-mark \{[^}]*width: auto[^}]*white-space: nowrap/);
    assert.match(screenerJs, /const meta = node\('div', 'monitor-target-meta'\);[\s\S]*?meta\.append\(stockPriceTag\(target\.stockPrice\)\)/);
    assert.match(screenerCss, /\.monitor-target-meta > \.stock-price-tag/);
    assert.match(screenerCss, /\.monitor-target-body\[hidden\]/);
    assert.doesNotMatch(screenerCss, /\.monitor-target-disclosure/);
    assert.match(screenerCss, /\.candidate-reward \{[^}]*grid-template-columns: 1fr 1fr/);
    assert.match(screenerCss, /\.candidate-signals \{[^}]*grid-template-columns: \.7fr 1\.15fr 1\.35fr/);
    assert.match(screenerCss, /\.candidate-disclosure > i \{[^}]*border-right: 1px solid currentColor[^}]*transform: rotate\(45deg\)/);
    assert.match(screenerCss, /\.candidate-card\[open\] \.candidate-disclosure > i \{ transform: rotate\(225deg\); \}/);
    assert.match(screenerCss, /\.candidate-reason-list/);
    assert.doesNotMatch(screenerCss, /content: "⌄"/);
    assert.doesNotMatch(candidateCardSource, /'Details'/);
    assert.match(screenerJs, /`Breakeven at most \$\{price\}`/);
    assert.match(settingsJs, /'Maximum breakeven price'/);
    assert.doesNotMatch(`${screenerJs}\n${settingsJs}\n${html}`, /net purchase price/i);
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
    for (const id of ['strategy-settings-workspace', 'goal-preset-tabs', 'settings-ticker-search', 'settings-ticker-count', 'ticker-playbook-list', 'settings-status']) {
      assert.match(more, new RegExp(`id="${id}"`));
    }
    assert.ok(more.indexOf('settings-goals-title') < more.indexOf('settings-tickers-title'));
    assert.doesNotMatch(more, /settings-lineage|settings-scopes|data-settings-scope/);
    assert.doesNotMatch(more, /settings-global-title|>Defaults<|Lighter values/);
    assert.match(more, /Choose what Radar should optimize for/);
    assert.match(html, /href="\/assets\/css\/settings\.css"/);
    assert.match(more, /class="settings-edit"[^>]+title="Edit selected goal"[\s\S]*?<svg/);
    assert.doesNotMatch(more, />\s*Edit\s*</);
    assert.match(more, /editable starting points, not trading recommendations/);
    assert.match(more, /class="settings-support"[^>]+aria-label="Support Wheely Nilly"/);
    assert.match(more, /id="leave-a-tip"[^>]+href="https:\/\/ko-fi\.com\/asadhusain">leave a tip/);
    assert.doesNotMatch(more, /Buy Me a Chai|buymeachai|>Ko-fi</);
    assert.match(html, /id="tip-celebration"[^>]+role="status"[^>]+aria-live="polite"[^>]+hidden/);
    assert.match(html, /id="tip-celebration-image"[^>]+src="\/assets\/images\/happy-tip\.gif"/);
    assert.ok(existsSync(path.join(rootDirectory, 'frontend/assets/images/happy-tip.gif')));
    assert.match(js, /function initializeTipCelebration/);
    assert.match(js, /setTimeout\(\(\) => window\.location\.assign\(link\.href\), 2000\)/);
    assert.match(css, /\.tip-celebration\{/);
    for (const id of ['settings-editor-dialog', 'settings-editor-form', 'settings-reset-defaults', 'save-strategy-settings', 'settings-editor-drag-zone']) {
      assert.match(html, new RegExp(`id="${id}"`));
    }
    assert.match(html, /class="settings-editor-sheet"[^>]+role="dialog"[^>]+aria-modal="true"/);
    for (const token of ['Advanced rules', 'minNetSalePriceMinor', 'maxNetPurchasePriceMinor', 'Settings saved', 'window.confirm', '/api/v1/strategy-settings', 'getTrackedTickers', 'field-inherit-reset', 'BUILT_IN_GOAL_PROFILES', 'pointerdown']) {
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
    assert.match(settingsJs, /tickerPlaybooks\[model\.editor\.symbol\]\[model\.editor\.leg\]\.enabled = true/);
    assert.doesNotMatch(settingsJs, /Object\.values\(model\.editor\.draft\.tickerPlaybooks/);
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
    assert.match(settingsJs, /sheet-tabs ticker-inline-strategy-tabs/);
    assert.match(settingsJs, /strategyTabs\.setAttribute\('aria-labelledby', strategyLabel\.id\)/);
    assert.match(settingsJs, /tickerRules\.querySelector\('\.editor-rule-list'\)\.prepend\(priceGuard/);
    assert.doesNotMatch(settingsJs, /document\.createElement\('select'\)/);
    assert.match(settingsCss, /\.ticker-price-guard \.editor-rule-controls\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) 34px/);
    assert.match(settingsCss, /\.ticker-strategy-field\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) 108px[^}]*align-items: center/);
    assert.match(settingsCss, /\.ticker-inline-strategy-tabs\s*\{[^}]*width: 108px[^}]*justify-self: end[^}]*margin: 0/);
    assert.match(settingsCss, /\.ticker-inline-strategy-tabs > button\s*\{[^}]*min-height: 32px[^}]*font-size: 10px/);
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
    for (const token of ['Escape', 'pointerdown', 'pointermove', 'pointerup', 'setBackgroundInert', 'lastFocused.focus', 'filterGlossary', 'entry.hidden', 'group.hidden', 'search.addEventListener', 'createGlossaryTerm', 'LONG_PRESS_DURATION_MS', 'data-glossary-term']) {
      assert.match(glossaryJs, new RegExp(token));
    }
    assert.match(settingsJs, /createGlossaryTerm/);
    assert.match(settingsJs, /\{ glossaryTerms: true \}/);
    assert.match(settingsJs, /GLOSSARY_TERM_BY_RULE_KEY/);
    assert.match(settingsJs, /key: 'closeAtProfitCapture', label: 'Close when premium captured'[^\n]+scale: 100/);
    assert.match(settingsJs, /closeAtProfitCapture: 0\.50/);
    assert.doesNotMatch(settingsJs, /maxQuoteAgeSeconds|Maximum quote age/);
    assert.match(settingsJs, /ruleSummary\(rules,[\s\S]*?\{ glossaryTerms: true \}\)/);
    assert.match(settingsJs, /createGlossaryTerm\(labelText, 'Net price guard', 'editor-rule-label'\)/);
    assert.match(settingsJs, /createGlossaryTerm\('Goal', 'Goal profiles', 'ticker-goal-label'\)/);
    assert.match(settingsJs, /!model\.editor \|\| overlay\(\)\.inert/);
    assert.match(css, /\.glossary-term\s*\{[^}]*border-bottom: 1px dotted/);
    assert.match(css, /\.glossary-overlay\.is-above-modal\s*\{[^}]*z-index: 47/);
    assert.match(settingsCss, /\.editor-rule-label\s*\{/);
    assert.match(glossaryJs, /suspendedDialog/);
    assert.match(css, /\.glossary-sheet\{[^}]*height:min\(90dvh,860px\)/);
    assert.match(css, /prefers-reduced-motion:reduce\)[\s\S]*?\.glossary-sheet/);
    assert.match(settingsCss, /\.glossary-sheet\s*\{[^}]*grid-template-rows: auto auto minmax\(0, 1fr\)/);
    assert.match(settingsCss, /\.glossary-search\s*\{[^}]*border-radius: 999px/);
    assert.match(settingsCss, /\.glossary-search:focus-within/);
    assert.match(settingsCss, /\.glossary-search input::\-webkit-search-cancel-button\s*\{[^}]*display: none/);
    for (const term of ['Option contract', 'Covered call', 'Cash-secured put', 'Premium', 'ITM / ATM / OTM', 'Intrinsic &amp; extrinsic value', 'Exercise &amp; assignment', 'Booked profit', 'Return on collateral', 'Annualized rate', 'Capital velocity', 'Premium capture', 'Wheel capital', 'CSP collateral', 'Contract multiplier', 'Premium received', 'DTE', 'Delta', 'Open interest', 'Settings layers', 'Goal profiles', 'Moneyness', 'Target delta range', 'Maximum spread', 'Minimum open interest', 'Minimum volume', 'Minimum return', 'Net price guard', 'Candidate rank', 'Strike price', 'Underlying price', 'Executable option price', 'Bid-ask spread', 'Open interest / volume', 'Net contract credit', 'Return on capital', 'Period return', 'Net sale / breakeven price', 'Implied volatility', 'Theta per day', 'Breakeven', 'Strike distance', 'Estimated fee', 'Radar calculation inputs']) {
      assert.match(glossary, new RegExp(term));
    }
    assert.match(glossary, /class="glossary-example"/);
    assert.match(glossary, /class="glossary-guide"/);
    assert.match(glossary, /class="glossary-sources"/);
    assert.match(glossary, /href="https:\/\/en\.wikipedia\.org\/wiki\//);
    assert.match(glossary, /href="https:\/\/www\.theocc\.com\/company-information\/documents-and-archives\/options-disclosure-document"/);
    assert.match(glossary, /target="_blank"[^>]+rel="noopener noreferrer"/);
    assert.equal((glossary.match(/<dt>Annualized/g) ?? []).length, 1);
    assert.match(glossary, /Dashboard: qualified booked profit × 365 ÷ Σ\(collateral × days held\)/);
    assert.match(glossary, /Radar: net premium ÷ return collateral × 365 ÷ DTE/);
    assert.match(glossary, /Moneyness = strike price ÷ stock price × 100%/);
    assert.match(glossary, /Spread % = \(ask − bid\) ÷ midpoint × 100/);
    assert.match(glossary, /Cash-secured put = net premium ÷ \(strike × 100 − net premium\)/);
    assert.match(glossary, /Put breakeven price = strike − net premium per share/);
    assert.match(glossary, /Strike distance % = \|strike − stock price\| ÷ stock price × 100%/);
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
    assert.match(js, /tickerClosedTimestamp/);
    assert.match(js, /tickerSort: 'date_desc'/);
    assert.match(js, /document\.createElement\(['"]details['"]\)/);
    assert.doesNotMatch(js, /Open now/);
    assert.match(js, /Past contracts/);
    assert.match(html, /Closed contracts only/);
    assert.match(js, /ticker\.pastTrades\.length > 0/);
    assert.match(js, /closedContractCountText/);
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
    assert.match(js, /createGlossaryTerm, initializeGlossary/);
    assert.match(js, /function tradesGlossaryLabel/);
    assert.match(js, /function appendLabeledAmount/);
    for (const metric of [
      ["'Booked P&L'", "'Booked profit'"],
      ["'Return'", "'Return on collateral'"],
      ["'Annualized'", "'Annualized return'"],
      ["'Collateral'", "'Collateral'"],
    ]) {
      assert.match(js, new RegExp(`tickerKpi\\(${metric[0]},[^\\n]+${metric[1]}`));
    }
    assert.match(js, /tradesGlossaryLabel\('Booked option P&L', 'Booked profit'\)/);
    assert.match(js, /tradesGlossaryLabel\('close cost', 'Closing cash flow'\)/);
    assert.match(js, /appendLabeledAmount\([^\n]+, 'Premium received', 'Premium received'\)/);
    assert.doesNotMatch(js, /'Opening credit'/);
    assert.doesNotMatch(js, /tradesGlossaryLabel\(`?\$\{?(?:money|percent)/);
    assert.match(css, /\.trades-glossary-label\{display:inline;vertical-align:baseline\}/);
    assert.match(html, /<dt>Closing cash flow <span>Close cost<\/span><\/dt>/);
    assert.doesNotMatch(html, /id="cycles-body"/);
  });
});
