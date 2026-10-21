// One implementAction per file in this directory. The action generator lists each factory here;
// the module calls every one with its ports.
import type { ActionImpl } from '@app/kernel';

import type { ExplorerModuleDeps } from '../deps';
import { createInventoryQueryAction } from './inventory-query';

export const actionFactories: readonly ((
  deps: ExplorerModuleDeps,
) => ActionImpl)[] = [createInventoryQueryAction];

export function createActions(deps: ExplorerModuleDeps): readonly ActionImpl[] {
  return actionFactories.map((create) => create(deps));
}
