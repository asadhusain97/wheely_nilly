import { createGlossaryTerm, initializeGlossary } from './glossary.js';
import { calculateLiquidity } from './radar-scoring.js';
import { resolveRadarScoringConfig } from './radar-scoring-config.js';
import { createScreenerController } from './screener.js';
import { createStrategySettingsController } from './settings.js';
import { createRollController } from './rolls.js';
import { deriveRollReview, GOAL_LABELS } from '../../src/roll-analysis.ts';

const SCREENED_TICKERS_KEY = 'wheely-nilly.screened-tickers.v1';

function loadScreenedTickers() {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(SCREENED_TICKERS_KEY) ?? '[]');
    return Array.isArray(saved) ? saved.filter((ticker) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker?.symbol)) : [];
  } catch {
    return [];
  }
}

const state = {
  dashboard: null,
  closeByContract: new Map(),
  closeMetricsStatus: 'loading',
  tickerSort: 'date_desc',
  monthlyTicker: null,
  monthlyDetail: null,
  screenedTickers: loadScreenedTickers(),
};

const $ = (selector) => document.querySelector(selector);
const money = (value, { sign = false, maximumFractionDigits = 0 } = {}) => value == null
  ? '—'
  : new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', signDisplay: sign ? 'exceptZero' : 'auto',
    minimumFractionDigits: 0, maximumFractionDigits,
  }).format(Number(value));
const marketPrice = (value) => money(value, { maximumFractionDigits: 2 });
const percent = (value, { sign = true } = {}) => value == null
  ? '—'
  : new Intl.NumberFormat('en-US', { style: 'percent', signDisplay: sign ? 'exceptZero' : 'auto', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
const decimal = (value, digits = 2) => value == null
  ? 'Unavailable'
  : new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Number(value));
const quantity = (value) => new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(value));
const shortDate = (value) => value
  ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(value))
  : '—';
const historyDate = (value) => value
  ? new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(value))
  : '—';
const updatedAt = (value) => value
  ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)).replace(',', ' ·')
  : '—';
const refreshTime = (value) => value
  ? new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(value))
  : null;
const label = (value) => String(value ?? '').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());

function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function tradesGlossaryLabel(label, term) {
  return createGlossaryTerm(label, term, 'trades-glossary-label');
}

function appendLabeledAmount(container, value, label, term) {
  if (value == null) {
    container.append(tradesGlossaryLabel(label, term), document.createTextNode(' unavailable'));
    return;
  }
  container.append(document.createTextNode(`${value} `), tradesGlossaryLabel(label.toLocaleLowerCase(), term));
}

function initializeHomeGlossaryTerms() {
  for (const [selector, term] of [
    ['#open-csps-label', 'Open CSPs / open CCs'],
    ['#open-ccs-label', 'Open CSPs / open CCs'],
    ['#capital-velocity-label', 'Capital velocity'],
    ['#premium-capture-label', 'Premium capture'],
  ]) {
    const metricName = $(selector);
    metricName.replaceChildren(createGlossaryTerm(metricName.textContent.trim(), term, 'home-glossary-label'));
  }
}

function stack(primary, secondary, className = 'cell-stack') {
  const node = el('div', className);
  node.append(el('strong', '', primary));
  if (secondary) node.append(el('small', '', secondary));
  return node;
}

function stockPriceTag(value) {
  const available = value !== null && value !== undefined;
  const price = marketPrice(value);
  const tag = el('span', `stock-price-tag${available ? '' : ' is-unavailable'}`, price);
  tag.setAttribute('aria-label', available ? `Latest stock price ${price}` : 'Latest stock price unavailable');
  tag.title = available ? 'Latest stock price' : 'Latest stock price unavailable';
  return tag;
}

function emptyCard(container, message) {
  container.append(el('p', 'empty-card', message));
}

async function json(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { Accept: 'application/json', ...(options.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error?.message ?? `Request returned ${response.status}`);
    error.status = response.status;
    error.code = body.error?.code;
    throw error;
  }
  return body;
}

function toast(message, tone = 'neutral') {
  const node = $('#toast');
  const safeTone = ['success', 'error'].includes(tone) ? tone : 'neutral';
  node.className = `toast is-${safeTone}`;
  node.setAttribute('role', safeTone === 'error' ? 'alert' : 'status');
  node.replaceChildren(
    el('span', 'toast-mark', safeTone === 'success' ? '✓' : safeTone === 'error' ? '!' : 'i'),
    el('span', 'toast-copy', message),
  );
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 4000);
}

function rememberScreenedTicker(instrument, leg) {
  const symbol = typeof instrument === 'string' ? instrument : instrument.symbol;
  const preferredLeg = leg === 'cash_secured_put' ? 'cashSecuredPut' : 'coveredCall';
  const ticker = {
    symbol,
    name: typeof instrument === 'object' ? instrument.name : null,
    instrumentType: typeof instrument === 'object' ? instrument.instrument_type : null,
    preferredLeg,
    goal: preferredLeg === 'cashSecuredPut' ? 'acquire' : 'income',
    lastActivityAt: new Date().toISOString(),
  };
  state.screenedTickers = [ticker, ...state.screenedTickers.filter((item) => item.symbol !== symbol)].slice(0, 100);
  try {
    globalThis.localStorage?.setItem(SCREENED_TICKERS_KEY, JSON.stringify(state.screenedTickers));
  } catch {
    // Browser storage can be unavailable; the ticker still remains for this session.
  }
}

function forgetScreenedTicker(symbol) {
  state.screenedTickers = state.screenedTickers.filter((item) => item.symbol !== symbol);
  try {
    globalThis.localStorage?.setItem(SCREENED_TICKERS_KEY, JSON.stringify(state.screenedTickers));
  } catch {
    // Browser storage can be unavailable; the ticker is still removed for this session.
  }
}

function settingsTickerFromActivity(ticker) {
  const trades = [...(ticker.openTrades ?? []), ...(ticker.pastTrades ?? [])];
  const recentTrade = trades.slice().sort((a, b) => {
    const time = (trade) => Math.max(Date.parse(trade.closedAt) || 0, Date.parse(trade.openedAt) || 0);
    return time(b) - time(a);
  })[0];
  const preferredLeg = recentTrade?.type === 'csp' ? 'cashSecuredPut' : 'coveredCall';
  const goal = preferredLeg === 'coveredCall'
    ? defaultContractGoal(ticker.instrumentType)
    : 'income';
  return {
    symbol: ticker.symbol,
    instrumentType: ticker.instrumentType ?? null,
    preferredLeg,
    goal,
    lastActivityAt: recentTrade?.closedAt ?? recentTrade?.openedAt ?? null,
  };
}

const strategySettingsController = createStrategySettingsController({
  request: json,
  notify: toast,
  getTrackedTickers: () => [
    ...(state.dashboard?.tickerPerformance ?? []).map(settingsTickerFromActivity),
    ...state.screenedTickers,
  ],
});
strategySettingsController.initialize();
const rollController = createRollController({ request: json, notify: toast });
const screenerController = createScreenerController({
  request: json,
  notify: toast,
  stockPriceTag,
  rememberTicker: rememberScreenedTicker,
  getTickerIdentity: (symbol) => state.screenedTickers.find((ticker) => ticker.symbol === symbol),
  addTicker: (symbol, leg, goal) => strategySettingsController.addTicker(symbol, leg, goal),
  removeTicker: async (symbol) => {
    const result = await strategySettingsController.removeTicker(symbol);
    forgetScreenedTicker(symbol);
    strategySettingsController.refresh();
    return result;
  },
  openSettings: () => showScreen('more'),
});
screenerController.initialize();
initializeHomeGlossaryTerms();
initializeGlossary();

