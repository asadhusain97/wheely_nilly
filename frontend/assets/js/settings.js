const RULE_FIELDS = [
  { key: 'minDte', label: 'Minimum DTE', short: 'Min DTE', step: 1, min: 1, max: 365 },
  { key: 'maxDte', label: 'Maximum DTE', short: 'Max DTE', step: 1, min: 1, max: 730 },
  { key: 'targetDeltaMin', label: 'Minimum delta', short: 'Min delta', step: 0.01, min: 0, max: 1, nullable: true },
  { key: 'targetDeltaMax', label: 'Maximum delta', short: 'Max delta', step: 0.01, min: 0, max: 1, nullable: true },
  { key: 'minPeriodReturn', label: 'Minimum period return', short: 'Min return', step: 0.1, min: 0, max: 1000, scale: 100, suffix: '%' },
  { key: 'minMoneyness', label: 'Minimum strike / stock', short: 'Min moneyness', step: 1, min: 0.01, max: 200, scale: 100, suffix: '%' },
  { key: 'maxMoneyness', label: 'Maximum strike / stock', short: 'Max moneyness', step: 1, min: 0.01, max: 300, scale: 100, suffix: '%' },
  { key: 'maxSpreadPercent', label: 'Maximum bid / ask spread', short: 'Max spread', step: 1, min: 0.01, max: 100, scale: 100, suffix: '%' },
  { key: 'minOpenInterest', label: 'Minimum open interest', short: 'Min open interest', step: 1, min: 0, integer: true },
  { key: 'minVolume', label: 'Minimum daily volume', short: 'Min volume', step: 1, min: 0, integer: true },
  { key: 'maxQuoteAgeSeconds', label: 'Maximum quote age', short: 'Quote age', step: 1, min: 1, max: 1440, divisor: 60, suffix: 'min' },
];

const FIELD_BY_KEY = Object.fromEntries(RULE_FIELDS.map((field) => [field.key, field]));
const CORE_FIELDS = RULE_FIELDS.slice(0, 5);
const ADVANCED_FIELDS = RULE_FIELDS.slice(5);
const LEG_LABELS = {
  coveredCall: 'Covered call',
  cashSecuredPut: 'Cash-secured put',
};
const LEG_SHORT_LABELS = {
  coveredCall: 'CC',
  cashSecuredPut: 'CSP',
};
const GOAL_LABELS = {
  protect: 'Protect',
  income: 'Income',
  exit: 'Exit',
  acquire: 'Acquire',
};
const GOAL_COPY = {
  protect: 'More distance for shares you want to protect.',
  income: 'Balance premium with room for the stock to move.',
  exit: 'A closer path when selling shares is the goal.',
  acquire: 'Shape puts around a preferred entry.',
};
const ALLOWED_GOALS = {
  coveredCall: ['protect', 'income', 'exit'],
  cashSecuredPut: ['income', 'acquire'],
};
const BUILT_IN_GLOBAL = {
  minDte: 7,
  maxDte: 45,
  minMoneyness: 0.8,
  maxMoneyness: 1.2,
  targetDeltaMin: null,
  targetDeltaMax: 0.35,
  maxSpreadPercent: 0.2,
  minOpenInterest: 10,
  minVolume: 0,
  maxQuoteAgeSeconds: 900,
  minPeriodReturn: 0,
};
const BUILT_IN_GOALS = {
  protect: { minDte: 30, maxDte: 60, targetDeltaMin: 0.1, targetDeltaMax: 0.2 },
  income: { minDte: 21, maxDte: 45, targetDeltaMin: 0.2, targetDeltaMax: 0.35 },
  exit: { minDte: 7, maxDte: 30, targetDeltaMin: 0.35, targetDeltaMax: 0.7 },
  acquire: { minDte: 21, maxDte: 45, targetDeltaMin: 0.2, targetDeltaMax: 0.35 },
};

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const deepCopy = (value) => structuredClone(value);
const ICON_PATHS = {
  undo: ['M9 7H4V2', 'M4 7a8 8 0 1 1-1 6'],
  chevron: ['m7 9 5 5 5-5'],
};

function icon(name, className = 'ui-icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const data of ICON_PATHS[name]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', data);
    svg.append(path);
  }
  return svg;
}

const uiValue = (field, value) => {
  if (value == null) return '';
  if (field.scale) return Number((value * field.scale).toFixed(6));
  if (field.divisor) return Number((value / field.divisor).toFixed(6));
  return value;
};

