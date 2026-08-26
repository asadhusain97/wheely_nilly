const LEG_LABELS = { coveredCall: 'Covered call', cashSecuredPut: 'Cash-secured put' };
const GOAL_LABELS = { protect: 'Protect', income: 'Income', exit: 'Exit', acquire: 'Acquire' };

const node = (tag, className, text) => {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
};

const money = (value) => value == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
const percent = (value) => value == null ? '—' : new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 2 }).format(value);
const number = (value, digits = 2) => value == null ? '—' : Number(value).toLocaleString('en-US', { maximumFractionDigits: digits });
const dateTime = (value) => value ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : '—';
const sentence = (value) => String(value ?? '').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
const exchangeLabel = (instrument) => instrument.exchange && instrument.exchange !== 'United States' ? instrument.exchange : '';
const EXCLUSION_LABELS = {
  dte: 'expiration window', moneyness: 'strike range', in_the_money: 'in-the-money contracts',
  invalid_quote: 'usable quotes', spread: 'bid-ask spread', open_interest: 'open interest', volume: 'volume',
  open_interest_unavailable: 'available open-interest data', volume_unavailable: 'available volume data',
  stale_quote: 'quote freshness', insufficient_cash: 'available cash', insufficient_shares: 'share coverage',
  max_net_purchase_price: 'maximum purchase price', min_net_sale_price: 'minimum sale price',
  delta_low: 'delta range', delta_high: 'delta range', period_return: 'term return',
};

export function candidateHeadline(candidate) {
  return `${money(candidate.net_contract_credit)} net credit`;
}

function metric(label, value, note = '') {
  const item = node('div', 'monitor-metric');
  item.append(node('dt', '', label), node('dd', '', value));
  if (note) item.append(node('small', '', note));
  return item;
}

export function exclusionSummary(exclusions = {}) {
  const labels = Object.entries(exclusions)
    .filter(([, count]) => count > 0)
    .sort(([, left], [, right]) => right - left)
    .map(([reason]) => EXCLUSION_LABELS[reason] ?? sentence(reason).toLowerCase());
  return [...new Set(labels)].slice(0, 3);
}

