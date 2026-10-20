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

/** Every id of FEATURES is in the result. A decision that cannot be reached is closed with a reason. */
export function computeGates(
  input: GateInput,
): Record<FeatureId, GateDecision> {
  const gates = {} as Record<FeatureId, GateDecision>;
  for (const feature of FEATURES) {
    try {
      gates[feature] = decide(input, feature);
    } catch {
      gates[feature] = UNDECIDED;
    }
  }
  return gates;
}
