// The broker context of a normalisation, from the semantics registry (I-3). The question is
// whether the broker interprets a client-published `x-death` (up to 3.13) or keeps it opaque (4.0
// and later); the registry answers it as the capability `clientDeathHeaderInterpreted` for the
// cluster's BrokerProfile, and holds it only while every node is proven below 4.0.0. A lookup that
// throws (a gap) or answers for an unreadable cluster is unknown, which fails closed.
import type { CapabilityProfile } from '@app/semantics';
import type { DeathContext } from './types.ts';

/** The registry capability that carries the rule. */
export const INTERPRETED_CAPABILITY = 'clientDeathHeaderInterpreted';

/**
 * `capability` is `semanticsRegistry.capability`. A capability holds only on evidence and answers
 * false for a cluster that cannot be read, so false here means "kept opaque or unknown"; a throw
 * means the registry has no rule, which is unknown (null).
 */
export function deathContext(
  capability: (id: string, profile: CapabilityProfile) => boolean,
  profile: CapabilityProfile,
): DeathContext {
  try {
    return {
      clientDeathInterpreted: capability(INTERPRETED_CAPABILITY, profile),
    };
  } catch {
    return { clientDeathInterpreted: null };
  }
}
