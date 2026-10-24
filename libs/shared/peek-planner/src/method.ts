// The method (R9, DC-10, amendment A-3): how the messages are read.
//
//   amqp091.get           the default, sequential basic.get on a dedicated peek connection.
//   amqp091.consumer-sac  a consumer, for a quorum queue with single active consumer and no active
//                         consumer (basic.get is refused there), only where the registry's
//                         consumer_timeout cell adds no failed delivery and does not close the channel.
//   amqp10.credit1-step   opt-in; credit 1 and a `released` per step. Needs the same of the
//                         `released` cell AND the strict doom rule: a 1.0 client sees the count the
//                         guard needs only there (before 4.3 it cannot see the acquired count).
//   http.get_fallback     A-3. Only for a classic queue, or an unlimited quorum queue that is provably
//                         not a dead-letter target in an era with the strict rule. Never for a finite
//                         or unknown limit, never for a queue that fails the dead-letter check: the
//                         HTTP route settles server-side and cannot stop at the first doomed message.
//
// "Offered" is decided by registry cells and the doom probe, never by an era name (I-3).
import type { Era } from '@app/domain-model';
import type { SettleAction, SettleEffect } from '@app/semantics';
import { provablyNonDlx } from './dlx-hazard.ts';
import { carriesDeliveryCount, resolveCell, type LimitView } from './limit.ts';
import type { ReasonCode } from './rejections.ts';
import type {
  PeekMethod,
  PeekPreflight,
  PlannerRegistry,
  PreferredMethod,
} from './types.ts';

/** The HTTP route takes at most this many messages (DC-10). */
export const HTTP_FALLBACK_MAX = 50;

export type MethodOutcome =
  | { readonly ok: true; readonly method: PeekMethod }
  | {
      readonly ok: false;
      readonly reasons: readonly [ReasonCode, ...ReasonCode[]];
    };

export interface MethodInput {
  readonly registry: PlannerRegistry;
  readonly era: Era;
  readonly preflight: PeekPreflight;
  /** The limit as the plan will use it (after the dead-letter verdict). */
  readonly limit: LimitView;
  readonly prefer: PreferredMethod | undefined;
}

/**
 * A return or a timeout that adds no failed delivery, is not counted against the limit and does not
 * destroy the message: the effects the consumer path and the 1.0 path rely on.
 */
export function addsNoFailedDelivery(effect: SettleEffect | null): boolean {
  return (
    effect !== null &&
    effect.deltaDC === 0 &&
    effect.countsTowardLimit !== 'yes' &&
    !effect.destructive
  );
}

/** The effect of an action in this era, only when a row of the era itself answers (no substitute). */
function ownEffect(
  input: MethodInput,
  action: SettleAction,
  protocol: 'amqp091' | 'amqp10',
): SettleEffect | null {
  const found = resolveCell(input.registry, {
    era: input.era,
    queueType: 'quorum',
    protocol,
    action,
    limitState: input.limit.state,
    delayedRetryMatters: false,
  });
  return found !== null && found.gap === null ? found.cell.effect : null;
}

export function chooseMethod(input: MethodInput): MethodOutcome {
  const { preflight, limit, prefer } = input;
  const queue = preflight.queue;
  const quorum = queue.type === 'quorum';
  const unavailable = (
    ...reasons: [ReasonCode, ...ReasonCode[]]
  ): MethodOutcome => ({ ok: false, reasons });

  if (prefer === 'http-fallback') {
    if (quorum && queue.singleActiveConsumer) {
      return unavailable('sac-consumer-path-unavailable');
    }
    if (!quorum) return { ok: true, method: 'http.get_fallback' };
    const reasons: ReasonCode[] = [];
    if (limit.basis === 'finite') reasons.push('http-limit-finite');
    if (limit.basis === 'finite-unknown') reasons.push('http-limit-unknown');
    if (limit.basis === 'unlimited') {
      if (!carriesDeliveryCount(input.registry, input.era)) {
        reasons.push('http-era-not-strict');
      }
      if (!provablyNonDlx(preflight)) {
        reasons.push(
          preflight.heldDeathSources === undefined
            ? 'http-held-death-unchecked'
            : 'http-not-provably-non-dlx',
        );
      }
    }
    const [first, ...rest] = reasons;
    return first === undefined
      ? { ok: true, method: 'http.get_fallback' }
      : unavailable(first, ...rest);
  }

  if (prefer === 'amqp10-step') {
    const released = ownEffect(input, 'amqp10.released', 'amqp10');
    return quorum &&
      !queue.singleActiveConsumer &&
      addsNoFailedDelivery(released) &&
      carriesDeliveryCount(input.registry, input.era)
      ? { ok: true, method: 'amqp10.credit1-step' }
      : unavailable('amqp10-not-available');
  }

  if (quorum && queue.singleActiveConsumer) {
    const timeout = ownEffect(input, 'consumer_timeout', 'amqp091');
    return addsNoFailedDelivery(timeout)
      ? { ok: true, method: 'amqp091.consumer-sac' }
      : unavailable('sac-consumer-path-unavailable');
  }
  return { ok: true, method: 'amqp091.get' };
}
