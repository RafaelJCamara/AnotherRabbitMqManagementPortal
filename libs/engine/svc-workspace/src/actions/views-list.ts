// views.list: List the saved views of the caller
import { VIEWS_PAGE_MAX, viewsList } from '@app/contracts';
import { implementAction, type ActionImpl } from '@app/kernel';

import type { WorkspaceModuleDeps } from '../deps';
import { ownerOf, toSavedView } from '../internal/common';

const DEFAULT_PAGE_SIZE = 100;

/** The ports this action reads through: a subset of the module's deps (src/deps.ts). */
export type ViewsListDeps = Pick<WorkspaceModuleDeps, 'workspace'>;

export const createViewsListAction = (
  deps: ViewsListDeps,
): ActionImpl<typeof viewsList> =>
  implementAction(viewsList, {
    // The owner is the only scope: a view is not bound to a connection, so no connection id is
    // part of the question and the same list answers on every connection.
    execute: async (input, ctx) => {
      const window = await deps.workspace.listViews(ownerOf(ctx.principal), {
        limit: Math.min(input.limit ?? DEFAULT_PAGE_SIZE, VIEWS_PAGE_MAX),
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
      return {
        items: window.items.map(toSavedView),
        ...(window.nextCursor === undefined
          ? {}
          : { nextCursor: window.nextCursor }),
      };
    },
  });
