import { createGlossaryTerm } from './glossary.js';
import { prepareRadarCandidates } from './radar-scoring.js';

const LEG_LABELS = { coveredCall: 'Covered call', cashSecuredPut: 'Cash-secured put' };
const GOAL_LABELS = {
  protect: 'Keep Shares',
  income: 'Earn Income',
  exit: 'Plan Exit',
  acquire: 'Plan Entry',
};
const GOAL_LEGS = {
  protect: ['coveredCall'],
  income: ['coveredCall', 'cashSecuredPut'],
  exit: ['coveredCall'],
  acquire: ['cashSecuredPut'],
};
const SCAN_RESULTS_KEY = 'wheely-nilly.radar-scan-results.v1';
const SCAN_RESULT_KEY = /^[A-Z][A-Z0-9.-]{0,9}:(coveredCall|cashSecuredPut)$/;

function browserStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function storableScanEntry(entry) {
  return entry?.status === 'error' || (entry?.status === 'success' && Array.isArray(entry.result?.candidates));
}

export function loadStoredScanResults(storage = browserStorage()) {
  try {
    const saved = JSON.parse(storage?.getItem(SCAN_RESULTS_KEY) ?? '{}');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return new Map();
    return new Map(Object.entries(saved).filter(([resultKey, entry]) => SCAN_RESULT_KEY.test(resultKey) && storableScanEntry(entry)));
  } catch {
    return new Map();
  }
}

export function storeScanResults(results, storage = browserStorage()) {
  try {
    const saved = Object.fromEntries([...results].filter(([resultKey, entry]) => SCAN_RESULT_KEY.test(resultKey) && storableScanEntry(entry)));
    storage?.setItem(SCAN_RESULTS_KEY, JSON.stringify(saved));
  } catch {
    // Keep the latest results for this session when browser storage is unavailable or full.
  }
}

export function failedScanEntry(previous, error) {
  return previous?.status === 'success'
    ? { ...previous, refreshFailed: true }
    : { status: 'error', error };
}

const node = (tag, className, text) => {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
};

const money = (value, maximumFractionDigits = 0) => value == null ? '—' : new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits,
}).format(value);
const marketPrice = (value) => money(value, 2);
const percent = (value) => value == null ? '—' : new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 2 }).format(value);
const number = (value, digits = 2) => value == null ? '—' : Number(value).toLocaleString('en-US', { maximumFractionDigits: digits });
const percentagePoints = (value, digits = 2) => value == null ? '—' : `${Number(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
const compactDate = (value) => value ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`)) : '—';
export const marketDateTime = (value) => value ? `${new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
}).format(new Date(value))} ET` : '—';
const sentence = (value) => String(value ?? '').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
const exchangeLabel = (instrument) => instrument.exchange && instrument.exchange !== 'United States' ? instrument.exchange : '';
const EXCLUSION_LABELS = {
  dte: 'expiration window', moneyness: 'strike range', in_the_money: 'in-the-money contracts',
  invalid_quote: 'usable quotes', spread: 'bid-ask spread', open_interest: 'open interest', volume: 'volume',
  open_interest_unavailable: 'available open-interest data', volume_unavailable: 'available volume data',
  stale_quote: 'quote freshness', insufficient_cash: 'available cash', insufficient_shares: 'share coverage',
  max_net_purchase_price: 'maximum breakeven price', min_net_sale_price: 'minimum sale price',
  delta_low: 'delta range', delta_high: 'delta range', period_return: 'term return',
};

export function candidateHeadline(candidate) {
  return `${money(candidate.net_contract_credit)} net credit`;
}

export function candidateReturnCaption(candidate) {
  const days = Number(candidate.dte);
  const term = Number.isFinite(days) ? `${days}-day ` : '';
  return `Estimated ${term}return on capital: ${percent(candidate.period_return)}`;
}

function glossaryLabel(label, term) {
  return createGlossaryTerm(label, term, 'radar-glossary-label');
}

export function exclusionSummary(exclusions = {}) {
  const labels = Object.entries(exclusions)
    .filter(([, count]) => count > 0)
    .sort(([, left], [, right]) => right - left)
    .map(([reason]) => EXCLUSION_LABELS[reason] ?? sentence(reason).toLowerCase());
  return [...new Set(labels)].slice(0, 3);
}

