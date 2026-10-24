// One implementAction per file in this directory. The action generator lists each factory here;
// the module calls every one with its ports and the module's snapshot reader.
import type { ActionImpl } from '@app/kernel';

import type { ActionDeps } from '../internal/load';
import { createQueuesEffectiveConfigAction } from './queues-effective-config';

export const actionFactories: readonly ((deps: ActionDeps) => ActionImpl)[] = [
  createQueuesEffectiveConfigAction,
];

export function createActions(deps: ActionDeps): readonly ActionImpl[] {
  return actionFactories.map((create) => create(deps));
}
