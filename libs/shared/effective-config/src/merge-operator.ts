// Step 1 of the effective policy (fact sheet k.3): the operator policy merged with the user policy,
// per key, by the registry's merge rule. A key set by one layer only passes through unchanged. A key
// set by both with no rule that names it (and not two booleans) is `unknown`: the policies guide
// says operator policies override user policies, but the code lists keys, and the library does not
// guess the rest (OQ-964). The result is what the broker reports as `effective_policy_definition`:
// it is `notEffective`, because the queue argument may still win (step 2, `resolve.ts`).
import {
  semanticsRegistry,
  SemanticsGapError,
  type EffectiveConfigLookup,
  type MergeKind,
} from '@app/semantics';
import {
  isFiniteNumber,
  type MergedEntry,
  type MergedPolicy,
  type PolicyInput,
} from './model.ts';

export type PolicyLayer = 'user-policy' | 'operator-policy';

/** Step 1 rule label. */
export function mergeLabel(kind: MergeKind): string {
  return kind === 'operator' ? 'operator' : `${kind}(user, operator)`;
}

/** Step 1 for one key, with the leaves that decided it (for the provenance of step 2). */
export interface MergeDetail {
  readonly entry: MergedEntry;
  readonly userSet: boolean;
  readonly operatorSet: boolean;
  /** The layers whose value is the merged value and won the rule. */
  readonly deciding: ReadonlySet<PolicyLayer>;
  /** The layers the rule gave no say (the operator value replaced the user value). */
  readonly overridden: ReadonlySet<PolicyLayer>;
  readonly citations: MergeCitations;
}

type MergeCitations = ReturnType<EffectiveConfigLookup['merge']>['citations'];

/** The numeric merge rules. `negative-rule`: a negative value means "no limit", so the larger wins. */
export function combine(kind: MergeKind, a: number, b: number): number {
  switch (kind) {
    case 'min':
      return Math.min(a, b);
    case 'max':
      return Math.max(a, b);
    case 'negative-rule':
      return a < 0 || b < 0 ? Math.max(a, b) : Math.min(a, b);
    case 'operator':
      return b;
  }
}

const own = (definition: Readonly<Record<string, unknown>>, key: string) =>
  Object.hasOwn(definition, key);

function mergeKey(
  key: string,
  user: PolicyInput | null,
  operator: PolicyInput | null,
  lookup: EffectiveConfigLookup,
): MergeDetail {
  const userSet = user !== null && own(user.definition, key);
  const operatorSet = operator !== null && own(operator.definition, key);
  const userValue: unknown = userSet ? user.definition[key] : undefined;
  const operatorValue: unknown = operatorSet
    ? operator.definition[key]
    : undefined;
  const base = { userSet, operatorSet, citations: [] as MergeCitations };

  if (userSet !== operatorSet) {
    return {
      ...base,
      entry: {
        status: 'value',
        value: userSet ? userValue : operatorValue,
        rule: null,
      },
      deciding: new Set<PolicyLayer>([
        userSet ? 'user-policy' : 'operator-policy',
      ]),
      overridden: new Set<PolicyLayer>(),
    };
  }

  const bothBoolean =
    typeof userValue === 'boolean' && typeof operatorValue === 'boolean';
  let rule: ReturnType<EffectiveConfigLookup['merge']>;
  try {
    rule = lookup.merge(key, bothBoolean);
  } catch (error) {
    if (!(error instanceof SemanticsGapError)) throw error;
    return {
      ...base,
      entry: {
        status: 'unknown',
        reason: 'no-merge-rule',
        userValue,
        operatorValue,
      },
      deciding: new Set<PolicyLayer>(),
      overridden: new Set<PolicyLayer>(),
    };
  }
  const withRule = { ...base, citations: rule.citations };

  if (rule.kind === 'operator') {
    return {
      ...withRule,
      entry: {
        status: 'value',
        value: operatorValue,
        rule: mergeLabel(rule.kind),
      },
      deciding: new Set<PolicyLayer>(['operator-policy']),
      overridden: new Set<PolicyLayer>(['user-policy']),
    };
  }
  if (!isFiniteNumber(userValue) || !isFiniteNumber(operatorValue)) {
    const which = isFiniteNumber(userValue) ? 'operator policy' : 'user policy';
    return {
      ...withRule,
      entry: {
        status: 'invalid',
        reason: `${which} value is not a number`,
        userValue,
        operatorValue,
      },
      deciding: new Set<PolicyLayer>(),
      overridden: new Set<PolicyLayer>(),
    };
  }
  const merged = combine(rule.kind, userValue, operatorValue);
  const deciding = new Set<PolicyLayer>();
  if (userValue === merged) deciding.add('user-policy');
  if (operatorValue === merged) deciding.add('operator-policy');
  return {
    ...withRule,
    entry: { status: 'value', value: merged, rule: mergeLabel(rule.kind) },
    deciding,
    overridden: new Set<PolicyLayer>(),
  };
}

/** Step 1 with details; keys are sorted so the result does not depend on definition order. */
export function mergeDetails(
  user: PolicyInput | null,
  operator: PolicyInput | null,
  lookup: EffectiveConfigLookup,
): Map<string, MergeDetail> {
  const keys = new Set<string>([
    ...(user === null ? [] : Object.keys(user.definition)),
    ...(operator === null ? [] : Object.keys(operator.definition)),
  ]);
  const details = new Map<string, MergeDetail>();
  for (const key of [...keys].sort()) {
    details.set(key, mergeKey(key, user, operator, lookup));
  }
  return details;
}

/**
 * The operator policy merged with the user policy. The result is marked `notEffective`: the broker
 * reports the same thing as `effective_policy_definition`, and a queue argument may beat it.
 */
export function mergeOperator(
  user: PolicyInput | null,
  operator: PolicyInput | null,
  lookup: EffectiveConfigLookup = semanticsRegistry.effectiveConfig,
): MergedPolicy {
  const entries: [string, MergedEntry][] = [];
  for (const [key, detail] of mergeDetails(user, operator, lookup)) {
    entries.push([key, detail.entry]);
  }
  return { notEffective: true, entries: Object.fromEntries(entries) };
}
