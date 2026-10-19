// layouts.put: Save the workspace layout of a connection profile
import { LAYOUTS_PER_OWNER_MAX, layoutsPut } from '@app/contracts';
import { AppError, implementAction, type ActionImpl } from '@app/kernel';

import type { WorkspaceModuleDeps } from '../deps';
import { alwaysValid, ownerOf, plainPlan } from '../internal/common';

/** The ports this action reads through: a subset of the module's deps (src/deps.ts). */
export type LayoutsPutDeps = Pick<WorkspaceModuleDeps, 'workspace'>;

export const createLayoutsPutAction = (
  deps: LayoutsPutDeps,
): ActionImpl<typeof layoutsPut> =>
  implementAction(layoutsPut, {
    plan: (input) => plainPlan({ replaces: 'layout', cid: input.cid })(),
    revalidate: alwaysValid,
    execute: async (input, ctx) => {
      const owner = ownerOf(ctx.principal);
      const existing = await deps.workspace.getDocument(
        owner,
        'layout',
        input.cid,
      );
      // One layout per connection profile and a bounded number of profiles (I-6): a new profile
      // past the cap is refused, a profile that already has a layout is always replaced.
      if (existing === undefined) {
        const kept = await deps.workspace.listDocuments(
          owner,
          'layout',
          LAYOUTS_PER_OWNER_MAX,
        );
        if (kept.length >= LAYOUTS_PER_OWNER_MAX) {
          throw new AppError('BUDGET_EXCEEDED', {
            detail: `At most ${String(LAYOUTS_PER_OWNER_MAX)} layouts can be saved.`,
          });
        }
      }
      await deps.workspace.putDocument(
        owner,
        'layout',
        input.cid,
        input.layout,
      );
      return {};
    },
  });
