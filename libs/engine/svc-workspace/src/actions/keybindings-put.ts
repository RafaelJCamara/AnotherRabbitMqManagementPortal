// keybindings.put: Replace the keybinding overrides
import { keybindingsPut } from '@app/contracts';
import { implementAction, type ActionImpl } from '@app/kernel';

import type { WorkspaceModuleDeps } from '../deps';
import { alwaysValid, ownerOf, plainPlan } from '../internal/common';
import { KEYBINDINGS_KEY } from './keybindings-get';

/** The ports this action reads through: a subset of the module's deps (src/deps.ts). */
export type KeybindingsPutDeps = Pick<WorkspaceModuleDeps, 'workspace'>;

export const createKeybindingsPutAction = (
  deps: KeybindingsPutDeps,
): ActionImpl<typeof keybindingsPut> =>
  implementAction(keybindingsPut, {
    plan: (input) =>
      plainPlan({ overrides: Object.keys(input.bindings).length })(),
    revalidate: alwaysValid,
    execute: async (input, ctx) => {
      await deps.workspace.putDocument(
        ownerOf(ctx.principal),
        'keybindings',
        KEYBINDINGS_KEY,
        input.bindings,
      );
      return {};
    },
  });