export function providerName(provider) {
  if (provider === 'yfinance') return 'Yahoo Finance';
  return sentence(provider);
}

export function targetIdentity(target, savedIdentity = null) {
  return {
    name: String(savedIdentity?.name || target.name || '').trim(),
    instrumentType: String(savedIdentity?.instrumentType || savedIdentity?.instrument_type ||
      target.instrumentType || target.instrument_type || '').trim(),
  };
}

export function exactInstrumentIdentity(matches, symbol) {
  const match = matches?.find((instrument) => instrument.symbol === symbol);
  if (!match?.name || !match?.instrument_type) return null;
  return { name: match.name, instrumentType: match.instrument_type };
}

export async function hydrateTargetIdentities(targets, request, getTickerIdentity, identities = new Map()) {
  await Promise.all(targets.map(async (target) => {
    if (identities.has(target.symbol)) return;
    const current = targetIdentity(target, getTickerIdentity?.(target.symbol));
    if (current.name && current.instrumentType) {
      identities.set(target.symbol, current);
      return;
    }
    try {
      const response = await request(`/api/v1/screens/instruments?query=${encodeURIComponent(target.symbol)}`);
      const identity = exactInstrumentIdentity(response.matches, target.symbol);
      if (identity) identities.set(target.symbol, identity);
    } catch {
      // Keep the ticker mark on its own when identity lookup is temporarily unavailable.
    }
  }));
  return identities;
}

function rulesSummary(rules) {
  const anyDelta = rules.targetDeltaMin == null && rules.targetDeltaMax == null;
  const summary = node('span', 'monitor-rule-terms');
  summary.append(
    document.createTextNode(`${rules.minDte}–${rules.maxDte} `),
    glossaryLabel('DTE', 'DTE range'),
    document.createTextNode(' · '),
    document.createTextNode(anyDelta ? 'any ' : `${rules.targetDeltaMin ?? 0}–${rules.targetDeltaMax ?? 1} `),
    glossaryLabel(anyDelta ? 'delta' : '|Δ|', 'Target delta range'),
    document.createTextNode(' · '),
    document.createTextNode(`≥ ${percent(rules.minPeriodReturn)} `),
    glossaryLabel('term return', 'Minimum return'),
  );
  return summary;
}

function priceGuardText(effective) {
  if (effective.priceGuard.valueMinor == null) return 'No net price guard';
  const price = marketPrice(effective.priceGuard.valueMinor / 100);
  return effective.leg === 'coveredCall' ? `Net sale at least ${price}` : `Breakeven at most ${price}`;
}

function trashIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('ui-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const pathData of ['M4.5 7h15', 'M9 3.75h6l1 3.25H8l1-3.25Z', 'm7 7 .8 12.25h8.4L17 7', 'M10 10.5v5.5M14 10.5v5.5']) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathData);
    svg.append(path);
  }
  return svg;
}

function detailRow(label, value, term) {
  if (value == null || value === '—') return null;
  const row = node('div', 'candidate-detail-row');
  const metricName = node('dt');
  metricName.append(glossaryLabel(label, term));
  row.append(metricName, node('dd', '', value));
  return row;
}

function detailSection(title, rows) {
  const presentRows = rows.filter(Boolean);
  if (!presentRows.length) return null;
  const section = node('section', 'candidate-analysis-section');
  section.append(node('h4', '', title));
  const metrics = node('dl', 'candidate-detail-grid');
  metrics.append(...presentRows);
  section.append(metrics);
  return section;
}

function whyTrade(reasons) {
  const section = node('section', 'candidate-why');
  section.append(node('p', 'candidate-analysis-eyebrow', 'Why this trade?'));
  const list = node('ul', 'candidate-reason-list');
  for (const reason of reasons) {
    const item = node('li', `candidate-reason is-${reason.tone}`);
    item.append(node('span', 'candidate-reason-mark'), node('div'));
    item.lastChild.append(node('strong', '', reason.title), node('p', '', reason.message));
    list.append(item);
  }
  section.append(list);
  return section;
}

function fitLabel(label) {
  return `${sentence(label)} fit`;
}

function liquidityLabel(label) {
  return label === 'unknown' ? 'Unknown liquidity' : `${sentence(label)} liquidity`;
}

