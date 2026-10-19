// connections.list: List the connection profiles the caller can see, in windows
import { connectionsList } from '@app/contracts';
import { implementAction, type ActionImpl } from '@app/kernel';

import type { ConnectionsModuleDeps } from '../deps';
import { toProfile } from '../internal/endpoints';

const DEFAULT_PAGE_SIZE = 50;

/** The ports this action reads through: a subset of the module's deps (src/deps.ts). */
export type ConnectionsListDeps = Pick<ConnectionsModuleDeps, 'store'>;

export const createConnectionsListAction = (
  deps: ConnectionsListDeps,
): ActionImpl<typeof connectionsList> =>
  implementAction(connectionsList, {
    execute: async (input, ctx) => {
      const owner = ctx.principal.id;
      const window = await deps.store.list({
        visibleTo: owner,
        limit: input.limit ?? DEFAULT_PAGE_SIZE,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
      const items = [];
      for (const record of window.items) {
        items.push(
          toProfile(record, await deps.store.credentials(record.id), owner),
        );
      }
      return {
        items,
        ...(window.nextCursor === undefined
          ? {}
          : { nextCursor: window.nextCursor }),
      };
    },
  });
