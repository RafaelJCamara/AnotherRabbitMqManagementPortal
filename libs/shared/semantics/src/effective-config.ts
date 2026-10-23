// Effective-config rules (DC-30, POL-01, fact sheet k.3 and b.5): how a queue argument, a user policy
// and an operator policy combine into the value a queue really has. Two steps, both data:
//   1. merge: the operator policy merged with the user policy, per key (`rabbit_policies`);
//   2. resolution: the merged policy value against the queue argument, per queue type, key and
//      broker version (`args_policy_lookup` and the queue types).
// The resolver is `@app/effective-config`; it holds no broker knowledge and no version comparison
// (I-3), it asks this table. A key, queue type or version with no row is a gap: the lookup throws
// SemanticsGapError and the resolver answers "unknown", never a default. Like the other M0-13
// tables the rows carry citations and conformance ids but no status or evidence (OQ-361, OQ-960).
import {
  ConformanceIdSchema,
  WarningIdSchema,
  WarningRefSchema,
  type ConformanceId,
  type WarningId,
  type WarningRef,
} from '@app/contracts';
import {
  parseVersionRange,
  QueueTypeSchema,
  rangeIncludes,
  VersionRangeTextSchema,
  type QueueType,
  type SemVer,
  type VersionRange,
} from '@app/domain-model';
import { z } from 'zod';
import {
  CitationSchema,
  RegistryDataError,
  SemanticsGapError,
  type Citation,
} from './schema.ts';

/** How two policy values for one key are merged (step 1). `operator` takes the operator's value. */
export const MergeKindSchema = z.enum([
  'min',
  'max',
  'negative-rule',
  'operator',
]);
export type MergeKind = z.infer<typeof MergeKindSchema>;

/**
 * How the merged policy value meets the queue argument (step 2).
 * `min`, `max`, `negative-rule`: both are numbers and the rule combines them (`negative-rule`: if
 * either is negative the larger one, otherwise the minimum). `argument-wins`, `policy-wins`: the
 * named one decides when both are set. `argument-only`: the policy key has no effect here.
 * `unsupported`: neither the argument nor the policy key has an effect here (older broker).
 * `undetermined`: the sources disagree, so no answer is given (OQ-962).
 */
export const ResolveKindSchema = z.enum([
  'min',
  'max',
  'negative-rule',
  'argument-wins',
  'policy-wins',
  'argument-only',
  'unsupported',
  'undetermined',
]);
export type ResolveKind = z.infer<typeof ResolveKindSchema>;

/** When a warning attached to a resolution row is shown. */
export const WarningConditionSchema = z.enum([
  'always',
  'policy-present',
  'argument-present',
  'both-present',
  'operator-and-argument',
  'neither-present',
]);
export type WarningCondition = z.infer<typeof WarningConditionSchema>;

const citations = z.array(CitationSchema).min(1);
const conformance = z.array(ConformanceIdSchema).min(1);

export const OperatorMergeRuleSchema = z
  .strictObject({
    /** The policy key the rule names, or null for a rule on the value type. */
    key: z.string().min(1).nullable(),
    /** `boolean`: the rule applies to any key whose two values are booleans. */
    valueType: z.literal('boolean').nullable(),
    merge: MergeKindSchema,
    citations,
    conformance,
  })
  .refine((rule) => (rule.key === null) !== (rule.valueType === null), {
    message: 'a merge rule names a key or a value type, not both and not none',
  });
export type OperatorMergeRule = z.infer<typeof OperatorMergeRuleSchema>;

export const ResolutionRuleSchema = z.strictObject({
  queueType: QueueTypeSchema,
  /** The policy key (`max-length`). */
  key: z.string().min(1),
  /** The queue argument (`x-max-length`). */
  argument: z.string().regex(/^x-[a-z0-9-]+$/),
  /** The broker versions the row speaks for. A version outside every row is a gap. */
  versions: VersionRangeTextSchema,
  /** The part of `versions` the cited source was read at (v4.3.6); the rest is extrapolated. */
  sourceRead: VersionRangeTextSchema.nullable(),
  resolve: ResolveKindSchema,
  /**
   * What the broker uses when neither an argument nor a policy sets the key: `{ value: null }` is
   * "no limit"; absent: the registry does not say, and the answer stays `unset`.
   */
  brokerDefault: z.strictObject({ value: z.number().nullable() }).optional(),
  /** Warnings shown with this row, as ids of `EffectiveConfigData.warnings`. */
  warnings: z.array(
    z.strictObject({ id: WarningIdSchema, when: WarningConditionSchema }),
  ),
  citations,
  conformance,
});
export type ResolutionRule = z.infer<typeof ResolutionRuleSchema>;

