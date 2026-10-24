// Why an answer may be incomplete, as closed codes (spec R6). The first four are the `ContextGap`s of
// `dlxSources` (A-2) and are passed to it; the other two are this module's. An answer built with any
// gap is not exact, whatever the library says, and a consumer must never read an empty list as "no
// hazard" when a gap exists.
import { TOPOLOGY_GAPS, type TopologyGapCode } from '@app/contracts';
import type { BrokerProfile } from '@app/domain-model';
import type { ContextGap } from '@app/routing';

import type { Snapshot, SnapshotTruncation } from './snapshot';

export type TopologyGap = TopologyGapCode;

const CONTEXT_GAPS: ReadonlySet<TopologyGap> = new Set<ContextGap>([
  'policy-unreadable',
  'operator-policy-unreadable',
  'stats-fields-missing',
  'other-clients-may-declare',
]);

/** What conversion found while reading the rows. */
export interface ConversionFlags {
  readonly statsMissing: boolean;
  readonly undecided: boolean;
  /** Rows that could not be used (a binding to a destination of an unknown type). */
  readonly skipped: number;
}

export function cutAnything(truncation: SnapshotTruncation): boolean {
  return Object.values(truncation).some((count) => count > 0);
}

/** The gaps of an answer, sorted in the order of `TOPOLOGY_GAPS`. */
export function collectGaps(
  snapshot: Snapshot,
  profile: BrokerProfile,
  flags: ConversionFlags,
): readonly TopologyGap[] {
  const found = new Set<TopologyGap>();
  if (snapshot.policies.state === 'unreadable') found.add('policy-unreadable');
  if (snapshot.operatorPolicies.state === 'unreadable') {
    found.add('operator-policy-unreadable');
  }
  if (flags.statsMissing) found.add('stats-fields-missing');
  // The listing may not show every queue to a principal that cannot monitor (OQ-1408).
  if (!profile.identity.isAdmin && !profile.identity.canMonitor) {
    found.add('other-clients-may-declare');
  }
  if (flags.undecided) found.add('policy-match-undecided');
  if (
    cutAnything(snapshot.truncation) ||
    snapshot.consumers === 'truncated' ||
    flags.skipped > 0
  ) {
    found.add('truncated');
  }
  return TOPOLOGY_GAPS.filter((gap) => found.has(gap));
}

/** The gaps `dlxSources` takes. */
export function contextGaps(gaps: readonly TopologyGap[]): ContextGap[] {
  return gaps.filter((gap): gap is ContextGap => CONTEXT_GAPS.has(gap));
}