function candidateCard(viewModel) {
  const candidate = viewModel.rawMetrics;
  const card = document.createElement('details');
  card.className = 'candidate-card';
  card.dataset.fit = viewModel.strategyFit.label;
  const summary = document.createElement('summary');
  const header = node('div', 'candidate-header');
  header.append(node('span', 'candidate-match', `#${viewModel.rank} match`), node('div', 'candidate-contract'));
  header.lastChild.append(
    node('strong', '', `${viewModel.symbol} ${marketPrice(viewModel.strike)} ${sentence(viewModel.optionType)}`),
    node('small', '', `${compactDate(viewModel.expiration)} · ${viewModel.dte} DTE`),
  );

  const reward = node('div', 'candidate-reward');
  const credit = node('div', 'candidate-reward-metric');
  credit.append(node('strong', '', money(viewModel.reward.netCredit)), glossaryLabel('Credit', 'Net contract credit'));
  const roc = node('div', 'candidate-reward-metric is-roc');
  roc.append(node('strong', '', percentagePoints(viewModel.reward.roc)), glossaryLabel('ROC', 'Return on capital'));
  reward.append(credit, roc);

  const signals = node('div', 'candidate-signals');
  const delta = node('span', 'candidate-signal');
  delta.append(node('strong', '', viewModel.risk.delta == null ? '—' : number(viewModel.risk.delta)), glossaryLabel('Δ', 'Delta'));
  const cushion = node('span', 'candidate-signal');
  cushion.append(node('strong', '', viewModel.risk.strikeDistanceLabel));
  const execution = node('span', `candidate-signal candidate-liquidity is-${viewModel.execution.liquidityLabel}`);
  execution.append(node('i'), node('strong', '', liquidityLabel(viewModel.execution.liquidityLabel)));
  signals.append(delta, cushion, execution);

  const fit = node('div', `candidate-fit is-${viewModel.strategyFit.label}`);
  const fitHeading = node('div');
  fitHeading.append(node('i'), node('strong', '', fitLabel(viewModel.strategyFit.label)));
  fit.append(fitHeading, node('p', '', viewModel.strategyFit.summary));

  const disclosure = node('span', 'candidate-disclosure');
  disclosure.append(node('span', 'candidate-disclosure-label', 'View analysis'), node('i'));
  summary.append(header, reward, signals, fit, disclosure);

  const detail = node('div', 'candidate-detail');
  const sections = [
    whyTrade(viewModel.reasons),
    detailSection('Contract metrics', [
      detailRow('Bid / ask', candidate.bid == null || candidate.ask == null ? null : `${marketPrice(candidate.bid)} / ${marketPrice(candidate.ask)}`, 'Executable option price'),
      detailRow('Spread', viewModel.execution.factors.spread.value == null ? null : percentagePoints(viewModel.execution.factors.spread.value, 2), 'Bid-ask spread'),
      detailRow('Market activity', candidate.open_interest == null || candidate.volume == null ? null : `${number(candidate.open_interest, 0)} OI · ${number(candidate.volume, 0)} volume`, 'Open interest / volume'),
      detailRow('Estimated fees', candidate.estimated_fees == null ? null : money(candidate.estimated_fees, 2), 'Estimated fee'),
      detailRow('Capital required', money(viewModel.reward.capitalRequired), 'Capital required'),
      detailRow('Annualized return', percentagePoints(viewModel.reward.annualizedReturn, 1), 'Annualized return'),
      detailRow('Implied volatility', candidate.implied_volatility == null ? null : percent(candidate.implied_volatility), 'Implied volatility'),
      detailRow('Theta per day', candidate.theta_per_day == null ? null : number(candidate.theta_per_day, 4), 'Theta per day'),
      detailRow('Gamma', candidate.gamma == null ? null : number(candidate.gamma, 4), 'Gamma'),
      detailRow('Vega', candidate.vega == null ? null : number(candidate.vega, 4), 'Vega'),
    ]),
  ].filter(Boolean);
  detail.append(...sections);
  card.append(summary, detail);
  return card;
}

