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

export function rollActionPresentation(review) {
  if (review?.state === 'unavailable') {
    return {
      disabled: true,
      label: 'Waiting for market data',
      title: review.reason ?? 'A usable current option quote is required before checking roll candidates.',
    };
  }
  const recommended = review?.state === 'review';
  return {
    disabled: false,
    label: 'Check roll candidates',
    title: recommended ? 'A rollover review is recommended' : 'Check later contracts against this goal',
  };
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
    contractBlock('Buy to close', result.currentStrike, result.currentExpiration, null, result.strategy === 'cc' ? 'call' : 'put'),
    node('span', 'roll-swap-arrow', '→'),
    contractBlock('Sell to open', candidate.strike, candidate.expiration, candidate.dte, candidate.optionType),
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
  section.append(
    rail,
    node('p', 'roll-price-assumption', `Assumes a ${price(result.currentQuote.ask)} buy at the current ask and a ${price(candidate.bid)} sale at the replacement bid.`),
    economics,
    node('p', 'roll-fit-summary', candidate.fitSummary),
  );
  return section;
}

function choiceTabs(activeGroup, otherCount, select) {
  const tabs = node('div', 'roll-choice-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Roll choice type');
  for (const [group, label, count] of [
    ['preferred', 'Preferred choice', null],
    ['others', 'Other options', otherCount],
  ]) {
    const active = group === activeGroup;
    const button = node('button', active ? 'is-active' : '', count == null ? label : `${label} ${count}`);
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.id = `roll-${group}-tab`;
    button.dataset.rollGroup = group;
    button.setAttribute('aria-controls', `roll-${group}-panel`);
    button.setAttribute('aria-selected', String(active));
    if (group === 'others' && count === 0) button.disabled = true;
    button.addEventListener('click', () => select(group));
    tabs.append(button);
  }
  tabs.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const group = event.key === 'ArrowLeft' ? 'preferred' : 'others';
    const target = tabs.querySelector(`[data-roll-group="${group}"]:not([disabled])`);
    if (!target) return;
    event.preventDefault();
    target.click();
    target.focus();
  });
  return tabs;
}

function alternativeNote(candidate) {
  const note = node('section', 'roll-alternative-note');
  const misses = candidate.preferenceMisses ?? [];
  note.append(
    node('strong', '', 'Usable quote, outside saved rules'),
    node('p', '', misses.length
      ? `This contract misses your ${misses.slice(0, 3).join(', ')} settings.`
      : 'This contract was outside the top rule matches.'),
  );
  return note;
}

