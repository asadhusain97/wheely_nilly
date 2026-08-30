import { formatRollPlan } from '../../src/roll-analysis.ts';

const node = (tag, className, text) => {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
};

const price = (value) => value == null ? '—' : new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
}).format(Number(value));
const percent = (value) => value == null ? '—' : new Intl.NumberFormat('en-US', {
  style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1,
}).format(Number(value));
const date = (value) => value ? new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', timeZone: 'UTC',
}).format(new Date(`${value}T00:00:00Z`)) : '—';
const quoteTime = (value) => value ? new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
}).format(new Date(value)) + ' ET' : 'Time unavailable';

const EXCLUSIONS = {
  dte: 'expiration window', moneyness: 'strike range', in_the_money: 'money state', invalid_quote: 'usable quotes',
  spread: 'bid-ask spread', open_interest: 'open interest', volume: 'volume', stale_quote: 'quote freshness',
  open_interest_unavailable: 'open-interest data', volume_unavailable: 'volume data', delta_low: 'delta range',
  delta_high: 'delta range', period_return: 'term return',
};

function goalGuidance(goal) {
  if (goal === 'protect') return 'Keep Shares favors a higher call strike and lower assignment pressure.';
  if (goal === 'exit') return 'Plan Exit favors a call that keeps the intended sale price acceptable.';
  if (goal === 'acquire') return 'Plan Entry favors a put near the intended purchase price.';
  return 'Earn Income favors another liquid contract inside the saved income range.';
}

function strikeGuidance(profile, strategy) {
  if (profile.strikeDirection === 'higher') return 'Higher call strike';
  if (profile.strikeDirection === 'lower') return 'Near or below spot';
  if (profile.strikeDirection === 'nearSpot') return 'Near-spot put';
  return strategy === 'cc' ? 'Saved call range' : 'Saved put range';
}

function searchProfileView(profile, strategy) {
  const section = node('section', 'roll-search-profile');
  section.append(node('p', 'roll-section-eyebrow', 'At your broker, look for'));
  const grid = node('dl', 'roll-search-grid');
  const values = [
    ['Strike', strikeGuidance(profile, strategy)],
    ['Expiration', `${profile.minDte}–${profile.maxDte} DTE`],
    ['Delta', profile.deltaMin == null && profile.deltaMax == null ? 'Any delta' : `${profile.deltaMin ?? 0}–${profile.deltaMax ?? 1}`],
  ];
  for (const [label, value] of values) {
    const item = node('div');
    item.append(node('dt', '', label), node('dd', '', value));
    grid.append(item);
  }
  section.append(grid);
  if (profile.priceGuardMinor != null) {
    const copy = profile.priceGuardField === 'minNetSalePriceMinor'
      ? `Keep the effective sale price at or above ${price(profile.priceGuardMinor / 100)}.`
      : `Keep the effective purchase price at or below ${price(profile.priceGuardMinor / 100)}.`;
    section.append(node('p', 'roll-price-guard', copy));
  }
  return section;
}

function rollCash(value) {
  const amount = Number(value);
  return `${price(Math.abs(amount))} ${amount >= 0 ? 'credit' : 'debit'}`;
}

function contractBlock(label, strike, expiration, dte, optionType) {
  const block = node('div', 'roll-contract-block');
  block.append(
    node('span', 'roll-contract-label', label),
    node('strong', '', `${price(strike)} ${optionType === 'call' ? 'Call' : 'Put'}`),
    node('small', '', `${date(expiration)}${dte == null ? '' : ` · ${dte} DTE`}`),
  );
  return block;
}

function swapView(result, candidate) {
  const section = node('section', 'roll-selection');
  const rail = node('div', 'roll-swap-rail');
  rail.append(
    contractBlock('Current', result.currentStrike, result.currentExpiration, null, result.strategy === 'cc' ? 'call' : 'put'),
    node('span', 'roll-swap-arrow', '→'),
    contractBlock('Replacement', candidate.strike, candidate.expiration, candidate.dte, candidate.optionType),
  );
  const economics = node('dl', 'roll-economics');
  for (const [label, value, tone] of [
    ['Estimated roll', rollCash(candidate.naturalRollCash), candidate.naturalRollCash < 0 ? 'is-debit' : 'is-credit'],
    ['Added time', `${candidate.addedDays} days`, ''],
    [result.strategy === 'cc' ? 'Effective sale price' : 'Effective purchase price', price(candidate.effectiveAssignmentPrice), ''],
  ]) {
    const item = node('div', tone);
    item.append(node('dt', '', label), node('dd', '', value));
    economics.append(item);
  }
  section.append(rail, economics, node('p', 'roll-fit-summary', candidate.fitSummary));
  return section;
}