function scanResultView(entry) {
  const container = node('div', 'leg-results');
  if (!entry) {
    container.append(node('p', 'leg-empty', 'Ready when you are. Scan for matching contracts.'));
    return container;
  }
  if (entry.status === 'loading') {
    container.append(node('p', 'leg-empty is-loading', 'Checking the option chain…'));
    return container;
  }
  if (entry.status === 'error') {
    const unavailable = node('section', 'scan-empty is-error');
    unavailable.append(node('strong', '', 'Scan unavailable'), node('p', '', 'Quotes could not be loaded. Try again in a moment.'));
    container.append(unavailable);
    return container;
  }
  const result = entry.result;
  if (entry.refreshFailed) {
    container.append(node('p', 'scan-history-warning', 'Latest scan unavailable. Showing the previous result.'));
  }
  const source = node('div', 'scan-source');
  source.append(node('time', '', marketDateTime(result.quote_timestamp)), node('small', '', providerName(result.provider)));
  if (result.quote_timestamp) source.firstChild.dateTime = result.quote_timestamp;
  container.append(source);
  if (!result.candidates.length) {
    const noMatch = node('section', 'scan-empty');
    noMatch.append(node('strong', '', 'No match right now'), node('p', '', "The available contracts did not fit this ticker's monitoring rules. Scan again later or adjust its settings."));
    const filters = exclusionSummary(result.exclusions);
    if (filters.length) noMatch.append(node('small', '', `Main filters: ${filters.join(', ')}.`));
    container.append(noMatch);
    return container;
  }
  prepareRadarCandidates(result).forEach((candidate) => container.append(candidateCard(candidate)));
  return container;
}

export function legForGoal(goal, incomeLeg = 'cashSecuredPut') {
  if (goal === 'income') return GOAL_LEGS.income.includes(incomeLeg) ? incomeLeg : null;
  return GOAL_LEGS[goal]?.[0] ?? null;
}