const storedValue = (field, value) => {
  if (value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (field.scale) return parsed / field.scale;
  if (field.divisor) return parsed * field.divisor;
  return parsed;
};

function dollarsFromMinor(value) {
  if (!Number.isSafeInteger(value)) return '';
  const minor = BigInt(value);
  return `${minor / 100n}.${String(minor % 100n).padStart(2, '0')}`;
}

function dollarsToMinor(value) {
  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(String(value).trim());
  if (!match) return null;
  const minor = BigInt(match[1]) * 100n + BigInt(`${match[2] ?? ''}00`.slice(0, 2));
  const number = Number(minor);
  return Number.isSafeInteger(number) ? number : null;
}

function constrainNumericInput(input, { allowDecimal = true } = {}) {
  const accepted = allowDecimal ? /^\d*(?:\.\d*)?$/ : /^\d*$/;
  input.type = 'number';
  input.inputMode = allowDecimal ? 'decimal' : 'numeric';
  input.autocomplete = 'off';
  input.setAttribute('enterkeyhint', 'done');
  input.addEventListener('keydown', (event) => {
    if (['e', 'E', '+', '-'].includes(event.key) || (!allowDecimal && ['.', ','].includes(event.key))) {
      event.preventDefault();
    }
  });
  input.addEventListener('beforeinput', (event) => {
    if (event.data && !accepted.test(event.data)) event.preventDefault();
  });
  input.addEventListener('paste', (event) => {
    const pasted = event.clipboardData?.getData('text').trim() ?? '';
    if (!accepted.test(pasted)) event.preventDefault();
  });
}

function defaultPlaybook() {
  return {
    coveredCall: { enabled: true, goal: 'income', minNetSalePriceMinor: null, overrides: {} },
    cashSecuredPut: { enabled: true, goal: 'acquire', maxNetPurchasePriceMinor: null, overrides: {} },
  };
}

export function settingsWithTicker(settings, symbol, leg, goal) {
  if (!ALLOWED_GOALS[leg]?.includes(goal)) throw new Error('Choose a goal supported by this strategy.');
  const draft = deepCopy(settings);
  if (!draft.tickerPlaybooks[symbol]) {
    draft.tickerPlaybooks[symbol] = defaultPlaybook();
    draft.tickerPlaybooks[symbol].coveredCall.enabled = false;
    draft.tickerPlaybooks[symbol].cashSecuredPut.enabled = false;
  }
  draft.tickerPlaybooks[symbol][leg].enabled = true;
  draft.tickerPlaybooks[symbol][leg].goal = goal;
  return draft;
}

export function settingsWithoutTicker(settings, symbol) {
  const draft = deepCopy(settings);
  delete draft.tickerPlaybooks[symbol];
  return draft;
}

function mergedRules(settings, symbol, leg) {
  const ticker = settings.tickerPlaybooks[symbol]?.[leg];
  const preset = ticker ? settings.goalPresets[ticker.goal].rules : {};
  return { ...settings.globalRules[leg], ...preset, ...(ticker?.overrides ?? {}) };
}

function rulesError(rules, scope) {
  for (const field of RULE_FIELDS) {
    const value = rules[field.key];
    if (value == null && field.nullable) continue;
    if (!Number.isFinite(value)) return `${scope}: ${field.label} needs a number.`;
    const display = uiValue(field, value);
    if (field.min != null && display < field.min) return `${scope}: ${field.label} is below its allowed minimum.`;
    if (field.max != null && display > field.max) return `${scope}: ${field.label} is above its allowed maximum.`;
    if ((field.integer || ['minDte', 'maxDte', 'maxQuoteAgeSeconds'].includes(field.key)) && !Number.isSafeInteger(value)) {
      return `${scope}: ${field.label} must be a whole number.`;
    }
  }
  if (rules.minDte > rules.maxDte) return `${scope}: Minimum DTE cannot exceed maximum DTE.`;
  if (rules.minMoneyness > rules.maxMoneyness) return `${scope}: Minimum moneyness cannot exceed maximum moneyness.`;
  if (rules.targetDeltaMin != null && rules.targetDeltaMax != null && rules.targetDeltaMin > rules.targetDeltaMax) {
    return `${scope}: Minimum delta cannot exceed maximum delta.`;
  }
  return null;
}

function validateDraft(settings) {
  for (const leg of Object.keys(LEG_LABELS)) {
    const error = rulesError(settings.globalRules[leg], `${LEG_LABELS[leg]} defaults`);
    if (error) throw new Error(error);
  }
  for (const [goal, preset] of Object.entries(settings.goalPresets)) {
    for (const leg of preset.applicableLegs) {
      const error = rulesError({ ...settings.globalRules[leg], ...preset.rules }, `${GOAL_LABELS[goal]} goal`);
      if (error) throw new Error(error);
    }
  }
  for (const [symbol, playbook] of Object.entries(settings.tickerPlaybooks)) {
    for (const leg of Object.keys(LEG_LABELS)) {
      const legSettings = playbook[leg];
      const error = rulesError(mergedRules(settings, symbol, leg), `${symbol} ${LEG_LABELS[leg]}`);
      if (error) throw new Error(error);
      const guard = leg === 'coveredCall' ? legSettings.minNetSalePriceMinor : legSettings.maxNetPurchasePriceMinor;
      if (guard != null && (!Number.isSafeInteger(guard) || guard < 0)) {
        throw new Error(`${symbol} ${LEG_LABELS[leg]}: Enter a valid dollar price with no more than two decimals.`);
      }
    }
  }
}

function compactNumber(value) {
  if (value == null) return 'Any';
  return String(Number(Number(value).toFixed(2)));
}

function displayField(key, value) {
  if (value == null) return 'Any';
  const field = FIELD_BY_KEY[key];
  const displayed = uiValue(field, value);
  if (field.suffix === '%') return `${compactNumber(displayed)}%`;
  if (field.suffix === 'min') return `${compactNumber(displayed)} min`;
  return compactNumber(displayed);
}

function glyphForLeg(leg) {
  return element('span', `strategy-glyph ${leg === 'coveredCall' ? 'cc' : 'csp'}`, LEG_SHORT_LABELS[leg]);
}

export function normalizeTrackedTickers(items = []) {
  const tickers = new Map();
  for (const item of items) {
    const raw = typeof item === 'string' ? { symbol: item } : item;
    const symbol = String(raw?.symbol ?? '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) continue;
    const recency = Date.parse(raw.lastActivityAt) || 0;
    const preferredLeg = raw.preferredLeg === 'cashSecuredPut' ? 'cashSecuredPut' : 'coveredCall';
    const allowedGoals = ALLOWED_GOALS[preferredLeg];
    const goal = allowedGoals.includes(raw.goal) ? raw.goal : (preferredLeg === 'cashSecuredPut' ? 'acquire' : 'income');
    const existing = tickers.get(symbol);
    if (!existing || recency >= existing.recency) tickers.set(symbol, { symbol, recency, preferredLeg, goal });
  }
  return tickers;
}

export function resolveTickerGoal(playbook, tracked) {
  const preferredLeg = tracked?.preferredLeg ?? (playbook.coveredCall.enabled ? 'coveredCall' : 'cashSecuredPut');
  const firstEnabled = ['coveredCall', 'cashSecuredPut'].find((leg) => playbook[leg].enabled);
  const leg = playbook[preferredLeg].enabled ? preferredLeg : (firstEnabled ?? preferredLeg);
  return playbook[leg].enabled ? playbook[leg].goal : (tracked?.goal ?? playbook[leg].goal);
}

export function visibleTickerEntries(tickers, query = '', expanded = false) {
  const normalizedQuery = query.trim().toUpperCase();
  const sorted = tickers
    .filter(({ symbol }) => !normalizedQuery || symbol.includes(normalizedQuery))
    .sort((a, b) => b.recency - a.recency || a.symbol.localeCompare(b.symbol));
  return { sorted, visible: normalizedQuery || expanded ? sorted : sorted.slice(0, 8) };
}

export function createStrategySettingsController({ request, notify, getTrackedTickers = () => [] }) {
  const model = {
    settings: null,
    persistence: null,
    loaded: false,
    loading: false,
    globalLeg: 'coveredCall',
    preset: 'protect',
    tickerQuery: '',
    tickersExpanded: false,
    editor: null,
  };
  let inputSequence = 0;
  let closeTimer = null;
  let drag = null;

  const status = () => document.querySelector('#settings-status');
  const overlay = () => document.querySelector('#settings-editor-dialog');
  const sheet = () => overlay().querySelector('.settings-editor-sheet');

  function setStatus(message, type = 'ready', { hide = false, retry = false } = {}) {
    const node = status();
    node.hidden = hide;
    node.className = `settings-status is-${type}`;
    node.replaceChildren(element('span', '', message));
    if (retry) {
      const button = element('button', '', 'Try again');
      button.type = 'button';
      button.addEventListener('click', () => load(true));
      node.append(button);
    }
  }

  function tabKeyboard(tablist, event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...tablist.querySelectorAll('[role="tab"]')];
    const current = Math.max(0, tabs.indexOf(document.activeElement));
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    tabs[next].focus();
    tabs[next].click();
  }

  function renderTabs(container, items, selected, onSelect, prefix, controlsId = null) {
    container.replaceChildren();
    for (const [key, label] of items) {
      const active = key === selected;
      const button = element('button', `${prefix === 'goal' ? 'goal-chip ' : ''}${active ? 'is-active' : ''}`.trim(), label);
      if (prefix === 'goal') button.dataset.goal = key;
      button.type = 'button';
      button.id = `${prefix}-${key}-tab`;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(active));
      if (controlsId) button.setAttribute('aria-controls', controlsId);
      button.tabIndex = active ? 0 : -1;
      button.addEventListener('click', () => onSelect(key));
      container.append(button);
    }
    container.onkeydown = (event) => tabKeyboard(container, event);
  }

  function valueToken(key, value, specific, source) {
    const token = element('span', `rule-value${specific ? '' : ' is-inherited'}`, displayField(key, value));
    token.title = specific ? `Set for ${source}` : `Inherited from ${source}`;
    return token;
  }

  function rangeSummary(label, rules, first, second, specificKeys, source, suffix = '') {
    const row = element('div', 'settings-rule-row');
    row.append(element('span', 'settings-rule-label', label));
    const value = element('div', 'settings-rule-value');
    const separator = element('span', 'rule-separator', '–');
    if (!specificKeys.has(first) && !specificKeys.has(second)) separator.classList.add('is-inherited');
    value.append(
      valueToken(first, rules[first], specificKeys.has(first), source),
      separator,
      valueToken(second, rules[second], specificKeys.has(second), source),
    );
    if (suffix) value.append(element('small', '', suffix));
    row.append(value);
    return row;
  }

  function singleSummary(label, rules, key, specificKeys, source) {
    const row = element('div', 'settings-rule-row');
    row.append(element('span', 'settings-rule-label', label));
    const value = element('div', 'settings-rule-value');
    value.append(valueToken(key, rules[key], specificKeys.has(key), source));
    row.append(value);
    return row;
  }

  function ruleSummary(rules, specificKeys, source) {
    const list = element('div', 'settings-rule-list');
    list.append(
      rangeSummary('DTE', rules, 'minDte', 'maxDte', specificKeys, source, 'days'),
      rangeSummary('Delta', rules, 'targetDeltaMin', 'targetDeltaMax', specificKeys, source),
      singleSummary('Minimum return', rules, 'minPeriodReturn', specificKeys, source),
    );
    const advanced = element('details', 'settings-rule-advanced');
    const advancedSummary = element('summary');
    advancedSummary.append(element('span', '', 'Advanced rules'), icon('chevron', 'ui-icon disclosure-icon'));
    advanced.append(advancedSummary);
    const advancedList = element('div', 'settings-rule-list');
    advancedList.append(
      rangeSummary('Moneyness', rules, 'minMoneyness', 'maxMoneyness', specificKeys, source),
      singleSummary('Maximum spread', rules, 'maxSpreadPercent', specificKeys, source),
      singleSummary('Minimum open interest', rules, 'minOpenInterest', specificKeys, source),
      singleSummary('Minimum volume', rules, 'minVolume', specificKeys, source),
      singleSummary('Maximum quote age', rules, 'maxQuoteAgeSeconds', specificKeys, source),
    );
    advanced.append(advancedList);
    list.append(advanced);
    return list;
  }

  function renderGlobal() {
    renderTabs(
      document.querySelector('#global-leg-tabs'),
      Object.entries(LEG_SHORT_LABELS),
      model.globalLeg,
      (leg) => {
        model.globalLeg = leg;
        renderGlobal();
      },
      'global-leg',
      'global-rules-view',
    );
    const view = document.querySelector('#global-rules-view');
    view.setAttribute('aria-labelledby', `global-leg-${model.globalLeg}-tab`);
    view.replaceChildren();
    view.append(ruleSummary(
      model.settings.globalRules[model.globalLeg],
      new Set(RULE_FIELDS.map(({ key }) => key)),
      LEG_LABELS[model.globalLeg],
    ));
    document.querySelector('#edit-global-settings').setAttribute('aria-label', `Edit ${LEG_LABELS[model.globalLeg]} default settings`);
  }

  function renderGoal() {
    renderTabs(
      document.querySelector('#goal-preset-tabs'),
      Object.entries(GOAL_LABELS),
      model.preset,
      (goal) => {
        model.preset = goal;
        renderGoal();
      },
      'goal',
      'goal-rules-view',
    );
    const preset = model.settings.goalPresets[model.preset];
    const inherited = model.settings.globalRules[preset.applicableLegs[0]];
    const effective = { ...inherited, ...preset.rules };
    const view = document.querySelector('#goal-rules-view');
    view.setAttribute('aria-labelledby', `goal-${model.preset}-tab`);
    view.replaceChildren();
    const context = element('div', 'rule-view-context goal-context');
    const copy = element('div');
    const goalName = element('strong', 'goal-tone', GOAL_LABELS[model.preset]);
    goalName.dataset.goal = model.preset;
    copy.append(goalName, element('small', '', GOAL_COPY[model.preset]));
    context.append(copy, element('span', 'applies-chip', preset.applicableLegs.map((leg) => LEG_SHORT_LABELS[leg]).join(' + ')));
    view.append(context, ruleSummary(effective, new Set(Object.keys(preset.rules)), 'Defaults'));
    document.querySelector('#edit-goal-settings').setAttribute('aria-label', `Edit ${GOAL_LABELS[model.preset]} goal`);
  }

  function trackedTickers() {
    return normalizeTrackedTickers(getTrackedTickers());
  }

  function seededPlaybook(symbol) {
    const playbook = defaultPlaybook();
    const tracked = trackedTickers().get(symbol);
    if (tracked) playbook[tracked.preferredLeg].goal = tracked.goal;
    return playbook;
  }

  function renderTickers() {
    const list = document.querySelector('#ticker-playbook-list');
    list.replaceChildren();
    const tracked = trackedTickers();
    for (const symbol of Object.keys(model.settings.tickerPlaybooks)) {
      if (!tracked.has(symbol)) tracked.set(symbol, { symbol, recency: 0, preferredLeg: 'coveredCall', goal: model.settings.tickerPlaybooks[symbol].coveredCall.goal });
    }
    const query = model.tickerQuery.trim().toUpperCase();
    const { sorted: tickers, visible } = visibleTickerEntries([...tracked.values()], query, model.tickersExpanded);
    document.querySelector('#settings-ticker-count').textContent = query
      ? `${tickers.length} match${tickers.length === 1 ? '' : 'es'}`
      : `${tracked.size} ticker${tracked.size === 1 ? '' : 's'}`;
    if (!visible.length) {
      list.append(element('p', 'ticker-settings-empty', query ? 'No tickers match.' : 'Screen a ticker or complete a trade to see it here.'));
      return;
    }
    for (const ticker of visible) {
      const { symbol } = ticker;
      const playbook = model.settings.tickerPlaybooks[symbol] ?? seededPlaybook(symbol);
      const button = element('button', `ticker-capsule${model.settings.tickerPlaybooks[symbol] ? '' : ' is-starting'}`);
      button.type = 'button';
      const displayedGoal = resolveTickerGoal(playbook, ticker);
      const goalName = element('small', 'goal-tone', GOAL_LABELS[displayedGoal]);
      goalName.dataset.goal = displayedGoal;
      button.append(
        element('strong', '', symbol),
        goalName,
      );
      button.setAttribute('aria-label', `Edit ${symbol} ticker settings`);
      button.addEventListener('click', () => openTickerEditor(symbol));
      list.append(button);
    }
    if (!query && tickers.length > 8) {
      const remaining = tickers.length - 8;
      const more = element('button', `ticker-more${model.tickersExpanded ? ' is-expanded' : ''}`);
      more.type = 'button';
      more.append(
        element('span', '', model.tickersExpanded ? 'Show less' : `More ${remaining}`),
        icon('chevron', 'ui-icon disclosure-icon'),
      );
      more.setAttribute('aria-expanded', String(model.tickersExpanded));
      more.addEventListener('click', () => {
        model.tickersExpanded = !model.tickersExpanded;
        renderTickers();
      });
      list.append(more);
    }
  }

  function renderAll() {
    if (!model.settings) return;
    renderGlobal();
    renderGoal();
    renderTickers();
  }

  function setBackgroundInert(inert) {
    for (const node of document.querySelectorAll('.app-bar, main, .bottom-nav, #glossary-dialog')) node.inert = inert;
  }

  function openEditor(editor) {
    clearTimeout(closeTimer);
    model.editor = {
      ...editor,
      draft: deepCopy(model.settings),
      dirty: false,
      lastFocused: document.activeElement,
    };
    if (model.editor.kind === 'ticker' && !model.editor.draft.tickerPlaybooks[model.editor.symbol]) {
      model.editor.draft.tickerPlaybooks[model.editor.symbol] = seededPlaybook(model.editor.symbol);
      model.editor.isNew = true;
    }
    const dialog = overlay();
    dialog.hidden = false;
    document.body.classList.add('has-modal');
    setBackgroundInert(true);
    renderEditor();
    requestAnimationFrame(() => {
      dialog.classList.add('is-open');
      (sheet().querySelector('[autofocus]') ?? sheet()).focus();
    });
  }

  function openGlobalEditor() {
    openEditor({ kind: 'global', leg: model.globalLeg });
  }

  function openGoalEditor() {
    openEditor({ kind: 'goal', goal: model.preset });
  }

  function openTickerEditor(symbol) {
    openEditor({ kind: 'ticker', symbol, leg: trackedTickers().get(symbol)?.preferredLeg ?? 'coveredCall' });
  }

  async function addTicker(symbol, leg, goal) {
    await load();
    const draft = settingsWithTicker(model.settings, symbol, leg, goal);
    validateDraft(draft);
    const result = await request('/api/v1/strategy-settings', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft),
    });
    model.settings = deepCopy(result.settings);
    model.persistence = result.persistence;
    renderAll();
    setStatus('Settings saved', 'success');
    notify(`${symbol} added to Radar`, 'success');
    return result;
  }

  async function removeTicker(symbol) {
    await load();
    if (!model.settings.tickerPlaybooks[symbol]) return null;
    const draft = settingsWithoutTicker(model.settings, symbol);
    validateDraft(draft);
    const result = await request('/api/v1/strategy-settings', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft),
    });
    model.settings = deepCopy(result.settings);
    model.persistence = result.persistence;
    renderAll();
    setStatus('Settings saved', 'success');
    notify(`${symbol} removed from Radar`, 'success');
    return result;
  }

  function finishClose() {
    const editor = model.editor;
    const dialog = overlay();
    dialog.hidden = true;
    dialog.classList.remove('is-open', 'is-dragging');
    sheet().style.removeProperty('transform');
    dialog.querySelector('.settings-editor-backdrop').style.removeProperty('opacity');
    document.body.classList.remove('has-modal');
    setBackgroundInert(false);
    model.editor = null;
    editor?.lastFocused?.focus?.();
  }

  function closeEditor({ force = false } = {}) {
    if (!model.editor) return true;
    if (!force && model.editor.dirty && !window.confirm('Discard the changes in this sheet?')) {
      overlay().classList.add('is-open');
      sheet().style.removeProperty('transform');
      overlay().querySelector('.settings-editor-backdrop').style.removeProperty('opacity');
      return false;
    }
    overlay().classList.remove('is-open');
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    closeTimer = setTimeout(finishClose, reducedMotion ? 0 : 260);
    return true;
  }

  function markEditorDirty() {
    if (model.editor) model.editor.dirty = true;
  }

  function editorError(message = '') {
    const existing = document.querySelector('#settings-editor-error');
    if (!existing) return;
    existing.textContent = message;
    existing.hidden = !message;
    if (message) existing.focus();
  }

  function ruleField(field, rules, { partial = false, inherited = {}, inheritLabels = {} } = {}) {
    const overridden = Object.hasOwn(rules, field.key);
    const id = `strategy-rule-${inputSequence += 1}`;
    const row = element('div', `editor-rule-row${partial && !overridden ? ' is-inherited' : ''}`);
    const copy = element('div', 'editor-rule-copy');
    const label = element('label', '', field.label);
    label.htmlFor = id;
    const helper = element('small', '', partial && !overridden ? `From ${inheritLabels[field.key] ?? 'the layer above'}` : '');
    helper.hidden = !partial || overridden;
    copy.append(label, helper);

    const controls = element('div', 'editor-rule-controls');
    const inputWrap = element('div', 'rule-input');
    const input = document.createElement('input');
    input.id = id;
    const wholeNumber = field.integer || ['minDte', 'maxDte', 'maxQuoteAgeSeconds'].includes(field.key);
    constrainNumericInput(input, { allowDecimal: !wholeNumber });
    input.step = String(field.step);
    if (field.min != null) input.min = String(field.min);
    if (field.max != null) input.max = String(field.max);
    input.required = !field.nullable && !partial;
    input.value = uiValue(field, overridden ? rules[field.key] : inherited[field.key]);
    inputWrap.append(input);
    if (field.suffix) inputWrap.append(element('span', '', field.suffix));

    const reset = element('button', 'field-inherit-reset');
    reset.type = 'button';
    reset.hidden = !partial || !overridden;
    reset.title = `Use inherited ${field.label}`;
    reset.setAttribute('aria-label', `Use inherited ${field.label}`);
    reset.append(icon('undo'));

    const syncAppearance = (isOverride) => {
      row.classList.toggle('is-inherited', partial && !isOverride);
      helper.textContent = partial && !isOverride ? `From ${inheritLabels[field.key] ?? 'the layer above'}` : '';
      helper.hidden = !partial || isOverride;
      reset.hidden = !partial || !isOverride;
      input.required = !field.nullable && (!partial || isOverride);
    };
    input.addEventListener('input', () => {
      rules[field.key] = storedValue(field, input.value);
      syncAppearance(true);
      markEditorDirty();
      editorError();
    });
    reset.addEventListener('click', () => {
      delete rules[field.key];
      input.value = uiValue(field, inherited[field.key]);
      syncAppearance(false);
      markEditorDirty();
    });
    controls.append(inputWrap, reset);
    row.append(copy, controls);
    return row;
  }

  function ruleEditor(rules, options = {}) {
    const editor = element('div', 'sheet-rule-editor');
    const core = element('div', 'editor-rule-list');
    for (const field of CORE_FIELDS) core.append(ruleField(field, rules, options));
    editor.append(core);
    const advanced = element('details', 'editor-advanced-rules');
    const summary = element('summary');
    const advancedCopy = element('div');
    advancedCopy.append(element('span', '', 'Advanced rules'), element('small', '', 'Moneyness, liquidity, and quotes'));
    summary.append(advancedCopy, icon('chevron', 'ui-icon disclosure-icon'));
    const advancedList = element('div', 'editor-rule-list');
    for (const field of ADVANCED_FIELDS) advancedList.append(ruleField(field, rules, options));
    advanced.append(summary, advancedList);
    editor.append(advanced);
    return editor;
  }

  function editorIntro(leg, text) {
    const intro = element('div', 'sheet-editor-intro');
    intro.append(glyphForLeg(leg));
    const copy = element('div');
    copy.append(element('strong', '', LEG_LABELS[leg]), element('small', '', text));
    intro.append(copy);
    return intro;
  }

  function renderGlobalEditor(body) {
    const { leg, draft } = model.editor;
    body.append(
      editorIntro(leg, 'The complete baseline for this strategy.'),
      ruleEditor(draft.globalRules[leg]),
    );
  }

  function renderGoalEditor(body) {
    const { goal, draft } = model.editor;
    const preset = draft.goalPresets[goal];
    const inherited = draft.globalRules[preset.applicableLegs[0]];
    const intro = element('div', 'goal-editor-intro');
    const goalName = element('strong', 'goal-tone', GOAL_LABELS[goal]);
    goalName.dataset.goal = goal;
    intro.append(
      element('span', 'applies-chip', preset.applicableLegs.map((leg) => LEG_SHORT_LABELS[leg]).join(' + ')),
      goalName,
      element('small', '', 'Light values continue to use Defaults.'),
    );
    body.append(intro, ruleEditor(preset.rules, {
      partial: true,
      inherited,
      inheritLabels: Object.fromEntries(RULE_FIELDS.map(({ key }) => [key, 'Defaults'])),
    }));
  }

  function priceGuard(symbol, leg, legSettings) {
    const key = leg === 'coveredCall' ? 'minNetSalePriceMinor' : 'maxNetPurchasePriceMinor';
    const field = element('div', 'sheet-primary-field');
    const id = `price-guard-${symbol}-${leg}`;
    const label = element('label', '', leg === 'coveredCall' ? 'Minimum net sale price' : 'Maximum net purchase price');
    label.htmlFor = id;
    const wrap = element('div', 'money-input');
    wrap.append(element('span', '', '$'));
    const input = document.createElement('input');
    input.id = id;
    constrainNumericInput(input);
    input.min = '0';
    input.step = '0.01';
    input.placeholder = 'No guard';
    input.value = dollarsFromMinor(legSettings[key]);
    input.addEventListener('input', () => {
      const parsed = input.value.trim() ? dollarsToMinor(input.value) : null;
      input.setCustomValidity(input.value.trim() && parsed == null ? 'Use dollars with no more than two decimal places.' : '');
      legSettings[key] = input.value.trim() && parsed == null ? input.value.trim() : parsed;
      markEditorDirty();
      editorError();
    });
    wrap.append(input);
    field.append(label, wrap);
    return field;
  }

  function renderTickerEditor(body) {
    const { symbol, leg, draft } = model.editor;
    if (model.editor.removed) {
      const removed = element('div', 'settings-empty');
      removed.append(element('strong', '', `${symbol} settings will be removed`), element('p', '', 'Its Defaults and Goal values remain available.'));
      body.append(removed);
      return;
    }
    const playbook = draft.tickerPlaybooks[symbol];
    const tabs = element('div', 'layer-tabs sheet-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', `${symbol} strategy`);
    renderTabs(tabs, Object.entries(LEG_SHORT_LABELS), leg, (nextLeg) => {
      model.editor.leg = nextLeg;
      renderEditor();
    }, 'ticker-leg', 'ticker-leg-panel');
    const panel = element('div', 'ticker-leg-panel');
    panel.id = 'ticker-leg-panel';
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `ticker-leg-${leg}-tab`);
    body.append(tabs, panel);

    const legSettings = playbook[leg];
    const primary = element('div', 'ticker-sheet-primary');

    const controls = element('div', 'ticker-sheet-fields');
    const goalField = element('div', 'sheet-primary-field goal-tone');
    goalField.dataset.goal = legSettings.goal;
    const goalLabel = element('label');
    const goal = document.createElement('select');
    for (const allowed of ALLOWED_GOALS[leg]) {
      const option = element('option', '', GOAL_LABELS[allowed]);
      option.value = allowed;
      option.selected = allowed === legSettings.goal;
      goal.append(option);
    }
    goal.addEventListener('change', () => {
      legSettings.goal = goal.value;
      markEditorDirty();
      renderEditor();
    });
    goalLabel.append(goal);
    goalField.append(element('span', 'field-label', 'Goal'), goalLabel);
    controls.append(goalField, priceGuard(symbol, leg, legSettings));
    primary.append(controls);
    panel.append(primary);

    const preset = draft.goalPresets[legSettings.goal].rules;
    const inherited = { ...draft.globalRules[leg], ...preset };
    const inheritLabels = Object.fromEntries(RULE_FIELDS.map(({ key }) => [
      key,
      Object.hasOwn(preset, key) ? GOAL_LABELS[legSettings.goal] : 'Defaults',
    ]));
    const count = Object.keys(legSettings.overrides).length;
    panel.append(
      element('p', 'editor-effective-note', `Using ${GOAL_LABELS[legSettings.goal]} with ${count} ${symbol} change${count === 1 ? '' : 's'}.`),
      ruleEditor(legSettings.overrides, { partial: true, inherited, inheritLabels }),
    );

    if (model.settings.tickerPlaybooks[symbol]) {
      const remove = element('button', 'remove-playbook', 'Remove saved ticker settings');
      remove.type = 'button';
      remove.addEventListener('click', () => {
        if (!window.confirm(`Remove the ${symbol} playbook?`)) return;
        delete draft.tickerPlaybooks[symbol];
        model.editor.removed = true;
        markEditorDirty();
        renderEditor();
      });
      panel.append(remove);
    }
  }

  function setEditorHeader(title, description, resetLabel, saveLabel, resetVisible = true) {
    document.querySelector('#settings-editor-title').textContent = title;
    document.querySelector('#settings-editor-description').textContent = description;
    const reset = document.querySelector('#settings-reset-defaults');
    reset.textContent = resetLabel;
    reset.hidden = !resetVisible;
    document.querySelector('#save-strategy-settings').textContent = saveLabel;
  }

  function renderEditor() {
    const body = document.querySelector('#settings-editor-body');
    body.replaceChildren();
    const error = element('div', 'settings-editor-error');
    error.id = 'settings-editor-error';
    error.role = 'alert';
    error.tabIndex = -1;
    error.hidden = true;
    body.append(error);
    const editor = model.editor;
    if (editor.kind === 'global') {
      setEditorHeader(`Edit ${LEG_SHORT_LABELS[editor.leg]} Defaults`, 'Changes become the baseline', `Reset ${LEG_SHORT_LABELS[editor.leg]}`, 'Save changes');
      renderGlobalEditor(body);
    } else if (editor.kind === 'goal') {
      setEditorHeader(`Edit ${GOAL_LABELS[editor.goal]}`, 'Tune this starting profile', `Reset ${GOAL_LABELS[editor.goal]}`, 'Save changes');
      renderGoalEditor(body);
    } else if (editor.kind === 'ticker') {
      setEditorHeader(editor.symbol, 'Ticker settings', `Reset ${LEG_SHORT_LABELS[editor.leg]}`, editor.removed ? 'Save removal' : 'Save changes', !editor.removed);
      renderTickerEditor(body);
    }
  }

  function resetEditor() {
    const editor = model.editor;
    if (!editor) return;
    if (editor.kind === 'global') editor.draft.globalRules[editor.leg] = deepCopy(BUILT_IN_GLOBAL);
    if (editor.kind === 'goal') editor.draft.goalPresets[editor.goal].rules = deepCopy(BUILT_IN_GOALS[editor.goal]);
    if (editor.kind === 'ticker') editor.draft.tickerPlaybooks[editor.symbol][editor.leg] = deepCopy(seededPlaybook(editor.symbol)[editor.leg]);
    markEditorDirty();
    renderEditor();
  }

  async function saveEditor(event) {
    event.preventDefault();
    if (!model.editor) return;
    if (model.editor.kind === 'ticker' && !model.editor.removed) {
      for (const settings of Object.values(model.editor.draft.tickerPlaybooks[model.editor.symbol])) settings.enabled = true;
    }
    try {
      validateDraft(model.editor.draft);
    } catch (error) {
      editorError(error.message);
      return;
    }
    const button = document.querySelector('#save-strategy-settings');
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    editorError('');
    try {
      const result = await request('/api/v1/strategy-settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(model.editor.draft),
      });
      model.settings = deepCopy(result.settings);
      model.persistence = result.persistence;
      model.editor.dirty = false;
      closeEditor({ force: true });
      renderAll();
      document.dispatchEvent(new CustomEvent('strategy-settings-saved'));
      setStatus('Settings saved', 'success');
      notify('Settings saved', 'success');
      setTimeout(() => {
        if (status().classList.contains('is-success')) status().hidden = true;
      }, 3000);
    } catch (error) {
      editorError(`Settings were not saved: ${error.message}`);
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }

  async function load(force = false) {
    if ((model.loaded && !force) || model.loading) return;
    model.loading = true;
    setStatus('Loading strategy settings…', 'loading');
    for (const button of document.querySelectorAll('.settings-edit')) button.disabled = true;
    try {
      const result = await request('/api/v1/strategy-settings');
      model.settings = deepCopy(result.settings);
      model.persistence = result.persistence;
      model.loaded = true;
      renderAll();
      setStatus('', 'ready', { hide: true });
    } catch (error) {
      model.loaded = false;
      setStatus(`Strategy settings could not be loaded: ${error.message}`, 'error', { retry: true });
    } finally {
      model.loading = false;
      for (const button of document.querySelectorAll('.settings-edit')) button.disabled = !model.loaded;
    }
  }

  function trapFocus(event) {
    if (event.key !== 'Tab' || !model.editor) return;
    const focusable = [...sheet().querySelectorAll('button:not([disabled]):not([hidden]), input:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')]
      .filter((node) => !node.hidden && node.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === sheet())) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function dragStart(event) {
    if (!model.editor || event.button !== 0 || event.target.closest('button')) return;
    drag = { pointerId: event.pointerId, startY: event.clientY, lastY: event.clientY, lastTime: event.timeStamp, velocity: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
    overlay().classList.add('is-dragging');
  }

  function dragMove(event) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const distance = Math.max(0, event.clientY - drag.startY);
    const elapsed = Math.max(1, event.timeStamp - drag.lastTime);
    drag.velocity = (event.clientY - drag.lastY) / elapsed;
    drag.lastY = event.clientY;
    drag.lastTime = event.timeStamp;
    sheet().style.transform = `translateY(${distance}px)`;
    overlay().querySelector('.settings-editor-backdrop').style.opacity = String(Math.max(0, 1 - distance / 420));
  }

  function dragEnd(event) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const distance = Math.max(0, event.clientY - drag.startY);
    const shouldClose = distance > 88 || (distance > 28 && drag.velocity > 0.55);
    drag = null;
    overlay().classList.remove('is-dragging');
    if (shouldClose) closeEditor();
    else {
      sheet().style.removeProperty('transform');
      overlay().querySelector('.settings-editor-backdrop').style.removeProperty('opacity');
    }
  }

  function confirmLeave() {
    return !model.editor?.dirty || window.confirm('Discard the unsaved Settings changes?');
  }

  function refresh() {
    if (model.loaded) renderTickers();
  }

  function initialize() {
    document.querySelector('#edit-global-settings').addEventListener('click', openGlobalEditor);
    document.querySelector('#edit-goal-settings').addEventListener('click', openGoalEditor);
    document.querySelector('#settings-editor-form').addEventListener('submit', saveEditor);
    document.querySelector('#settings-reset-defaults').addEventListener('click', resetEditor);
    document.querySelector('#settings-ticker-search').addEventListener('input', (event) => {
      model.tickerQuery = event.currentTarget.value;
      model.tickersExpanded = false;
      if (model.loaded) renderTickers();
    });
    for (const button of document.querySelectorAll('[data-settings-editor-close]')) {
      button.addEventListener('click', () => closeEditor());
    }
    document.addEventListener('keydown', (event) => {
      if (!model.editor) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeEditor();
      } else trapFocus(event);
    });
    const dragZone = document.querySelector('#settings-editor-drag-zone');
    dragZone.addEventListener('pointerdown', dragStart);
    dragZone.addEventListener('pointermove', dragMove);
    dragZone.addEventListener('pointerup', dragEnd);
    dragZone.addEventListener('pointercancel', dragEnd);
    window.addEventListener('beforeunload', (event) => {
      if (!model.editor?.dirty) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }

  return { initialize, load, confirmLeave, refresh, addTicker, removeTicker };
}