function candidateButton(candidate, selected, select) {
  const button = node('button', `roll-candidate${selected ? ' is-selected' : ''}`);
  button.type = 'button';
  button.setAttribute('aria-pressed', String(selected));
  const identity = node('span', 'roll-candidate-identity');
  identity.append(node('strong', '', `${price(candidate.strike)} ${candidate.optionType === 'call' ? 'Call' : 'Put'}`), node('small', '', `${date(candidate.expiration)} · ${candidate.dte} DTE`));
  const outcome = node('span', `roll-candidate-outcome${candidate.naturalRollCash < 0 ? ' is-debit' : ''}`);
  outcome.append(node('strong', '', rollCash(candidate.naturalRollCash)), node('small', '', candidate.direction));
  button.append(identity, outcome);
  button.addEventListener('click', select);
  return button;
}

function auditView(result, candidate) {
  const details = node('details', 'roll-audit');
  details.append(node('summary', '', 'Show how this was chosen'));
  const grid = node('dl', 'roll-audit-grid');
  const values = [
    ['Current buyback', price(candidate.closeDebit)],
    ['New contract credit', price(candidate.newOpenCredit)],
    ['Midpoint estimate', candidate.midpointRollCash == null ? null : rollCash(candidate.midpointRollCash)],
    ['Delta', candidate.delta == null ? null : Math.abs(candidate.delta).toFixed(2)],
    ['Bid / ask', `${price(candidate.bid)} / ${price(candidate.ask)}`],
    ['Spread', candidate.spreadPercent == null ? null : percent(candidate.spreadPercent)],
    ['Market activity', candidate.openInterest == null && candidate.volume == null ? null : `${candidate.openInterest ?? '—'} OI · ${candidate.volume ?? '—'} volume`],
  ].filter(([, value]) => value != null);
  for (const [label, value] of values) {
    const item = node('div');
    item.append(node('dt', '', label), node('dd', '', value));
    grid.append(item);
  }
  details.append(grid, node('p', 'roll-audit-note', `Quotes from ${result.provider === 'yfinance' ? 'Yahoo Finance' : result.provider ?? 'the market provider'} · ${quoteTime(result.quoteTimestamp)}. Confirm live prices with your broker.`));
  return details;
}

function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  return copied ? Promise.resolve() : Promise.reject(new Error('Copy unavailable'));
}