export const EffectiveConfigDataSchema = z.strictObject({
  merges: z.array(OperatorMergeRuleSchema),
  resolutions: z.array(ResolutionRuleSchema),
  /** The `W-EC-*` warnings; their texts are `i18n/en/effective-config.json`. */
  warnings: z.array(WarningRefSchema),
});
export type EffectiveConfigData = z.infer<typeof EffectiveConfigDataSchema>;

export interface MergeOutcome {
  readonly kind: MergeKind;
  readonly citations: readonly Citation[];
  readonly conformance: readonly ConformanceId[];
}

export interface RowWarning {
  readonly when: WarningCondition;
  readonly warning: WarningRef;
}

export interface ResolutionOutcome {
  readonly queueType: QueueType;
  readonly key: string;
  readonly argument: string;
  readonly resolve: ResolveKind;
  /** `source-read` when the cited source was read at a version that covers this one. */
  readonly basis: 'source-read' | 'extrapolated';
  readonly brokerDefault: { readonly value: number | null } | null;
  readonly warnings: readonly RowWarning[];
  readonly citations: readonly Citation[];
  readonly conformance: readonly ConformanceId[];
}

/** The lookups of the effective-config table (`registry.effectiveConfig`). */
export interface EffectiveConfigLookup {
  /**
   * Step 1. `bothBoolean` selects the value-type rule when no rule names the key. Throws
   * SemanticsGapError when nothing applies.
   */
  merge(key: string, bothBoolean: boolean): MergeOutcome;
  /**
   * Step 2. Throws SemanticsGapError for a key or queue type without a row, a version no row
   * covers, an unreadable version (`null`) and rows that overlap for the version.
   */
  resolution(
    queueType: QueueType,
    key: string,
    version: SemVer | null,
  ): ResolutionOutcome;
  /** The policy key a queue argument stands for, or null when no row uses the argument. */
  keyForArgument(argument: string): string | null;
  /** Throws SemanticsGapError for an unknown `W-EC-*` id. */
  warning(id: WarningId): WarningRef;
}

const rowId = (queueType: QueueType, key: string): string =>
  `${queueType}|${key}`;

const describeRow = (rule: ResolutionRule): string =>
  `${rowId(rule.queueType, rule.key)} (${rule.versions})`;

const NEEDS_WARNING: readonly ResolveKind[] = [
  'argument-only',
  'unsupported',
  'undetermined',
];

function parseRange(text: string, where: string): VersionRange {
  const range = parseVersionRange(text);
  if (range === null) {
    throw new RegistryDataError([`${where}: invalid version range ${text}`]);
  }
  return range;
}

/**
 * Builds the lookups. Throws RegistryDataError for: a duplicate merge rule or `W-EC-*` id; a row
 * that names an unknown warning; a row that is `argument-only`, `unsupported` or `undetermined`
 * without a warning (it would say nothing about why); a key mapped to two arguments or an argument
 * mapped to two keys; two rows of one (queue type, key) with the same range. Rows whose ranges
 * overlap are not rejected here: the lookup fails closed for a version both cover, and the data
 * spec sweeps every version.
 */
