// One implementAction per file in this directory. The action generator lists each factory here;
// the module calls every one with its ports.
import type { ActionImpl } from '@app/kernel';

import type { IdentityModuleDeps } from '../deps';

export const actionFactories: readonly ((
  deps: IdentityModuleDeps,
) => ActionImpl)[] = [];

export function createActions(deps: IdentityModuleDeps): readonly ActionImpl[] {
  return actionFactories.map((create) => create(deps));
}
