// Hypothetical names ("what applies if I declare X", POL-01): which user policy and which operator
// policy the broker would pick for a queue name, and the effective configuration that follows.
// The broker takes, per layer, the matching policy with the highest priority. Where that choice
// cannot be made here, because two policies tie on priority or a pattern cannot be evaluated like
// the broker does (pattern.ts), the answer is computed for every candidate and kept only for the
// keys on which all candidates agree; the others are `unknown` with W-EC-TIE (OQ-965).
import type { QueueType, SemVer } from '@app/domain-model';
import { semanticsRegistry, type EffectiveConfigLookup } from '@app/semantics';
import type {
  EffectiveConfig,
  EffectiveEntry,
  EffectiveWarning,
  PolicyInput,
  ProvenanceEntry,
} from './model.ts';
import { testPattern } from './pattern.ts';
import { resolveEffective } from './resolve.ts';

/** A policy as the broker lists it (`/api/policies`, `/api/operator-policies`). */
export interface PolicyDefinition {
  readonly name: string;
  readonly pattern: string;
  /** `all`, `queues`, `classic_queues`, `quorum_queues`, `streams` or `exchanges`. */
  readonly applyTo: string;
  readonly priority: number;
  readonly definition: Readonly<Record<string, unknown>>;
}

export type PolicyTarget =
  | {
      readonly kind: 'queue';
      readonly name: string;
      readonly queueType: QueueType;
    }
  | { readonly kind: 'exchange'; readonly name: string };

export interface UncertainPolicy {
  readonly policy: string;
  readonly reason: string;
}

export type PolicyMatch =
  | { readonly kind: 'none' }
  | { readonly kind: 'one'; readonly policy: PolicyDefinition }
  | {
      readonly kind: 'ambiguous';
      /** Every policy that may be the one the broker picks; null: no policy may match at all. */
      readonly candidates: readonly (PolicyDefinition | null)[];
      /** Policies whose match could not be decided here, with why. */
      readonly uncertain: readonly UncertainPolicy[];
      /** True when two policies that certainly match tie on the highest priority. */
      readonly tied: boolean;
    };

type Evaluation = 'match' | 'no-match' | { readonly uncertain: string };

function applies(applyTo: string, target: PolicyTarget): boolean | null {
  switch (applyTo) {
    case 'all':
      return true;
    case 'queues':
      return target.kind === 'queue';
    case 'exchanges':
      return target.kind === 'exchange';
    case 'classic_queues':
      return target.kind === 'queue' && target.queueType === 'classic';
    case 'quorum_queues':
      return target.kind === 'queue' && target.queueType === 'quorum';
    case 'streams':
      return target.kind === 'queue' && target.queueType === 'stream';
    default:
      return null;
  }
}

function evaluate(policy: PolicyDefinition, target: PolicyTarget): Evaluation {
  if (!Number.isFinite(policy.priority)) {
    return { uncertain: 'the priority is not a number' };
  }
  const applicable = applies(policy.applyTo, target);
  if (applicable === null) {
    return {
      uncertain: `apply-to ${policy.applyTo.slice(0, 40)} is not known`,
    };
  }
  if (!applicable) return 'no-match';
  const result = testPattern(policy.pattern, target.name);
  if (!result.ok) return { uncertain: result.reason };
  return result.matches ? 'match' : 'no-match';
}

/**
 * The policy the broker would pick for `target` among `policies` (one layer): the matching policy
 * with the highest priority. See the file header for the cases it will not decide.
 */
export function matchPolicy(
  policies: readonly PolicyDefinition[],
  target: PolicyTarget,
): PolicyMatch {
  const matches: PolicyDefinition[] = [];
  const uncertain: { policy: PolicyDefinition; reason: string }[] = [];
  for (const policy of policies) {
    const result = evaluate(policy, target);
    if (result === 'match') matches.push(policy);
    else if (result !== 'no-match') {
      uncertain.push({ policy, reason: result.uncertain });
    }
  }

  const top = matches.reduce(
    (best, policy) => Math.max(best, policy.priority),
    -Infinity,
  );
  const winners = matches.filter((policy) => policy.priority === top);
  // An uncertain policy matters only if it could win or tie: its priority is at least the best sure match.
  // A priority that is not a number cannot be ranked, so such a policy always could win.
  const risky = uncertain.filter(
    (entry) =>
      !Number.isFinite(entry.policy.priority) || entry.policy.priority >= top,
  );

  if (risky.length === 0) {
    if (winners.length === 0) return { kind: 'none' };
    const [only, ...rest] = winners;
    if (only !== undefined && rest.length === 0)
      return { kind: 'one', policy: only };
    return {
      kind: 'ambiguous',
      candidates: winners,
      uncertain: [],
      tied: true,
    };
  }
  return {
    kind: 'ambiguous',
    candidates: [
      ...(winners.length === 0 ? [null] : winners),
      ...risky.map((entry) => entry.policy),
    ],
    uncertain: risky.map((entry) => ({
      policy: entry.policy.name,
      reason: entry.reason,
    })),
    tied: winners.length > 1,
  };
}