export function createScreenerController({ request, notify, addTicker, removeTicker, rememberTicker, getTickerIdentity, openSettings, stockPriceTag, storage }) {
  const resultStorage = storage === undefined ? browserStorage() : storage;
  const state = { targets: [], results: loadStoredScanResults(resultStorage), loading: new Set(), loaded: false,
    removing: new Set(), collapsed: new Set(), seenTargets: new Set(), identities: new Map(),
    selectedInstrument: null, searchSequence: 0, searchTimer: null };
  const key = (symbol, leg) => `${symbol}:${leg}`;

  function syncDefaultCollapsedTargets() {
    const current = new Set(state.targets.map((target) => target.symbol));
    for (const target of state.targets) {
      if (!state.seenTargets.has(target.symbol)) {
        state.seenTargets.add(target.symbol);
        state.collapsed.add(target.symbol);
      }
    }
    for (const symbol of state.seenTargets) {
      if (!current.has(symbol)) {
        state.seenTargets.delete(symbol);
        state.collapsed.delete(symbol);
      }
    }
  }

  function pruneStoredResults() {
    const eligible = new Set(state.targets.flatMap((target) => target.legs.map((leg) => key(target.symbol, leg.leg))));
    let changed = false;
    for (const resultKey of state.results.keys()) {
      if (!eligible.has(resultKey)) {
        state.results.delete(resultKey);
        changed = true;
      }
    }
    if (changed) storeScanResults(state.results, resultStorage);
  }

  function targetCard(target) {
    const card = node('article', 'monitor-target');
    const { name: instrumentName, instrumentType } = targetIdentity(target,
      state.identities.get(target.symbol) ?? getTickerIdentity?.(target.symbol));
    const accessibleName = instrumentName || target.symbol;
    const bodyId = `monitor-target-${target.symbol.replace(/[^A-Z0-9]/gi, '-').toLowerCase()}-body`;
    const collapsed = state.collapsed.has(target.symbol);
    const header = node('header', 'monitor-target-header');
    const toggle = node('button', 'monitor-target-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-controls', bodyId);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${accessibleName}`);
    const identity = node('div', 'monitor-target-identity');
    identity.append(node('span', 'monitor-symbol-mark', target.symbol), node('div', 'monitor-target-copy'));
    if (instrumentName) identity.lastChild.append(node('strong', '', instrumentName));
    const meta = node('div', 'monitor-target-meta');
    if (instrumentType) meta.append(node('small', 'monitor-instrument-type', instrumentType));
    meta.append(stockPriceTag(target.stockPrice));
    identity.lastChild.append(meta);
    const badges = node('span', 'target-badges');
    if (target.owned) badges.append(node('i', '', `${target.uncoveredLots} uncovered lot${target.uncoveredLots === 1 ? '' : 's'}`));
    if (badges.childElementCount) identity.lastChild.append(badges);
    toggle.append(identity);
    header.append(toggle);
    const body = node('div', 'monitor-target-body');
    body.id = bodyId;
    body.hidden = collapsed;
    card.classList.toggle('is-collapsed', collapsed);
    toggle.addEventListener('click', () => {
      const nextCollapsed = !state.collapsed.has(target.symbol);
      if (nextCollapsed) state.collapsed.add(target.symbol);
      else state.collapsed.delete(target.symbol);
      card.classList.toggle('is-collapsed', nextCollapsed);
      body.hidden = nextCollapsed;
      toggle.setAttribute('aria-expanded', String(!nextCollapsed));
      toggle.setAttribute('aria-label', `${nextCollapsed ? 'Expand' : 'Collapse'} ${accessibleName}`);
    });
    if (target.manuallyTracked && !target.owned) {
      const removing = state.removing.has(target.symbol);
      const remove = node('button', `monitor-remove-button${removing ? ' is-removing' : ''}`);
      remove.append(removing ? document.createTextNode('…') : trashIcon());
      remove.type = 'button';
      remove.disabled = removing;
      remove.setAttribute('aria-label', `Remove ${target.symbol} from Radar`);
      remove.title = `Remove ${target.symbol} from Radar`;
      let confirming = false;
      let confirmTimer;
      const resetConfirmation = () => {
        confirming = false;
        remove.classList.remove('is-confirming');
        remove.replaceChildren(trashIcon());
        remove.setAttribute('aria-label', `Remove ${target.symbol} from Radar`);
      };
      remove.addEventListener('click', () => {
        if (!confirming) {
          confirming = true;
          remove.classList.add('is-confirming');
          remove.textContent = 'Are you sure?';
          remove.setAttribute('aria-label', `Confirm removal of ${target.symbol}`);
          clearTimeout(confirmTimer);
          confirmTimer = setTimeout(resetConfirmation, 4000);
          return;
        }
        clearTimeout(confirmTimer);
        removeTarget(target.symbol);
      });
      remove.addEventListener('blur', () => { if (confirming) resetConfirmation(); });
      header.append(remove);
    }
    for (const targetLeg of target.legs) {
      const leg = node('section', 'monitor-leg');
      const heading = node('div', 'monitor-leg-heading');
      const copy = node('div', 'monitor-leg-copy');
      const ruleSummary = node('small', 'monitor-leg-rule');
      const goal = node('span', 'goal-inline goal-tone', GOAL_LABELS[targetLeg.goal] ?? 'Goal profile');
      if (targetLeg.goal) goal.dataset.goal = targetLeg.goal;
      ruleSummary.append(goal, document.createTextNode(' · '), rulesSummary(targetLeg.effectiveSettings.rules));
      copy.append(node('strong', '', LEG_LABELS[targetLeg.leg]), ruleSummary, node('small', 'price-guard-copy', priceGuardText(targetLeg.effectiveSettings)));
      const scan = node('button', 'scan-target-button', state.loading.has(key(target.symbol, targetLeg.leg)) ? 'Scanning…' : 'Scan');
      scan.type = 'button';
      scan.disabled = state.loading.has(key(target.symbol, targetLeg.leg));
      scan.addEventListener('click', () => scanTarget(target.symbol, targetLeg.leg));
      heading.append(copy, scan);
      leg.append(heading, scanResultView(state.results.get(key(target.symbol, targetLeg.leg))));
      body.append(leg);
    }
    card.append(header, body);
    return card;
  }

  function render() {
    const owned = document.querySelector('#owned-monitor-targets');
    const tracked = document.querySelector('#tracked-monitor-targets');
    if (!owned || !tracked) return;
    owned.replaceChildren(); tracked.replaceChildren();
    const ownedTargets = state.targets.filter((target) => target.owned);
    const trackedOnly = state.targets.filter((target) => target.manuallyTracked && !target.owned);
    document.querySelector('#owned-monitor-count').textContent = String(ownedTargets.length);
    document.querySelector('#tracked-monitor-count').textContent = String(trackedOnly.length);
    document.querySelector('#owned-monitor-group').hidden = ownedTargets.length === 0;
    ownedTargets.forEach((target) => owned.append(targetCard(target)));
    if (!trackedOnly.length) tracked.append(node('p', 'monitor-empty', 'No tracked tickers yet. Use + to add one.'));
    else trackedOnly.forEach((target) => tracked.append(targetCard(target)));
  }

  async function loadTargets(force = false) {
    if (state.loaded && !force) return;
    try {
      const result = await request('/api/v1/screens/targets');
      state.targets = result.targets;
      syncDefaultCollapsedTargets();
      pruneStoredResults();
      await hydrateTargetIdentities(state.targets, request, getTickerIdentity, state.identities);
      state.loaded = true;
      const notice = document.querySelector('#screener-meta');
      notice.hidden = !result.freshness?.stale;
      notice.textContent = result.freshness?.stale ? 'Portfolio data is stale. Refresh Home before relying on share or cash coverage.' : '';
      notice.className = 'monitor-notice is-caution';
      render();
    } catch (error) {
      const notice = document.querySelector('#screener-meta');
      notice.hidden = false;
      notice.textContent = `Targets could not be loaded: ${error.message}`;
      notice.className = 'monitor-notice is-error';
    }
  }

  async function scanAll() {
    await loadTargets(true);
    const scanKeys = state.targets.flatMap((target) => target.legs.map((leg) => key(target.symbol, leg.leg)));
    const previousResults = new Map(scanKeys.map((scanKey) => [scanKey, state.results.get(scanKey)]));
    for (const scanKey of scanKeys) {
      state.loading.add(scanKey);
      state.results.set(scanKey, { status: 'loading' });
    }
    render();
    try {
      const scan = await request('/api/v1/screens/scan-all', { method: 'POST' });
      await applyScan(scan, previousResults);
      return scan;
    } catch (error) {
      for (const scanKey of scanKeys) state.results.set(scanKey, failedScanEntry(previousResults.get(scanKey), error));
      throw error;
    } finally {
      for (const scanKey of scanKeys) state.loading.delete(scanKey);
      pruneStoredResults();
      storeScanResults(state.results, resultStorage);
      render();
    }
  }

  async function applyScan(scan, previousResults = state.results) {
    if (!scan || !Array.isArray(scan.targets) || !Array.isArray(scan.results)) return;
      state.targets = scan.targets;
      syncDefaultCollapsedTargets();
      await hydrateTargetIdentities(state.targets, request, getTickerIdentity, state.identities);
      for (const entry of scan.results) {
        const target = state.targets.find((item) => item.symbol === entry.symbol);
        const entryKey = key(entry.symbol, entry.leg);
        if (entry.status === 'success' && target && entry.result.underlying_price != null) {
          target.stockPrice = entry.result.underlying_price;
        }
        state.results.set(entryKey, entry.status === 'success'
          ? { status: 'success', result: entry.result }
          : failedScanEntry(previousResults.get(entryKey), entry.error));
      }
      state.loaded = true;
      pruneStoredResults();
      storeScanResults(state.results, resultStorage);
      render();
  }

  async function scanTarget(symbol, leg) {
    await loadTargets();
    const target = state.targets.find((item) => item.symbol === symbol && item.legs.some((itemLeg) => itemLeg.leg === leg));
    if (!target || state.loading.has(key(symbol, leg))) return;
    const scanKey = key(symbol, leg);
    const previous = state.results.get(scanKey);
    state.loading.add(scanKey);
    state.results.set(scanKey, { status: 'loading' });
    render();
    try {
      const result = await request('/api/v1/screens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbol, leg }) });
      if (result.underlying_price != null) target.stockPrice = result.underlying_price;
      state.results.set(scanKey, { status: 'success', result });
    } catch (error) {
      state.results.set(scanKey, failedScanEntry(previous, error));
      notify(previous?.status === 'success'
        ? 'Latest scan unavailable. The previous result is still shown.'
        : 'Scan unavailable. Try again when quotes are available.', 'error');
    } finally {
      state.loading.delete(scanKey);
      storeScanResults(state.results, resultStorage);
      render();
    }
  }

  async function removeTarget(symbol) {
    if (state.removing.has(symbol)) return;
    state.removing.add(symbol);
    render();
    try {
      await removeTicker(symbol);
      for (const resultKey of [...state.results.keys()]) if (resultKey.startsWith(`${symbol}:`)) state.results.delete(resultKey);
      storeScanResults(state.results, resultStorage);
      state.targets = state.targets
        .filter((target) => target.symbol !== symbol || target.owned)
        .map((target) => target.symbol === symbol ? { ...target, manuallyTracked: false } : target);
      syncDefaultCollapsedTargets();
    } catch (error) {
      notify(`Ticker was not removed: ${error.message}`, 'error');
    } finally {
      state.removing.delete(symbol);
      render();
    }
  }

  function renderGoals() {
    const tabs = document.querySelector('#monitor-goal-tabs');
    const previous = tabs.querySelector('input[name="goal"]:checked')?.value;
    const goals = Object.keys(GOAL_LABELS);
    tabs.replaceChildren(...goals.map((goal, index) => {
      const label = node('label', 'monitor-goal-option');
      const input = document.createElement('input');
      input.type = 'radio'; input.name = 'goal'; input.value = goal;
      input.checked = goals.includes(previous) ? goal === previous : goal === 'acquire';
      const copy = node('span', 'goal-chip', GOAL_LABELS[goal]);
      copy.dataset.goal = goal;
      label.append(input, copy);
      return label;
    }));
    document.querySelector('#monitor-leg-picker').hidden = tabs.querySelector('input[name="goal"]:checked')?.value !== 'income';
  }

  function selectInstrument(instrument) {
    state.selectedInstrument = instrument;
    const input = document.querySelector('#screener-add-symbol');
    const results = document.querySelector('#instrument-search-results');
    clearTimeout(state.searchTimer);
    state.searchSequence += 1;
    input.value = instrument.symbol;
    input.setAttribute('aria-expanded', 'false');
    results.hidden = true;
    results.replaceChildren();
    const exchange = exchangeLabel(instrument);
    document.querySelector('#instrument-search-status').textContent = `${instrument.name} · ${instrument.instrument_type}${exchange ? ` · ${exchange}` : ''}`;
    document.querySelector('#monitor-add-submit').disabled = false;
    input.blur();
  }

  async function searchInstruments(query, sequence) {
    const status = document.querySelector('#instrument-search-status');
    const results = document.querySelector('#instrument-search-results');
    status.textContent = 'Checking instruments…';
    try {
      const response = await request(`/api/v1/screens/instruments?query=${encodeURIComponent(query)}`);
      if (sequence !== state.searchSequence) return;
      results.replaceChildren();
      if (!response.matches.length) {
        results.hidden = true;
        status.textContent = 'No verified stocks, ETFs, or mutual funds found.';
        return;
      }
      const exact = query.toUpperCase();
      const matches = response.matches.slice().sort((a, b) => Number(b.symbol === exact) - Number(a.symbol === exact));
      for (const instrument of matches) {
        const exchange = exchangeLabel(instrument);
        const option = node('button', 'instrument-result');
        option.type = 'button'; option.setAttribute('role', 'option');
        option.append(node('strong', '', instrument.symbol), node('span', '', instrument.name),
          node('small', '', `${instrument.instrument_type}${exchange ? ` · ${exchange}` : ''}`));
        option.addEventListener('click', () => selectInstrument(instrument));
        results.append(option);
      }
      results.hidden = false;
      document.querySelector('#screener-add-symbol').setAttribute('aria-expanded', 'true');
      status.textContent = `${response.matches.length} verified match${response.matches.length === 1 ? '' : 'es'}. Select one to continue.`;
    } catch (error) {
      if (sequence !== state.searchSequence) return;
      results.hidden = true;
      status.textContent = error.status === 404
        ? 'Ticker lookup is not loaded. Restart Wheely Nilly and try again.'
        : 'Ticker search is unavailable right now. Check your connection and try again.';
    }
  }

  function resetAddForm() {
    const form = document.querySelector('#screener-add-ticker');
    form.reset();
    state.selectedInstrument = null;
    state.searchSequence += 1;
    clearTimeout(state.searchTimer);
    document.querySelector('#instrument-search-results').hidden = true;
    document.querySelector('#instrument-search-status').textContent = 'Type a symbol or company name.';
    document.querySelector('#monitor-add-error').hidden = true;
    document.querySelector('#monitor-add-submit').disabled = true;
    document.querySelector('#screener-add-symbol').setAttribute('aria-expanded', 'false');
    renderGoals();
  }

  function openAdd() {
    resetAddForm();
    const overlay = document.querySelector('#monitor-add-dialog');
    overlay.hidden = false;
    document.querySelector('main')?.setAttribute('inert', '');
    document.querySelector('.bottom-nav')?.setAttribute('inert', '');
    document.body.classList.add('has-modal');
    document.querySelector('#open-monitor-add').setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => { overlay.classList.add('is-open'); document.querySelector('#screener-add-symbol').focus(); });
  }

  function closeAdd() {
    const overlay = document.querySelector('#monitor-add-dialog');
    overlay.classList.remove('is-open');
    document.querySelector('main')?.removeAttribute('inert');
    document.querySelector('.bottom-nav')?.removeAttribute('inert');
    document.body.classList.remove('has-modal');
    document.querySelector('#open-monitor-add').setAttribute('aria-expanded', 'false');
    setTimeout(() => { overlay.hidden = true; document.querySelector('#open-monitor-add').focus(); }, 220);
  }

  function keepFocusInAddDialog(event) {
    if (event.key === 'Escape') { closeAdd(); return; }
    if (event.key !== 'Tab') return;
    const dialog = document.querySelector('#monitor-add-dialog');
    const focusable = [...dialog.querySelectorAll('button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), select:not([disabled])')]
      .filter((element) => !element.closest('[hidden]'));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function initialize() {
    document.querySelector('#open-monitor-add').addEventListener('click', openAdd);
    document.querySelector('#monitor-open-settings').addEventListener('click', openSettings);
    for (const close of document.querySelectorAll('[data-monitor-add-close]')) close.addEventListener('click', closeAdd);
    document.querySelector('#monitor-add-dialog').addEventListener('keydown', keepFocusInAddDialog);
    document.querySelector('#monitor-goal-tabs').addEventListener('change', (event) => {
      if (event.target.name === 'goal') document.querySelector('#monitor-leg-picker').hidden = event.target.value !== 'income';
    });
    document.querySelector('#screener-add-symbol').addEventListener('input', (event) => {
      state.selectedInstrument = null;
      document.querySelector('#monitor-add-submit').disabled = true;
      clearTimeout(state.searchTimer);
      const query = event.currentTarget.value.trim();
      const sequence = ++state.searchSequence;
      document.querySelector('#instrument-search-results').hidden = true;
      if (!query) {
        document.querySelector('#instrument-search-status').textContent = 'Type a symbol or company name.';
        return;
      }
      document.querySelector('#instrument-search-status').textContent = 'Waiting for you to pause typing…';
      state.searchTimer = setTimeout(() => searchInstruments(query, sequence), 250);
    });
    document.querySelector('#screener-add-ticker').addEventListener('submit', async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      const error = document.querySelector('#monitor-add-error');
      if (!state.selectedInstrument || state.selectedInstrument.symbol !== values.symbol.trim().toUpperCase()) {
        error.textContent = 'Select a verified instrument from the results.'; error.hidden = false; return;
      }
      const leg = legForGoal(values.goal, values.leg);
      if (!leg) {
        error.textContent = 'Choose CC or CSP for Earn Income.'; error.hidden = false; return;
      }
      const submit = document.querySelector('#monitor-add-submit');
      submit.disabled = true; submit.textContent = 'Adding…'; error.hidden = true;
      try {
        await addTicker(state.selectedInstrument.symbol, leg, values.goal);
        rememberTicker(state.selectedInstrument, leg === 'cashSecuredPut' ? 'cash_secured_put' : 'covered_call');
        await loadTargets(true);
        closeAdd();
      } catch (addError) {
        error.textContent = `Ticker was not added: ${addError.message}`; error.hidden = false; submit.disabled = false;
      } finally {
        submit.textContent = 'Add to Radar';
      }
    });
    document.addEventListener('strategy-settings-saved', () => loadTargets(true));
    document.addEventListener('wheely-radar-updated', (event) => {
      void applyScan(event.detail).catch(() => undefined);
    });
    loadTargets();
  }

  return { initialize, loadTargets, scanTarget, scanAll };
}
