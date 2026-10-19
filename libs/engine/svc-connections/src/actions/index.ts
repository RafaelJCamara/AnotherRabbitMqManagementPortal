// One implementAction per file in this directory. The action generator lists each factory here;
// the module calls every one with its ports.
import type { ActionImpl } from '@app/kernel';

import type { ConnectionsModuleDeps } from '../deps';

export const actionFactories: readonly ((
  deps: ConnectionsModuleDeps,
) => ActionImpl)[] = [];

export function createActions(
  deps: ConnectionsModuleDeps,
): readonly ActionImpl[] {
  return actionFactories.map((create) => create(deps));
}
