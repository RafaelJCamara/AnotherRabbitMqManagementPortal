// connections.create: Save a connection profile with separate HTTP and AMQP endpoints and credentials
import {
  CONNECTIONS_PER_PRINCIPAL_MAX,
  connectionsCreate,
} from '@app/contracts';
import { AppError, implementAction, type ActionImpl } from '@app/kernel';

import type { ConnectionsModuleDeps } from '../deps';
import { alwaysValid, plainPlan, toCredentialChange } from '../internal/common';
import { resolveNew, toProfile } from '../internal/endpoints';

/** The ports this action uses: a subset of the module's deps (src/deps.ts). */
export type ConnectionsCreateDeps = Pick<
  ConnectionsModuleDeps,
  'store' | 'sealer' | 'newId'
>;

export const createConnectionsCreateAction = (
  deps: ConnectionsCreateDeps,
): ActionImpl<typeof connectionsCreate> =>
  implementAction(connectionsCreate, {
    plan: (input) => {
      // A pasted URI that does not parse is the caller's mistake, and plan() is the place to say so.
      // The preview names the profile only: the input carries secrets, the plan never does.
      resolveNew(input);
      return plainPlan({ creates: 'connection', name: input.name })();
    },
    revalidate: alwaysValid,
    execute: async (input, ctx) => {
      const owner = ctx.principal.id;
      const resolved = resolveNew(input);
      // A bounded number of profiles per person (I-6, I-7).
      if ((await deps.store.count(owner)) >= CONNECTIONS_PER_PRINCIPAL_MAX) {
        throw new AppError('BUDGET_EXCEEDED', {
          detail: `At most ${String(CONNECTIONS_PER_PRINCIPAL_MAX)} connections can be saved.`,
        });
      }
      const id = deps.newId();
      const credentials = await toCredentialChange(
        deps.sealer,
        id,
        resolved.secrets,
      );
      const record = await deps.store.save(
        {
          id,
          name: input.name,
          envClass: input.envClass,
          color: input.color ?? null,
          config: resolved.config,
          ownerId: owner,
          visibility: input.visibility ?? 'private',
        },
        credentials,
      );
      return {
        profile: toProfile(record, await deps.store.credentials(id), owner),
      };
    },
  });
