// One implementAction per file in this directory. The action generator lists each factory here;
// the module calls every one with its ports.
import type { ActionImpl } from '@app/kernel';

import type { MetricsModuleDeps } from '../deps';

export const actionFactories: readonly ((
  deps: MetricsModuleDeps,
) => ActionImpl)[] = [];

export function createActions(deps: MetricsModuleDeps): readonly ActionImpl[] {
  return actionFactories.map((create) => create(deps));
}