export interface HypotheticalInput {
  /** The queue name being declared. */
  readonly name: string;
  readonly queueType: QueueType;
  readonly version: SemVer | null;
  readonly args: Readonly<Record<string, unknown>>;
  readonly policies: readonly PolicyDefinition[];
  readonly operatorPolicies: readonly PolicyDefinition[];
  readonly keys?: readonly string[] | undefined;
}

export interface MatchView {
  readonly status: 'none' | 'one' | 'ambiguous';
  /** The policy that applies; null for none or ambiguous. */
  readonly selected: string | null;
  /** The names of every policy that may apply. */
  readonly candidates: readonly string[];
}

export interface HypotheticalResult extends EffectiveConfig {
  readonly userMatch: MatchView;
  readonly operatorMatch: MatchView;
}

/** Candidates per layer that are resolved one by one; beyond it the layer's keys are unknown. */
export const MAX_CANDIDATES = 16;

interface Layer {
  readonly choices: readonly (PolicyInput | null)[];
  readonly names: readonly string[];
  readonly view: MatchView;
  /** Keys every candidate may set, when there are too many candidates to resolve one by one. */
  readonly overflowKeys: ReadonlySet<string>;
}

const asInput = (policy: PolicyDefinition): PolicyInput => ({
  name: policy.name,
  definition: policy.definition,
});

function layerOf(match: PolicyMatch): Layer {
  if (match.kind === 'none') {
    return {
      choices: [null],
      names: [],
      view: { status: 'none', selected: null, candidates: [] },
      overflowKeys: new Set(),
    };
  }
  if (match.kind === 'one') {
    return {
      choices: [asInput(match.policy)],
      names: [match.policy.name],
      view: {
        status: 'one',
        selected: match.policy.name,
        candidates: [match.policy.name],
      },
      overflowKeys: new Set(),
    };
  }
  const named = match.candidates.filter(
    (policy): policy is PolicyDefinition => policy !== null,
  );
  const names = named.map((policy) => policy.name).sort();
  const view: MatchView = {
    status: 'ambiguous',
    selected: null,
    candidates: names,
  };
  if (match.candidates.length > MAX_CANDIDATES) {
    const keys = new Set<string>();
    for (const policy of named)
      for (const key of Object.keys(policy.definition)) keys.add(key);
    return { choices: [null], names, view, overflowKeys: keys };
  }
  return {
    choices: match.candidates.map((policy) =>
      policy === null ? null : asInput(policy),
    ),
    names,
    view,
    overflowKeys: new Set(),
  };
}

const sameAnswer = (a: EffectiveEntry, b: EffectiveEntry): boolean =>
  a.status === b.status &&
  a.value === b.value &&
  a.rule === b.rule &&
  a.mergeRule === b.mergeRule &&
  a.basis === b.basis;

function tieWarning(
  lookup: EffectiveConfigLookup,
  candidates: string,
): EffectiveWarning {
  const def = lookup.warning('W-EC-TIE');
  return {
    id: def.id,
    severity: def.severity,
    textKey: def.textKey,
    textVersion: def.textVersion,
    params: { candidates },
    citations: [],
  };
}

function patternWarning(
  lookup: EffectiveConfigLookup,
  entry: UncertainPolicy,
): EffectiveWarning {
  const def = lookup.warning('W-EC-PATTERN');
  return {
    id: def.id,
    severity: def.severity,
    textKey: def.textKey,
    textVersion: def.textVersion,
    params: { policyName: entry.policy, reason: entry.reason },
    citations: [],
  };
}

