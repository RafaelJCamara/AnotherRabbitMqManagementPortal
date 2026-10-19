// The fingerprint of a BrokerProfile: a plan is bound to it (`PLAN_STALE` when it changes), so it
// must change when anything a decision reads changes and must not change when only the time of the
// probe does. It is the SHA-256 of the profile's canonical JSON without `probedAt`, `fingerprint`
// and the per-principal `allowedActions`.
import { createHash } from 'node:crypto';

import type { BrokerProfile } from '@app/domain-model';

/** JSON with object keys in sorted order at every level, so equal profiles give equal text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const fields = Object.entries(value as Record<string, unknown>)
      .filter(([, field]) => field !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`);
    return `{${fields.join(',')}}`;
  }
  // undefined fields are dropped above, so a primitive reaching here always has a JSON text.
  return JSON.stringify(value);
}

export function fingerprintOf(
  profile: Omit<BrokerProfile, 'fingerprint' | 'probedAt' | 'allowedActions'>,
): string {
  return createHash('sha256').update(canonicalJson(profile)).digest('hex');
}
