// views.create: Save a view (filters, columns, sort) that works on any connection
import { VIEWS_PER_OWNER_MAX, viewsCreate } from '@app/contracts';
import { AppError, implementAction, type ActionImpl } from '@app/kernel';

import type { WorkspaceModuleDeps } from '../deps';
import {
  alwaysValid,
  ownerOf,
  plainPlan,
  toSavedView,
} from '../internal/common';

/** The ports this action reads through: a subset of the module's deps (src/deps.ts). */
export type ViewsCreateDeps = Pick<WorkspaceModuleDeps, 'workspace' | 'newId'>;

export const createViewsCreateAction = (
  deps: ViewsCreateDeps,
): ActionImpl<typeof viewsCreate> =>
  implementAction(viewsCreate, {
    plan: (input) => plainPlan({ creates: 'view', name: input.name })(),
    revalidate: alwaysValid,
    execute: async (input, ctx) => {
      const owner = ownerOf(ctx.principal);
      // A bounded number of views per person (I-6, I-7). Nothing here names a connection.
      if ((await deps.workspace.countViews(owner)) >= VIEWS_PER_OWNER_MAX) {
        throw new AppError('BUDGET_EXCEEDED', {
          detail: `At most ${String(VIEWS_PER_OWNER_MAX)} views can be saved.`,
        });
      }
      const now = ctx.now();
      const record = {
        id: deps.newId(),
        ownerId: owner,
        name: input.name,
        kind: input.kind,
        definition: input.definition,
        createdAt: now,
        updatedAt: now,
      };
      await deps.workspace.insertView(record);
      return { view: toSavedView(record) };
    },
  });
