// Step 2 of the effective policy (fact sheet k.3, b.5): the merged policy value against the queue
// argument, by the rule the registry holds for the queue type, the key and the broker version. The
// resolver knows no broker behaviour and compares no version (I-3): every rule, default and
// warning is registry data. Where the registry has no row, no merge rule, or no readable version,
// the answer is `unknown` with the reason, never a default (SemanticsGapError handled
// conservatively, as the registry rules require).
import {
  semanticsRegistry,
  SemanticsGapError,
  type EffectiveConfigLookup,
  type ResolutionOutcome,
  type WarningCondition,
} from '@app/semantics';
import { combine, mergeDetails, type MergeDetail } from './merge-operator.ts';
import {
  describeValue,
  isFiniteNumber,
  isPolicyValue,
  type EffectiveConfig,
  type EffectiveEntry,
  type EffectiveWarning,
  type EntryStatus,
  type MergedEntry,
  type PolicyValue,
  type ResolveInput,
} from './model.ts';
import {
  buildProvenance,
  resolveLabel,
  type Side,
  type SideOutcome,
} from './provenance.ts';

type Registry = EffectiveConfigLookup;

const NUMERIC_KINDS = new Set(['min', 'max', 'negative-rule']);

const sides = (...list: Side[]): ReadonlySet<Side> => new Set(list);

interface Flags {
  readonly argumentSet: boolean;
  readonly policySet: boolean;
  readonly operatorSet: boolean;
}

function holds(when: WarningCondition, flags: Flags): boolean {
  switch (when) {
    case 'always':
      return true;
    case 'policy-present':
      return flags.policySet;
    case 'argument-present':
      return flags.argumentSet;
    case 'both-present':
      return flags.policySet && flags.argumentSet;
    case 'operator-and-argument':
      return flags.operatorSet && flags.argumentSet;
    case 'neither-present':
      return !flags.policySet && !flags.argumentSet;
  }
}

/** Everything one key's answer is built from. */
interface Context {
  readonly key: string;
  readonly input: ResolveInput;
  readonly lookup: Registry;
  readonly detail: MergeDetail | undefined;
  readonly argument:
    | { readonly name: string; readonly value: unknown }
    | undefined;
}

function userLeaf(ctx: Context) {
  const { userPolicy } = ctx.input;
  const set = ctx.detail?.userSet === true;
  return {
    name: userPolicy?.name ?? '',
    value: set ? userPolicy?.definition[ctx.key] : undefined,
    set,
  };
}

function operatorLeaf(ctx: Context) {
  const { operatorPolicy } = ctx.input;
  const set = ctx.detail?.operatorSet === true;
  return {
    name: operatorPolicy?.name ?? '',
    value: set ? operatorPolicy?.definition[ctx.key] : undefined,
    set,
  };
}

function policyNames(ctx: Context): string {
  return [userLeaf(ctx), operatorLeaf(ctx)]
    .filter((leaf) => leaf.set)
    .map((leaf) => leaf.name)
    .join(' and ');
}

const mergedValue = (entry: MergedEntry | undefined): unknown =>
  entry?.status === 'value' ? entry.value : undefined;

function params(
  ctx: Context,
  row: ResolutionOutcome | undefined,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const { input } = ctx;
  return {
    key: ctx.key,
    argument: row?.argument ?? ctx.argument?.name ?? 'none',
    queueType: input.queueType,
    version: input.version?.raw ?? 'unknown',
    argumentValue: describeValue(ctx.argument?.value),
    userValue: describeValue(userLeaf(ctx).value),
    operatorValue: describeValue(operatorLeaf(ctx).value),
    policyValue: describeValue(mergedValue(ctx.detail?.entry)),
    policyName: policyNames(ctx) || 'none',
    value: 'not set',
    rule: 'none',
    reason: 'none',
    ...extra,
  };
}

function warningOf(
  lookup: Registry,
  id: EffectiveWarning['id'],
  valuesOf: Readonly<Record<string, string>>,
  citations: EffectiveWarning['citations'],
): EffectiveWarning {
  const def = lookup.warning(id);
  return {
    id: def.id,
    severity: def.severity,
    textKey: def.textKey,
    textVersion: def.textVersion,
    params: valuesOf,
    citations,
  };
}

function rowWarnings(
  ctx: Context,
  row: ResolutionOutcome,
  valuesOf: Readonly<Record<string, string>>,
): EffectiveWarning[] {
  const flags: Flags = {
    argumentSet: ctx.argument !== undefined,
    policySet: ctx.detail !== undefined,
    operatorSet: ctx.detail?.operatorSet === true,
  };
  return row.warnings
    .filter((attached) => holds(attached.when, flags))
    .map((attached) =>
      warningOf(ctx.lookup, attached.warning.id, valuesOf, row.citations),
    );
}

