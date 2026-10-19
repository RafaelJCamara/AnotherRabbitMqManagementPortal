// One implementAction per file in this directory. The action generator lists each factory here;
// the module calls every one with its ports.
import type { ActionImpl } from '@app/kernel';

import type { WorkspaceModuleDeps } from '../deps';
import { createLayoutsGetAction } from './layouts-get';
import { createLayoutsPutAction } from './layouts-put';
import { createViewsListAction } from './views-list';
import { createViewsCreateAction } from './views-create';
import { createViewsDeleteAction } from './views-delete';
import { createSettingsGetAction } from './settings-get';
import { createSettingsPutAction } from './settings-put';
import { createKeybindingsGetAction } from './keybindings-get';
import { createKeybindingsPutAction } from './keybindings-put';

export const actionFactories: readonly ((
  deps: WorkspaceModuleDeps,
) => ActionImpl)[] = [
  createLayoutsGetAction,
  createLayoutsPutAction,
  createViewsListAction,
  createViewsCreateAction,
  createViewsDeleteAction,
  createSettingsGetAction,
  createSettingsPutAction,
  createKeybindingsGetAction,
  createKeybindingsPutAction,
];

export function createActions(
  deps: WorkspaceModuleDeps,
): readonly ActionImpl[] {
  return actionFactories.map((create) => create(deps));
}
