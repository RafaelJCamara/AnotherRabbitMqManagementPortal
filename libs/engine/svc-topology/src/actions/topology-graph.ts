// topology.graph: The graph of a vhost, held to a fixed number of elements
// A vhost larger than the cap is aggregated (spec R4): the answer says so, how much was folded, and
// the exact totals of the vhost. It is built from the same snapshot and settings as the routing
// actions, so a dead-letter link is drawn only where the setting could be resolved.
import { topologyGraph } from '@app/contracts';
import { implementAction, type ActionImpl } from '@app/kernel';

import { graphAnswer } from '../internal/graph-action';
import type { ActionDeps } from '../internal/load';

/** The ports this action reads through (src/internal/load.ts). */
export type TopologyGraphDeps = ActionDeps;

export const createTopologyGraphAction = (
  deps: TopologyGraphDeps,
): ActionImpl<typeof topologyGraph> =>
  implementAction(topologyGraph, {
    execute: (input, ctx) => graphAnswer(deps, input, { depth: 1 }, ctx),
  });