interface Decision {
  readonly status: EntryStatus;
  readonly value: PolicyValue | null;
  readonly rule: string | null;
  readonly outcome: SideOutcome;
  readonly brokerDefault?: { readonly value: number | null } | undefined;
  /** Replaces the row's warnings: the answer is unknown or invalid, so "who wins" warnings are moot. */
  readonly failure?: { id: EffectiveWarning['id']; reason: string } | undefined;
}

const UNRESOLVED: SideOutcome = 'unresolved';

function ignoredBoth(): SideOutcome {
  return {
    deciding: sides(),
    overridden: sides(),
    ignored: sides('arg', 'policy'),
  };
}

function decide(ctx: Context, row: ResolutionOutcome): Decision {
  const kind = row.resolve;
  if (kind === 'undetermined') {
    // The sources disagree: the row's own warning says so, and no value is given.
    return { status: 'unknown', value: null, rule: null, outcome: UNRESOLVED };
  }
  if (kind === 'unsupported') {
    return { status: 'unset', value: null, rule: null, outcome: ignoredBoth() };
  }
  const numeric = NUMERIC_KINDS.has(kind);
  const arg = ctx.argument;
  const merged = ctx.detail?.entry;
  const policySet = ctx.detail !== undefined;

  const badArgument = (): Decision => ({
    status: 'invalid',
    value: null,
    rule: null,
    outcome: UNRESOLVED,
    failure: {
      id: 'W-EC-BAD-VALUE',
      reason: numeric
        ? 'the queue argument is not a number'
        : 'the queue argument is not a number, string or boolean',
    },
  });
  const argumentUsable =
    arg === undefined ||
    (numeric ? isFiniteNumber(arg.value) : isPolicyValue(arg.value));

  // Nothing sets the key: the registry's broker default, or unset.
  if (arg === undefined && !policySet) {
    const brokerDefault = row.brokerDefault;
    if (brokerDefault === null) {
      return {
        status: 'unset',
        value: null,
        rule: null,
        outcome: ignoredBoth(),
      };
    }
    return {
      status: 'default',
      value: brokerDefault.value,
      rule: 'broker-default',
      outcome: ignoredBoth(),
      brokerDefault,
    };
  }

  // The policy cannot matter: the argument decides.
  if (
    arg !== undefined &&
    (kind === 'argument-only' ||
      (kind === 'argument-wins' && policySet) ||
      !policySet)
  ) {
    if (!argumentUsable) return badArgument();
    const policyTreatment = !policySet
      ? { overridden: sides(), ignored: sides() }
      : kind === 'argument-only'
        ? { overridden: sides(), ignored: sides('policy') }
        : { overridden: sides('policy'), ignored: sides() };
    return {
      status: 'effective',
      value: arg.value as PolicyValue,
      rule: 'arg',
      outcome: { deciding: sides('arg'), ...policyTreatment },
    };
  }

  // From here the policy is needed, so its merge must have produced a usable value.
  if (kind === 'argument-only') {
    // A policy only, and the policy key has no effect here: nothing is set.
    return {
      status: 'unset',
      value: null,
      rule: null,
      outcome: {
        deciding: sides(),
        overridden: sides(),
        ignored: sides('policy'),
      },
    };
  }
  if (merged?.status === 'unknown') {
    return {
      status: 'unknown',
      value: null,
      rule: null,
      outcome: UNRESOLVED,
      failure: { id: 'W-EC-NO-MERGE', reason: 'no merge rule' },
    };
  }
  if (merged?.status === 'invalid') {
    return {
      status: 'invalid',
      value: null,
      rule: null,
      outcome: UNRESOLVED,
      failure: { id: 'W-EC-BAD-VALUE', reason: merged.reason },
    };
  }
  const policyValue = merged?.status === 'value' ? merged.value : undefined;
  const policyUsable = numeric
    ? isFiniteNumber(policyValue)
    : isPolicyValue(policyValue);
  if (!policyUsable) {
    return {
      status: 'invalid',
      value: null,
      rule: null,
      outcome: UNRESOLVED,
      failure: {
        id: 'W-EC-BAD-VALUE',
        reason: numeric
          ? 'the policy value is not a number'
          : 'the policy value is not a number, string or boolean',
      },
    };
  }
  if (arg === undefined) {
    return {
      status: 'effective',
      value: policyValue as PolicyValue,
      rule: 'policy',
      outcome: {
        deciding: sides('policy'),
        overridden: sides(),
        ignored: sides(),
      },
    };
  }
  if (!argumentUsable) return badArgument();

  if (kind === 'policy-wins') {
    return {
      status: 'effective',
      value: policyValue as PolicyValue,
      rule: 'policy',
      outcome: {
        deciding: sides('policy'),
        overridden: sides('arg'),
        ignored: sides(),
      },
    };
  }
  // min, max, negative-rule: both are numbers here.
  const result = combine(
    kind as 'min' | 'max' | 'negative-rule',
    arg.value as number,
    policyValue as number,
  );
  const deciding = new Set<Side>();
  if (arg.value === result) deciding.add('arg');
  if (policyValue === result) deciding.add('policy');
  return {
    status: 'effective',
    value: result,
    rule: resolveLabel(kind),
    outcome: { deciding, overridden: sides(), ignored: sides() },
  };
}