function renamed(
  provenance: readonly ProvenanceEntry[],
  user: Layer,
  operator: Layer,
  role: ProvenanceEntry['role'] | null,
): ProvenanceEntry[] {
  return provenance.map((leaf) => {
    const layer =
      leaf.layer === 'user-policy'
        ? user
        : leaf.layer === 'operator-policy'
          ? operator
          : null;
    const name =
      layer !== null && layer.view.status === 'ambiguous'
        ? layer.names.join(' | ') || leaf.name
        : leaf.name;
    return { ...leaf, name, role: role ?? leaf.role };
  });
}

/**
 * What applies if a queue named `input.name` is declared with these arguments: the policy of each
 * layer is picked as the broker would, then `resolveEffective` runs. When the pick is ambiguous,
 * every candidate is resolved and a key keeps its answer only if all candidates give the same one.
 */
export function resolveHypothetical(
  input: HypotheticalInput,
  lookup: EffectiveConfigLookup = semanticsRegistry.effectiveConfig,
): HypotheticalResult {
  const target: PolicyTarget = {
    kind: 'queue',
    name: input.name,
    queueType: input.queueType,
  };
  const userMatch = matchPolicy(input.policies, target);
  const operatorMatch = matchPolicy(input.operatorPolicies, target);
  const user = layerOf(userMatch);
  const operator = layerOf(operatorMatch);

  const keys = new Set<string>(input.keys ?? []);
  for (const layer of [user, operator]) {
    for (const choice of layer.choices) {
      if (choice !== null)
        for (const key of Object.keys(choice.definition)) keys.add(key);
    }
    for (const key of layer.overflowKeys) keys.add(key);
  }
  const requested = [...keys].sort();

  const results: EffectiveConfig[] = [];
  for (const userChoice of user.choices) {
    for (const operatorChoice of operator.choices) {
      results.push(
        resolveEffective(
          {
            queueType: input.queueType,
            version: input.version,
            args: input.args,
            userPolicy: userChoice,
            operatorPolicy: operatorChoice,
            keys: requested,
          },
          lookup,
        ),
      );
    }
  }

  const first = results[0];
  if (first === undefined)
    throw new Error('unreachable: a layer always has a choice');
  const uncertain = [
    ...(userMatch.kind === 'ambiguous' ? userMatch.uncertain : []),
    ...(operatorMatch.kind === 'ambiguous' ? operatorMatch.uncertain : []),
  ];
  const ambiguous =
    user.view.status === 'ambiguous' || operator.view.status === 'ambiguous';

  const warnings: EffectiveWarning[] = uncertain.map((entry) =>
    patternWarning(lookup, entry),
  );
  const candidates = [...user.names, ...operator.names].join(', ');
  if (
    (userMatch.kind === 'ambiguous' && userMatch.tied) ||
    (operatorMatch.kind === 'ambiguous' && operatorMatch.tied)
  ) {
    warnings.push(tieWarning(lookup, candidates));
  }

  if (!ambiguous) {
    return {
      ...first,
      warnings: [...first.warnings, ...warnings],
      userMatch: user.view,
      operatorMatch: operator.view,
    };
  }

  const forced = new Set<string>([
    ...user.overflowKeys,
    ...operator.overflowKeys,
  ]);
  const entries: [string, EffectiveEntry][] = [];
  for (const key of Object.keys(first.entries).sort()) {
    const all = results.map((result) => result.entries[key]);
    const lead = all[0];
    if (lead === undefined) continue;
    const agree =
      !forced.has(key) &&
      all.every((entry) => entry !== undefined && sameAnswer(entry, lead));
    entries.push([
      key,
      agree
        ? {
            ...lead,
            provenance: renamed(lead.provenance, user, operator, null),
            warnings: lead.warnings,
          }
        : {
            ...lead,
            status: 'unknown',
            value: null,
            rule: null,
            mergeRule: null,
            basis: null,
            provenance: renamed(lead.provenance, user, operator, 'unresolved'),
            warnings: [tieWarning(lookup, candidates)],
          },
    ]);
  }

  return {
    ...first,
    entries: Object.fromEntries(entries),
    // The merged policy belongs to one choice of policies; with several candidates there is none.
    mergedPolicy: { notEffective: true, entries: {} },
    warnings,
    userMatch: user.view,
    operatorMatch: operator.view,
  };
}
