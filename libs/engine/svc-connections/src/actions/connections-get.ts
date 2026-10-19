// connections.get: Read one connection profile; secrets are reported only as set or not set
import { connectionsGet } from '@app/contracts';
import { implementAction, type ActionImpl } from '@app/kernel';

import type { ConnectionsModuleDeps } from '../deps';
import { loadVisible } from '../internal/common';
import { toProfile } from '../internal/endpoints';

/** The ports this action reads through: a subset of the module's deps (src/deps.ts). */
export type ConnectionsGetDeps = Pick<ConnectionsModuleDeps, 'store'>;

export const createConnectionsGetAction = (
  deps: ConnectionsGetDeps,
): ActionImpl<typeof connectionsGet> =>
  implementAction(connectionsGet, {
    execute: async (input, ctx) => {
      const owner = ctx.principal.id;
      const record = await loadVisible(deps.store, input.cid, owner);
      return {
        profile: toProfile(
          record,
          await deps.store.credentials(input.cid),
          owner,
        ),
      };
    },
  });
