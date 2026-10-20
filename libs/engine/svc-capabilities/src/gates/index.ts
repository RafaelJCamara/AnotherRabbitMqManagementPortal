// computeGates: the whole `BrokerProfile.gates` map. Every id of FEATURES is in the result (fail
// closed): a decision that throws, or a feature nobody decides, is a closed gate with a reason.
import type { FeatureId, GateDecision } from '@app/contracts';
import { SemanticsGapError } from '@app/semantics';

import {
  contextOf,
  DECISIONS,
  FEATURES,
  type GateInput,
  type GateProfileInput,
} from './features';

export { FEATURES, type GateInput, type GateProfileInput };

const UNDECIDED: GateDecision = {
  enabled: false,
  reason: 'this feature could not be decided, so it stays closed',
  source: 'svc-capabilities gates',
};

function decide(input: GateInput, feature: FeatureId): GateDecision {
  const decision = DECISIONS[feature]?.(contextOf(input)) ?? UNDECIDED;
  if (!decision.enabled) return decision;
  // A registry row can close what the profile opens (I-3); no row is not a reason to close.
  try {
    const row = input.registry.gate(feature, input.profile);
    return row.enabled
      ? decision
      : {
          enabled: false,
          reason: row.reason ?? UNDECIDED.reason,
          source: row.source ?? 'semantics registry gate row',
        };
  } catch (error) {
    if (error instanceof SemanticsGapError) return decision;
    throw error;
  }
}

/**
 * The class of a thrown value, and nothing else: the constructor name of an error, so a closed gate
 * can say what kind of failure closed it without ever carrying the message, which may hold text of
 * the broker or a credential (I-10). A name that is not a plain identifier (a class renamed at
 * run time, minified or not, can hold anything) is `Error`; a thrown value that is not an error is
 * `non-error`.
 */
export function errorClassOf(error: unknown): string {
  if (!(error instanceof Error)) return 'non-error';
  const name = (error.constructor as { name?: unknown }).name;
  return typeof name === 'string' && /^[A-Za-z_$][\w$]{0,63}$/.test(name)
    ? name
    : 'Error';
}

/** The closed decision of a feature whose decision threw: still closed, now with the class of the failure. */
const undecided = (error: unknown): GateDecision => ({
  ...UNDECIDED,
  source: `${UNDECIDED.source ?? 'svc-capabilities gates'} (${errorClassOf(error)})`,
});

/** Every id of FEATURES is in the result. A decision that cannot be reached is closed with a reason. */
export function computeGates(
  input: GateInput,
): Record<FeatureId, GateDecision> {
  const gates = {} as Record<FeatureId, GateDecision>;
  for (const feature of FEATURES) {
    try {
      gates[feature] = decide(input, feature);
    } catch (error) {
      // Fail closed, never fail silently: the class of the error is in the decision's source.
      gates[feature] = undecided(error);
    }
  }
  return gates;
}
