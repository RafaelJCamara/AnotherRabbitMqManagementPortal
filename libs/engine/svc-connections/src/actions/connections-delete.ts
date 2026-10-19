// connections.delete: Delete a connection profile and its stored credentials
import { connectionsDelete } from '@app/contracts';
import { implementAction, type ActionImpl } from '@app/kernel';

import type { ConnectionsModuleDeps } from '../deps';
import { loadEditable, plainPlan } from '../internal/common';

/** The ports this action uses: a subset of the module's deps (src/deps.ts). */
export type ConnectionsDeleteDeps = Pick<ConnectionsModuleDeps, 'store'>;

export const createConnectionsDeleteAction = (
  deps: ConnectionsDeleteDeps,
): ActionImpl<typeof connectionsDelete> =>
  implementAction(connectionsDelete, {
    plan: async (input, ctx) => {
      const record = await loadEditable(
        deps.store,
        input.cid,
        ctx.principal.id,
      );
      const stored = await deps.store.credentials(input.cid);
      return plainPlan({
        deletes: 'connection',
        name: record.name,
        storedCredentials: stored.length,
      })();
    },
    revalidate: async (plan, ctx) => {
      const record = await deps.store.get(plan.input.cid);
      return record?.ownerId === ctx.principal.id
        ? 'valid'
        : {
            stale: 'The connection changed or is gone since the plan was made.',
          };
    },
    execute: async (input, ctx) => {
      await loadEditable(deps.store, input.cid, ctx.principal.id);
      return { deleted: await deps.store.delete(input.cid) };
    },
  });
