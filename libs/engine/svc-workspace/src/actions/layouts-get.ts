// layouts.get: Read the saved workspace layout of a connection profile
import { LayoutDocumentSchema, layoutsGet } from '@app/contracts';
import { implementAction, type ActionImpl } from '@app/kernel';

import type { WorkspaceModuleDeps } from '../deps';
import { ownerOf } from '../internal/common';

/** The ports this action reads through: a subset of the module's deps (src/deps.ts). */
export type LayoutsGetDeps = Pick<WorkspaceModuleDeps, 'workspace'>;

export const createLayoutsGetAction = (
  deps: LayoutsGetDeps,
): ActionImpl<typeof layoutsGet> =>
  implementAction(layoutsGet, {
    execute: async (input, ctx) => {
      const stored = await deps.workspace.getDocument(
        ownerOf(ctx.principal),
        'layout',
        input.cid,
      );
      // A stored layout that no longer fits the contract (it tightened) reads as "none saved".
      const layout = LayoutDocumentSchema.safeParse(stored?.value);
      return stored !== undefined && layout.success
        ? { layout: layout.data, updatedAt: stored.updatedAt }
        : { layout: null, updatedAt: null };
    },
  });
