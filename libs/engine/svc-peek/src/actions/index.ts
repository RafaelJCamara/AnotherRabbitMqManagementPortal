// One implementAction per file in this directory. The action generator lists each factory here;
// the module calls every one with its ports.
import type { ActionImpl } from '@app/kernel';

import type { PeekModuleDeps } from '../deps';

export const actionFactories: readonly ((
  deps: PeekModuleDeps,
) => ActionImpl)[] = [];

export function createActions(deps: PeekModuleDeps): readonly ActionImpl[] {
  return actionFactories.map((create) => create(deps));
}
