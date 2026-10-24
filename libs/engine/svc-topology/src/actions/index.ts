// One implementAction per file in this directory. The action generator lists each factory here;
// the module calls every one with its ports and the module's snapshot reader.
import type { ActionImpl } from '@app/kernel';

import type { ActionDeps } from '../internal/load';
import { createQueuesEffectiveConfigAction } from './queues-effective-config';
import { createTopologyGraphAction } from './topology-graph';
import { createTopologySubgraphAction } from './topology-subgraph';
import { createRoutingSimulateAction } from './routing-simulate';
import { createRoutingDeadLetterAction } from './routing-dead-letter';
import { createRoutingDlxSourcesAction } from './routing-dlx-sources';

export const actionFactories: readonly ((deps: ActionDeps) => ActionImpl)[] = [
  createQueuesEffectiveConfigAction,
  createTopologyGraphAction,
  createTopologySubgraphAction,
  createRoutingSimulateAction,
  createRoutingDeadLetterAction,
  createRoutingDlxSourcesAction,
];

export function createActions(deps: ActionDeps): readonly ActionImpl[] {
  return actionFactories.map((create) => create(deps));
}
