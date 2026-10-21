// One implementAction per file in this directory. The action generator lists each factory here;
// the module calls every one with its ports and the module's sweeper.
import type { ActionImpl } from '@app/kernel';

import type { ExplorerModuleDeps } from '../deps';
import type { Sweeper } from '../internal/sweeper';
import { createInventoryQueryAction } from './inventory-query';
import { createOverviewGetAction } from './overview-get';
import { createSearchQueryAction } from './search-query';

/** The module's ports and the one sweeper every action reads the index of. */
export type ExplorerActionDeps = ExplorerModuleDeps & {
  readonly sweeper: Sweeper;
};

export const actionFactories: readonly ((
  deps: ExplorerActionDeps,
) => ActionImpl)[] = [
  createInventoryQueryAction,
  createOverviewGetAction,
  createSearchQueryAction,
];

export function createActions(deps: ExplorerActionDeps): readonly ActionImpl[] {
  return actionFactories.map((create) => create(deps));
}
