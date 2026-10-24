// What topology.graph and topology.subgraph share: read the vhost, convert it, build the graph.
import {
  GRAPH_ELEMENTS_MAX,
  type ConnectionId,
  type GraphAnswer,
} from '@app/contracts';
import { AppError } from '@app/kernel';

import { DEFAULT_TOPOLOGY_LIMITS } from '../deps';

import { nextLoopTurn } from './cooperative';
import { buildGraph } from './graph';
import {
  loadVhost,
  routingInput,
  snapshotMeta,
  type ActionDeps,
  type CallContext,
} from './load';

export async function graphAnswer(
  deps: ActionDeps,
  input: {
    readonly cid: ConnectionId;
    readonly vhost: string;
    readonly maxElements?: number | undefined;
    readonly refresh?: boolean | undefined;
  },
  scope: {
    readonly focus?: {
      readonly kind: 'exchange' | 'queue';
      readonly name: string;
    };
    readonly depth: 0 | 1 | 2;
  },
  ctx: CallContext,
): Promise<GraphAnswer> {
  const loaded = await loadVhost(deps, input, ctx);
  const converted = await routingInput(deps, loaded);
  const result = await buildGraph(converted.topology, {
    ...(scope.focus === undefined ? {} : { focus: scope.focus }),
    depth: scope.depth,
    maxElements: input.maxElements ?? GRAPH_ELEMENTS_MAX,
    every:
      deps.limits?.yieldEveryItems ?? DEFAULT_TOPOLOGY_LIMITS.yieldEveryItems,
    yieldNow: deps.yieldNow ?? nextLoopTurn,
  });
  if (result.kind === 'focus-not-found') {
    const cut = loaded.snapshot.truncation;
    throw new AppError('NOT_FOUND', {
      detail:
        cut.queues > 0 || cut.exchanges > 0
          ? 'The object is not among those that were read; the vhost is larger than the limit.'
          : 'There is no such exchange or queue.',
    });
  }
  return {
    vhost: input.vhost,
    graph: result.graph,
    gaps: [...converted.gaps],
    snapshot: snapshotMeta(loaded.snapshot),
  };
}
