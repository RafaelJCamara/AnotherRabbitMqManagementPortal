// DLX-source analysis (M1-03, R7, amendment A-2): which queues dead-letter into a queue, and with
// what delivery limit. W-OVERLIMIT and the DLQ hazard advisor read it, so an EMPTY or PARTIAL
// answer must never read as "no hazard": `complete` is true only when nothing was unknown, and
// every unknown has a code (`unknownReasons`). The consumer treats an incomplete answer as a finite
// but unknown limit (human consent; AI and unattended runs blocked); that rule is not here.
//
// A source is a queue with a dead-letter exchange whose dead letters can be routed to the target
// (`routeDeadLetter`: exact for a fixed key, a may-reach over-approximation otherwise, OQ-1304).
// Chains are not followed: the source of a source feeds the source, and the delivery counter the
// target sees comes from the direct source.
import {
  indexDeadLetters,
  newDlxTruncation,
  resolveDlxLimits,
  routeDeadLetter,
} from './dlx.ts';
import type { DeadLetterIndex, DlxLimitOptions } from './dlx.ts';
import { compareNames } from './e2e.ts';
import { deadLetterReasons } from './ttl.ts';
import type { DeliveryLimit } from '@app/semantics';
import type {
  DeadLetterReason,
  DlxTruncation,
  RoutingTopology,
  TopologyQueue,
} from './types.ts';

/** What the caller could not read (the topology cannot know that). */
export type ContextGap =
  | 'policy-unreadable'
  | 'operator-policy-unreadable'
  | 'stats-fields-missing'
  | 'other-clients-may-declare';

export type UnknownReasonCode =
  | ContextGap
  /** A queue whose dead-letter setting could not be read could feed the target. */
  | 'dead-letter-unknown'
  /** A source's delivery limit is absent or unknown. */
  | 'source-limit-unknown'
  /** A dead-letter route crosses an exchange the simulator cannot model. */
  | 'unknown-exchange-in-path'
  /** The target holds messages whose x-death names a queue that is not a known source. */
  | 'held-death-source-missing'
  /** The target is not in the topology. */
  | 'target-not-found'
  /** A limit cut the analysis (counted in `truncation`). */
  | 'truncated';

export interface UnknownReason {
  readonly code: UnknownReasonCode;
  /** The queue or exchange concerned, when there is one. */
  readonly subject?: string;
}

export interface DlxSource {
  readonly queue: string;
  /** The SOURCE's limit; absent in the topology means unknown, never unlimited (OQ-1301). */
  readonly limit: DeliveryLimit;
  readonly certainty: 'definite' | 'possible';
  /** The exchanges of the first route found, from the dead-letter exchange on; empty if unknown. */
  readonly via: readonly string[];
  readonly reasons: readonly DeadLetterReason[];
}

export interface DlxSourcesContext {
  readonly gaps?: readonly ContextGap[];
  readonly limits?: DlxLimitOptions;
}

export interface DlxSourcesResult {
  /** Sorted by queue name. */
  readonly sources: readonly DlxSource[];
  /** True only when `unknownReasons` is empty. An empty `sources` with `complete` is "no hazard". */
  readonly complete: boolean;
  readonly unknownReasons: readonly UnknownReason[];
  readonly truncation: DlxTruncation;
}

/**
 * The reasons a queue may dead-letter, for the hazard analysis. Unlike `deadLetterReasons` (which
 * needs `rejectable === true` to list `rejected`, OQ-1302), a queue is assumed to be rejectable
 * unless it says `rejectable: false`: a consumer we cannot see may reject, and a source we skip
 * is a hazard we hide (A-2, OQ-1311).
 */
function sourceReasons(queue: TopologyQueue): readonly DeadLetterReason[] {
  const reasons = deadLetterReasons(queue);
  if (queue.rejectable === false || reasons.includes('rejected'))
    return reasons;
  return [...reasons, 'rejected'];
}

const UNKNOWN_LIMIT: DeliveryLimit = { kind: 'unknown' };

function compareReasons(a: UnknownReason, b: UnknownReason): number {
  return (
    compareNames(a.code, b.code) ||
    compareNames(a.subject ?? '', b.subject ?? '')
  );
}

/**
 * The queues that dead-letter into `target`, each with its delivery limit, and everything the
 * analysis could not establish. `topology` may be the result of `indexDeadLetters` to reuse the
 * index (one index serves every source examined).
 */
