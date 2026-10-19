// settings.get: Read the workspace settings of the caller
import { settingsGet } from '@app/contracts';
import { implementAction, type ActionImpl } from '@app/kernel';

import type { WorkspaceModuleDeps } from '../deps';
import { ownerOf } from '../internal/common';
import { readSettings } from '../internal/settings';

/** The ports this action reads through: a subset of the module's deps (src/deps.ts). */
export type SettingsGetDeps = Pick<WorkspaceModuleDeps, 'workspace'>;

export const createSettingsGetAction = (
  deps: SettingsGetDeps,
): ActionImpl<typeof settingsGet> =>
  implementAction(settingsGet, {
    execute: async (_input, ctx) => ({
      settings: await readSettings(deps.workspace, ownerOf(ctx.principal)),
    }),
  });