function unknownFromGap(
  ctx: Context,
  version: ResolveInput['version'],
): EffectiveEntry {
  const id = version === null ? 'W-EC-VERSION-UNKNOWN' : 'W-EC-NO-ROW';
  return entry(ctx, undefined, {
    status: 'unknown',
    value: null,
    rule: null,
    outcome: UNRESOLVED,
    failure: {
      id,
      reason:
        version === null
          ? 'the broker version could not be read'
          : 'no registry row',
    },
  });
}

function entry(
  ctx: Context,
  row: ResolutionOutcome | undefined,
  decision: Decision,
): EffectiveEntry {
  const effectiveValue =
    decision.status === 'default' && decision.value === null
      ? 'no limit'
      : describeValue(decision.value);
  const valuesOf = params(ctx, row, {
    value: effectiveValue,
    rule: decision.rule ?? 'none',
    reason: decision.failure?.reason ?? 'none',
  });
  let warnings: EffectiveWarning[] = [];
  if (decision.failure !== undefined) {
    warnings = [
      warningOf(
        ctx.lookup,
        decision.failure.id,
        valuesOf,
        row?.citations ?? [],
      ),
    ];
  } else if (row !== undefined) {
    warnings = rowWarnings(ctx, row, valuesOf);
  }
  const argName = row?.argument ?? ctx.argument?.name ?? null;
  return {
    key: ctx.key,
    argument: argName,
    status: decision.status,
    value: decision.value,
    rule: decision.rule,
    mergeRule:
      ctx.detail?.entry.status === 'value' ? ctx.detail.entry.rule : null,
    basis: row?.basis ?? null,
    provenance: buildProvenance({
      argument: {
        name: argName ?? '',
        value: ctx.argument?.value,
        set: ctx.argument !== undefined,
      },
      user: userLeaf(ctx),
      operator: operatorLeaf(ctx),
      merge: ctx.detail,
      outcome: decision.outcome,
      brokerDefault: decision.brokerDefault,
    }),
    warnings,
  };
}

function resolveKey(ctx: Context): EffectiveEntry {
  const { lookup, input } = ctx;
  let row: ResolutionOutcome;
  try {
    row = lookup.resolution(input.queueType, ctx.key, input.version);
  } catch (error) {
    if (error instanceof SemanticsGapError)
      return unknownFromGap(ctx, input.version);
    throw error;
  }
  return entry(ctx, row, decide(ctx, row));
}

/**
 * The effective configuration of one queue: per policy key, the value the queue has, how it came
 * about and what the registry says about it. `lookup` defaults to the registry this release ships.
 */
export function resolveEffective(
  input: ResolveInput,
  lookup: Registry = semanticsRegistry.effectiveConfig,
): EffectiveConfig {
  const details = mergeDetails(input.userPolicy, input.operatorPolicy, lookup);

  const byKey = new Map<string, { name: string; value: unknown }>();
  const unrecognised: string[] = [];
  for (const name of Object.keys(input.args).sort()) {
    const key = lookup.keyForArgument(name);
    if (key === null) unrecognised.push(name);
    else byKey.set(key, { name, value: input.args[name] });
  }

  const keys = new Set<string>([
    ...details.keys(),
    ...byKey.keys(),
    ...(input.keys ?? []),
  ]);
  const entries: [string, EffectiveEntry][] = [];
  for (const key of [...keys].sort()) {
    entries.push([
      key,
      resolveKey({
        key,
        input,
        lookup,
        detail: details.get(key),
        argument: byKey.get(key),
      }),
    ]);
  }

  const merged: [string, MergedEntry][] = [];
  for (const [key, detail] of details) merged.push([key, detail.entry]);

  return {
    queueType: input.queueType,
    version: input.version?.raw ?? null,
    entries: Object.fromEntries(entries),
    mergedPolicy: { notEffective: true, entries: Object.fromEntries(merged) },
    unrecognisedArguments: unrecognised,
    warnings: [],
  };
}
