// connections.update: Change a connection profile; a secret is replaced only when a new one is sent
import { connectionsUpdate } from '@app/contracts';
import { implementAction, type ActionImpl } from '@app/kernel';

import type { ConnectionsModuleDeps } from '../deps';
import {
  alwaysValid,
  loadEditable,
  plainPlan,
  toCredentialChange,
} from '../internal/common';
import { configOf, resolveChange, toProfile } from '../internal/endpoints';

/** The ports this action uses: a subset of the module's deps (src/deps.ts). */
export type ConnectionsUpdateDeps = Pick<
  ConnectionsModuleDeps,
  'store' | 'sealer'
>;

export const createConnectionsUpdateAction = (
  deps: ConnectionsUpdateDeps,
): ActionImpl<typeof connectionsUpdate> =>
  implementAction(connectionsUpdate, {
    plan: async (input, ctx) => {
      const record = await loadEditable(
        deps.store,
        input.cid,
        ctx.principal.id,
      );
      const stored = await deps.store.credentials(input.cid);
      // Validates the change against what is stored; the preview says which parts change, not to what.
      resolveChange(
        configOf(record),
        {
          http: stored.some((row) => row.protocol === 'http'),
          amqp: stored.some((row) => row.protocol === 'amqp'),
        },
        input,
      );
      return plainPlan({
        changes: 'connection',
        name: record.name,
        parts: Object.keys(input).filter((key) => key !== 'cid'),
      })();
    },
    revalidate: alwaysValid,
    execute: async (input, ctx) => {
      const owner = ctx.principal.id;
      const record = await loadEditable(deps.store, input.cid, owner);
      const stored = await deps.store.credentials(input.cid);
      const resolved = resolveChange(
        configOf(record),
        {
          http: stored.some((row) => row.protocol === 'http'),
          amqp: stored.some((row) => row.protocol === 'amqp'),
        },
        input,
      );
      const credentials = await toCredentialChange(
        deps.sealer,
        input.cid,
        resolved.secrets,
      );
      const saved = await deps.store.save(
        {
          id: record.id,
          name: input.name ?? record.name,
          envClass: input.envClass ?? record.envClass,
          color: input.color === undefined ? record.color : input.color,
          config: resolved.config,
          ownerId: record.ownerId,
          visibility: input.visibility ?? record.visibility,
        },
        credentials,
      );
      return {
        profile: toProfile(
          saved,
          await deps.store.credentials(input.cid),
          owner,
        ),
      };
    },
  });
