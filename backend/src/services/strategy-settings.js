import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

export const STRATEGY_LEGS = ['coveredCall', 'cashSecuredPut'];
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
  'maxQuoteAgeSeconds',
  'minPeriodReturn',
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
  maxQuoteAgeSeconds: z.number().int().min(1).max(86_400),
  minPeriodReturn: z.number().min(0).max(10),
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

const protectPresetSchema = z.object({
  applicableLegs: z.tuple([z.literal('coveredCall')]),
  rules: partialRuleSetSchema,
}).strict();
const incomePresetSchema = z.object({
  applicableLegs: z.tuple([z.literal('coveredCall'), z.literal('cashSecuredPut')]),
  rules: partialRuleSetSchema,
}).strict();
const exitPresetSchema = z.object({
  applicableLegs: z.tuple([z.literal('coveredCall')]),
  rules: partialRuleSetSchema,
}).strict();
const acquirePresetSchema = z.object({
  applicableLegs: z.tuple([z.literal('cashSecuredPut')]),
  rules: partialRuleSetSchema,
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

const editableDocumentShape = {
  schemaVersion: z.literal(1),
  globalRules: z.object({
    coveredCall: completeRuleSetSchema,
    cashSecuredPut: completeRuleSetSchema,
  }).strict(),
  goalPresets: z.object({
    protect: protectPresetSchema,
    income: incomePresetSchema,
    exit: exitPresetSchema,
    acquire: acquirePresetSchema,
  }).strict(),
  tickerPlaybooks: z.record(tickerSymbolSchema, tickerPlaybookSchema),
};

export const strategySettingsDocumentSchema = z.object(editableDocumentShape).strict()
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

const persistedDocumentSchema = z.object({
  ...editableDocumentShape,
  updatedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((document, context) => {
  const editable = {
    schemaVersion: document.schemaVersion,
    globalRules: document.globalRules,
    goalPresets: document.goalPresets,
    tickerPlaybooks: document.tickerPlaybooks,
  };
  const result = strategySettingsDocumentSchema.safeParse(editable);
  if (!result.success) {
    for (const issue of result.error.issues) context.addIssue(issue);
  }
});

const GLOBAL_RULE_DEFAULTS = {
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

const BUILT_IN_SETTINGS = {
  schemaVersion: 1,
  globalRules: {
    coveredCall: { ...GLOBAL_RULE_DEFAULTS },
    cashSecuredPut: { ...GLOBAL_RULE_DEFAULTS },
  },
  goalPresets: {
    protect: {
      applicableLegs: ['coveredCall'],
      rules: { minDte: 30, maxDte: 60, targetDeltaMin: 0.1, targetDeltaMax: 0.2 },
    },
    income: {
      applicableLegs: ['coveredCall', 'cashSecuredPut'],
      rules: { minDte: 21, maxDte: 45, targetDeltaMin: 0.2, targetDeltaMax: 0.35 },
    },
    exit: {
      applicableLegs: ['coveredCall'],
      rules: { minDte: 7, maxDte: 30, targetDeltaMin: 0.35, targetDeltaMax: 0.7 },
    },
    acquire: {
      applicableLegs: ['cashSecuredPut'],
      rules: { minDte: 21, maxDte: 45, targetDeltaMin: 0.2, targetDeltaMax: 0.35 },
    },
  },
  tickerPlaybooks: {},
};

export function builtInStrategySettings() {
  return structuredClone(BUILT_IN_SETTINGS);
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
  const result = strategySettingsDocumentSchema.safeParse(input);
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
  const presetRules = legSettings
    ? settings.goalPresets[legSettings.goal].rules
    : {};
  const rules = {
    ...settings.globalRules[parsedLeg.data],
    ...presetRules,
    ...(legSettings?.overrides ?? {}),
  };
  const sourceMap = Object.fromEntries(RULE_FIELDS.map((field) => [field, 'global']));
  for (const field of Object.keys(presetRules)) sourceMap[field] = 'preset';
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
      const persisted = persistedDocumentSchema.parse(JSON.parse(await fsImpl.readFile(file, 'utf8')));
      const { updatedAt, ...settings } = persisted;
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
