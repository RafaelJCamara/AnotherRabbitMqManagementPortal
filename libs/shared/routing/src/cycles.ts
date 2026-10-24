// Dead-letter loops (M1-03, R5). Nodes are queues; an edge A -> B means a dead letter from A can be
// routed to B (a may-reach edge when the keys are open). The strongly connected components are the
// loops (`findLoops` of e2e.ts works on any named edges).
//
// The broker drops a dead letter that closes a ring when no death since the target's last one was
// a rejection (rabbit_dead_letter:detect_cycles/3, see dlx.ts). So a ring none of whose queues can
// be rejected from is a DROP loop: whatever travels it is dropped when it comes back, on the first
// lap for a queue that dead-letters into itself. A ring with a rejectable queue is a retry ring: it
// keeps messages that were rejected somewhere in it, and drops the others.
import { compareNames, findLoops } from './e2e.ts';
import type { Edge } from './e2e.ts';
import {
  indexDeadLetters,
  newDlxTruncation,
  resolveDlxLimits,
  routeDeadLetter,
} from './dlx.ts';
import type { DeadLetterIndex, DlxLimitOptions } from './dlx.ts';
import { deadLetterReasons } from './ttl.ts';
import type { DlxTruncation, RoutingTopology } from './types.ts';

export interface DlxLoop {
  /** The queues of the loop, sorted. */
  readonly queues: readonly string[];
  readonly kind: 'drop-loop' | 'retry-ring';
  /** True when an edge of the loop is a may-reach edge (open keys). */
  readonly possible: boolean;
}

export interface DlxLoopsResult {
  readonly loops: readonly DlxLoop[];
  /**
   * Queues that dead-letter into the default exchange with open keys: any queue may be the
   * target, so no edge was drawn (their loops are not analysed).
   */
  readonly unresolved: readonly string[];
  readonly truncation: DlxTruncation;
}

/**
 * The dead-letter loops of the topology. Only queues that can dead-letter (a dead-letter exchange
 * and at least one reason) have edges; a queue whose setting is unknown has none.
 */
export function findDlxLoops(
  topology: RoutingTopology | DeadLetterIndex,
  limitOptions: DlxLimitOptions = {},
): DlxLoopsResult {
  const index = indexDeadLetters(topology);
  const limits = resolveDlxLimits(limitOptions);
  const acc = newDlxTruncation();

  const edges: Edge[] = [];
  const possibleEdges = new Set<string>();
  const unresolved: string[] = [];
  for (const queue of index.queues.values()) {
    if (queue.deadLetter?.status !== 'set') continue;
    if (deadLetterReasons(queue).length === 0) continue;
    const routing = routeDeadLetter(index, queue, null, limits, acc);
    if (routing.kind !== 'routed') continue;
    if (routing.routed.anyQueue) {
      unresolved.push(queue.name);
      continue;
    }
    for (const target of routing.routed.targets) {
      edges.push({ from: queue.name, to: target.queue });
      if (target.certainty === 'possible') {
        possibleEdges.add(`${queue.name}\u0000${target.queue}`);
      }
    }
  }

  const found = findLoops(edges);
  const loops: DlxLoop[] = [];
  for (const queues of found) {
    if (loops.length >= limits.maxDlxLoops) {
      acc.loops += 1;
      continue;
    }
    const members = new Set(queues);
    const rejectable = queues.some(
      (name) => index.queues.get(name)?.rejectable === true,
    );
    const possible = edges.some(
      (edge) =>
        members.has(edge.from) &&
        members.has(edge.to) &&
        possibleEdges.has(`${edge.from}\u0000${edge.to}`),
    );
    loops.push({
      queues,
      kind: rejectable ? 'retry-ring' : 'drop-loop',
      possible,
    });
  }
  return {
    loops,
    unresolved: unresolved.sort(compareNames),
    truncation: acc,
  };
}
