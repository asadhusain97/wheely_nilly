import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

export const STRATEGY_LEGS = ['coveredCall', 'cashSecuredPut'];
export const GOALS = ['protect', 'income', 'exit', 'acquire'];
export const GOAL_LEGS = {
  protect: ['coveredCall'],
  income: ['coveredCall', 'cashSecuredPut'],
  exit: ['coveredCall'],
  acquire: ['cashSecuredPut'],
};
export const RULE_FIELDS = [
  'minDte',
  'maxDte',
  'minMoneyness',
  'maxMoneyness',
  'targetDeltaMin',
  'targetDeltaMax',
  'maxSpreadPercent',
  'minOpenInterest',
  'minVolume',
  'minPeriodReturn',
  'closeAtProfitCapture',
  'rollReviewDte',
];

const legSchema = z.enum(STRATEGY_LEGS);
export const tickerSymbolSchema = z.string()
  .trim()
  .toUpperCase()
  .pipe(z.string().regex(/^[A-Z][A-Z0-9.-]{0,9}$/, 'must be a valid ticker symbol'));

const safeNonnegativeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ruleShape = {
  minDte: z.number().int().min(1).max(365),
  maxDte: z.number().int().min(1).max(730),
  minMoneyness: z.number().positive().max(2),
  maxMoneyness: z.number().positive().max(3),
  targetDeltaMin: z.number().min(0).max(1).nullable(),
  targetDeltaMax: z.number().min(0).max(1).nullable(),
  maxSpreadPercent: z.number().positive().max(1),
  minOpenInterest: safeNonnegativeInteger,
  minVolume: safeNonnegativeInteger,
  minPeriodReturn: z.number().min(0).max(10),
  closeAtProfitCapture: z.number().positive().max(1),
  rollReviewDte: z.number().int().min(0).max(365),
};

const legacyRuleShape = {
  ...ruleShape,
  closeAtProfitCapture: ruleShape.closeAtProfitCapture.optional(),
  rollReviewDte: ruleShape.rollReviewDte.optional(),
  maxQuoteAgeSeconds: z.number().int().min(1).max(86_400).optional(),
};

function addRangeIssues(rules, context, pathPrefix = []) {
  if (rules.minDte != null && rules.maxDte != null && rules.minDte > rules.maxDte) {
    context.addIssue({
      code: 'custom',
      path: [...pathPrefix, 'maxDte'],
      message: 'maxDte must be greater than or equal to minDte',
    });
  }
  if (rules.minMoneyness != null && rules.maxMoneyness != null && rules.minMoneyness > rules.maxMoneyness) {
    context.addIssue({
      code: 'custom',
      path: [...pathPrefix, 'maxMoneyness'],
      message: 'maxMoneyness must be greater than or equal to minMoneyness',
    });
  }
  if (rules.targetDeltaMin != null && rules.targetDeltaMax != null && rules.targetDeltaMin > rules.targetDeltaMax) {
    context.addIssue({
      code: 'custom',
      path: [...pathPrefix, 'targetDeltaMax'],
      message: 'targetDeltaMax must be greater than or equal to targetDeltaMin',
    });
  }
}

export const completeRuleSetSchema = z.object(ruleShape).strict()
  .superRefine((rules, context) => addRangeIssues(rules, context));
export const partialRuleSetSchema = z.object(ruleShape).partial().strict()
  .superRefine((rules, context) => addRangeIssues(rules, context));

const v1ProtectPresetSchema = z.object({
  applicableLegs: z.tuple([z.literal('coveredCall')]),
  rules: z.object(legacyRuleShape).partial().strict(),
}).strict();
const v1IncomePresetSchema = z.object({
  applicableLegs: z.tuple([z.literal('coveredCall'), z.literal('cashSecuredPut')]),
  rules: z.object(legacyRuleShape).partial().strict(),
}).strict();
const v1ExitPresetSchema = z.object({
  applicableLegs: z.tuple([z.literal('coveredCall')]),
  rules: z.object(legacyRuleShape).partial().strict(),
}).strict();
const v1AcquirePresetSchema = z.object({
  applicableLegs: z.tuple([z.literal('cashSecuredPut')]),
  rules: z.object(legacyRuleShape).partial().strict(),
}).strict();