function optionSummary(candidate) {
  const summary = node('summary', 'roll-option-summary');
  const identity = node('span', 'roll-candidate-identity');
  identity.append(node('strong', '', `${price(candidate.strike)} ${candidate.optionType === 'call' ? 'Call' : 'Put'}`), node('small', '', `${date(candidate.expiration)} · ${candidate.dte} DTE`));
  const outcome = node('span', `roll-candidate-outcome${candidate.naturalRollCash < 0 ? ' is-debit' : ''}`);
  outcome.append(node('strong', '', rollCash(candidate.naturalRollCash)), node('small', '', candidate.direction));
  summary.append(identity, outcome, node('span', 'roll-option-chevron', '⌄'));
  return summary;
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

function optionBody(result, candidate, outsideRules) {
  const content = node('div', 'roll-option-body');
  if (outsideRules) content.append(alternativeNote(candidate));
  content.append(swapView(result, candidate), auditView(result, candidate));
  return content;
}

function optionCard(result, choice, collapsible) {
  if (!collapsible) return optionBody(result, choice.candidate, choice.outsideRules);
  const details = node('details', 'roll-option-card');
  details.append(optionSummary(choice.candidate), optionBody(result, choice.candidate, choice.outsideRules));
  return details;
}

export function groupRollChoices(result) {
  const matches = (result.candidates ?? []).map((candidate) => ({ candidate, outsideRules: false }));
  const alternatives = (result.alternatives ?? []).map((candidate) => ({ candidate, outsideRules: true }));
  const choices = [...matches, ...alternatives];
  return { preferred: choices[0] ?? null, others: choices.slice(1) };
}

export function createRollController({ request }) {
  const dialog = document.querySelector('#roll-dialog');
  const sheet = dialog.querySelector('.roll-sheet');
  const body = document.querySelector('#roll-sheet-body');
  const title = document.querySelector('#roll-title');
  const description = document.querySelector('#roll-description');
  const status = document.querySelector('#roll-status');
  let opener = null;
  let sequence = 0;
  let current = null;
  let selectedGroup = 'preferred';

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
    body.replaceChildren();
    if (!current.currentQuote?.available) {
      const unavailable = node('section', 'roll-empty is-warning');
      unavailable.append(node('strong', '', 'Current price unavailable'), node('p', '', 'Confirm the current buyback price with your broker before choosing a roll.'));
      body.append(unavailable);
      return;
    }
    const { preferred, others } = groupRollChoices(current);
    if (!preferred) {
      const empty = node('section', 'roll-empty');
      empty.append(node('strong', '', `No verified roll fits ${current.goalLabel} right now.`));
      const filters = [...new Set(Object.entries(current.exclusions ?? {}).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]).map(([key]) => EXCLUSIONS[key] ?? key.replaceAll('_', ' ')))].slice(0, 3);
      empty.append(node('p', '', filters.length ? `Available contracts missed the ${filters.join(', ')} filters.` : 'No later contract passed the saved rules.'));
      body.append(empty);
      return;
    }
    if (selectedGroup === 'others' && !others.length) selectedGroup = 'preferred';
    let preferredPanel;
    let othersPanel;
    const tabs = choiceTabs(selectedGroup, others.length, (group) => {
      selectedGroup = group;
      for (const button of tabs.querySelectorAll('[role="tab"]')) {
        const active = button.dataset.rollGroup === group;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', String(active));
      }
      preferredPanel.hidden = group !== 'preferred';
      othersPanel.hidden = group !== 'others';
    });
    preferredPanel = node('section', 'roll-preferred-panel');
    preferredPanel.id = 'roll-preferred-panel';
    preferredPanel.setAttribute('role', 'tabpanel');
    preferredPanel.setAttribute('aria-labelledby', 'roll-preferred-tab');
    preferredPanel.hidden = selectedGroup !== 'preferred';
    preferredPanel.append(optionCard(current, preferred, false));
    othersPanel = node('section', 'roll-options-panel');
    othersPanel.id = 'roll-others-panel';
    othersPanel.setAttribute('role', 'tabpanel');
    othersPanel.setAttribute('aria-labelledby', 'roll-others-tab');
    othersPanel.hidden = selectedGroup !== 'others';
    for (const choice of others) othersPanel.append(optionCard(current, choice, true));
    body.append(tabs, preferredPanel, othersPanel);
  };

  const open = async (trade, review, source) => {
    const requestSequence = ++sequence;
    opener = source;
    opener.setAttribute('aria-expanded', 'true');
    current = null;
    selectedGroup = 'preferred';
    title.textContent = `Roll ${trade.symbol} ${trade.type === 'cc' ? 'call' : 'put'}`;
    description.textContent = goalGuidance(review.goal);
    status.textContent = 'Checking the current contract and later expirations.';
    body.replaceChildren();
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
      const matchCount = result.candidates?.length ?? 0;
      const alternativeCount = result.alternatives?.length ?? 0;
      const totalCount = matchCount + alternativeCount;
      status.textContent = totalCount
        ? `One preferred choice and ${Math.max(0, totalCount - 1)} other ${totalCount === 2 ? 'option' : 'options'} found.`
        : 'No usable later contracts found.';
      renderResult();
    } catch (error) {
      if (requestSequence !== sequence) return;
      status.textContent = 'Roll choices unavailable.';
      body.replaceChildren();
      const unavailable = node('section', 'roll-empty is-warning');
      unavailable.append(node('strong', '', 'Roll choices could not be verified'), node('p', '', error.status === 409 ? 'This contract is no longer open. Refresh Home to see the latest position.' : 'Try again after market quotes refresh.'));
      body.append(unavailable);
    }
  };

  const action = (trade, review) => {
    if (!review?.goal || review.state === 'unavailable') return null;
    const recommended = review.state === 'review';
    const presentation = rollActionPresentation(review);
    const wrapper = node('div', `roll-review-action${recommended ? ' is-recommended' : ''}`);
    const button = node('button', '', presentation.label);
    button.type = 'button';
    button.disabled = presentation.disabled;
    button.title = presentation.title;
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-controls', 'roll-dialog');
    button.setAttribute('aria-expanded', 'false');
    if (recommended) button.setAttribute('aria-label', 'Check roll candidates, rollover review recommended');
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
