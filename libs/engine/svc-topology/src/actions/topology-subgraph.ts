// topology.subgraph: The neighbourhood of one exchange or queue, at most two hops
// The focus, then the objects within `depth` hops of it over bindings, alternate-exchange links and
// dead-letter links in either direction, held to the cap like the whole graph.
import { topologySubgraph } from '@app/contracts';
import { implementAction, type ActionImpl } from '@app/kernel';

import { graphAnswer } from '../internal/graph-action';
import type { ActionDeps } from '../internal/load';

/** The ports this action reads through (src/internal/load.ts). */
export type TopologySubgraphDeps = ActionDeps;

export const createTopologySubgraphAction = (
  deps: TopologySubgraphDeps,
): ActionImpl<typeof topologySubgraph> =>
  implementAction(topologySubgraph, {
    execute: (input, ctx) =>
      graphAnswer(
        deps,
        input,
        { focus: input.focus, depth: input.depth ?? 1 },
        ctx,
      ),
  });
