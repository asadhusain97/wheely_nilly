import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

export const STRATEGY_LEGS = ['coveredCall', 'cashSecuredPut'];
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
};

const legacyRuleShape = {
  ...ruleShape,
  closeAtProfitCapture: ruleShape.closeAtProfitCapture.optional(),
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

const coveredCallPlaybookSchema = z.object({
  enabled: z.boolean(),
  goal: z.enum(['protect', 'income', 'exit']),
  minNetSalePriceMinor: safeNonnegativeInteger.nullable(),
  overrides: partialRuleSetSchema,
}).strict();
const cashSecuredPutPlaybookSchema = z.object({
  enabled: z.boolean(),
  goal: z.enum(['income', 'acquire']),
  maxNetPurchasePriceMinor: safeNonnegativeInteger.nullable(),
  overrides: partialRuleSetSchema,
}).strict();

const tickerPlaybookSchema = z.object({
  coveredCall: coveredCallPlaybookSchema,
  cashSecuredPut: cashSecuredPutPlaybookSchema,
}).strict();

const tickerPlaybooksSchema = z.record(tickerSymbolSchema, tickerPlaybookSchema);

const legacyCoveredCallPlaybookSchema = coveredCallPlaybookSchema.extend({
  overrides: z.object(legacyRuleShape).partial().strict(),
});
const legacyCashSecuredPutPlaybookSchema = cashSecuredPutPlaybookSchema.extend({
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

const editableDocumentShape = {
  schemaVersion: z.literal(2),
  goalProfiles: goalProfilesSchema,
  tickerPlaybooks: tickerPlaybooksSchema,
};

export const strategySettingsDocumentSchema = z.object(editableDocumentShape).strict()
  .superRefine((document, context) => {
    for (const [symbol, playbook] of Object.entries(document.tickerPlaybooks)) {
      for (const leg of STRATEGY_LEGS) {
        const legSettings = playbook[leg];
        const goalRules = document.goalProfiles[legSettings.goal]?.[leg];
        if (!goalRules) {
          context.addIssue({
            code: 'custom',
            path: ['tickerPlaybooks', symbol, leg, 'goal'],
            message: `${legSettings.goal} is not compatible with ${leg}`,
          });
          continue;
        }
        addRangeIssues(
          { ...goalRules, ...legSettings.overrides },
          context,
          ['tickerPlaybooks', symbol, leg, 'overrides'],
        );
      }
    }
  });

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
};

const completeProfile = (rules = {}) => ({ ...SYSTEM_RULE_DEFAULTS, ...rules });

const BUILT_IN_SETTINGS = {
  schemaVersion: 2,
  goalProfiles: {
    protect: { coveredCall: completeProfile({ minDte: 30, maxDte: 60, targetDeltaMin: 0.1, targetDeltaMax: 0.2 }) },
    income: {
      coveredCall: completeProfile({ minDte: 21, maxDte: 45, targetDeltaMin: 0.2, targetDeltaMax: 0.35 }),
      cashSecuredPut: completeProfile({ minDte: 21, maxDte: 45, targetDeltaMin: 0.2, targetDeltaMax: 0.35 }),
    },
    exit: { coveredCall: completeProfile({ minDte: 7, maxDte: 30, targetDeltaMin: 0.35, targetDeltaMax: 0.7 }) },
    acquire: { cashSecuredPut: completeProfile({ minDte: 21, maxDte: 45, targetDeltaMin: 0.2, targetDeltaMax: 0.35 }) },
  },
  tickerPlaybooks: {},
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
    schemaVersion: 2,
    goalProfiles,
    tickerPlaybooks: normalizePlaybooks(settings.tickerPlaybooks),
  };
}

function withoutLegacyQuoteAge(rules) {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return rules;
  const { maxQuoteAgeSeconds: _removed, ...current } = rules;
  return current;
}

function normalizePlaybooks(playbooks) {
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

function defaultPersistedV2(input) {
  const settings = structuredClone(input);
  for (const profiles of Object.values(settings.goalProfiles ?? {})) {
    if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) continue;
    for (const [leg, rules] of Object.entries(profiles)) {
      const compatible = withoutLegacyQuoteAge(rules);
      profiles[leg] = compatible && typeof compatible === 'object' && !Array.isArray(compatible)
        ? completeProfile(compatible)
        : compatible;
    }
  }
  settings.tickerPlaybooks = normalizePlaybooks(settings.tickerPlaybooks ?? {});
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
  const compatible = input?.schemaVersion === 2 ? defaultPersistedV2(input) : input;
  const result = strategySettingsDocumentSchema.safeParse(compatible);
  if (!result.success) {
    throw new StrategySettingsValidationError(issueMessage(result.error), result.error.issues);
  }
  return result.data;
}

export function resolveEffectiveSettings(input, { symbol, leg }) {
  const settings = normalizeStrategySettings(input);
  const parsedSymbol = tickerSymbolSchema.safeParse(symbol);
  const parsedLeg = legSchema.safeParse(leg);
  if (!parsedSymbol.success || !parsedLeg.success) {
    throw new StrategySettingsValidationError('symbol and leg must identify a valid strategy target');
  }

  const normalizedSymbol = parsedSymbol.data;
  const playbook = settings.tickerPlaybooks[normalizedSymbol];
  const legSettings = playbook?.[parsedLeg.data] ?? null;
  const goalRules = legSettings
    ? settings.goalProfiles[legSettings.goal][parsedLeg.data]
    : SYSTEM_RULE_DEFAULTS;
  const rules = {
    ...goalRules,
    ...(legSettings?.overrides ?? {}),
  };
  const sourceMap = Object.fromEntries(RULE_FIELDS.map((field) => [field, legSettings ? 'goal' : 'system']));
  for (const field of Object.keys(legSettings?.overrides ?? {})) sourceMap[field] = 'tickerOverride';

  const priceGuardField = parsedLeg.data === 'coveredCall'
    ? 'minNetSalePriceMinor'
    : 'maxNetPurchasePriceMinor';
  return {
    symbol: normalizedSymbol,
    leg: parsedLeg.data,
    rules,
    enabled: legSettings?.enabled ?? false,
    goal: legSettings?.goal ?? null,
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
      const persisted = raw.schemaVersion === 1
        ? persistedV1DocumentSchema.parse(raw)
        : persistedDocumentSchema.parse(defaultPersistedV2(raw));
      const { updatedAt, ...editable } = persisted;
      const settings = editable.schemaVersion === 1 ? migrateV1StrategySettings(editable) : editable;
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