function initializeTipCelebration() {
  const link = $('#leave-a-tip');
  const celebration = $('#tip-celebration');
  let redirectPending = false;

  link.addEventListener('click', (event) => {
    const modifiedClick = event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
    if (modifiedClick || matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    event.preventDefault();
    if (redirectPending) return;
    redirectPending = true;

    const image = $('#tip-celebration-image');
    image.src = image.src;
    celebration.hidden = false;
    setTimeout(() => window.location.assign(link.href), 2000);
  });
}

initializeTipCelebration();

function setFreshness(value) {
  const updated = $('#last-updated');
  if (!updated) return;
  updated.replaceChildren(
    el('span', '', value.stale ? 'Last update · stale' : 'Last updated'),
    el('strong', '', updatedAt(value.lastSuccessAt)),
  );
  updated.dateTime = value.lastSuccessAt ?? '';
  updated.classList.toggle('is-stale', value.stale);
  updated.title = value.stale ? 'Brokerage data may be stale' : 'Brokerage data is current';
}

function openCoveredCallScreen(opportunity) {
  showScreen('screener');
  screenerController.scanTarget(opportunity.symbol, 'coveredCall');
}

function renderOpportunities(dashboard) {
  const section = $('#opportunities-section');
  const container = $('#opportunity-list');
  container.replaceChildren();
  if (!dashboard.opportunities.coveredCalls.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  for (const opportunity of dashboard.opportunities.coveredCalls) {
    const card = el('article', 'opportunity-card');
    const button = el('button', 'text-button', 'Find calls');
    button.type = 'button';
    button.addEventListener('click', () => openCoveredCallScreen(opportunity));
    card.append(
      el('span', 'opportunity-icon', opportunity.symbol.slice(0, 2)),
      stack(
        opportunity.symbol,
        `${opportunity.availableLots} uncovered lot${opportunity.availableLots === 1 ? '' : 's'} · ${quantity(opportunity.shares)} shares`,
        'opportunity-copy',
      ),
      button,
    );
    container.append(card);
  }
}

function dteLabel(dte) {
  if (dte == null) return 'DTE unknown';
  if (dte < 0) return `${Math.abs(dte)}d past expiry`;
  if (dte === 0) return 'Expires today';
  return `${dte} DTE`;
}

function closedContractCountText(ticker) {
  if (!ticker.closedContracts) return 'No closed contracts';
  const parts = [];
  if (ticker.closedCspContracts) parts.push(`${quantity(ticker.closedCspContracts)} CSP`);
  if (ticker.closedCcContracts) parts.push(`${quantity(ticker.closedCcContracts)} CC`);
  return parts.join(' · ');
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const POSITIVE_TICKER_INKS = ['#176b40', '#23784a', '#308456', '#3f9063', '#509c71', '#62a880', '#76b38f', '#8bbf9f', '#a2cbae', '#bad7bf', '#d0e3d1', '#e1eee3'];
const NEGATIVE_TICKER_INKS = ['#b5001c', '#c5001e', '#d50021', '#e60023', '#e92743', '#ed465d', '#f05f73', '#f27887', '#f4919c', '#f6a9b1', '#f8c0c6', '#fad7da'];

function monthKey(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function nextMonth(key) {
  const [year, month] = key.split('-').map(Number);
  const date = new Date(Date.UTC(year, month, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthDate(key) {
  return new Date(`${key}-01T00:00:00.000Z`);
}

function monthRangeLabel(months) {
  if (!months.length) return 'No closed contracts';
  const first = monthDate(months[0].key);
  const last = monthDate(months.at(-1).key);
  const month = (date) => new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(date);
  if (first.getUTCFullYear() === last.getUTCFullYear()) {
    return `${month(first)}–${month(last)} ${last.getUTCFullYear()}`;
  }
  return `${month(first)} ${first.getUTCFullYear()}–${month(last)} ${last.getUTCFullYear()}`;
}

function compactMoney(value) {
  const amount = Number(value);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: Math.abs(amount) >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: Math.abs(amount) >= 1000 ? 1 : 0,
  }).format(amount);
}

function buildMonthlyTickerSeries(tickers) {
  const byMonth = new Map();
  const tickerTotals = new Map(tickers.map((ticker) => [ticker.symbol, { net: 0, magnitude: 0, trades: 0 }]));
  let firstMonth = null;
  let lastMonth = null;

  for (const ticker of tickers) {
    for (const trade of ticker.pastTrades ?? []) {
      const key = monthKey(trade.closedAt);
      const profit = Number(trade.profit);
      if (!key || !Number.isFinite(profit)) continue;
      const contributions = byMonth.get(key) ?? new Map();
      const contribution = contributions.get(ticker.symbol) ?? { value: 0, trades: [] };
      contribution.value += profit;
      contribution.trades.push(trade);
      contributions.set(ticker.symbol, contribution);
      byMonth.set(key, contributions);
      tickerTotals.get(ticker.symbol).net += profit;
      tickerTotals.get(ticker.symbol).trades += 1;
      if (!firstMonth || key < firstMonth) firstMonth = key;
      if (!lastMonth || key > lastMonth) lastMonth = key;
    }
  }

  for (const contributions of byMonth.values()) {
    for (const [symbol, contribution] of contributions) tickerTotals.get(symbol).magnitude += Math.abs(contribution.value);
  }

  const symbols = [...tickerTotals.entries()]
    .map(([symbol, values]) => ({ symbol, ...values }))
    .sort((a, b) => b.magnitude - a.magnitude || Math.abs(b.net) - Math.abs(a.net) || a.symbol.localeCompare(b.symbol))
    .map((ticker, colorIndex) => ({ ...ticker, colorIndex }));
  const months = [];
  for (let key = firstMonth; key && key <= lastMonth; key = nextMonth(key)) {
    const contributions = byMonth.get(key) ?? new Map();
    months.push({
      key,
      contributions,
      positive: [...contributions.values()].filter(({ value }) => value > 0).reduce((sum, { value }) => sum + value, 0),
      negative: [...contributions.values()].filter(({ value }) => value < 0).reduce((sum, { value }) => sum + value, 0),
    });
  }
  return { months, symbols, total: symbols.reduce((sum, ticker) => sum + ticker.net, 0) };
}

function svgElement(tag, attributes = {}) {
  const node = document.createElementNS(SVG_NAMESPACE, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}

function tickerInk(index) {
  return {
    positive: POSITIVE_TICKER_INKS[index % POSITIVE_TICKER_INKS.length],
    negative: NEGATIVE_TICKER_INKS[index % NEGATIVE_TICKER_INKS.length],
  };
}

function monthlyTradeSummary(trades) {
  const contractCount = trades.reduce((total, trade) => total + Math.abs(Number(trade.contracts ?? 1)), 0);
  const typeCount = (type) => trades.filter((trade) => trade.type === type)
    .reduce((total, trade) => total + Math.abs(Number(trade.contracts ?? 1)), 0);
  const types = [['csp', 'CSP'], ['cc', 'CC']]
    .map(([type, name]) => [typeCount(type), name])
    .filter(([count]) => count)
    .map(([count, name]) => `${quantity(count)} ${name}`);
  return `${quantity(contractCount)} closed contract${contractCount === 1 ? '' : 's'}${types.length ? ` · ${types.join(' · ')}` : ''}`;
}

function filterMonthlyTickerSeries(series) {
  const selected = series.symbols.find(({ symbol }) => symbol === state.monthlyTicker);
  if (state.monthlyTicker && !selected) state.monthlyTicker = null;
  const symbols = selected ? [selected] : series.symbols;
  const visible = new Set(symbols.map(({ symbol }) => symbol));
  const months = series.months.map((month) => {
    const contributions = new Map([...month.contributions].filter(([symbol]) => visible.has(symbol)));
    return {
      ...month,
      contributions,
      positive: [...contributions.values()].filter(({ value }) => value > 0).reduce((sum, { value }) => sum + value, 0),
      negative: [...contributions.values()].filter(({ value }) => value < 0).reduce((sum, { value }) => sum + value, 0),
    };
  });
  return { ...series, months, symbols, total: selected ? selected.net : series.total };
}

function hideMonthlyTooltip() {
  $('#monthly-pnl-tooltip').hidden = true;
  for (const bar of document.querySelectorAll('.monthly-bar-segment')) bar.classList.remove('is-inspected');
}

function positionMonthlyTooltip(segment) {
  const stage = $('#monthly-chart-stage');
  const tooltip = $('#monthly-pnl-tooltip');
  const stageRect = stage.getBoundingClientRect();
  const segmentRect = segment.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const center = segmentRect.left - stageRect.left + segmentRect.width / 2;
  const left = Math.max(4, Math.min(center - tooltipRect.width / 2, stageRect.width - tooltipRect.width - 4));
  let top = segmentRect.top - stageRect.top - tooltipRect.height - 8;
  const below = top < 4;
  if (below) top = segmentRect.bottom - stageRect.top + 8;
  top = Math.max(4, Math.min(top, stageRect.height - tooltipRect.height - 4));
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
  tooltip.style.setProperty('--tip-x', `${Math.max(10, Math.min(center - left, tooltipRect.width - 10))}px`);
  tooltip.classList.toggle('is-below', below);
}

function showMonthlyTooltip(segment) {
  for (const bar of document.querySelectorAll('.monthly-bar-segment')) bar.classList.toggle('is-inspected', bar === segment);
  const detail = segment.monthlyDetail;
  $('#monthly-pnl-tooltip-label').textContent = detail.label;
  const value = $('#monthly-pnl-tooltip-value');
  value.textContent = money(detail.value, { sign: true });
  value.className = detail.value < 0 ? 'loss' : 'gain';
  $('#monthly-pnl-tooltip-meta').textContent = detail.meta;
  const tooltip = $('#monthly-pnl-tooltip');
  tooltip.hidden = false;
  positionMonthlyTooltip(segment);
}

function restoreMonthlyTooltip() {
  const pinned = [...document.querySelectorAll('.monthly-bar-segment')]
    .find((segment) => segment.dataset.detailKey === state.monthlyDetail);
  if (pinned) showMonthlyTooltip(pinned);
  else {
    state.monthlyDetail = null;
    hideMonthlyTooltip();
  }
}

function renderTickerKey(series, scrollLeft = 0) {
  const legend = $('#monthly-pnl-legend');
  legend.replaceChildren();
  for (const ticker of series.symbols) {
    const item = el('button', 'ticker-key-item');
    item.type = 'button';
    item.dataset.symbol = ticker.symbol;
    const selected = ticker.symbol === state.monthlyTicker;
    item.textContent = ticker.symbol;
    item.classList.toggle('is-selected', selected);
    item.setAttribute('aria-pressed', String(selected));
    item.setAttribute('aria-label', `${selected ? 'Show all tickers' : `Show only ${ticker.symbol}`} · ${money(ticker.net, { sign: true })}`);
    item.addEventListener('click', () => {
      state.monthlyTicker = state.monthlyTicker === ticker.symbol ? null : ticker.symbol;
      state.monthlyDetail = null;
      renderMonthlyPerformance(state.dashboard?.tickerPerformance ?? []);
    });
    legend.append(item);
  }
  requestAnimationFrame(() => { legend.scrollLeft = scrollLeft; });
}

function renderMonthlyPerformance(tickers) {
  const legendScrollLeft = $('#monthly-pnl-legend').scrollLeft;
  const fullSeries = buildMonthlyTickerSeries(tickers);
  const series = filterMonthlyTickerSeries(fullSeries);
  const chart = $('#monthly-pnl-chart');
  hideMonthlyTooltip();
  chart.replaceChildren();
  $('#monthly-pnl-total').textContent = money(series.total, { sign: true });
  $('#monthly-pnl-total').className = Number(series.total) < 0 ? 'negative' : 'positive';
  const range = monthRangeLabel(series.months);
  $('#monthly-pnl-range').textContent = state.monthlyTicker ? `${state.monthlyTicker} · ${range}` : range;
  renderTickerKey(fullSeries, legendScrollLeft);

  const width = Math.max($('#monthly-chart-scroll').clientWidth, 268, series.months.length * 34 + 38);
  const height = 184;
  chart.setAttribute('viewBox', `0 0 ${width} ${height}`);
  chart.setAttribute('width', width);
  chart.setAttribute('height', height);
  chart.style.width = `${width}px`;

  const hasContributions = series.months.some((month) => month.contributions.size);
  if (!series.months.length || !hasContributions) {
    const empty = svgElement('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', class: 'monthly-chart-empty' });
    empty.textContent = state.monthlyTicker ? `No closed contracts for ${state.monthlyTicker}.` : 'Closed trades will build this chart.';
    chart.append(empty);
    return;
  }

  const plot = { left: 31, right: 5, top: 13, bottom: 30 };
  const plotHeight = height - plot.top - plot.bottom;
  const plotWidth = width - plot.left - plot.right;
  const monthStep = plotWidth / series.months.length;
  const barWidth = Math.min(22, monthStep * 0.68);
  const maxPositive = Math.max(0, ...series.months.map((month) => month.positive));
  const maxNegative = Math.max(0, ...series.months.map((month) => Math.abs(month.negative)));
  const totalRange = maxPositive + maxNegative;
  const positiveShare = maxPositive && maxNegative ? maxPositive / totalRange : maxPositive ? 0.86 : 0.14;
  const positiveHeight = plotHeight * positiveShare;
  const negativeHeight = plotHeight - positiveHeight;
  const zeroY = plot.top + positiveHeight;
  const positiveScale = maxPositive ? positiveHeight / maxPositive : 0;
  const negativeScale = maxNegative ? negativeHeight / maxNegative : 0;

  const zeroLine = svgElement('line', { x1: plot.left, x2: width - plot.right, y1: zeroY, y2: zeroY, class: 'monthly-zero-line' });
  chart.append(zeroLine);
  const zeroLabel = svgElement('text', { x: 4, y: Math.max(plot.top + 7, zeroY - 4), class: 'monthly-axis-label' });
  zeroLabel.textContent = '$0';
  chart.append(zeroLabel);
  if (maxPositive) {
    const labelNode = svgElement('text', { x: 4, y: plot.top + 4, class: 'monthly-axis-label' });
    labelNode.textContent = compactMoney(maxPositive);
    chart.append(labelNode);
  }
  if (maxNegative) {
    const labelNode = svgElement('text', { x: 4, y: height - plot.bottom - 2, class: 'monthly-axis-label' });
    labelNode.textContent = compactMoney(-maxNegative);
    chart.append(labelNode);
  }

  for (const [monthIndex, month] of series.months.entries()) {
    const x = plot.left + monthStep * monthIndex + (monthStep - barWidth) / 2;
    let positiveY = zeroY;
    let negativeY = zeroY;
    for (const ticker of series.symbols) {
      const contribution = month.contributions.get(ticker.symbol);
      const value = contribution?.value ?? 0;
      if (!value) continue;
      const colors = tickerInk(ticker.colorIndex);
      const segmentHeight = Math.abs(value) * (value > 0 ? positiveScale : negativeScale);
      const y = value > 0 ? positiveY - segmentHeight : negativeY;
      const segment = svgElement('rect', {
        x,
        y,
        width: barWidth,
        height: segmentHeight,
        rx: 2,
        fill: value > 0 ? colors.positive : colors.negative,
        class: 'monthly-bar-segment',
        tabindex: 0,
        role: 'button',
      });
      const fullMonth = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(monthDate(month.key));
      const detailKey = `${month.key}:${ticker.symbol}`;
      const detail = {
        color: value > 0 ? colors.positive : colors.negative,
        label: `${ticker.symbol} · ${fullMonth}`,
        meta: monthlyTradeSummary(contribution.trades),
        value,
      };
      segment.dataset.symbol = ticker.symbol;
      segment.dataset.detailKey = detailKey;
      segment.monthlyDetail = detail;
      segment.setAttribute('aria-label', `${detail.label} · ${money(value, { sign: true })} · ${detail.meta}`);
      segment.setAttribute('aria-pressed', String(state.monthlyDetail === detailKey));
      const title = svgElement('title');
      title.textContent = `${detail.label} · ${money(value, { sign: true })} · ${detail.meta}`;
      segment.append(title);
      const togglePinnedDetail = () => {
        state.monthlyDetail = state.monthlyDetail === detailKey ? null : detailKey;
        for (const bar of document.querySelectorAll('.monthly-bar-segment')) {
          bar.setAttribute('aria-pressed', String(bar.dataset.detailKey === state.monthlyDetail));
        }
        restoreMonthlyTooltip();
      };
      segment.addEventListener('mouseenter', () => showMonthlyTooltip(segment));
      segment.addEventListener('mouseleave', restoreMonthlyTooltip);
      segment.addEventListener('focus', () => showMonthlyTooltip(segment));
      segment.addEventListener('blur', restoreMonthlyTooltip);
      segment.addEventListener('click', togglePinnedDetail);
      segment.addEventListener('keydown', (event) => {
        if (!['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        togglePinnedDetail();
      });
      chart.append(segment);
      if (value > 0) positiveY -= segmentHeight;
      else negativeY += segmentHeight;
    }
    const monthLabel = svgElement('text', {
      x: x + barWidth / 2,
      y: height - 10,
      'text-anchor': 'middle',
      class: 'monthly-month-label',
    });
    const date = monthDate(month.key);
    const monthName = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(date);
    monthLabel.textContent = monthIndex === 0 || date.getUTCMonth() === 0
      ? `${monthName} '${String(date.getUTCFullYear()).slice(-2)}`
      : monthName;
    chart.append(monthLabel);
  }

  requestAnimationFrame(() => {
    const scroller = $('#monthly-chart-scroll');
    scroller.scrollLeft = scroller.scrollWidth;
    restoreMonthlyTooltip();
  });
}

function tickerKpi(name, value, term, detail) {
  const item = el('div');
  const metricName = el('dt');
  metricName.append(tradesGlossaryLabel(name, term));
  item.append(metricName, el('dd', '', value));
  if (detail) item.append(el('small', '', detail));
  return item;
}

function closeActionText(action) {
  return { buy_to_close: 'Bought back', expiration: 'Expired', assignment: 'Assigned' }[action] ?? label(action);
}

function tickerPastTradeRow(trade) {
  const item = el('li', 'history-item');
  item.append(el('span', 'history-dot'));
  const content = el('article', 'history-card');
  const top = el('div', 'history-topline');
  const identity = el('div', 'history-identity');
  identity.append(
    el('span', `trade-badge ${trade.type}`, trade.type.toUpperCase()),
    el('strong', '', `${marketPrice(trade.strike)} strike`),
  );
  top.append(identity, el('time', '', shortDate(trade.closedAt)));

  const lifecycle = el('p', 'history-lifecycle', `${shortDate(trade.openedAt)} → ${shortDate(trade.closedAt)} · ${trade.daysHeld ?? '—'} day${trade.daysHeld === 1 ? '' : 's'} · ${closeActionText(trade.closeAction)}`);
  const metrics = el('dl', 'history-metrics');
  metrics.append(
    tickerKpi('Booked P&L', money(trade.profit, { sign: true }), 'Booked profit'),
    tickerKpi('Return', percent(trade.returnRate), 'Return on collateral'),
    tickerKpi('Annualized', percent(trade.annualizedReturnRate), 'Annualized return'),
  );
  const closeCash = Number(trade.closingCashFlow);
  const cashFlow = el('small', 'history-cashflow');
  appendLabeledAmount(cashFlow, trade.openingCredit == null ? null : money(trade.openingCredit), 'Premium received', 'Premium received');
  cashFlow.append(document.createTextNode(' · '));
  if (trade.closingCashFlow == null) {
    cashFlow.append(document.createTextNode('Closing cash unavailable'));
  } else if (closeCash < 0) {
    cashFlow.append(document.createTextNode(`${money(Math.abs(closeCash))} `), tradesGlossaryLabel('close cost', 'Closing cash flow'));
  } else {
    cashFlow.append(document.createTextNode(`${money(closeCash)} closing cash`));
  }
  if (trade.needsReview) cashFlow.append(' · Return needs review');
  content.append(top, lifecycle, metrics, cashFlow);
  item.append(content);
  return item;
}

function tickerDetail(ticker) {
  const detail = el('div', 'ticker-detail');
  const historySection = el('section', 'ticker-detail-section history-section');
  const historyHeader = el('div', 'ticker-detail-title');
  historyHeader.append(el('h3', '', 'Past contracts'), el('span', '', `${ticker.pastTrades.length} closed`));
  historySection.append(historyHeader);
  if (ticker.pastTrades.length) {
    const history = el('ol', 'ticker-history');
    for (const trade of ticker.pastTrades) history.append(tickerPastTradeRow(trade));
    historySection.append(history);
  } else {
    const empty = el('div', 'ticker-open-list');
    emptyCard(empty, 'No closed contracts have been matched yet.');
    historySection.append(empty);
  }
  detail.append(historySection);
  return detail;
}

function tickerCard(ticker) {
  const card = document.createElement('details');
  card.className = 'ticker-card';
  const summary = el('summary', 'ticker-summary');
  const topline = el('div', 'ticker-topline');
  const name = el('div', 'ticker-name');
  const nameCopy = el('div', 'ticker-name-copy');
  const symbolLine = el('div', 'ticker-symbol-line');
  symbolLine.append(el('strong', '', ticker.symbol), stockPriceTag(ticker.stockPrice));
  nameCopy.append(symbolLine, el('small', '', closedContractCountText(ticker)));
  name.append(
    el('span', 'ticker-monogram', ticker.symbol.slice(0, 2)),
    nameCopy,
  );
  const result = el('div', 'ticker-result');
  const resultLabel = el('small');
  resultLabel.append(tradesGlossaryLabel('Booked option P&L', 'Booked profit'));
  result.append(
    resultLabel,
    el('strong', Number(ticker.bookedProfit) < 0 ? 'negative' : 'positive', money(ticker.bookedProfit, { sign: true })),
    el('span', 'ticker-chevron', '⌄'),
  );
  topline.append(name, result);

  const kpis = el('dl', 'ticker-kpis');
  kpis.append(
    tickerKpi('Return', percent(ticker.returnRate), 'Return on collateral'),
    tickerKpi('Annualized', percent(ticker.annualizedReturnRate), 'Annualized return'),
    tickerKpi('Collateral', money(ticker.capitalInvolved), 'Collateral'),
  );
  summary.append(topline, kpis);
  const warnings = [];
  if (ticker.quality.returnTradesExcluded) warnings.push(`${ticker.quality.returnTradesExcluded} closed trade${ticker.quality.returnTradesExcluded === 1 ? '' : 's'} excluded from rates`);
  if (ticker.quality.capitalNeedsReview) warnings.push('some capital basis is missing');
  if (warnings.length) summary.append(el('p', 'ticker-quality review', `${warnings.join(' · ')} · Check data`));
  card.append(summary, tickerDetail(ticker));
  return card;
}

function tickerClosedTimestamp(ticker, contractType = '') {
  const trades = (ticker.pastTrades ?? []).filter((trade) => !contractType || trade.type === contractType);
  const timestamps = trades.map((trade) => Date.parse(trade.closedAt)).filter(Number.isFinite);
  return timestamps.length ? Math.max(...timestamps) : null;
}

function sortTickerPerformance(tickers, contractType = '') {
  const [field, direction] = state.tickerSort.split('_');
  const valueFor = (ticker) => {
    if (field === 'date') return tickerClosedTimestamp(ticker, contractType);
    if (field === 'pnl') return Number(ticker.bookedProfit);
    if (field === 'capital') return Number(ticker.capitalInvolved);
    if (field === 'return') return ticker.returnRate == null ? null : Number(ticker.returnRate);
    return null;
  };
  return tickers.slice().sort((a, b) => {
    const aValue = valueFor(a);
    const bValue = valueFor(b);
    const aMissing = aValue == null || !Number.isFinite(aValue);
    const bMissing = bValue == null || !Number.isFinite(bValue);
    if (aMissing !== bMissing) return aMissing ? 1 : -1;
    if (!aMissing && aValue !== bValue) return direction === 'asc' ? aValue - bValue : bValue - aValue;
    return a.symbol.localeCompare(b.symbol);
  });
}

function syncTickerSortDirection() {
  const ascending = state.tickerSort.endsWith('_asc');
  $('#ticker-sort-arrow').textContent = ascending ? '↑' : '↓';
  const button = $('#ticker-sort-direction');
  button.setAttribute('aria-label', `Sort ${ascending ? 'ascending' : 'descending'}. Tap to reverse.`);
  button.setAttribute('aria-pressed', String(ascending));
}

function toggleTickerSortDirection() {
  const [field, direction] = state.tickerSort.split('_');
  state.tickerSort = `${field}_${direction === 'asc' ? 'desc' : 'asc'}`;
  syncTickerSortDirection();
  renderTickerTrades();
}

function renderTickerTrades() {
  const allTickers = state.dashboard?.tickerPerformance ?? [];
  const query = $('#ticker-filter').value.trim().toUpperCase();
  const contractType = $('#ticker-status-filter').value;
  const direction = state.tickerSort.split('_')[1] ?? 'desc';
  state.tickerSort = `${$('#ticker-sort').value}_${direction}`;
  syncTickerSortDirection();
  const tickers = sortTickerPerformance(allTickers.filter((ticker) => ticker.pastTrades.length > 0
    && (!query || ticker.symbol.includes(query))
    && (!contractType || ticker.pastTrades.some((trade) => trade.type === contractType))), contractType);
  const container = $('#ticker-list');
  container.replaceChildren();
  if (!tickers.length) {
    emptyCard(container, allTickers.length ? 'No tickers match these filters.' : 'No wheel trade activity found yet.');
    return;
  }
  for (const ticker of tickers) container.append(tickerCard(ticker));
}

function renderOpenTrades(dashboard) {
  const container = $('#open-trade-list');
  container.replaceChildren();
  $('#open-trade-count').textContent = `${dashboard.openTrades.length} open`;
  if (!dashboard.openTrades.length) {
    emptyCard(container, 'No short option contracts are open right now.');
    return;
  }
  for (const trade of dashboard.openTrades) {
    const management = state.closeByContract.get(trade.contractSymbol);
    const metricsMissing = !management;
    const metricsFailed = metricsMissing && state.closeMetricsStatus === 'error';
    const card = el('article', `trade-card${metricsMissing ? ' is-metrics-loading' : ''}`);
    if (metricsMissing && !metricsFailed) card.setAttribute('aria-busy', 'true');
    card.setAttribute('aria-label', `${trade.symbol} ${trade.type.toUpperCase()} open contract`);
    card.append(contractHeader(trade, management, dashboard));
    if (metricsMissing) {
      const pending = el('div', `contract-metrics-loading${metricsFailed ? ' is-error' : ''}`);
      pending.setAttribute('role', 'status');
      pending.append(el('span', '', metricsFailed ? 'Metrics unavailable' : 'Loading metrics'));
      if (!metricsFailed) pending.append(el('i'), el('i'), el('i'));
      const goal = effectiveContractGoal(trade, management, dashboard);
      const rollAction = rollController.action(trade, {
        state: 'unavailable', goal, searchProfile: null,
      });
      card.append(pending, ...[rollAction].filter(Boolean));
    } else {
      const rollReview = deriveRollReview({ trade, management });
      const details = contractDetails(trade, management, rollReview);
      const rollAction = rollController.action(trade, rollReview);
      card.append(
        recommendationSummary(management, rollReview, rollAction),
        economicsSummary(management),
        premiumCaptureProgress(management),
        details.footer,
        details.panel,
      );
    }
    container.append(card);
  }
}

function defaultContractGoal(instrumentType) {
  const normalizedType = String(instrumentType ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return normalizedType === 'etf' || normalizedType === 'mutualfund' ? 'protect' : 'income';
}

function effectiveContractGoal(trade, management, dashboard) {
  const savedGoal = management?.effectiveSettings?.goal;
  if (savedGoal && GOAL_LABELS[savedGoal]) return savedGoal;
  const ticker = dashboard?.tickerPerformance?.find((item) => item.symbol === trade.symbol);
  const screened = state.screenedTickers.find((item) => item.symbol === trade.symbol);
  const opportunity = dashboard?.opportunities?.coveredCalls?.find((item) => item.symbol === trade.symbol);
  return defaultContractGoal(
    trade.instrumentType ?? ticker?.instrumentType ?? screened?.instrumentType ?? opportunity?.instrumentType,
  );
}

function contractHeader(trade, management = null, dashboard = null) {
  const header = el('header', 'contract-header');
  const title = el('div', 'contract-title');
  const identity = el('div', 'contract-identity');
  identity.append(
    el('h3', '', trade.symbol),
    el('span', `trade-badge ${trade.type}`, trade.type.toUpperCase()),
  );
  const goal = effectiveContractGoal(trade, management, dashboard);
  const goalChip = el('span', 'contract-goal goal-tone', GOAL_LABELS[goal]);
  goalChip.dataset.goal = goal;
  identity.append(goalChip);
  const optionType = trade.type === 'csp' ? 'Put' : 'Call';
  title.append(
    identity,
    el('p', 'contract-terms', `${marketPrice(trade.strike)} ${optionType} · ${shortDate(trade.expiration)} · ${dteLabel(trade.dte)}`),
  );
  const contracts = trade.contracts == null ? Number.NaN : Math.abs(Number(trade.contracts));
  const headerMeta = el('div', 'contract-header-meta');
  headerMeta.append(
    stockPriceTag(management?.close?.metrics?.underlyingPrice ?? trade.stockPrice),
    el('small', 'contract-quantity', Number.isFinite(contracts)
      ? `${quantity(contracts)} contract${contracts === 1 ? '' : 's'}`
      : 'Quantity unavailable'),
  );
  header.append(
    title,
    headerMeta,
  );
  return header;
}

function recommendationPresentation(management, rollReview) {
  const close = management?.close;
  if (!close?.available) {
    return {
      label: 'Market data unavailable',
      tone: 'unavailable',
      reason: close?.unavailableReason ?? 'Close guidance has not been calculated yet.',
    };
  }
  if (rollReview?.state === 'review') {
    return { label: rollReview.label, tone: 'roll', reason: rollReview.reason };
  }
  if (rollReview?.state === 'assignmentAligned') {
    return { label: rollReview.label, tone: 'assignment', reason: rollReview.reason };
  }
  const capture = percent(close.metrics.premiumCapture, { sign: false });
  const target = percent(management.effectiveSettings.rules.closeAtProfitCapture, { sign: false });
  const moneyState = close.metrics?.moneyState;
  const strikeDistance = close.metrics?.distanceFromStrikePercent;
  const alignment = close.metrics?.assignmentAlignment;
  const assignmentMeaning = alignment?.status === 'aligns' || alignment?.status === 'conflicts'
    ? alignment.reason
    : 'Assignment risk deserves attention.';
  const assignmentNote = moneyState === 'ITM' ? ` This contract is ${strikeDistance == null ? '' : `${percent(Math.abs(strikeDistance), { sign: false })} `}ITM. ${assignmentMeaning}` : '';
  return close.signal
    ? { label: 'Close candidate', tone: 'close', reason: `${capture} of premium captured, meeting your ${target} close target.${assignmentNote}` }
    : { label: 'Hold', tone: 'hold', reason: `${capture} of premium captured; your close target is ${target}.${assignmentNote}` };
}

function recommendationSummary(management, rollReview, rollAction = null) {
  const recommendation = recommendationPresentation(management, rollReview);
  const summary = el('section', `recommendation-summary is-${recommendation.tone}`);
  if (rollReview?.goal) summary.dataset.goal = rollReview.goal;
  const heading = el('div', 'recommendation-heading');
  heading.append(
    el('span', 'recommendation-eyebrow', 'Recommendation'),
    el('strong', 'recommendation-label', recommendation.label),
  );
  summary.append(heading, el('p', 'recommendation-reason', recommendation.reason));
  const staleQuote = management?.lastUsableQuote;
  if (!management?.close?.available && staleQuote) {
    const timestamp = staleQuote.quoteTimestamp ?? staleQuote.fetchedAt;
    const note = el('div', 'stale-market-note');
    const tag = el('span', 'stale-market-tag', 'Stale quote');
    const time = el('time', '', timestamp ? `Last usable ${updatedAt(timestamp)}` : 'Last usable time unavailable');
    if (timestamp) time.dateTime = timestamp;
    const prices = staleQuote.bidPerShare == null && staleQuote.askPerShare == null
      ? 'Bid / ask unavailable'
      : `${marketPrice(staleQuote.bidPerShare)} / ${marketPrice(staleQuote.askPerShare)} bid / ask`;
    note.append(tag, time, el('strong', '', prices));
    summary.append(note);
  }
  if (rollAction) summary.append(rollAction);
  return summary;
}

function summaryMetric(labelText, value, glossaryTerm, context) {
  const item = el('div', 'economics-metric');
  const term = el('dt');
  term.append(tradesGlossaryLabel(labelText, glossaryTerm));
  item.append(term, el('dd', '', value));
  if (context) item.append(el('small', '', context));
  return item;
}

function economicsSummary(management) {
  const metrics = management?.close?.metrics;
  const summary = el('dl', 'trade-economics');
  summary.append(
    summaryMetric(
      'P/L if closed',
      metrics?.profitIfClosed == null ? '—' : money(metrics.profitIfClosed, { sign: true }),
      'Profit if closed',
      'Estimated now',
    ),
    summaryMetric(
      'Earned / day',
      metrics?.earnedPerDay == null ? '—' : money(metrics.earnedPerDay, { sign: true, maximumFractionDigits: 2 }),
      'Earned per day',
      'Since opening',
    ),
  );
  return summary;
}

function premiumCaptureProgress(management) {
  const rawCapture = management?.close?.metrics?.premiumCapture;
  const rawTarget = management?.effectiveSettings?.rules?.closeAtProfitCapture;
  const capture = rawCapture == null ? Number.NaN : Number(rawCapture);
  const target = rawTarget == null ? Number.NaN : Number(rawTarget);
  const captureAvailable = Number.isFinite(capture);
  const targetAvailable = Number.isFinite(target);
  const available = captureAvailable && targetAvailable;
  const progress = el('div', `premium-progress${management?.close?.signal === true ? ' is-met' : ''}${available ? '' : ' is-unavailable'}`);
  const heading = el('div', 'premium-progress-heading');
  heading.append(
    el('span', '', 'Premium capture progress'),
    el('strong', '', targetAvailable ? `Target ${percent(target, { sign: false })}` : 'Target unavailable'),
  );
  progress.append(heading);
  if (!available) {
    progress.append(el('p', 'premium-progress-unavailable', 'Progress unavailable until premium capture can be calculated.'));
    return progress;
  }

  const capturePercent = Math.min(100, Math.max(0, capture * 100));
  const targetPercent = Math.min(100, Math.max(0, target * 100));
  const track = el('div', 'premium-progress-track');
  track.style.setProperty('--capture-progress', `${capturePercent}%`);
  track.style.setProperty('--capture-target', `${targetPercent}%`);
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  track.setAttribute('aria-valuenow', String(Math.round(capturePercent)));
  track.setAttribute('aria-valuetext', `${percent(capture, { sign: false })} premium captured; target ${percent(target, { sign: false })}`);
  const marker = el('span', 'premium-progress-target');
  marker.title = `Close target ${percent(target, { sign: false })}`;
  marker.setAttribute('aria-hidden', 'true');
  track.append(el('span', 'premium-progress-fill'), marker);
  progress.append(track);
  return progress;
}

function detailMetric(labelText, value, glossaryTerm = labelText) {
  if (value == null) return null;
  const item = el('div', 'close-metric');
  const term = el('dt');
  term.append(glossaryTerm ? tradesGlossaryLabel(labelText, glossaryTerm) : document.createTextNode(labelText));
  item.append(term, el('dd', '', value));
  return item;
}

function detailGrid(metrics) {
  const visibleMetrics = metrics.filter(Boolean);
  if (!visibleMetrics.length) return null;
  const grid = el('dl', 'contract-detail-grid');
  grid.append(...visibleMetrics);
  return grid;
}

function positionCheckRow(title, message, tone = 'neutral') {
  const row = el('div', `position-check-row is-${tone}`);
  const mark = el('span', 'position-check-mark', tone === 'positive' ? '✓' : tone === 'warning' ? '!' : '•');
  mark.setAttribute('aria-hidden', 'true');
  const copy = el('div', 'position-check-copy');
  copy.append(el('strong', '', title), el('p', '', message));
  row.append(mark, copy);
  return row;
}

function profitTargetCheck(management) {
  const rawCapture = management?.close?.metrics?.premiumCapture;
  const rawTarget = management?.effectiveSettings?.rules?.closeAtProfitCapture;
  const capture = Number(rawCapture);
  const target = Number(rawTarget);
  if (rawCapture == null || rawTarget == null || !Number.isFinite(capture) || !Number.isFinite(target)) {
    return positionCheckRow('Profit target', 'Premium capture or the close target is unavailable.');
  }
  if (capture < 0) {
    return positionCheckRow(
      'Profit target',
      `${percent(capture, { sign: false })} captured. The current buyback estimate is above the opening credit.`,
      'warning',
    );
  }
  const status = management.close.signal === true ? 'met' : 'not reached';
  return positionCheckRow(
    'Profit target',
    `${percent(capture, { sign: false })} captured. Your ${percent(target, { sign: false })} close target is ${status}.`,
    management.close.signal === true ? 'positive' : 'neutral',
  );
}

function assignmentRiskCheck(trade, management) {
  const metrics = management?.close?.metrics;
  const moneyState = metrics?.moneyState;
  if (!moneyState) {
    return positionCheckRow('Assignment risk', 'Strike distance is unavailable, so assignment pressure cannot be assessed.');
  }
  const distance = metrics.distanceFromStrikePercent == null
    ? null
    : percent(Math.abs(metrics.distanceFromStrikePercent), { sign: false });
  const dte = metrics.dte ?? trade.dte;
  const context = [
    `${distance == null ? '' : `${distance} `}${moneyState}`,
    dte == null ? null : dteLabel(dte),
    metrics.delta == null ? null : `delta ${decimal(metrics.delta, 2)}`,
  ].filter(Boolean).join(' · ');
  const alignment = metrics.assignmentAlignment;
  const meaning = moneyState !== 'ITM'
    ? 'The contract remains on the OTM side of the strike.'
    : alignment?.status === 'aligns' || alignment?.status === 'conflicts'
      ? alignment.reason
      : 'Assignment risk deserves attention.';
  const tone = moneyState === 'ITM' ? (alignment?.status === 'aligns' ? 'positive' : 'warning') : 'neutral';
  return positionCheckRow('Assignment risk', `${context}. ${meaning}`, tone);
}

function exitLiquidityCheck(trade, management) {
  const metrics = management?.close?.metrics;
  const leg = trade.type === 'csp' ? 'cashSecuredPut' : 'coveredCall';
  const config = resolveRadarScoringConfig({ leg, symbol: trade.symbol });
  const liquidity = calculateLiquidity({
    bid: metrics?.bidPerShare,
    ask: metrics?.askPerShare,
    openInterest: metrics?.openInterest,
    volume: metrics?.volume,
  }, config);
  if (liquidity.label === 'unknown') {
    return positionCheckRow('Exit liquidity', 'Bid/ask, open interest, or volume is unavailable, so liquidity cannot be rated.');
  }
  const rating = liquidity.label === 'poor' ? 'Thin' : label(liquidity.label);
  const detail = [
    metrics?.spreadPercent == null ? null : `${percent(metrics.spreadPercent, { sign: false })} spread`,
    metrics?.openInterest == null ? null : `${quantity(metrics.openInterest)} OI`,
    metrics?.volume == null ? null : `${quantity(metrics.volume)} volume`,
  ].filter(Boolean).join(' · ');
  const executionWarning = liquidity.warnings.some((warning) => warning.severity !== 'info');
  const guidance = liquidity.label === 'poor'
    ? 'Closing may require careful limit pricing.'
    : liquidity.label === 'fair' || executionWarning
      ? 'A limit order may need more patience.'
      : 'Market depth should support a routine close.';
  const tone = ['excellent', 'good'].includes(liquidity.label) && !executionWarning ? 'positive' : 'warning';
  return positionCheckRow('Exit liquidity', `${rating} liquidity. ${detail}. ${guidance}`, tone);
}

function rollDecisionCheck(rollReview) {
  if (!['review', 'assignmentAligned'].includes(rollReview?.state)) return null;
  return positionCheckRow(
    'Roll decision',
    rollReview.reason,
    rollReview.state === 'assignmentAligned' ? 'positive' : 'warning',
  );
}

function positionCheck(trade, management, updateTime, rollReview) {
  const section = el('section', 'position-check');
  const heading = el('div', 'position-check-heading');
  const refreshed = refreshTime(updateTime);
  heading.append(
    el('h4', '', 'Position check'),
    el('small', '', refreshed ? `Market data ${refreshed}` : 'Market data time unavailable'),
  );
  const rows = el('div', 'position-check-list');
  rows.append(
    profitTargetCheck(management),
    assignmentRiskCheck(trade, management),
    exitLiquidityCheck(trade, management),
    ...[rollDecisionCheck(rollReview)].filter(Boolean),
  );
  section.append(heading, rows);
  return section;
}

function contractDetails(trade, management, rollReview) {
  const metrics = management?.close?.metrics;
  const footer = el('div', 'contract-details-footer');
  const updateTime = management?.quoteTimestamps?.contract
    ?? management?.quoteTimestamps?.underlying
    ?? management?.quoteTimestamps?.providerFetchedAt;
  const control = el('button', 'contract-details-control');
  const panelId = `contract-details-${String(trade.contractSymbol).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  control.type = 'button';
  control.id = `${panelId}-control`;
  control.setAttribute('aria-expanded', 'false');
  control.setAttribute('aria-controls', panelId);
  footer.append(control);

  const panel = el('div', 'contract-details');
  panel.id = panelId;
  panel.hidden = true;
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-labelledby', control.id);
  const setExpanded = (expanded) => {
    control.setAttribute('aria-expanded', String(expanded));
    const controlLabel = `${expanded ? 'Hide' : 'Show'} position check for ${trade.symbol}`;
    control.setAttribute('aria-label', controlLabel);
    control.title = controlLabel;
    panel.hidden = !expanded;
  };
  control.addEventListener('click', () => setExpanded(control.getAttribute('aria-expanded') !== 'true'));
  setExpanded(false);

  const metricsGrid = detailGrid([
    detailMetric('Premium received', trade.openingCredit == null ? null : money(trade.openingCredit), 'Premium received'),
    detailMetric('Buyback estimate', metrics?.estimatedBuybackDebit == null ? null : money(metrics.estimatedBuybackDebit), 'Buyback debit'),
    detailMetric('Collateral', trade.collateral == null ? null : money(trade.collateral), 'Collateral'),
    detailMetric('Breakeven price', metrics?.breakevenPrice == null ? null : marketPrice(metrics.breakevenPrice), 'Breakeven'),
    detailMetric(
      'Bid / ask',
      metrics?.bidPerShare == null && metrics?.askPerShare == null
        ? null
        : [
          `${metrics?.bidPerShare == null ? 'Unavailable' : marketPrice(metrics.bidPerShare)} / ${metrics?.askPerShare == null ? 'Unavailable' : marketPrice(metrics.askPerShare)}`,
          metrics?.spreadPercent == null ? null : `${percent(metrics.spreadPercent, { sign: false })} spread`,
        ].filter(Boolean).join(' · '),
      'Bid-ask spread',
    ),
    detailMetric('Delta', metrics?.delta == null ? null : decimal(metrics.delta, 3), 'Delta'),
    detailMetric('Implied volatility', metrics?.impliedVolatility == null ? null : percent(metrics.impliedVolatility, { sign: false }), 'Implied volatility'),
  ]);
  panel.append(positionCheck(trade, management, updateTime, rollReview), ...[metricsGrid].filter(Boolean));
  if (trade.needsReview) {
    panel.append(el('p', 'contract-data-note', 'Some opening-position data needs review.'));
  }
  return { footer, panel };
}

function renderDashboard(dashboard) {
  for (const region of document.querySelectorAll('[data-dashboard-metrics]')) {
    region.removeAttribute('aria-busy');
  }
  const { kpis, quality } = dashboard;
  const booked = $('#booked-profit');
  booked.textContent = money(kpis.bookedProfit, { sign: true });
  booked.classList.toggle('loss', Number(kpis.bookedProfit) < 0);
  $('#return-rate').textContent = percent(kpis.returnRate);
  $('#annualized-return-rate').textContent = percent(kpis.annualizedReturnRate);
  const tradeCount = Number(quality.closedTrades) || 0;
  const tradeLabel = `${tradeCount} trade${tradeCount === 1 ? '' : 's'}`;
  $('#calculation-quality').textContent = quality.historyStartsAt
    ? `${tradeLabel} since ${historyDate(quality.historyStartsAt)}`
    : tradeCount ? tradeLabel : 'No trade history yet';

  $('#wheel-capital').textContent = money(kpis.wheelCapital);
  $('#wheel-capital-detail').textContent = `${money(kpis.cspCollateral)} puts · ${money(kpis.shareCapital)} shares`;
  $('#open-csps').textContent = quantity(kpis.openCspContracts);
  $('#csp-collateral').textContent = `${money(kpis.cspCollateral)} secured`;
  $('#open-ccs').textContent = quantity(kpis.openCcContracts);

  $('#capital-velocity').textContent = kpis.capitalVelocity == null ? '—' : money(kpis.capitalVelocity);
  $('#premium-capture').textContent = percent(kpis.premiumCaptureRate, { sign: false });
  $('#next-expiry').textContent = shortDate(kpis.nextExpiration);
  const nextTrade = dashboard.openTrades.find((trade) => trade.expiration === kpis.nextExpiration);
  $('#expiry-detail').textContent = kpis.contractsExpiringSoon
    ? `${kpis.contractsExpiringSoon} contract${kpis.contractsExpiringSoon === 1 ? '' : 's'} within 7 days`
    : nextTrade ? dteLabel(nextTrade.dte) : 'No open contracts';

  renderOpportunities(dashboard);
  renderOpenTrades(dashboard);
  renderMonthlyPerformance(dashboard.tickerPerformance ?? []);
  renderTickerTrades();
}

async function loadDashboard() {
  state.closeMetricsStatus = 'loading';
  state.closeByContract = new Map();
  const closeRequest = json('/api/v1/position-management')
    .then((value) => ({ value, error: null }))
    .catch((error) => ({ value: null, error }));
  const dashboard = await json('/api/v1/wheel/dashboard');
  state.dashboard = dashboard;
  strategySettingsController.refresh();
  setFreshness(dashboard.freshness);
  renderDashboard(dashboard);
  try {
    const closeResult = await closeRequest;
    if (closeResult.error) throw closeResult.error;
    const closeBatch = closeResult.value;
    state.closeByContract = new Map(closeBatch.results.map((item) => [item.contract.contractSymbol, item]));
    state.closeMetricsStatus = 'ready';
    renderOpenTrades(dashboard);
  } catch {
    state.closeMetricsStatus = 'error';
    renderOpenTrades(dashboard);
  }
}

function showScreen(target) {
  const current = document.querySelector('.app-screen.is-active')?.dataset.screen;
  if (current === 'more' && target !== 'more' && !strategySettingsController.confirmLeave()) return false;
  for (const screen of document.querySelectorAll('.app-screen')) {
    const active = screen.dataset.screen === target;
    screen.hidden = !active;
    screen.classList.toggle('is-active', active);
  }
  for (const button of document.querySelectorAll('.bottom-nav button')) {
    const active = button.dataset.target === target;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  const names = { overview: 'Portfolio', cycles: 'Wheel trades', screener: 'Radar', more: 'Strategy settings' };
  const screenKicker = $('#screen-kicker');
  if (screenKicker) screenKicker.textContent = names[target];
  window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  if (target === 'cycles') {
    renderMonthlyPerformance(state.dashboard?.tickerPerformance ?? []);
    renderTickerTrades();
  }
  if (target === 'screener') screenerController.loadTargets(true);
  if (target === 'more') strategySettingsController.load();
  return true;
}

$('#ticker-filters').addEventListener('input', renderTickerTrades);
$('#ticker-filters').addEventListener('reset', () => setTimeout(renderTickerTrades));
$('#ticker-sort-direction').addEventListener('click', toggleTickerSortDirection);
for (const button of document.querySelectorAll('.bottom-nav button')) {
  button.addEventListener('click', () => showScreen(button.dataset.target));
}

let localReloadTimer;
for (const eventName of ['wheely-brokerage-updated', 'wheely-history-updated', 'wheely-market-updated']) {
  document.addEventListener(eventName, () => {
    clearTimeout(localReloadTimer);
    localReloadTimer = setTimeout(() => loadDashboard().catch(() => undefined), 40);
  });
}

loadDashboard().catch((error) => {
  toast(`Dashboard unavailable: ${error.message}`, 'error');
  const opportunities = $('#opportunity-list');
  const trades = $('#open-trade-list');
  $('#opportunities-section').hidden = true;
  opportunities.replaceChildren();
  trades.replaceChildren();
  emptyCard(trades, 'Open trades could not be loaded.');
});
