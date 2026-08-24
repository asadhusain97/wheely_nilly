import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { rootDirectory } from '../src/config/index.js';

const html = readFileSync(path.join(rootDirectory, 'frontend/index.html'), 'utf8');
const css = readFileSync(path.join(rootDirectory, 'frontend/assets/css/app.css'), 'utf8');
const js = readFileSync(path.join(rootDirectory, 'frontend/assets/js/app.js'), 'utf8');

describe('responsive dashboard shell', () => {
  it('has semantic landmarks, labels, live regions, and keyboard navigation support', () => {
    for (const token of ['<header', '<main', '<nav', '<table', 'aria-live=', 'skip-link', '<label']) assert.match(html, new RegExp(token));
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
    for (const label of ['Home', 'Trades', 'Screen', 'More']) assert.match(navigation, new RegExp(`>${label}<`));
  });
  it('keeps future configuration above a calculation-backed glossary in More', () => {
    const more = html.match(/<section class="app-screen" id="more"[\s\S]*?<\/section>\s*<\/section>\s*<\/section>/)?.[0] ?? '';
    assert.match(more, /<h1 id="more-title">More<\/h1>/);
    assert.ok(more.indexOf('id="configuration-title"') < more.indexOf('id="glossary-title"'));
    for (const term of ['Booked profit', 'Return on collateral', 'Annualized rate', 'Capital velocity', 'Premium capture', 'Wheel capital', 'CSP collateral', 'Contract multiplier', 'Opening credit', 'DTE', 'Delta', 'Open interest']) {
      assert.match(more, new RegExp(term));
    }
    assert.equal((more.match(/<dt>Annualized/g) ?? []).length, 1);
    assert.match(more, /Dashboard: qualified booked profit × 365 ÷ Σ\(collateral × days held\)/);
    assert.match(more, /Screener: net premium ÷ return collateral × 365 ÷ DTE/);
    assert.doesNotMatch(more, /<table|<button|CC holdings|Premium ledger|Alerts/);
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
    assert.match(css, /\.ticker-kpis\{[^}]*grid-template-columns:repeat\(4,1fr\)/);
    assert.doesNotMatch(html, /id="cycles-body"/);
  });
});
