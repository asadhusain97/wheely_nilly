import { createGlossaryTerm } from './glossary.js';

const RULE_FIELDS = [
  { key: 'minDte', label: 'Minimum DTE', short: 'Min DTE', step: 1, min: 1, max: 365 },
  { key: 'maxDte', label: 'Maximum DTE', short: 'Max DTE', step: 1, min: 1, max: 730 },
  { key: 'targetDeltaMin', label: 'Minimum delta', short: 'Min delta', step: 0.01, min: 0, max: 1, nullable: true },
  { key: 'targetDeltaMax', label: 'Maximum delta', short: 'Max delta', step: 0.01, min: 0, max: 1, nullable: true },
  { key: 'minPeriodReturn', label: 'Minimum period return', short: 'Min return', step: 0.1, min: 0, max: 1000, scale: 100, suffix: '%' },
  { key: 'closeAtProfitCapture', label: 'Close when premium captured', short: 'Close when premium captured', step: 1, min: 0.01, max: 100, scale: 100, suffix: '%' },
  { key: 'minMoneyness', label: 'Minimum strike / stock', short: 'Min moneyness', step: 1, min: 0.01, max: 200, scale: 100, suffix: '%' },
  { key: 'maxMoneyness', label: 'Maximum strike / stock', short: 'Max moneyness', step: 1, min: 0.01, max: 300, scale: 100, suffix: '%' },
  { key: 'maxSpreadPercent', label: 'Maximum bid / ask spread', short: 'Max spread', step: 1, min: 0.01, max: 100, scale: 100, suffix: '%' },
  { key: 'minOpenInterest', label: 'Minimum open interest', short: 'Min open interest', step: 1, min: 0, integer: true },
  { key: 'minVolume', label: 'Minimum daily volume', short: 'Min volume', step: 1, min: 0, integer: true },
];

const FIELD_BY_KEY = Object.fromEntries(RULE_FIELDS.map((field) => [field.key, field]));
const CORE_FIELDS = RULE_FIELDS.slice(0, 5);
const ADVANCED_FIELDS = RULE_FIELDS.slice(5);
const GLOSSARY_TERM_BY_RULE_KEY = {
  minDte: 'DTE',
  maxDte: 'DTE',
  targetDeltaMin: 'Delta',
  targetDeltaMax: 'Delta',
  minPeriodReturn: 'Minimum return',
  closeAtProfitCapture: 'Premium capture',
  minMoneyness: 'Moneyness',
  maxMoneyness: 'Moneyness',
  maxSpreadPercent: 'Maximum spread',
  minOpenInterest: 'Minimum open interest',
  minVolume: 'Minimum volume',
};
const LEG_LABELS = {
  coveredCall: 'Covered call',
  cashSecuredPut: 'Cash-secured put',
};
const LEG_SHORT_LABELS = {
  coveredCall: 'CC',
  cashSecuredPut: 'CSP',
};
const GOAL_LABELS = {
  protect: 'Keep Shares',
  income: 'Earn Income',
  exit: 'Plan Exit',
  acquire: 'Plan Entry',
};
const GOAL_COPY = {
  protect: 'More room for shares you want to keep.',
  income: 'Balance premium with room for the stock to move.',
  exit: 'Favor calls that could sell shares near your target.',
  acquire: 'Shape puts around your planned entry.',
};
const ALLOWED_GOALS = {
  coveredCall: ['protect', 'income', 'exit'],
  cashSecuredPut: ['income', 'acquire'],
};
const GOAL_LEGS = {
  protect: ['coveredCall'],
  income: ['coveredCall', 'cashSecuredPut'],
  exit: ['coveredCall'],
  acquire: ['cashSecuredPut'],
};
export const SYSTEM_RULES = {
  minDte: 7,
  maxDte: 45,
  minMoneyness: 0.8,
  maxMoneyness: 1.2,
  targetDeltaMin: null,
  targetDeltaMax: 0.35,
  maxSpreadPercent: 0.2,
  minOpenInterest: 10,
  minVolume: 0,
  minPeriodReturn: 0,
  closeAtProfitCapture: 0.50,
};
const BUILT_IN_GOAL_PROFILES = {
  protect: { coveredCall: {
    minDte: 30, maxDte: 60, minMoneyness: 1.05, maxMoneyness: 1.25,
    targetDeltaMin: 0.08, targetDeltaMax: 0.18, maxSpreadPercent: 0.08,
    minOpenInterest: 100, minVolume: 20, minPeriodReturn: 0.002,
    closeAtProfitCapture: 0.35,
  } },
  income: {
    coveredCall: {
      minDte: 14, maxDte: 35, minMoneyness: 1, maxMoneyness: 1.1,
      targetDeltaMin: 0.30, targetDeltaMax: 0.45, maxSpreadPercent: 0.08,
      minOpenInterest: 100, minVolume: 20, minPeriodReturn: 0.01,
      closeAtProfitCapture: 0.50,
    },
    cashSecuredPut: {
      minDte: 14, maxDte: 35, minMoneyness: 0.9, maxMoneyness: 1,
      targetDeltaMin: 0.30, targetDeltaMax: 0.45, maxSpreadPercent: 0.08,
      minOpenInterest: 100, minVolume: 20, minPeriodReturn: 0.01,
      closeAtProfitCapture: 0.50,
    },
  },
  exit: { coveredCall: {
    minDte: 7, maxDte: 21, minMoneyness: 0.95, maxMoneyness: 1.05,
    targetDeltaMin: 0.45, targetDeltaMax: 0.65, maxSpreadPercent: 0.10,
    minOpenInterest: 50, minVolume: 10, minPeriodReturn: 0.0025,
    closeAtProfitCapture: 0.90,
  } },
  acquire: { cashSecuredPut: {
    minDte: 7, maxDte: 28, minMoneyness: 0.97, maxMoneyness: 1,
    targetDeltaMin: 0.40, targetDeltaMax: 0.55, maxSpreadPercent: 0.10,
    minOpenInterest: 50, minVolume: 10, minPeriodReturn: 0.005,
    closeAtProfitCapture: 0.85,
  } },
};