const v2CoveredCallPlaybookSchema = z.object({
  enabled: z.boolean(),
  goal: z.enum(['protect', 'income', 'exit']),
  minNetSalePriceMinor: safeNonnegativeInteger.nullable(),
  overrides: partialRuleSetSchema,
}).strict();
const v2CashSecuredPutPlaybookSchema = z.object({
  enabled: z.boolean(),
  goal: z.enum(['income', 'acquire']),
  maxNetPurchasePriceMinor: safeNonnegativeInteger.nullable(),
  overrides: partialRuleSetSchema,
}).strict();

const v2TickerPlaybookSchema = z.object({
  coveredCall: v2CoveredCallPlaybookSchema,
  cashSecuredPut: v2CashSecuredPutPlaybookSchema,
}).strict();

const v2TickerPlaybooksSchema = z.record(tickerSymbolSchema, v2TickerPlaybookSchema);

const legacyCoveredCallPlaybookSchema = v2CoveredCallPlaybookSchema.extend({
  overrides: z.object(legacyRuleShape).partial().strict(),
});
const legacyCashSecuredPutPlaybookSchema = v2CashSecuredPutPlaybookSchema.extend({
  overrides: z.object(legacyRuleShape).partial().strict(),
});
const legacyTickerPlaybooksSchema = z.record(tickerSymbolSchema, z.object({
  coveredCall: legacyCoveredCallPlaybookSchema,
  cashSecuredPut: legacyCashSecuredPutPlaybookSchema,
}).strict());

const v1EditableDocumentShape = {
  schemaVersion: z.literal(1),
  globalRules: z.object({
    coveredCall: z.object(legacyRuleShape).strict(),
    cashSecuredPut: z.object(legacyRuleShape).strict(),
  }).strict(),
  goalPresets: z.object({
    protect: v1ProtectPresetSchema,
    income: v1IncomePresetSchema,
    exit: v1ExitPresetSchema,
    acquire: v1AcquirePresetSchema,
  }).strict(),
  tickerPlaybooks: legacyTickerPlaybooksSchema,
};

const v1DocumentSchema = z.object(v1EditableDocumentShape).strict()
  .superRefine((document, context) => {
    for (const [goal, preset] of Object.entries(document.goalPresets)) {
      for (const leg of preset.applicableLegs) {
        addRangeIssues(
          { ...document.globalRules[leg], ...preset.rules },
          context,
          ['goalPresets', goal, 'rules'],
        );
      }
    }
    for (const [symbol, playbook] of Object.entries(document.tickerPlaybooks)) {
      for (const leg of STRATEGY_LEGS) {
        const legSettings = playbook[leg];
        const preset = document.goalPresets[legSettings.goal];
        if (!preset.applicableLegs.includes(leg)) {
          context.addIssue({
            code: 'custom',
            path: ['tickerPlaybooks', symbol, leg, 'goal'],
            message: `${legSettings.goal} is not compatible with ${leg}`,
          });
          continue;
        }
        addRangeIssues(
          { ...document.globalRules[leg], ...preset.rules, ...legSettings.overrides },
          context,
          ['tickerPlaybooks', symbol, leg, 'overrides'],
        );
      }
    }
  });

const goalProfilesSchema = z.object({
  protect: z.object({ coveredCall: completeRuleSetSchema }).strict(),
  income: z.object({
    coveredCall: completeRuleSetSchema,
    cashSecuredPut: completeRuleSetSchema,
  }).strict(),
  exit: z.object({ coveredCall: completeRuleSetSchema }).strict(),
  acquire: z.object({ cashSecuredPut: completeRuleSetSchema }).strict(),
}).strict();

const coveredCallPlaybookSchema = z.object({
  enabled: z.boolean(),
  minNetSalePriceMinor: safeNonnegativeInteger.nullable(),
  overrides: partialRuleSetSchema,
}).strict();
const cashSecuredPutPlaybookSchema = z.object({
  enabled: z.boolean(),
  maxNetPurchasePriceMinor: safeNonnegativeInteger.nullable(),
  overrides: partialRuleSetSchema,
}).strict();
const tickerPlaybookSchema = z.object({
  goal: z.enum(GOALS),
  coveredCall: coveredCallPlaybookSchema,
  cashSecuredPut: cashSecuredPutPlaybookSchema,
}).strict();
const tickerPlaybooksSchema = z.record(tickerSymbolSchema, tickerPlaybookSchema);

