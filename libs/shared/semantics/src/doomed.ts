// The doom guard's rule (ADR-028, blueprint 5.4): is a message that was just acquired already past
// its delivery limit, so that returning it would make the broker drop or dead-letter it?
//
// The rule is applied literally to the observed header, whatever its provenance:
//   4.3 and later:  x-delivery-count >  L
//   4.0 to 4.2:     x-delivery-count >= L   (the header shows the acquired count)
//   3.13 with a limit:                >= L
// A queue without a limit never dooms a message. A limit that cannot be established, or a counter
// that cannot be read, is treated as doomed: a false positive lands recoverably in quarantine, a
// false negative loses the message.
import type { Era } from '@app/domain-model';

export type DeliveryLimit =
  | { readonly kind: 'unlimited' }
  | { readonly kind: 'finite'; readonly value: number }
  | { readonly kind: 'unknown' };

export interface DeliveryCounters {
  /** The `x-delivery-count` header; absent when the message was never returned. */
  readonly deliveryCount?: number | undefined;
  /** The `x-acquired-count` header (4.3 and later); absent when not present. */
  readonly acquiredCount?: number | undefined;
}

const isCount = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

/** True when returning a message with these counters would make the broker drop or dead-letter it. */
export function isDoomed(
  era: Era,
  counters: DeliveryCounters,
  limit: DeliveryLimit,
): boolean {
  if (limit.kind === 'unlimited') return false;
  if (limit.kind === 'unknown' || !Number.isFinite(limit.value)) return true;

  // An absent header means the message was never returned: its counter is zero.
  const deliveryCount = counters.deliveryCount ?? 0;
  const acquiredCount = counters.acquiredCount ?? 0;
  if (!isCount(deliveryCount) || !isCount(acquiredCount)) return true;

  if (era === '4.3' || era === '4.4') return deliveryCount > limit.value;
  // Before 4.3 the header is the acquired count; either counter at the limit dooms the message.
  return Math.max(deliveryCount, acquiredCount) >= limit.value;
}