export function buildEffectiveConfig(
  data: EffectiveConfigData,
): EffectiveConfigLookup {
  const problems: string[] = [];

  const warnings = new Map<string, WarningRef>();
  for (const warning of data.warnings) {
    if (warnings.has(warning.id)) {
      problems.push(`effective-config warning ${warning.id} is defined twice`);
    }
    warnings.set(warning.id, warning);
  }

  const merges = new Map<string, OperatorMergeRule>();
  let booleanRule: OperatorMergeRule | undefined;
  for (const rule of data.merges) {
    if (rule.key === null) {
      if (booleanRule !== undefined) {
        problems.push('effective-config: two merge rules for booleans');
      }
      booleanRule = rule;
    } else if (merges.has(rule.key)) {
      problems.push(
        `effective-config: merge rule ${rule.key} is defined twice`,
      );
    } else {
      merges.set(rule.key, rule);
    }
  }

  interface Row {
    readonly rule: ResolutionRule;
    readonly versions: VersionRange;
    readonly sourceRead: VersionRange | null;
    readonly warnings: readonly RowWarning[];
  }
  const rows = new Map<string, Row[]>();
  const keyToArgument = new Map<string, string>();
  const argumentToKey = new Map<string, string>();
  const seenRanges = new Set<string>();

  for (const rule of data.resolutions) {
    const where = describeRow(rule);
    try {
      const versions = parseRange(rule.versions, where);
      const sourceRead =
        rule.sourceRead === null ? null : parseRange(rule.sourceRead, where);
      const rowWarnings: RowWarning[] = [];
      for (const attached of rule.warnings) {
        const warning = warnings.get(attached.id);
        if (warning === undefined) {
          problems.push(`${where}: unknown warning ${attached.id}`);
        } else {
          rowWarnings.push({ when: attached.when, warning });
        }
      }
      if (NEEDS_WARNING.includes(rule.resolve) && rule.warnings.length === 0) {
        problems.push(`${where}: a ${rule.resolve} row needs a warning`);
      }
      const dup = where;
      if (seenRanges.has(dup)) problems.push(`${where}: defined twice`);
      seenRanges.add(dup);

      const argumentOfKey = keyToArgument.get(rule.key);
      if (argumentOfKey !== undefined && argumentOfKey !== rule.argument) {
        problems.push(
          `${where}: key ${rule.key} maps to ${rule.argument} and ${argumentOfKey}`,
        );
      }
      keyToArgument.set(rule.key, rule.argument);
      const keyOfArgument = argumentToKey.get(rule.argument);
      if (keyOfArgument !== undefined && keyOfArgument !== rule.key) {
        problems.push(
          `${where}: argument ${rule.argument} maps to ${rule.key} and ${keyOfArgument}`,
        );
      }
      argumentToKey.set(rule.argument, rule.key);

      const id = rowId(rule.queueType, rule.key);
      const list = rows.get(id) ?? [];
      list.push({ rule, versions, sourceRead, warnings: rowWarnings });
      rows.set(id, list);
    } catch (error) {
      if (error instanceof RegistryDataError) problems.push(...error.problems);
      else throw error;
    }
  }
  if (problems.length > 0) throw new RegistryDataError(problems);

  const gap = (id: string, reason: string): SemanticsGapError =>
    new SemanticsGapError({ table: 'effective-config', id }, reason);

  return {
    merge(key, bothBoolean) {
      const named = merges.get(key);
      const rule = named ?? (bothBoolean ? booleanRule : undefined);
      if (rule === undefined) {
        throw gap(key, 'no merge rule names this key');
      }
      return {
        kind: rule.merge,
        citations: rule.citations,
        conformance: rule.conformance,
      };
    },
    resolution(queueType, key, version) {
      const id = rowId(queueType, key);
      const candidates = rows.get(id);
      if (candidates === undefined) {
        throw gap(id, 'no row for this queue type and key');
      }
      if (version === null) {
        throw gap(id, 'the broker version could not be read');
      }
      const matching = candidates.filter((row) =>
        rangeIncludes(row.versions, version),
      );
      if (matching.length === 0) {
        throw gap(id, `no row covers version ${version.raw}`);
      }
      const [row, ...others] = matching;
      if (row === undefined || others.length > 0) {
        throw gap(id, `rows overlap for version ${version.raw}`);
      }
      const { rule } = row;
      return {
        queueType: rule.queueType,
        key: rule.key,
        argument: rule.argument,
        resolve: rule.resolve,
        basis:
          row.sourceRead !== null && rangeIncludes(row.sourceRead, version)
            ? 'source-read'
            : 'extrapolated',
        brokerDefault: rule.brokerDefault ?? null,
        warnings: row.warnings,
        citations: rule.citations,
        conformance: rule.conformance,
      };
    },
    keyForArgument(argument) {
      return argumentToKey.get(argument) ?? null;
    },
    warning(id) {
      const found = warnings.get(id);
      if (found === undefined) {
        throw new SemanticsGapError({ table: 'effective-config', id });
      }
      return found;
    },
  };
}