export function builtInSettingsDocument() {
  return { schemaVersion: 2, goalProfiles: structuredClone(BUILT_IN_GOAL_PROFILES), tickerPlaybooks: {} };
}

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
    coveredCall: { enabled: false, goal: 'income', minNetSalePriceMinor: null, overrides: {} },
    cashSecuredPut: { enabled: false, goal: 'acquire', maxNetPurchasePriceMinor: null, overrides: {} },
  };
}

export function settingsWithTicker(settings, symbol, leg, goal) {
  if (!ALLOWED_GOALS[leg]?.includes(goal)) throw new Error('Choose a goal supported by this strategy.');
  const draft = deepCopy(settings);
  if (!draft.tickerPlaybooks[symbol]) {
    draft.tickerPlaybooks[symbol] = defaultPlaybook();
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
  const goalRules = ticker ? settings.goalProfiles[ticker.goal][leg] : SYSTEM_RULES;
  return { ...goalRules, ...(ticker?.overrides ?? {}) };
}

function rulesError(rules, scope) {
  for (const field of RULE_FIELDS) {
    const value = rules[field.key];
    if (value == null && field.nullable) continue;
    if (!Number.isFinite(value)) return `${scope}: ${field.label} needs a number.`;
    const display = uiValue(field, value);
    if (field.min != null && display < field.min) return `${scope}: ${field.label} is below its allowed minimum.`;
    if (field.max != null && display > field.max) return `${scope}: ${field.label} is above its allowed maximum.`;
    if ((field.integer || ['minDte', 'maxDte'].includes(field.key)) && !Number.isSafeInteger(value)) {
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
  for (const [goal, profiles] of Object.entries(settings.goalProfiles)) {
    for (const [leg, rules] of Object.entries(profiles)) {
      const error = rulesError(rules, `${GOAL_LABELS[goal]} ${LEG_SHORT_LABELS[leg]}`);
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

export function resolveTickerLeg(playbook, tracked) {
  const preferredLeg = tracked?.preferredLeg ?? (playbook.coveredCall.enabled ? 'coveredCall' : 'cashSecuredPut');
  const firstEnabled = ['coveredCall', 'cashSecuredPut'].find((leg) => playbook[leg].enabled);
  return playbook[preferredLeg].enabled ? preferredLeg : (firstEnabled ?? preferredLeg);
}

export function resolveTickerGoal(playbook, tracked) {
  const leg = resolveTickerLeg(playbook, tracked);
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
    preset: 'protect',
    goalLeg: 'coveredCall',
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
      const isGoal = ['goal', 'ticker-goal'].includes(prefix);
      const button = element('button', `${isGoal ? 'goal-chip ' : ''}${active ? 'is-active' : ''}`.trim(), label);
      if (isGoal) button.dataset.goal = key;
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

  function summaryLabel(label, glossaryTerms) {
    return glossaryTerms
      ? createGlossaryTerm(label, label, 'settings-rule-label')
      : element('span', 'settings-rule-label', label);
  }

  function rangeSummary(label, rules, first, second, specificKeys, source, suffix = '', glossaryTerms = false) {
    const row = element('div', 'settings-rule-row');
    row.append(summaryLabel(label, glossaryTerms));
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

  function singleSummary(label, rules, key, specificKeys, source, glossaryTerms = false) {
    const row = element('div', 'settings-rule-row');
    row.append(summaryLabel(label, glossaryTerms));
    const value = element('div', 'settings-rule-value');
    value.append(valueToken(key, rules[key], specificKeys.has(key), source));
    row.append(value);
    return row;
  }

  function ruleSummary(rules, specificKeys, source, { glossaryTerms = false } = {}) {
    const list = element('div', 'settings-rule-list');
    list.append(
      rangeSummary('DTE', rules, 'minDte', 'maxDte', specificKeys, source, 'days', glossaryTerms),
      rangeSummary('Delta', rules, 'targetDeltaMin', 'targetDeltaMax', specificKeys, source, '', glossaryTerms),
      singleSummary('Minimum return', rules, 'minPeriodReturn', specificKeys, source, glossaryTerms),
      singleSummary('Close when premium captured', rules, 'closeAtProfitCapture', specificKeys, source, glossaryTerms),
    );
    const advanced = element('details', 'settings-rule-advanced');
    const advancedSummary = element('summary');
    advancedSummary.append(element('span', '', 'Advanced rules'), icon('chevron', 'ui-icon disclosure-icon'));
    advanced.append(advancedSummary);
    const advancedList = element('div', 'settings-rule-list');
    advancedList.append(
      rangeSummary('Moneyness', rules, 'minMoneyness', 'maxMoneyness', specificKeys, source, '', glossaryTerms),
      singleSummary('Maximum spread', rules, 'maxSpreadPercent', specificKeys, source, glossaryTerms),
      singleSummary('Minimum open interest', rules, 'minOpenInterest', specificKeys, source, glossaryTerms),
      singleSummary('Minimum volume', rules, 'minVolume', specificKeys, source, glossaryTerms),
    );
    advanced.append(advancedList);
    list.append(advanced);
    return list;
  }

  function renderGoal() {
    renderTabs(
      document.querySelector('#goal-preset-tabs'),
      Object.entries(GOAL_LABELS),
      model.preset,
      (goal) => {
        model.preset = goal;
        model.goalLeg = GOAL_LEGS[goal].includes(model.goalLeg) ? model.goalLeg : GOAL_LEGS[goal][0];
        renderGoal();
      },
      'goal',
      'goal-rules-view',
    );
    const legs = GOAL_LEGS[model.preset];
    const leg = legs.includes(model.goalLeg) ? model.goalLeg : legs[0];
    model.goalLeg = leg;
    const rules = model.settings.goalProfiles[model.preset][leg];
    const view = document.querySelector('#goal-rules-view');
    view.setAttribute('aria-labelledby', `goal-${model.preset}-tab`);
    view.replaceChildren();
    const context = element('div', 'rule-view-context goal-context');
    const copy = element('div');
    const goalName = element('strong', 'goal-tone', GOAL_LABELS[model.preset]);
    goalName.dataset.goal = model.preset;
    copy.append(goalName, element('small', '', GOAL_COPY[model.preset]));
    const strategyControl = element('span', 'applies-chip', LEG_SHORT_LABELS[leg]);
    if (model.preset === 'income') {
      strategyControl.className = 'layer-tabs strategy-tabs goal-inline-strategy-tabs';
      strategyControl.setAttribute('role', 'tablist');
      strategyControl.setAttribute('aria-label', 'Earn Income strategy');
      renderTabs(
        strategyControl,
        Object.entries(LEG_SHORT_LABELS),
        leg,
        (nextLeg) => {
          model.goalLeg = nextLeg;
          renderGoal();
        },
        'goal-leg',
        'goal-rules-view',
      );
    }
    context.append(copy, strategyControl);
    view.append(context, ruleSummary(rules, new Set(RULE_FIELDS.map(({ key }) => key)), GOAL_LABELS[model.preset], { glossaryTerms: true }));
    document.querySelector('#edit-goal-settings').setAttribute('aria-label', `Edit ${GOAL_LABELS[model.preset]} ${LEG_LABELS[leg]} settings`);
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

  function openGoalEditor() {
    openEditor({ kind: 'goal', goal: model.preset, leg: model.goalLeg });
  }

  function openTickerEditor(symbol) {
    const playbook = model.settings.tickerPlaybooks[symbol] ?? seededPlaybook(symbol);
    openEditor({ kind: 'ticker', symbol, leg: resolveTickerLeg(playbook, trackedTickers().get(symbol)) });
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

  function ruleField(field, rules, {
    partial = false,
    inherited = {},
    inheritLabels = {},
    glossaryTerms = false,
  } = {}) {
    const overridden = Object.hasOwn(rules, field.key);
    const id = `strategy-rule-${inputSequence += 1}`;
    const row = element('div', `editor-rule-row${partial && !overridden ? ' is-inherited' : ''}`);
    const copy = element('div', 'editor-rule-copy');
    const label = element('label', glossaryTerms ? 'sr-only' : '', field.label);
    label.htmlFor = id;
    const helper = element('small', '', partial && !overridden ? `From ${inheritLabels[field.key] ?? 'the layer above'}` : '');
    helper.hidden = !partial || overridden;
    if (glossaryTerms) {
      copy.append(
        createGlossaryTerm(field.label, GLOSSARY_TERM_BY_RULE_KEY[field.key] ?? field.label, 'editor-rule-label'),
        label,
        helper,
      );
    } else copy.append(label, helper);

    const controls = element('div', 'editor-rule-controls');
    const inputWrap = element('div', 'rule-input');
    const input = document.createElement('input');
    input.id = id;
    const wholeNumber = field.integer || ['minDte', 'maxDte'].includes(field.key);
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

  function renderGoalEditor(body) {
    const { goal, leg, draft } = model.editor;
    const intro = element('div', 'goal-editor-intro');
    const goalName = element('strong', 'goal-tone', GOAL_LABELS[goal]);
    goalName.dataset.goal = goal;
    intro.append(
      element('span', 'applies-chip', LEG_SHORT_LABELS[leg]),
      goalName,
      element('small', '', GOAL_COPY[goal]),
    );
    body.append(intro);
    if (goal === 'income') {
      const tabs = element('div', 'layer-tabs strategy-tabs sheet-tabs goal-editor-strategy');
      tabs.setAttribute('role', 'tablist');
      tabs.setAttribute('aria-label', 'Earn Income strategy');
      renderTabs(tabs, Object.entries(LEG_SHORT_LABELS), leg, (nextLeg) => {
        model.editor.leg = nextLeg;
        renderEditor();
      }, 'goal-editor-leg', 'settings-editor-body');
      body.append(tabs);
    }
    body.append(ruleEditor(draft.goalProfiles[goal][leg], { glossaryTerms: true }));
  }

  function priceGuard(symbol, leg, legSettings) {
    const key = leg === 'coveredCall' ? 'minNetSalePriceMinor' : 'maxNetPurchasePriceMinor';
    const row = element('div', 'editor-rule-row ticker-price-guard');
    const id = `price-guard-${symbol}-${leg}`;
    const copy = element('div', 'editor-rule-copy');
    const labelText = leg === 'coveredCall' ? 'Minimum net sale price' : 'Maximum breakeven price';
    const label = element('label', 'sr-only', labelText);
    label.htmlFor = id;
    copy.append(
      createGlossaryTerm(labelText, 'Net price guard', 'editor-rule-label'),
      label,
      element('small', '', 'Optional'),
    );
    const controls = element('div', 'editor-rule-controls');
    const wrap = element('div', 'rule-input');
    wrap.append(element('span', 'currency-prefix', '$'));
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
    controls.append(wrap);
    row.append(copy, controls);
    return row;
  }

  function renderTickerEditor(body) {
    const { symbol, leg, draft } = model.editor;
    if (model.editor.removed) {
      const removed = element('div', 'settings-empty');
      removed.append(element('strong', '', `${symbol} settings will be removed`), element('p', '', 'Your goal profiles will stay available.'));
      body.append(removed);
      return;
    }
    const playbook = draft.tickerPlaybooks[symbol];
    const panel = element('div', 'ticker-leg-panel');
    panel.id = 'ticker-leg-panel';
    body.append(panel);

    const legSettings = playbook[leg];
    const goalField = document.createElement('fieldset');
    goalField.className = 'ticker-goal-field';
    const goalLegend = document.createElement('legend');
    goalLegend.append(createGlossaryTerm('Goal', 'Goal profiles', 'ticker-goal-label'));
    goalField.append(goalLegend);
    const goalTabs = element('div', 'goal-picker ticker-goal-picker');
    goalTabs.setAttribute('role', 'tablist');
    goalTabs.setAttribute('aria-label', `${symbol} goal`);
    renderTabs(
      goalTabs,
      Object.entries(GOAL_LABELS),
      legSettings.goal,
      (nextGoal) => {
        const nextLeg = GOAL_LEGS[nextGoal].includes(leg) ? leg : GOAL_LEGS[nextGoal][0];
        model.editor.leg = nextLeg;
        playbook[nextLeg].goal = nextGoal;
        markEditorDirty();
        renderEditor();
      },
      'ticker-goal',
      'ticker-rules-editor',
    );
    goalField.append(goalTabs);
    panel.append(goalField);

    if (legSettings.goal === 'income') {
      const strategyField = element('div', 'ticker-strategy-field');
      const strategyLabel = element('span', 'ticker-strategy-label', 'Strategy');
      strategyLabel.id = 'ticker-strategy-label';
      const strategyTabs = element('div', 'layer-tabs strategy-tabs sheet-tabs ticker-inline-strategy-tabs');
      strategyTabs.setAttribute('role', 'tablist');
      strategyTabs.setAttribute('aria-labelledby', strategyLabel.id);
      renderTabs(strategyTabs, Object.entries(LEG_SHORT_LABELS), leg, (nextLeg) => {
        model.editor.leg = nextLeg;
        playbook[nextLeg].goal = 'income';
        markEditorDirty();
        renderEditor();
      }, 'ticker-leg', 'ticker-rules-editor');
      strategyField.append(strategyLabel, strategyTabs);
      panel.append(strategyField);
    } else {
      const strategyContext = element('div', 'ticker-fixed-strategy');
      strategyContext.append(element('span', '', 'Strategy'), element('span', 'applies-chip', LEG_SHORT_LABELS[leg]));
      panel.append(strategyContext);
    }

    const inherited = draft.goalProfiles[legSettings.goal][leg];
    const inheritLabels = Object.fromEntries(RULE_FIELDS.map(({ key }) => [key, GOAL_LABELS[legSettings.goal]]));
    const count = Object.keys(legSettings.overrides).length;
    const tickerRules = ruleEditor(legSettings.overrides, {
      partial: true,
      inherited,
      inheritLabels,
      glossaryTerms: true,
    });
    tickerRules.id = 'ticker-rules-editor';
    tickerRules.querySelector('.editor-rule-list').prepend(priceGuard(symbol, leg, legSettings));
    panel.append(
      element('p', 'editor-effective-note', `Using ${GOAL_LABELS[legSettings.goal]} with ${count} ${symbol} change${count === 1 ? '' : 's'}.`),
      tickerRules,
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
    if (editor.kind === 'goal') {
      setEditorHeader(`Edit ${GOAL_LABELS[editor.goal]}`, `${LEG_LABELS[editor.leg]} goal settings`, 'Reset to recommended', 'Save changes');
      renderGoalEditor(body);
    } else if (editor.kind === 'ticker') {
      setEditorHeader(editor.symbol, 'Goal and ticker changes', 'Reset ticker changes', editor.removed ? 'Save removal' : 'Save changes', !editor.removed);
      renderTickerEditor(body);
    }
  }

  function resetEditor() {
    const editor = model.editor;
    if (!editor) return;
    if (editor.kind === 'goal') editor.draft.goalProfiles[editor.goal][editor.leg] = deepCopy(BUILT_IN_GOAL_PROFILES[editor.goal][editor.leg]);
    if (editor.kind === 'ticker') {
      const legSettings = editor.draft.tickerPlaybooks[editor.symbol][editor.leg];
      legSettings.overrides = {};
      if (editor.leg === 'coveredCall') legSettings.minNetSalePriceMinor = null;
      else legSettings.maxNetPurchasePriceMinor = null;
    }
    markEditorDirty();
    renderEditor();
  }

  async function saveEditor(event) {
    event.preventDefault();
    if (!model.editor) return;
    if (model.editor.kind === 'ticker' && !model.editor.removed) {
      model.editor.draft.tickerPlaybooks[model.editor.symbol][model.editor.leg].enabled = true;
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
      if (model.editor.kind === 'goal') model.goalLeg = model.editor.leg;
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
      if (!model.editor || overlay().inert) return;
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