export function providerName(provider) {
  return provider === 'yfinance' ? 'Yahoo Finance' : sentence(provider);
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

function rulesText(rules) {
  const delta = rules.targetDeltaMin == null && rules.targetDeltaMax == null ? 'any delta' : `${rules.targetDeltaMin ?? 0}–${rules.targetDeltaMax ?? 1} |Δ|`;
  return `${rules.minDte}–${rules.maxDte} DTE · ${delta} · ≥ ${percent(rules.minPeriodReturn)} term return`;
}

function priceGuardText(effective) {
  if (effective.priceGuard.valueMinor == null) return 'No net price guard';
  const price = money(effective.priceGuard.valueMinor / 100);
  return effective.leg === 'coveredCall' ? `Net sale at least ${price}` : `Net purchase at most ${price}`;
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

function detailRow(label, value, qualifier = '') {
  const row = node('div', 'candidate-detail-row');
  row.append(node('dt', '', label), node('dd', '', value));
  if (qualifier) row.append(node('small', '', qualifier));
  return row;
}

function candidateCard(candidate, result, rank) {
  const card = document.createElement('details');
  card.className = 'candidate-card';
  const summary = document.createElement('summary');
  const identity = node('div', 'candidate-identity');
  identity.append(node('span', 'candidate-rank', String(rank)), node('div', '', undefined));
  identity.lastChild.append(node('strong', '', `${result.symbol} ${money(candidate.strike)}`), node('small', '', `${candidate.expiration} · ${candidate.dte} DTE`));
  const primary = node('div', 'candidate-primary');
  primary.append(node('strong', '', candidateHeadline(candidate)), node('small', '', `${percent(candidate.period_return)} for this contract term`));
  const compact = node('dl', 'candidate-compact');
  compact.append(
    metric('Approx. |delta|', candidate.delta == null ? 'Unavailable' : number(Math.abs(candidate.delta))),
    metric(candidate.option_type === 'call' ? 'Net sale price' : 'Net purchase price', money(candidate.net_sale_price ?? candidate.net_purchase_price)),
  );
  summary.append(identity, primary, compact, node('span', 'candidate-open-label', 'Details'));

  const detail = node('div', 'candidate-detail');
  const quote = node('dl', 'candidate-detail-grid');
  quote.append(
    detailRow('Underlying price', money(candidate.underlying_price), providerName(result.provider)),
    detailRow('Executable option price', `${money(candidate.executable_option_price_per_share)} per share`, `Bid ${money(candidate.bid)} · Ask ${money(candidate.ask)}`),
    detailRow('Spread', percent(candidate.spread_percent)),
    detailRow('Open interest / volume', `${number(candidate.open_interest, 0)} / ${number(candidate.volume, 0)}`),
    detailRow('Implied volatility', percent(candidate.implied_volatility), 'Provider-derived'),
    detailRow('Theta per day', number(candidate.theta_per_day, 4), candidate.greek_source === 'unavailable' ? 'Greek unavailable' : 'Black–Scholes estimate'),
    detailRow('Breakeven', money(candidate.breakeven)),
    detailRow('Strike distance', percent(Math.abs(candidate.strike_distance))),
    detailRow('Annualized return', percent(candidate.annualized_return), 'Secondary metric'),
    detailRow('Estimated fees', money(candidate.estimated_fees), 'Estimate'),
  );
  detail.append(quote);
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
  const source = node('div', 'scan-source');
  source.append(node('time', '', dateTime(result.quote_timestamp)), node('small', '', providerName(result.provider)));
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
  result.candidates.forEach((candidate, index) => container.append(candidateCard(candidate, result, index + 1)));
  return container;
}

export function goalsForLeg(leg) {
  return leg === 'coveredCall' ? ['income', 'protect', 'exit'] : ['acquire', 'income'];
}

export function createScreenerController({ request, notify, addTicker, removeTicker, rememberTicker, getTickerIdentity, openSettings }) {
  const state = { targets: [], results: new Map(), epoch: 0, loading: new Set(), scanAll: false, loaded: false,
    removing: new Set(), collapsed: new Set(), identities: new Map(), selectedInstrument: null, searchSequence: 0, searchTimer: null };
  const key = (symbol, leg) => `${symbol}:${leg}`;

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
    if (instrumentType) identity.lastChild.append(node('small', 'monitor-instrument-type', instrumentType));
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
      const goal = node('span', 'goal-inline goal-tone', GOAL_LABELS[targetLeg.goal] ?? 'Defaults');
      if (targetLeg.goal) goal.dataset.goal = targetLeg.goal;
      ruleSummary.append(goal, document.createTextNode(` · ${rulesText(targetLeg.effectiveSettings.rules)}`));
      copy.append(node('strong', '', LEG_LABELS[targetLeg.leg]), ruleSummary, node('small', 'price-guard-copy', priceGuardText(targetLeg.effectiveSettings)));
      const scan = node('button', 'scan-target-button', state.loading.has(key(target.symbol, targetLeg.leg)) ? 'Scanning…' : 'Scan');
      scan.type = 'button';
      scan.disabled = state.scanAll || state.loading.has(key(target.symbol, targetLeg.leg));
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
    const scanAll = document.querySelector('#scan-all');
    scanAll.disabled = state.scanAll || !state.targets.length;
    scanAll.textContent = state.scanAll ? 'Scanning…' : 'Scan all';
  }

  async function loadTargets(force = false) {
    if (state.loaded && !force) return;
    try {
      const result = await request('/api/v1/screens/targets');
      state.targets = result.targets;
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

  async function scanTarget(symbol, leg) {
    await loadTargets();
    const target = state.targets.find((item) => item.symbol === symbol && item.legs.some((itemLeg) => itemLeg.leg === leg));
    if (!target || state.scanAll || state.loading.has(key(symbol, leg))) return;
    const epoch = state.epoch;
    state.loading.add(key(symbol, leg));
    state.results.set(key(symbol, leg), { status: 'loading' });
    render();
    try {
      const result = await request('/api/v1/screens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbol, leg }) });
      if (epoch !== state.epoch) return;
      state.results.set(key(symbol, leg), { status: 'success', result });
    } catch (error) {
      if (epoch !== state.epoch) return;
      state.results.set(key(symbol, leg), { status: 'error', error });
    } finally {
      state.loading.delete(key(symbol, leg));
      if (epoch === state.epoch) render();
    }
  }

  async function removeTarget(symbol) {
    if (state.removing.has(symbol)) return;
    state.removing.add(symbol);
    render();
    try {
      await removeTicker(symbol);
      for (const resultKey of [...state.results.keys()]) if (resultKey.startsWith(`${symbol}:`)) state.results.delete(resultKey);
      state.targets = state.targets
        .filter((target) => target.symbol !== symbol || target.owned)
        .map((target) => target.symbol === symbol ? { ...target, manuallyTracked: false } : target);
    } catch (error) {
      notify(`Ticker was not removed: ${error.message}`, 'error');
    } finally {
      state.removing.delete(symbol);
      render();
    }
  }

  async function scanAll() {
    if (state.scanAll) return;
    await loadTargets();
    const epoch = ++state.epoch;
    state.scanAll = true;
    for (const target of state.targets) for (const leg of target.legs) state.results.set(key(target.symbol, leg.leg), { status: 'loading' });
    render();
    try {
      const response = await request('/api/v1/screens/scan-all', { method: 'POST' });
      if (epoch !== state.epoch) return;
      state.targets = response.targets;
      for (const entry of response.results) state.results.set(key(entry.symbol, entry.leg), entry.status === 'success' ? { status: 'success', result: entry.result } : { status: 'error', error: entry.error });
    } catch (error) {
      if (epoch !== state.epoch) return;
      notify('Scan all could not be completed. Try again.', 'error');
    } finally {
      if (epoch === state.epoch) { state.scanAll = false; render(); }
    }
  }

  function renderGoals() {
    const leg = document.querySelector('input[name="leg"]:checked').value;
    const tabs = document.querySelector('#monitor-goal-tabs');
    const previous = tabs.querySelector('input[name="goal"]:checked')?.value;
    const goals = goalsForLeg(leg);
    tabs.replaceChildren(...goals.map((goal, index) => {
      const label = node('label', 'monitor-goal-option');
      const input = document.createElement('input');
      input.type = 'radio'; input.name = 'goal'; input.value = goal;
      input.checked = goals.includes(previous) ? goal === previous : index === 0;
      const copy = node('span', 'goal-chip', GOAL_LABELS[goal]);
      copy.dataset.goal = goal;
      label.append(input, copy);
      return label;
    }));
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
    document.querySelector('#scan-all').addEventListener('click', scanAll);
    document.querySelector('#open-monitor-add').addEventListener('click', openAdd);
    document.querySelector('#monitor-open-settings').addEventListener('click', openSettings);
    for (const close of document.querySelectorAll('[data-monitor-add-close]')) close.addEventListener('click', closeAdd);
    document.querySelector('#monitor-add-dialog').addEventListener('keydown', keepFocusInAddDialog);
    document.querySelectorAll('input[name="leg"]').forEach((radio) => radio.addEventListener('change', renderGoals));
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
      const submit = document.querySelector('#monitor-add-submit');
      submit.disabled = true; submit.textContent = 'Adding…'; error.hidden = true;
      try {
        await addTicker(state.selectedInstrument.symbol, values.leg, values.goal);
        rememberTicker(state.selectedInstrument, values.leg === 'cashSecuredPut' ? 'cash_secured_put' : 'covered_call');
        await loadTargets(true);
        closeAdd();
      } catch (addError) {
        error.textContent = `Ticker was not added: ${addError.message}`; error.hidden = false; submit.disabled = false;
      } finally {
        submit.textContent = 'Add to Radar';
      }
    });
    document.addEventListener('strategy-settings-saved', () => loadTargets(true));
    loadTargets();
  }

  return { initialize, loadTargets, scanTarget };
}
