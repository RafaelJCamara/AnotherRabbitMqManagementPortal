// The disposition (R8, DC-09, amendments A-1 and A-2): what happens to a message that a return
// would drop or dead-letter. It is chosen at PLAN time, never while deliveries are held, and it is
// mandatory for a quorum queue whose limit is finite or unknown.
//
//   quarantine         copy to the quarantine queue with a confirm, then ack. Needs the rescue
//                      preflight; for AI and unattended runs it must be at most 60 s old (A-1).
//   raise-limit        an administrator writes a policy first. Not while the limit is unknown, not
//                      when an argument or operator policy fixes it, never on `nsb.*` or a policy a
//                      provider owns, and -1 only where the registry says -1 keeps the head.
//   let-broker-handle  a person types the queue name. Never for AI or unattended runs, never a default.
//
// A finite-unknown limit blocks every non-human principal (A-2): nothing here can make that safe.
import { decodeObjectKey } from '@app/contracts';
import type { Era, QueueType } from '@app/domain-model';
import { isHumanInteractive } from './principal.ts';
import { resolveCell, type LimitView } from './limit.ts';
import { reject, type PeekRejection, type ReasonCode } from './rejections.ts';
import type {
  Disposition,
  PeekPreflight,
  PeekPrincipal,
  PeekProfile,
  PlannedDisposition,
  PlannerRegistry,
} from './types.ts';

/** How old the rescue check or the preflight may be for an AI or unattended run (A-1). */
export const FRESH_MS = 60_000;

export const LET_BROKER_HANDLE_CONSENT = 'disposition:let-broker-handle';

export type DispositionOutcome =
  | {
      readonly ok: true;
      readonly disposition: PlannedDisposition;
      readonly consents: readonly string[];
    }
  | { readonly ok: false; readonly rejection: PeekRejection };

export interface DispositionInput {
  readonly registry: PlannerRegistry;
  readonly era: Era;
  readonly queueType: QueueType;
  readonly queueName: string;
  readonly limit: LimitView;
  /** The reasons that made the basis finite-unknown, for the rejection of a non-human run. */
  readonly unknownReason: 'limit-unknown' | 'dlx-evidence-unverified';
  readonly requested: Disposition | undefined;
  readonly profile: PeekProfile;
  readonly preflight: PeekPreflight;
  readonly principal: PeekPrincipal;
  readonly nowMs: number;
}

/**
 * Whether a limit of -1 is a safe thing to write in this era: the registry's `minus1` cell for a
 * return must neither destroy the message (3.13) nor send it to the tail (4.0-4.2). A substituted
 * or missing row is not safe: the answer fails closed.
 */
export function minus1IsSafe(registry: PlannerRegistry, era: Era): boolean {
  const found = resolveCell(registry, {
    era,
    queueType: 'quorum',
    protocol: 'amqp091',
    action: 'amqp091.nack_requeue',
    limitState: 'minus1',
    delayedRetry: 'disabled',
  });
  const effect = found?.cell.effect;
  return (
    found !== null &&
    found.gap === null &&
    effect !== null &&
    effect !== undefined &&
    !effect.destructive &&
    effect.position === 'head'
  );
}

/** Whether something taken at `at` is recent enough for an unattended run. */
const isFresh = (at: number, nowMs: number): boolean => {
  const age = nowMs - at;
  return Number.isFinite(age) && age >= 0 && age <= FRESH_MS;
};

/** Why the quarantine path cannot be used right now; empty when it can. */
function rescueFailures(
  input: DispositionInput,
  human: boolean,
  queue: string | undefined,
): ReasonCode[] {
  const rescue = input.preflight.rescue;
  if (rescue === undefined) return ['no-rescue'];
  const reasons: ReasonCode[] = [];
  if (queue !== undefined && queue !== rescue.queueName) {
    reasons.push('no-rescue');
  }
  if (!rescue.queueReady) reasons.push('rescue-queue-not-ready');
  if (!rescue.overflowSafe) reasons.push('rescue-overflow-unsafe');
  if (!rescue.permissionOk) reasons.push('rescue-permission');
  if (rescue.alarms.length > 0) reasons.push('rescue-alarm');
  if (rescue.publishBlocked) reasons.push('rescue-publish-blocked');
  if (!human && !isFresh(rescue.checkedAt, input.nowMs)) {
    reasons.push('rescue-stale');
  }
  return reasons;
}