export function dlxSources(
  topology: RoutingTopology | DeadLetterIndex,
  target: string,
  context: DlxSourcesContext = {},
): DlxSourcesResult {
  const index = indexDeadLetters(topology);
  const limits = resolveDlxLimits(context.limits);
  const acc = newDlxTruncation();
  const reasons = new Map<string, UnknownReason>();
  const unknown = (code: UnknownReasonCode, subject?: string): void => {
    const key = `${code}\u0000${subject ?? ''}`;
    if (!reasons.has(key)) {
      reasons.set(key, subject === undefined ? { code } : { code, subject });
    }
  };
  for (const gap of context.gaps ?? []) unknown(gap);

  const targetQueue = index.queues.get(target);
  if (targetQueue === undefined) {
    unknown('target-not-found', target);
    return finish([], reasons, acc);
  }

  const sources = new Map<string, DlxSource>();
  const addSource = (
    queue: TopologyQueue,
    certainty: 'definite' | 'possible',
    via: readonly string[],
  ): void => {
    if (sources.has(queue.name)) return;
    const limit = queue.deliveryLimit ?? UNKNOWN_LIMIT;
    if (limit.kind === 'unknown') unknown('source-limit-unknown', queue.name);
    sources.set(queue.name, {
      queue: queue.name,
      limit,
      certainty,
      via,
      reasons: sourceReasons(queue),
    });
  };

  // Sorted, so that the cut (if any) and the answer do not depend on the input order.
  const names = [...index.queues.keys()].sort(compareNames);
  names.forEach((name, position) => {
    if (position >= limits.maxDlxSourcesScanned) {
      acc.sources += 1;
      return;
    }
    const queue = index.queues.get(name);
    if (queue?.deadLetter === undefined) return;

    const routing = routeDeadLetter(index, queue, null, limits, acc);
    if (routing.kind === 'unknown-setting') {
      // It may feed the target; the limit of a queue we cannot read is unknown as well.
      unknown('dead-letter-unknown', name);
      addSource(queue, 'possible', []);
      return;
    }
    if (routing.kind !== 'routed') return;
    if (sourceReasons(queue).length === 0) return;
    const routed = routing.routed;
    if (routed.missingExchange) return;

    if (routed.anyQueue) {
      // Open keys on the default exchange: the dead letter can go to any queue.
      addSource(queue, 'possible', [routed.exchange]);
      return;
    }
    const hit = routed.targets.find((t) => t.queue === target);
    // An exchange that is neither modelled nor a hash/random one could route anywhere.
    const shared = new Set(routed.shares.map((share) => share.exchange));
    const opaque = routed.unknownExchanges.filter(
      (unknownExchange) => !shared.has(unknownExchange.exchange),
    );
    for (const exchange of opaque) {
      unknown('unknown-exchange-in-path', exchange.exchange);
    }
    if (hit !== undefined) {
      addSource(queue, hit.certainty, hit.via);
    } else if (opaque.length > 0) {
      addSource(queue, 'possible', [routed.exchange]);
    }
  });

  // A queue named by the broker's x-death of the target's messages is a DLX source even when no
  // current queue feeds the target (A-2).
  for (const name of targetQueue.heldDeathSources ?? []) {
    if (sources.has(name)) continue;
    unknown('held-death-source-missing', name);
    const known = index.queues.get(name);
    if (known !== undefined) {
      addSource(known, 'possible', []);
    } else {
      unknown('source-limit-unknown', name);
      sources.set(name, {
        queue: name,
        limit: UNKNOWN_LIMIT,
        certainty: 'possible',
        via: [],
        reasons: [],
      });
    }
  }

  if (acc.sources + acc.steps + acc.candidates > 0) unknown('truncated');
  return finish([...sources.values()], reasons, acc);
}

function finish(
  sources: DlxSource[],
  reasons: ReadonlyMap<string, UnknownReason>,
  truncation: DlxTruncation,
): DlxSourcesResult {
  const unknownReasons = [...reasons.values()].sort(compareReasons);
  return {
    sources: sources.sort((a, b) => compareNames(a.queue, b.queue)),
    complete: unknownReasons.length === 0,
    unknownReasons,
    truncation,
  };
}
