// keybindings.get: Read the keybinding overrides of the caller
import { KeybindingOverridesSchema, keybindingsGet } from '@app/contracts';
import { implementAction, type ActionImpl } from '@app/kernel';

import type { WorkspaceModuleDeps } from '../deps';
import { ownerOf } from '../internal/common';

/** The one document of the `keybindings` kind: the whole set of overrides. */
export const KEYBINDINGS_KEY = 'overrides';

/** The ports this action reads through: a subset of the module's deps (src/deps.ts). */
export type KeybindingsGetDeps = Pick<WorkspaceModuleDeps, 'workspace'>;

export const createKeybindingsGetAction = (
  deps: KeybindingsGetDeps,
): ActionImpl<typeof keybindingsGet> =>
  implementAction(keybindingsGet, {
    execute: async (_input, ctx) => {
      const stored = await deps.workspace.getDocument(
        ownerOf(ctx.principal),
        'keybindings',
        KEYBINDINGS_KEY,
      );
      // Overrides that no longer fit the contract read as "none": the defaults apply.
      const bindings = KeybindingOverridesSchema.safeParse(stored?.value);
      return { bindings: bindings.success ? bindings.data : {} };
    },
  });