const editableDocumentShape = {
  schemaVersion: z.literal(3),
  goalProfiles: goalProfilesSchema,
  tickerPlaybooks: tickerPlaybooksSchema,
};

export const strategySettingsDocumentSchema = z.object(editableDocumentShape).strict()
  .superRefine((document, context) => {
    for (const [symbol, playbook] of Object.entries(document.tickerPlaybooks)) {
      for (const leg of STRATEGY_LEGS) {
        const legSettings = playbook[leg];
        const goalRules = document.goalProfiles[playbook.goal]?.[leg] ?? SYSTEM_RULE_DEFAULTS;
        addRangeIssues(
          { ...goalRules, ...legSettings.overrides },
          context,
          ['tickerPlaybooks', symbol, leg, 'overrides'],
        );
      }
    }
  });

const v2EditableDocumentShape = {
  schemaVersion: z.literal(2),
  goalProfiles: goalProfilesSchema,
  tickerPlaybooks: v2TickerPlaybooksSchema,
};
const v2DocumentSchema = z.object(v2EditableDocumentShape).strict();

const persistedDocumentSchema = z.object({
  ...editableDocumentShape,
  updatedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((document, context) => {
  const editable = {
    schemaVersion: document.schemaVersion,
    goalProfiles: document.goalProfiles,
    tickerPlaybooks: document.tickerPlaybooks,
  };
  const result = strategySettingsDocumentSchema.safeParse(editable);
  if (!result.success) {
    for (const issue of result.error.issues) context.addIssue(issue);
  }
});

const persistedV1DocumentSchema = z.object({
  ...v1EditableDocumentShape,
  updatedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((document, context) => {
  const editable = {
    schemaVersion: document.schemaVersion,
    globalRules: document.globalRules,
    goalPresets: document.goalPresets,
    tickerPlaybooks: document.tickerPlaybooks,
  };
  const result = v1DocumentSchema.safeParse(editable);
  if (!result.success) {
    for (const issue of result.error.issues) context.addIssue(issue);
  }
});

const persistedV2DocumentSchema = z.object({
  ...v2EditableDocumentShape,
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

const SYSTEM_RULE_DEFAULTS = {
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
  rollReviewDte: 7,
};

const completeProfile = (rules = {}, rollReviewDte = Math.min(10, rules.minDte ?? SYSTEM_RULE_DEFAULTS.minDte)) => {
  const profile = { ...SYSTEM_RULE_DEFAULTS, ...rules };
  return {
    ...profile,
    rollReviewDte: rules.rollReviewDte ?? rollReviewDte,
  };
};

const BUILT_IN_SETTINGS = {
  schemaVersion: 3,
  goalProfiles: {
    protect: { coveredCall: {
      minDte: 30, maxDte: 60, minMoneyness: 1.05, maxMoneyness: 1.25,
      targetDeltaMin: 0.08, targetDeltaMax: 0.18, maxSpreadPercent: 0.08,
      minOpenInterest: 100, minVolume: 20, minPeriodReturn: 0.002,
      closeAtProfitCapture: 0.35, rollReviewDte: 21,
    } },
    income: {
      coveredCall: {
        minDte: 14, maxDte: 35, minMoneyness: 1, maxMoneyness: 1.1,
        targetDeltaMin: 0.30, targetDeltaMax: 0.45, maxSpreadPercent: 0.08,
        minOpenInterest: 100, minVolume: 20, minPeriodReturn: 0.01,
        closeAtProfitCapture: 0.50, rollReviewDte: 21,
      },
      cashSecuredPut: {
        minDte: 14, maxDte: 35, minMoneyness: 0.9, maxMoneyness: 1,
        targetDeltaMin: 0.30, targetDeltaMax: 0.45, maxSpreadPercent: 0.08,
        minOpenInterest: 100, minVolume: 20, minPeriodReturn: 0.01,
        closeAtProfitCapture: 0.50, rollReviewDte: 21,
      },
    },
    exit: { coveredCall: {
      minDte: 7, maxDte: 21, minMoneyness: 0.95, maxMoneyness: 1.05,
      targetDeltaMin: 0.45, targetDeltaMax: 0.65, maxSpreadPercent: 0.10,
      minOpenInterest: 50, minVolume: 10, minPeriodReturn: 0.0025,
      closeAtProfitCapture: 0.90, rollReviewDte: 7,
    } },
    acquire: { cashSecuredPut: {
      minDte: 7, maxDte: 28, minMoneyness: 0.97, maxMoneyness: 1,
      targetDeltaMin: 0.40, targetDeltaMax: 0.55, maxSpreadPercent: 0.10,
      minOpenInterest: 50, minVolume: 10, minPeriodReturn: 0.005,
      closeAtProfitCapture: 0.85, rollReviewDte: 7,
    } },
  },
  tickerPlaybooks: {},
};

const ORIGINAL_BUILT_IN_GOAL_PROFILES = {
  protect: { coveredCall: completeProfile({ minDte: 30, maxDte: 60, targetDeltaMin: 0.1, targetDeltaMax: 0.2 }) },
  income: {
    coveredCall: completeProfile({ minDte: 21, maxDte: 45, targetDeltaMin: 0.2, targetDeltaMax: 0.35 }),
    cashSecuredPut: completeProfile({ minDte: 21, maxDte: 45, targetDeltaMin: 0.2, targetDeltaMax: 0.35 }),
  },
  exit: { coveredCall: completeProfile({ minDte: 7, maxDte: 30, targetDeltaMin: 0.35, targetDeltaMax: 0.7 }) },
  acquire: { cashSecuredPut: completeProfile({ minDte: 21, maxDte: 45, targetDeltaMin: 0.2, targetDeltaMax: 0.35 }) },
};

const PREVIOUS_BUILT_IN_GOAL_PROFILES = {
  protect: { coveredCall: { ...BUILT_IN_SETTINGS.goalProfiles.protect.coveredCall, rollReviewDte: 10 } },
  income: {
    coveredCall: { ...BUILT_IN_SETTINGS.goalProfiles.income.coveredCall, rollReviewDte: 10 },
    cashSecuredPut: { ...BUILT_IN_SETTINGS.goalProfiles.income.cashSecuredPut, rollReviewDte: 10 },
  },
  exit: structuredClone(BUILT_IN_SETTINGS.goalProfiles.exit),
  acquire: structuredClone(BUILT_IN_SETTINGS.goalProfiles.acquire),
};

export function builtInStrategySettings() {
  return structuredClone(BUILT_IN_SETTINGS);
}

export function migrateV1StrategySettings(input) {
  const settings = v1DocumentSchema.parse(input);
  const goalProfiles = {};
  for (const [goal, preset] of Object.entries(settings.goalPresets)) {
    goalProfiles[goal] = Object.fromEntries(preset.applicableLegs.map((leg) => [
      leg,
      completeProfile(withoutLegacyQuoteAge({ ...settings.globalRules[leg], ...preset.rules })),
    ]));
  }
  return {
    schemaVersion: 3,
    goalProfiles,
    tickerPlaybooks: migrateV2Playbooks(settings.tickerPlaybooks),
  };
}

function withoutLegacyQuoteAge(rules) {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return rules;
  const { maxQuoteAgeSeconds: _removed, ...current } = rules;
  return current;
}

function normalizeV2Playbooks(playbooks) {
  if (!playbooks || typeof playbooks !== 'object' || Array.isArray(playbooks)) return playbooks;
  return Object.fromEntries(Object.entries(playbooks).map(([symbol, playbook]) => {
    if (!playbook || typeof playbook !== 'object' || Array.isArray(playbook)) return [symbol, playbook];
    const normalizeLeg = (leg) => leg && typeof leg === 'object' && !Array.isArray(leg)
      ? { ...leg, overrides: withoutLegacyQuoteAge(leg.overrides) }
      : leg;
    return [symbol, {
      ...playbook,
      coveredCall: normalizeLeg(playbook.coveredCall),
      cashSecuredPut: normalizeLeg(playbook.cashSecuredPut),
    }];
  }));
}

function legacyTickerGoal(playbook) {
  const enabledGoals = STRATEGY_LEGS
    .filter((leg) => playbook?.[leg]?.enabled)
    .map((leg) => playbook[leg].goal);
  const unique = [...new Set(enabledGoals)];
  if (unique.length === 1) return unique[0];
  if (unique.includes('income')) return 'income';
  return unique[0] ?? playbook?.coveredCall?.goal ?? playbook?.cashSecuredPut?.goal ?? 'income';
}

function migrateV2Playbooks(playbooks) {
  const normalized = normalizeV2Playbooks(playbooks);
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return normalized;
  return Object.fromEntries(Object.entries(normalized).map(([symbol, playbook]) => {
    if (!playbook || typeof playbook !== 'object' || Array.isArray(playbook)) return [symbol, playbook];
    const stripGoal = (leg) => {
      if (!leg || typeof leg !== 'object' || Array.isArray(leg)) return leg;
      const { goal: _goal, ...current } = leg;
      return current;
    };
    return [symbol, {
      goal: legacyTickerGoal(playbook),
      coveredCall: stripGoal(playbook.coveredCall),
      cashSecuredPut: stripGoal(playbook.cashSecuredPut),
    }];
  }));
}

export function migrateV2StrategySettings(input) {
  const settings = v2DocumentSchema.parse(defaultPersistedV2(input));
  return {
    schemaVersion: 3,
    goalProfiles: settings.goalProfiles,
    tickerPlaybooks: migrateV2Playbooks(settings.tickerPlaybooks),
  };
}

function defaultPersistedV2(input) {
  const settings = structuredClone(input);
  for (const [goal, profiles] of Object.entries(settings.goalProfiles ?? {})) {
    if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) continue;
    for (const [leg, rules] of Object.entries(profiles)) {
      const compatible = withoutLegacyQuoteAge(rules);
      profiles[leg] = compatible && typeof compatible === 'object' && !Array.isArray(compatible)
        ? completeProfile(compatible, BUILT_IN_SETTINGS.goalProfiles[goal]?.[leg]?.rollReviewDte)
        : compatible;
    }
  }
  settings.tickerPlaybooks = normalizeV2Playbooks(settings.tickerPlaybooks ?? {});
  return settings;
}

function upgradeFormerBuiltInProfiles(input) {
  const settings = structuredClone(input);
  for (const formerProfiles of [ORIGINAL_BUILT_IN_GOAL_PROFILES, PREVIOUS_BUILT_IN_GOAL_PROFILES]) {
    for (const [goal, profiles] of Object.entries(formerProfiles)) {
      for (const [leg, formerRules] of Object.entries(profiles)) {
        const savedRules = settings.goalProfiles?.[goal]?.[leg];
        const stillFormerDefault = savedRules
          && Object.keys(savedRules).length === RULE_FIELDS.length
          && RULE_FIELDS.every((field) => Object.is(savedRules[field], formerRules[field]));
        if (stillFormerDefault) settings.goalProfiles[goal][leg] = structuredClone(BUILT_IN_SETTINGS.goalProfiles[goal][leg]);
      }
    }
  }
  return settings;
}

function issueMessage(error) {
  const issue = error.issues[0];
  const location = issue.path.length ? `${issue.path.join('.')}: ` : '';
  return `${location}${issue.message}`;
}

export class StrategySettingsValidationError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'StrategySettingsValidationError';
    this.issues = issues;
  }
}

export function normalizeStrategySettings(input) {
  const migrated = input?.schemaVersion === 1
    ? migrateV1StrategySettings(input)
    : input?.schemaVersion === 2
      ? migrateV2StrategySettings(input)
      : input;
  const compatible = upgradeFormerBuiltInProfiles(migrated);
  const result = strategySettingsDocumentSchema.safeParse(compatible);
  if (!result.success) {
    throw new StrategySettingsValidationError(issueMessage(result.error), result.error.issues);
  }
  return result.data;
}

export function defaultGoalForInstrument({ leg, instrumentType }) {
  const kind = String(instrumentType ?? '').toLowerCase().replace(/[^a-z]/g, '');
  return leg === 'coveredCall' && ['etf', 'mutualfund'].includes(kind) ? 'protect' : 'income';
}

export function resolveEffectiveSettings(input, { symbol, leg, instrumentType = null }) {
  const settings = normalizeStrategySettings(input);
  const parsedSymbol = tickerSymbolSchema.safeParse(symbol);
  const parsedLeg = legSchema.safeParse(leg);
  if (!parsedSymbol.success || !parsedLeg.success) {
    throw new StrategySettingsValidationError('symbol and leg must identify a valid strategy target');
  }

  const normalizedSymbol = parsedSymbol.data;
  const playbook = settings.tickerPlaybooks[normalizedSymbol];
  const legSettings = playbook?.[parsedLeg.data] ?? null;
  const goal = playbook?.goal ?? defaultGoalForInstrument({ leg: parsedLeg.data, instrumentType });
  const goalRules = settings.goalProfiles[goal]?.[parsedLeg.data] ?? SYSTEM_RULE_DEFAULTS;
  const rules = {
    ...goalRules,
    ...(legSettings?.overrides ?? {}),
  };
  const rulesSource = settings.goalProfiles[goal]?.[parsedLeg.data] ? 'goal' : 'system';
  const sourceMap = Object.fromEntries(RULE_FIELDS.map((field) => [field, rulesSource]));
  for (const field of Object.keys(legSettings?.overrides ?? {})) sourceMap[field] = 'tickerOverride';

  const priceGuardField = parsedLeg.data === 'coveredCall'
    ? 'minNetSalePriceMinor'
    : 'maxNetPurchasePriceMinor';
  return {
    symbol: normalizedSymbol,
    leg: parsedLeg.data,
    rules,
    enabled: legSettings?.enabled ?? false,
    goal,
    goalDefaulted: !playbook,
    priceGuard: {
      field: priceGuardField,
      valueMinor: legSettings?.[priceGuardField] ?? null,
    },
    sourceMap,
  };
}

export function createStrategySettingsService({
  dataDir,
  fsImpl = fs,
  now = Date.now,
  randomUUID = crypto.randomUUID,
} = {}) {
  const directory = path.join(dataDir, 'config');
  const file = path.join(directory, 'strategy-settings.json');
  let writeChain = Promise.resolve();

  async function load() {
    try {
      const raw = JSON.parse(await fsImpl.readFile(file, 'utf8'));
      let updatedAt;
      let settings;
      if (raw.schemaVersion === 1) {
        const persisted = persistedV1DocumentSchema.parse(raw);
        ({ updatedAt } = persisted);
        const { updatedAt: _timestamp, ...editable } = persisted;
        settings = migrateV1StrategySettings(editable);
      } else if (raw.schemaVersion === 2) {
        const persisted = persistedV2DocumentSchema.parse(defaultPersistedV2(raw));
        ({ updatedAt } = persisted);
        const { updatedAt: _timestamp, ...editable } = persisted;
        settings = migrateV2StrategySettings(editable);
      } else {
        const persisted = persistedDocumentSchema.parse(raw);
        ({ updatedAt } = persisted);
        const { updatedAt: _timestamp, ...editable } = persisted;
        settings = editable;
      }
      settings = upgradeFormerBuiltInProfiles(settings);
      return { settings, persistence: { persisted: true, updatedAt } };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return {
          settings: builtInStrategySettings(),
          persistence: { persisted: false, updatedAt: null },
        };
      }
      if (error instanceof SyntaxError || error instanceof z.ZodError) {
        const message = error instanceof z.ZodError ? issueMessage(error) : 'stored JSON is malformed';
        throw new StrategySettingsValidationError(`Persisted strategy settings are invalid: ${message}`);
      }
      throw error;
    }
  }

  async function atomicWrite(document) {
    await fsImpl.mkdir(directory, { recursive: true, mode: 0o700 });
    await fsImpl.chmod(directory, 0o700);
    const temporaryFile = `${file}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await fsImpl.writeFile(temporaryFile, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await fsImpl.chmod(temporaryFile, 0o600);
      await fsImpl.rename(temporaryFile, file);
    } catch (error) {
      await fsImpl.unlink(temporaryFile).catch(() => {});
      throw error;
    }
  }

  function save(input) {
    let settings;
    try {
      settings = normalizeStrategySettings(input);
    } catch (error) {
      return Promise.reject(error);
    }
    const operation = writeChain.then(async () => {
      const updatedAt = new Date(now()).toISOString();
      await atomicWrite({ ...settings, updatedAt });
      return { settings, persistence: { persisted: true, updatedAt } };
    });
    writeChain = operation.catch(() => {});
    return operation;
  }

  async function effective(query) {
    const result = await load();
    return resolveEffectiveSettings(result.settings, query);
  }

  return { file, load, save, effective };
}
