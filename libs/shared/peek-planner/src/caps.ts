// Caps (R4): how many messages and how many bytes one peek may take. The numbers are the
// registry's (`peekCaps`: by era, queue type, role and verification, with the conservative ceiling
// for a build that is not verified); the planner only combines them with the request, the hold
// budget and the size of a message, and says which bound was the binding one (I-13: no silent clamp).
import type { Era, QueueType, Verification } from '@app/domain-model';
import { SemanticsGapError } from '@app/semantics';
import type { CapBound, PlannerRegistry } from './types.ts';

export interface CapsInput {
  readonly registry: PlannerRegistry;
  readonly era: Era;
  readonly queueType: QueueType;
  readonly admin: boolean;
  readonly verification: Verification;
  readonly requested: number;
  readonly maxBytes?: number | undefined;
  readonly avgBytes?: number | undefined;
  /** The most messages the hold budget allows (`floor(target / rtt)`). */
  readonly holdCount: number;
  /** A ceiling of the method itself (the HTTP fallback takes at most 50); reported as the cap. */
  readonly methodMax?: number | undefined;
}

export type CapsOutcome =
  | {
      readonly ok: true;
      readonly requested: number;
      readonly count: number;
      readonly bytes: number;
      /** The first binding bound, in the order cap, hold, bytes, request. */
      readonly limitedBy: CapBound;
    }
  | { readonly ok: false; readonly reason: 'avg-message-exceeds-bytes' }
  | {
      readonly ok: false;
      readonly reason: 'semantics-gap';
      readonly key: string;
    };

export function computeCaps(input: CapsInput): CapsOutcome {
  let caps: { def: number; max: number; maxBytes: number };
  try {
    caps = input.registry.peekCaps(
      input.era,
      input.queueType,
      input.admin ? 'admin' : 'user',
      input.verification,
    );
  } catch (error) {
    if (error instanceof SemanticsGapError) {
      return { ok: false, reason: 'semantics-gap', key: error.message };
    }
    throw error;
  }
  const bytes = Math.min(input.maxBytes ?? caps.maxBytes, caps.maxBytes);
  const byBytes =
    input.avgBytes !== undefined && input.avgBytes > 0
      ? Math.floor(bytes / input.avgBytes)
      : Number.POSITIVE_INFINITY;
  if (byBytes < 1) return { ok: false, reason: 'avg-message-exceeds-bytes' };

  const max = Math.min(caps.max, input.methodMax ?? Number.POSITIVE_INFINITY);
  const count = Math.min(input.requested, max, input.holdCount, byBytes);
  const limitedBy: CapBound =
    count === max
      ? 'cap'
      : count === input.holdCount
        ? 'hold'
        : count === byBytes
          ? 'bytes'
          : 'request';
  return { ok: true, requested: input.requested, count, bytes, limitedBy };
}
