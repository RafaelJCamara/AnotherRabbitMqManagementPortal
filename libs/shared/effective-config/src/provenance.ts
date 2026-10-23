// Provenance: the labels of the rules ("min(arg, policy)") and the role every input played in an
// answer. The provenance of an entry lists the argument, the user policy and the operator policy
// (those that set the key) and the broker default when it was used, each with the role it had, so
// the UI can say "arg 500, policy 1000, the smaller wins: 500" without recomputing anything.
import type { ResolveKind } from '@app/semantics';
import type { PolicyLayer, MergeDetail } from './merge-operator.ts';
import type { Layer, ProvenanceEntry, Role } from './model.ts';

/** Step 2 rule label when both an argument and a policy value were looked at. */
export function resolveLabel(kind: ResolveKind): string | null {
  switch (kind) {
    case 'min':
    case 'max':
    case 'negative-rule':
      return `${kind}(arg, policy)`;
    case 'argument-wins':
    case 'argument-only':
      return 'arg';
    case 'policy-wins':
      return 'policy';
    case 'unsupported':
    case 'undetermined':
      return null;
  }
}

export type Side = 'arg' | 'policy';

/** What step 2 decided about the two sides. */
export type SideOutcome =
  | 'unresolved'
  | {
      readonly deciding: ReadonlySet<Side>;
      readonly overridden: ReadonlySet<Side>;
      readonly ignored: ReadonlySet<Side>;
    };

export interface Leaf {
  readonly name: string;
  readonly value: unknown;
  readonly set: boolean;
}

export interface ProvenanceInput {
  readonly argument: Leaf;
  readonly user: Leaf;
  readonly operator: Leaf;
  readonly merge: MergeDetail | undefined;
  readonly outcome: SideOutcome;
  /** The broker default, when it is the answer. */
  readonly brokerDefault?: { readonly value: number | null } | undefined;
}

function policyRole(
  layer: PolicyLayer,
  outcome: Exclude<SideOutcome, 'unresolved'>,
  merge: MergeDetail | undefined,
): Role {
  if (outcome.ignored.has('policy')) return 'ignored';
  if (outcome.overridden.has('policy')) return 'overridden';
  if (outcome.deciding.has('policy')) {
    if (merge?.deciding.has(layer) === true) return 'deciding';
    if (merge?.overridden.has(layer) === true) return 'overridden';
    return 'compared';
  }
  return 'compared';
}

function argumentRole(outcome: Exclude<SideOutcome, 'unresolved'>): Role {
  if (outcome.ignored.has('arg')) return 'ignored';
  if (outcome.overridden.has('arg')) return 'overridden';
  return outcome.deciding.has('arg') ? 'deciding' : 'compared';
}

/** The provenance list, in the order argument, user policy, operator policy, broker default. */
export function buildProvenance(input: ProvenanceInput): ProvenanceEntry[] {
  const { outcome } = input;
  const out: ProvenanceEntry[] = [];
  const push = (layer: Layer, leaf: Leaf, role: Role): void => {
    out.push({ layer, name: leaf.name, value: leaf.value, role });
  };
  if (input.argument.set) {
    push(
      'argument',
      input.argument,
      outcome === 'unresolved' ? 'unresolved' : argumentRole(outcome),
    );
  }
  for (const [layer, leaf] of [
    ['user-policy', input.user],
    ['operator-policy', input.operator],
  ] as const) {
    if (!leaf.set) continue;
    push(
      layer,
      leaf,
      outcome === 'unresolved'
        ? 'unresolved'
        : policyRole(layer, outcome, input.merge),
    );
  }
  if (input.brokerDefault !== undefined) {
    out.push({
      layer: 'broker-default',
      name: 'broker default',
      value: input.brokerDefault.value,
      role: 'deciding',
    });
  }
  return out;
}
