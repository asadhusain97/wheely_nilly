const state = {
  dashboard: null,
  positions: [],
  premiums: [],
  tickerSort: 'date_desc',
  monthlyTicker: null,
  monthlyDetail: null,
  loaded: { more: false },
};

const $ = (selector) => document.querySelector(selector);
const money = (value, { sign = false, digits = 2 } = {}) => value == null
  ? '—'
  : new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', signDisplay: sign ? 'exceptZero' : 'auto',
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  }).format(Number(value));
const percent = (value, { sign = true } = {}) => value == null
  ? '—'
  : new Intl.NumberFormat('en-US', { style: 'percent', signDisplay: sign ? 'exceptZero' : 'auto', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
const quantity = (value) => new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(value));
const shortDate = (value) => value
  ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(value))
  : '—';
const historyDate = (value) => value
  ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(value))
  : '—';
const updatedAt = (value) => value
  ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)).replace(',', ' ·')
  : '—';
const label = (value) => String(value ?? '').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());

function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function stack(primary, secondary, className = 'cell-stack') {
  const node = el('div', className);
  node.append(el('strong', '', primary));
  if (secondary) node.append(el('small', '', secondary));
  return node;
}

function stockPriceTag(value) {
  const available = value !== null && value !== undefined;
  const price = money(value);
  const tag = el('span', `stock-price-tag${available ? '' : ' is-unavailable'}`, price);
  tag.setAttribute('aria-label', available ? `Latest stock price ${price}` : 'Latest stock price unavailable');
  tag.title = available ? 'Latest brokerage stock price' : 'Latest stock price unavailable';
  return tag;
}

function emptyRow(body, columns, message) {
  const row = el('tr', 'empty-row');
  const cell = el('td', '', message);
  cell.colSpan = columns;
  row.append(cell);
  body.append(row);
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
  if (!response.ok) throw new Error(body.error?.message ?? `Request returned ${response.status}`);
  return body;
}

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 4000);
}

function setFreshness(value) {
  const updated = $('#last-updated');
  updated.replaceChildren(
    el('span', '', value.stale ? 'Last update · stale' : 'Last updated'),
    el('strong', '', updatedAt(value.lastSuccessAt)),
  );
  updated.dateTime = value.lastSuccessAt ?? '';
  updated.classList.toggle('is-stale', value.stale);
  updated.title = value.stale ? 'Brokerage data may be stale' : 'Brokerage data is current';
}

function ccText(position) {
  const cc = position.coveredCall;
  if (cc.status === 'open') {
    const expiry = cc.expirations.length ? cc.expirations.map(shortDate).join(', ') : 'No expiry';
    return {
      title: `${quantity(cc.contracts)} CC open`,
      detail: `Expires ${expiry}${cc.availableLots ? ` · ${cc.availableLots} lot free` : ''}`,
      open: true,
    };
  }
  return { title: 'Ready for a CC', detail: `${cc.availableLots} lot${cc.availableLots === 1 ? '' : 's'} available`, open: false };
}

function positionRow(position) {
  const row = el('tr');
  const cc = ccText(position);
  const symbolCell = el('td');
  symbolCell.append(stack(position.symbol, `${position.coveredCall.totalLots} lot${position.coveredCall.totalLots === 1 ? '' : 's'}`));
  const ccCell = el('td');
  ccCell.append(stack(cc.title, cc.detail));
  ccCell.querySelector('strong').className = `status-label${cc.open ? ' open' : ''}`;
  row.append(
    symbolCell,
    ccCell,
    el('td', 'number-cell', quantity(position.quantity)),
    el('td', 'number-cell', money(position.price)),
    el('td', 'number-cell', money(position.brokerCostBasis)),
  );
  return row;
}

function renderPositions() {
  const body = $('#positions-body');
  body.replaceChildren();
  if (!state.positions.length) {
    emptyRow(body, 5, 'No covered-call eligible holdings.');
    return;
  }
  for (const position of state.positions) body.append(positionRow(position));
}

function premiumActivity(event) {
  const contract = event.option;
  const title = contract
    ? `${contract.underlying} · ${contract.optionType === 'put' ? 'P' : 'C'} ${money(contract.strikeMinor / 100)}`
    : 'Unknown contract';
  return {
    title,
    detail: `${shortDate(event.occurredAt)} · ${label(event.action)}${event.includedInTotals ? '' : ' · Review'}`,
  };
}

