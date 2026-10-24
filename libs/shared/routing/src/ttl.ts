// Why a queue can dead-letter (M1-03, R3). A queue sends a message to its dead-letter exchange when
// a consumer rejects it, its TTL runs out, a length limit drops it, or a quorum queue's delivery
// limit is exceeded. The reasons are derived from the queue's resolved settings; nothing here
// compares a broker version (I-3) or looks at a message.
// RS@v4.3.6:deps/rabbit/src/rabbit_amqqueue_process.erl L743-790 (length: drop-head and
// reject-publish-dlx dead-letter, reject-publish does not), L1076-1084 (expiry), L918-925
// (rejection); the quorum delivery limit is documentation only (OQ-1308).
import type { DeadLetterReason, TopologyQueue } from './types.ts';

const isLimit = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * The reasons the queue can dead-letter, sorted. A queue without a dead-letter exchange drops
 * what dies in it, so it has none that go anywhere; a queue whose setting is unknown (a policy
 * that could not be read) is treated as having one. A per-message `expiration` is invisible in a
 * topology, so `expired` needs a queue TTL (OQ-1303). A queue's own `expires` deletes the queue
 * and dead-letters nothing.
 */
export function deadLetterReasons(
  queue: Pick<
    TopologyQueue,
    | 'type'
    | 'deadLetter'
    | 'messageTtlMs'
    | 'maxLength'
    | 'maxLengthBytes'
    | 'overflow'
    | 'deliveryLimit'
    | 'rejectable'
  >,
): readonly DeadLetterReason[] {
  if (queue.deadLetter === undefined) return [];
  if (queue.type === 'stream') return [];

  const reasons: DeadLetterReason[] = [];
  const lengthLimited =
    isLimit(queue.maxLength) || isLimit(queue.maxLengthBytes);
  const overflowDeadLetters =
    queue.overflow === undefined ||
    queue.overflow === null ||
    queue.overflow === 'drop-head' ||
    queue.overflow === 'reject-publish-dlx';

  // Alphabetical, so the list is sorted without a sort call.
  if (queue.type === 'quorum' && queue.deliveryLimit?.kind !== 'unlimited') {
    // An absent limit is unknown, and unknown can be exceeded (OQ-1301).
    reasons.push('delivery_limit');
  }
  if (isLimit(queue.messageTtlMs)) reasons.push('expired');
  if (lengthLimited && overflowDeadLetters) reasons.push('maxlen');
  if (queue.rejectable === true) reasons.push('rejected');
  return reasons;
}