export function createRollController({ request, notify }) {
  const dialog = document.querySelector('#roll-dialog');
  const sheet = dialog.querySelector('.roll-sheet');
  const body = document.querySelector('#roll-sheet-body');
  const title = document.querySelector('#roll-title');
  const description = document.querySelector('#roll-description');
  const status = document.querySelector('#roll-status');
  let opener = null;
  let sequence = 0;
  let current = null;
  let selectedIndex = 0;

  const setBackgroundInert = (inert) => {
    for (const item of document.querySelectorAll('.app-bar, main, .bottom-nav, #settings-editor-dialog, #monitor-add-dialog, #glossary-dialog')) item.inert = inert;
  };

  const close = () => {
    const closingSequence = ++sequence;
    opener?.setAttribute?.('aria-expanded', 'false');
    dialog.classList.remove('is-open');
    document.body.classList.remove('has-modal');
    setBackgroundInert(false);
    setTimeout(() => {
      if (closingSequence !== sequence) return;
      dialog.hidden = true;
      body.replaceChildren();
      current = null;
      opener?.focus?.();
      opener = null;
    }, 220);
  };

  const renderResult = () => {
    body.replaceChildren(searchProfileView(current.searchProfile, current.strategy));
    if (!current.currentQuote?.available) {
      const unavailable = node('section', 'roll-empty is-warning');
      unavailable.append(node('strong', '', 'Current price unavailable'), node('p', '', 'Use the contract targets above in your broker and confirm the roll price there.'));
      body.append(unavailable);
      return;
    }
    if (!current.candidates.length) {
      const empty = node('section', 'roll-empty');
      empty.append(node('strong', '', `No verified roll fits ${current.goalLabel} right now.`));
      const filters = [...new Set(Object.entries(current.exclusions ?? {}).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]).map(([key]) => EXCLUSIONS[key] ?? key.replaceAll('_', ' ')))].slice(0, 3);
      empty.append(node('p', '', filters.length ? `Available contracts missed the ${filters.join(', ')} filters.` : 'No later contract passed the saved rules.'));
      body.append(empty);
      return;
    }
    const candidate = current.candidates[selectedIndex] ?? current.candidates[0];
    body.append(swapView(current, candidate));
    if (current.candidates.length > 1) {
      const alternatives = node('section', 'roll-alternatives');
      alternatives.append(node('p', 'roll-section-eyebrow', 'Other matches'));
      const choices = node('div', 'roll-candidate-list');
      current.candidates.forEach((item, index) => {
        if (index === selectedIndex) return;
        choices.append(candidateButton(item, false, () => {
          selectedIndex = index;
          renderResult();
        }));
      });
      alternatives.append(choices);
      body.append(alternatives);
    }
    body.append(auditView(current, candidate));
    const copy = node('button', 'roll-copy', 'Copy roll plan');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      const plan = formatRollPlan({
        symbol: current.symbol, strategy: current.strategy, quantity: current.quantity,
        currentStrike: current.currentStrike, currentExpiration: current.currentExpiration,
        candidate, goal: current.goal, quoteTimestamp: current.quoteTimestamp,
      });
      try {
        await copyText(plan);
        notify('Roll plan copied. Confirm it with your broker.', 'success');
      } catch {
        notify('Copy unavailable. Use the contract details shown here.', 'error');
      }
    });
    body.append(copy, node('p', 'roll-readonly-note', 'Wheely Nilly does not place or prepare an order. Confirm the net price, fees, and buying-power effect with your broker.'));
  };

  const open = async (trade, review, source) => {
    const requestSequence = ++sequence;
    opener = source;
    opener.setAttribute('aria-expanded', 'true');
    current = null;
    selectedIndex = 0;
    title.textContent = `Roll ${trade.symbol} ${trade.type === 'cc' ? 'call' : 'put'}`;
    description.textContent = goalGuidance(review.goal);
    status.textContent = 'Checking the current contract and later expirations.';
    body.replaceChildren(searchProfileView(review.searchProfile, trade.type));
    const loading = node('div', 'roll-loading');
    loading.append(node('span', '', 'Checking matching contracts'), node('i'), node('i'));
    body.append(loading);
    dialog.hidden = false;
    document.body.classList.add('has-modal');
    setBackgroundInert(true);
    requestAnimationFrame(() => {
      dialog.classList.add('is-open');
      sheet.focus();
    });
    try {
      const result = await request('/api/v1/position-management/rolls', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contractSymbol: trade.contractSymbol }),
      });
      if (requestSequence !== sequence) return;
      current = result;
      status.textContent = `${result.candidates.length} matching roll ${result.candidates.length === 1 ? 'choice' : 'choices'} found.`;
      renderResult();
    } catch (error) {
      if (requestSequence !== sequence) return;
      status.textContent = 'Roll choices unavailable.';
      body.replaceChildren(searchProfileView(review.searchProfile, trade.type));
      const unavailable = node('section', 'roll-empty is-warning');
      unavailable.append(node('strong', '', 'Roll choices could not be verified'), node('p', '', error.status === 409 ? 'This contract is no longer open. Refresh Home to see the latest position.' : 'Use the contract targets above in your broker and confirm current prices there.'));
      body.append(unavailable);
    }
  };

  const action = (trade, review) => {
    if (review.state !== 'review') return null;
    const wrapper = node('div', 'roll-review-action');
    const button = node('button', '', 'See roll choices');
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-controls', 'roll-dialog');
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', () => open(trade, review, button));
    wrapper.append(button);
    return wrapper;
  };

  const trapFocus = (event) => {
    if (event.key !== 'Tab' || dialog.hidden) return;
    const focusable = [...sheet.querySelectorAll('button:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')].filter((item) => item.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === sheet)) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  };

  for (const control of dialog.querySelectorAll('[data-roll-close]')) control.addEventListener('click', close);
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    else trapFocus(event);
  });

  return { action, close };
}