function renderPremiums() {
  const body = $('#premiums-body');
  body.replaceChildren();
  if (!state.premiums.length) {
    emptyRow(body, 4, 'No premium activity imported.');
    return;
  }
  for (const event of state.premiums.slice().reverse().slice(0, 100)) {
    const activity = premiumActivity(event);
    const row = el('tr');
    const activityCell = el('td');
    activityCell.append(stack(activity.title, activity.detail));
    row.append(
      activityCell,
      el('td', 'number-cell', money(event.amount)),
      el('td', 'number-cell', money(event.fee)),
      el('td', `number-cell ${Number(event.netCash) >= 0 ? 'positive' : 'negative'}`, money(event.netCash, { sign: true })),
    );
    body.append(row);
  }
}

function openCoveredCallScreen(opportunity) {
  const form = $('#screener-form');
  form.elements.symbol.value = opportunity.symbol;
  form.elements.leg.value = 'covered_call';
  form.elements.covered_shares.value = opportunity.availableLots * 100;
  showScreen('screener');
  form.elements.symbol.focus();
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

function contractCountText(ticker) {
  if (!ticker.openContracts) return 'No open contracts';
  const parts = [];
  if (ticker.openCspContracts) parts.push(`${quantity(ticker.openCspContracts)} CSP`);
  if (ticker.openCcContracts) parts.push(`${quantity(ticker.openCcContracts)} CC`);
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

function tickerKpi(name, value, detail) {
  const item = el('div');
  item.append(el('dt', '', name), el('dd', '', value));
  if (detail) item.append(el('small', '', detail));
  return item;
}

function tickerOpenTradeRow(trade) {
  const row = el('article', 'ticker-open-row');
  const identity = el('div', 'ticker-contract-identity');
  identity.append(
    el('span', `trade-badge ${trade.type}`, trade.type.toUpperCase()),
    stack(`${money(trade.strike)} strike`, `${shortDate(trade.expiration)} · ${dteLabel(trade.dte)}`),
  );
  const value = stack(money(trade.collateral), trade.type === 'csp' ? 'Cash secured' : 'Shares committed', 'ticker-contract-value');
  const note = el('small', 'ticker-contract-note', trade.openingCredit == null
    ? 'Opening credit unavailable'
    : `${money(trade.openingCredit)} opening credit`);
  if (trade.needsReview) note.append(' · Check data');
  row.append(identity, value, note);
  return row;
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
    el('strong', '', `${money(trade.strike)} strike`),
  );
  top.append(identity, el('time', '', shortDate(trade.closedAt)));

  const lifecycle = el('p', 'history-lifecycle', `${shortDate(trade.openedAt)} → ${shortDate(trade.closedAt)} · ${trade.daysHeld ?? '—'} day${trade.daysHeld === 1 ? '' : 's'} · ${closeActionText(trade.closeAction)}`);
  const metrics = el('dl', 'history-metrics');
  metrics.append(
    tickerKpi('Booked P&L', money(trade.profit, { sign: true })),
    tickerKpi('Return', percent(trade.returnRate)),
    tickerKpi('Annualized', percent(trade.annualizedReturnRate)),
  );
  const closeCash = Number(trade.closingCashFlow);
  const closeDetail = trade.closingCashFlow == null
    ? 'Closing cash unavailable'
    : closeCash < 0 ? `${money(Math.abs(closeCash))} close cost` : `${money(closeCash)} closing cash`;
  const cashFlow = el('small', 'history-cashflow', `${money(trade.openingCredit)} opening credit · ${closeDetail}`);
  if (trade.needsReview) cashFlow.append(' · Return needs review');
  content.append(top, lifecycle, metrics, cashFlow);
  item.append(content);
  return item;
}

function tickerDetail(ticker) {
  const detail = el('div', 'ticker-detail');
  const openSection = el('section', 'ticker-detail-section');
  const openHeader = el('div', 'ticker-detail-title');
  openHeader.append(el('h3', '', 'Open now'), el('span', '', `${ticker.openContracts} contract${ticker.openContracts === 1 ? '' : 's'}`));
  const openList = el('div', 'ticker-open-list');
  if (ticker.openTrades.length) {
    for (const trade of ticker.openTrades) openList.append(tickerOpenTradeRow(trade));
  } else {
    emptyCard(openList, 'No short option contracts are open for this ticker.');
  }
  openSection.append(openHeader, openList);

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
  detail.append(openSection, historySection);
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
  nameCopy.append(symbolLine, el('small', '', contractCountText(ticker)));
  name.append(
    el('span', 'ticker-monogram', ticker.symbol.slice(0, 2)),
    nameCopy,
  );
  const result = el('div', 'ticker-result');
  result.append(
    el('small', '', 'Booked option P&L'),
    el('strong', Number(ticker.bookedProfit) < 0 ? 'negative' : 'positive', money(ticker.bookedProfit, { sign: true })),
    el('span', 'ticker-chevron', '⌄'),
  );
  topline.append(name, result);

  const kpis = el('dl', 'ticker-kpis');
  kpis.append(
    tickerKpi('Return', percent(ticker.returnRate)),
    tickerKpi('Annualized', percent(ticker.annualizedReturnRate)),
    tickerKpi('Collateral', money(ticker.capitalInvolved, { digits: 0 })),
    tickerKpi('Contracts', quantity(ticker.openContracts)),
  );
  summary.append(topline, kpis);
  const warnings = [];
  if (ticker.quality.returnTradesExcluded) warnings.push(`${ticker.quality.returnTradesExcluded} closed trade${ticker.quality.returnTradesExcluded === 1 ? '' : 's'} excluded from rates`);
  if (ticker.quality.capitalNeedsReview) warnings.push('some capital basis is missing');
  if (warnings.length) summary.append(el('p', 'ticker-quality review', `${warnings.join(' · ')} · Check data`));
  card.append(summary, tickerDetail(ticker));
  return card;
}

function tickerOpenedTimestamp(ticker, status = '') {
  const trades = status === 'open'
    ? (ticker.openTrades ?? [])
    : status === 'history'
      ? (ticker.pastTrades ?? [])
      : [...(ticker.openTrades ?? []), ...(ticker.pastTrades ?? [])];
  const timestamps = trades.map((trade) => Date.parse(trade.openedAt)).filter(Number.isFinite);
  return timestamps.length ? Math.max(...timestamps) : null;
}

function sortTickerPerformance(tickers, status = '') {
  const [field, direction] = state.tickerSort.split('_');
  const valueFor = (ticker) => {
    if (field === 'date') return tickerOpenedTimestamp(ticker, status);
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
  const status = $('#ticker-status-filter').value;
  const direction = state.tickerSort.split('_')[1] ?? 'desc';
  state.tickerSort = `${$('#ticker-sort').value}_${direction}`;
  syncTickerSortDirection();
  const tickers = sortTickerPerformance(allTickers.filter((ticker) => (!query || ticker.symbol.includes(query))
    && (!status || (status === 'open' ? ticker.openContracts > 0 : ticker.pastTrades.length > 0))), status);
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
    const card = el('article', 'trade-card');
    const top = el('div', 'trade-topline');
    const identity = el('div', 'trade-identity');
    identity.append(
      el('span', `trade-badge ${trade.type}`, trade.type.toUpperCase()),
      el('strong', '', trade.symbol),
      stockPriceTag(trade.stockPrice),
    );
    top.append(identity, el('span', trade.dte !== null && trade.dte <= 7 ? 'trade-timing urgent' : 'trade-timing', dteLabel(trade.dte)));

    const contract = el('div', 'trade-contract');
    contract.append(
      stack(`${money(trade.strike)} strike`, `${shortDate(trade.expiration)} expiry`),
      stack(money(trade.collateral), trade.type === 'csp' ? 'Cash secured' : 'Shares committed', 'trade-number'),
    );
    const footer = el('div', 'trade-footer');
    const credit = el('small', '', trade.openingCredit == null ? 'Opening credit unavailable' : `${money(trade.openingCredit)} opening credit`);
    if (trade.needsReview) credit.append(' · Check data');
    const rollButton = el('button', 'roll-button', 'Find roll');
    rollButton.type = 'button';
    rollButton.disabled = true;
    rollButton.title = 'Rollover comparison logic is the next feature';
    footer.append(credit, rollButton);
    card.append(top, contract, footer);
    container.append(card);
  }
}

function renderDashboard(dashboard) {
  const { kpis, quality } = dashboard;
  const booked = $('#booked-profit');
  booked.textContent = money(kpis.bookedProfit, { sign: true });
  booked.classList.toggle('loss', Number(kpis.bookedProfit) < 0);
  $('#return-rate').textContent = percent(kpis.returnRate);
  $('#annualized-return-rate').textContent = percent(kpis.annualizedReturnRate);
  const unmatched = quality.unmatchedCloseContracts
    ? ` · ${quality.unmatchedCloseContracts} unmatched close${quality.unmatchedCloseContracts === 1 ? '' : 's'} need review`
    : '';
  const coverage = quality.historyStartsAt
    ? `All available history since ${historyDate(quality.historyStartsAt)}`
    : 'No option history available';
  $('#calculation-quality').textContent = `${coverage} · ${quality.returnTradesIncluded} of ${quality.closedTrades} closed trades included in returns${unmatched}`;

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
  const dashboard = await json('/api/v1/wheel/dashboard');
  state.dashboard = dashboard;
  setFreshness(dashboard.freshness);
  renderDashboard(dashboard);
}

async function loadAlerts() {
  const [status, audit] = await Promise.all([
    json('/api/v1/notifications/status'),
    json('/api/v1/notifications/audit'),
  ]);
  $('#alert-status').textContent = status.dryRun ? 'Dry run enabled' : status.configured ? 'ntfy configured' : 'ntfy not configured';
  $('#alert-detail').textContent = Object.entries(status.counts).map(([key, value]) => `${value} ${key}`).join(' · ') || 'No notifications yet';
  const body = $('#alerts-body');
  body.replaceChildren();
  if (!audit.notifications.length) {
    emptyRow(body, 3, 'No notification attempts yet.');
    return;
  }
  for (const item of audit.notifications) {
    const row = el('tr');
    row.append(el('td', '', label(item.eventType)), el('td', 'number-cell', label(item.status)), el('td', 'number-cell', shortDate(item.createdAt)));
    body.append(row);
  }
}

async function loadMore() {
  if (state.loaded.more) return;
  const [positions, premiums] = await Promise.all([
    json('/api/v1/wheel/positions'),
    json('/api/v1/wheel/premiums'),
    loadAlerts(),
  ]);
  state.positions = positions.positions;
  state.premiums = premiums.premiumLedger;
  state.loaded.more = true;
  renderPositions();
  renderPremiums();
}

function showScreen(target) {
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
  const names = { overview: 'Portfolio', cycles: 'Wheel trades', screener: 'Options screener', more: 'Records and settings' };
  const screenKicker = $('#screen-kicker');
  if (screenKicker) screenKicker.textContent = names[target];
  window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  if (target === 'cycles') {
    renderMonthlyPerformance(state.dashboard?.tickerPerformance ?? []);
    renderTickerTrades();
  }
  if (target === 'more') loadMore().catch((error) => toast(error.message));
}

$('#ticker-filters').addEventListener('input', renderTickerTrades);
$('#ticker-filters').addEventListener('reset', () => setTimeout(renderTickerTrades));
$('#ticker-sort-direction').addEventListener('click', toggleTickerSortDirection);
for (const button of document.querySelectorAll('.bottom-nav button')) {
  button.addEventListener('click', () => showScreen(button.dataset.target));
}

$('#refresh-button').addEventListener('click', async () => {
  const button = $('#refresh-button');
  button.disabled = true;
  button.classList.add('is-refreshing');
  button.setAttribute('aria-busy', 'true');
  button.setAttribute('aria-label', 'Refreshing portfolio data');
  try {
    const report = await json('/api/v1/snaptrade/refresh', { method: 'POST' });
    state.loaded = { more: false };
    await loadDashboard();
    toast(report.ok ? 'Portfolio refreshed.' : 'Refresh completed with some errors.');
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.classList.remove('is-refreshing');
    button.removeAttribute('aria-busy');
    button.setAttribute('aria-label', 'Refresh portfolio data');
  }
});

$('#screener-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  const body = $('#screener-body');
  button.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(form));
    const result = await json('/api/v1/screens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        symbol: values.symbol.trim().toUpperCase(),
        leg: values.leg,
        cash_available: Number(values.cash_available),
        covered_shares: Number(values.covered_shares),
      }),
    });
    body.replaceChildren();
    $('#screener-meta').textContent = `${result.provider}${result.provider_unofficial ? ' (unofficial)' : ''} · quote ${updatedAt(result.quote_timestamp)} · cache ${Math.round(result.cache.age_seconds ?? 0)}s${result.degraded ? ' · degraded' : ''}`;
    if (!result.candidates.length) {
      emptyRow(body, 4, `No candidates passed. ${Object.entries(result.exclusions).map(([key, value]) => `${label(key)}: ${value}`).join(' · ')}`);
    }
    for (const candidate of result.candidates) {
      const row = el('tr');
      const contract = el('td');
      contract.append(stack(`${money(candidate.strike)} · ${candidate.expiration}`, `${candidate.dte} DTE · OI ${candidate.open_interest ?? '—'}`));
      row.append(
        contract,
        el('td', 'number-cell', money(candidate.executable_premium)),
        el('td', 'number-cell positive', percent(candidate.annualized_return)),
        el('td', 'number-cell', candidate.delta?.toFixed(2) ?? '—'),
      );
      body.append(row);
    }
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});

$('#test-notification').addEventListener('click', async () => {
  try {
    await json('/api/v1/notifications/test', { method: 'POST' });
    toast('Test notification queued.');
    await loadAlerts();
  } catch (error) {
    toast(error.message);
  }
});

loadDashboard().catch((error) => {
  toast(`Dashboard unavailable: ${error.message}`);
  const opportunities = $('#opportunity-list');
  const trades = $('#open-trade-list');
  $('#opportunities-section').hidden = true;
  opportunities.replaceChildren();
  trades.replaceChildren();
  emptyCard(trades, 'Open trades could not be loaded.');
});
