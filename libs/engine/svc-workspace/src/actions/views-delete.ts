// views.delete: Delete a saved view
import { viewsDelete } from '@app/contracts';
import { AppError, implementAction, type ActionImpl } from '@app/kernel';

import type { WorkspaceModuleDeps } from '../deps';
import { alwaysValid, ownerOf, plainPlan } from '../internal/common';

/** The ports this action reads through: a subset of the module's deps (src/deps.ts). */
export type ViewsDeleteDeps = Pick<WorkspaceModuleDeps, 'workspace'>;

export const createViewsDeleteAction = (
  deps: ViewsDeleteDeps,
): ActionImpl<typeof viewsDelete> =>
  implementAction(viewsDelete, {
    plan: (input) => plainPlan({ deletes: 'view', viewId: input.viewId })(),
    revalidate: alwaysValid,
    execute: async (input, ctx) => {
      // The repository deletes only the caller's own view, so another person's id is "not found".
      const deleted = await deps.workspace.deleteView(
        ownerOf(ctx.principal),
        input.viewId,
      );
      if (!deleted) {
        throw new AppError('NOT_FOUND', {
          detail: `There is no saved view ${input.viewId}.`,
        });
      }
      return {};
    },
  });
