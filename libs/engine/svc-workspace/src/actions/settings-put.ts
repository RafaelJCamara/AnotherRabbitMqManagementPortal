// settings.put: Change workspace settings
import { settingsPut } from '@app/contracts';
import { implementAction, type ActionImpl } from '@app/kernel';

import type { WorkspaceModuleDeps } from '../deps';
import { alwaysValid, ownerOf, plainPlan } from '../internal/common';
import { readSettings } from '../internal/settings';

/** The ports this action reads through: a subset of the module's deps (src/deps.ts). */
export type SettingsPutDeps = Pick<WorkspaceModuleDeps, 'workspace'>;

export const createSettingsPutAction = (
  deps: SettingsPutDeps,
): ActionImpl<typeof settingsPut> =>
  implementAction(settingsPut, {
    plan: (input) =>
      plainPlan({ changes: Object.keys(input.settings).sort() })(),
    revalidate: alwaysValid,
    execute: async (input, ctx) => {
      const owner = ownerOf(ctx.principal);
      // The input is the strict schema of the known keys (the executor has already refused any
      // other), and each key is its own document, so a write of one key leaves the rest alone.
      for (const [key, value] of Object.entries(input.settings)) {
        if (value !== undefined) {
          await deps.workspace.putDocument(owner, 'setting', key, value);
        }
      }
      return { settings: await readSettings(deps.workspace, owner) };
    },
  });