/** Why raising the limit is not possible for this queue and person; empty when it is. */
function raiseLimitBlocks(
  input: DispositionInput,
  human: boolean,
  policyName: string | undefined,
): ReasonCode[] {
  const reasons: ReasonCode[] = [];
  const { queue } = input.preflight;
  if (!human && !isFresh(input.preflight.takenAt, input.nowMs)) {
    reasons.push('raise-limit-stale');
  }
  if (!input.profile.identity.isAdmin) reasons.push('raise-limit-not-admin');
  if (input.limit.basis === 'finite-unknown') {
    reasons.push('raise-limit-unknown-limit');
  }
  if (
    queue.limitFixedBy === 'argument' ||
    queue.limitFixedBy === 'operator-policy'
  ) {
    reasons.push('raise-limit-capped');
  }
  if (
    policyName !== undefined &&
    (policyName.startsWith('nsb.') ||
      input.profile.managedObjects.some(
        (object) => object.kind === 'policy' && object.name === policyName,
      ))
  ) {
    reasons.push('raise-limit-protected-name');
  }
  return reasons;
}

export function planDisposition(input: DispositionInput): DispositionOutcome {
  if (input.queueType !== 'quorum') {
    return {
      ok: true,
      disposition: { kind: 'none', reason: 'classic' },
      consents: [],
    };
  }
  if (input.limit.basis === 'unlimited') {
    return {
      ok: true,
      disposition: { kind: 'none', reason: 'unlimited' },
      consents: [],
    };
  }

  const human = isHumanInteractive(input.principal);
  const { requested } = input;
  const fail = (
    code: 'NO_SAFE_DISPOSITION' | 'RESCUE_PREFLIGHT_FAILED' | 'INVALID_REQUEST',
    reasons: readonly [ReasonCode, ...ReasonCode[]],
    offers?: readonly Disposition['kind'][],
  ): DispositionOutcome => ({
    ok: false,
    rejection: reject(code, reasons, { offers }),
  });

  // A-2: with an unknown limit nothing is safe enough for a run nobody watches.
  if (!human && input.limit.basis === 'finite-unknown') {
    return fail('NO_SAFE_DISPOSITION', [input.unknownReason]);
  }

  if (requested === undefined) {
    const rescue = input.preflight.rescue;
    const failures = rescueFailures(input, human, undefined);
    if (failures.length === 0 && rescue !== undefined) {
      return {
        ok: true,
        disposition: {
          kind: 'quarantine',
          queue: rescue.queueName,
          chosenBy: 'default',
        },
        consents: [],
      };
    }
    const offers: Disposition['kind'][] = [];
    if (raiseLimitBlocks(input, human, undefined).length === 0) {
      offers.push('raise-limit');
    }
    if (human) offers.push('let-broker-handle');
    return fail(
      'NO_SAFE_DISPOSITION',
      ['no-safe-disposition', ...failures],
      offers,
    );
  }

  switch (requested.kind) {
    case 'quarantine': {
      const failures = rescueFailures(input, human, requested.queue);
      const [first, ...rest] = failures;
      if (first !== undefined) {
        return fail('RESCUE_PREFLIGHT_FAILED', [first, ...rest]);
      }
      return {
        ok: true,
        disposition: {
          kind: 'quarantine',
          queue: requested.queue,
          chosenBy: 'request',
        },
        consents: [],
      };
    }
    case 'raise-limit': {
      const blocks = raiseLimitBlocks(input, human, requested.policyName);
      const [first, ...rest] = blocks;
      if (first !== undefined)
        return fail('NO_SAFE_DISPOSITION', [first, ...rest]);
      const { value } = requested;
      const current =
        input.limit.basis === 'finite' ? input.limit.value : undefined;
      const valid =
        Number.isSafeInteger(value) &&
        (value === -1
          ? minus1IsSafe(input.registry, input.era)
          : current !== undefined && value > current);
      if (!valid) return fail('INVALID_REQUEST', ['raise-limit-value-invalid']);
      return {
        ok: true,
        disposition: {
          kind: 'raise-limit',
          policyName: requested.policyName,
          value,
          chosenBy: 'request',
        },
        consents: [],
      };
    }
    case 'let-broker-handle': {
      if (!human)
        return fail('NO_SAFE_DISPOSITION', ['let-broker-handle-non-human']);
      if (requested.typedConsent !== input.queueName) {
        return fail('INVALID_REQUEST', ['typed-consent-mismatch']);
      }
      return {
        ok: true,
        disposition: { kind: 'let-broker-handle', chosenBy: 'request' },
        consents: [LET_BROKER_HANDLE_CONSENT],
      };
    }
  }
}

/** The queue name of an object key, or undefined for a key that does not decode (R2, step 1). */
export function queueNameOf(
  key: Parameters<typeof decodeObjectKey>[0],
): string | undefined {
  try {
    return decodeObjectKey(key).name;
  } catch {
    return undefined;
  }
}
