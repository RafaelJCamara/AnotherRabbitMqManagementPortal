// overview.get: Read the cluster overview of a connection
// Cheap by construction: at most three interactive-lane management reads (overview, nodes, one
// alarm check) and the message sums the inventory index already holds. It never lists a queue, an
// exchange or a connection, and it asks the sweeper for demand but never sweeps itself.
import { overviewGet } from '@app/contracts';
import {
  implementAction,
  systemClock,
  type ActionImpl,
  type Clock,
} from '@app/kernel';

import type { ExplorerModuleDeps } from '../deps';
import { describeFreshness, UNAVAILABLE_VERSION } from '../internal/freshness';
import {
  messagesOf,
  nodesOf,
  ratesOf,
  readOverview,
  totalsOf,
} from '../internal/overview';
import type { Sweeper } from '../internal/sweeper';
import { requireVisible } from '../internal/visible';

/** The ports this action reads through: a subset of the module's deps (src/deps.ts) and the sweeper. */
export type OverviewGetDeps = Pick<
  ExplorerModuleDeps,
  'clock' | 'connections' | 'mgmt'
> & { readonly sweeper: Pick<Sweeper, 'touch' | 'index' | 'status'> };

export const createOverviewGetAction = (
  deps: OverviewGetDeps,
): ActionImpl<typeof overviewGet> => {
  const clock: Clock = deps.clock ?? systemClock;
  return implementAction(overviewGet, {
    execute: async (input, ctx) => {
      const { cid } = input;
      await requireVisible(deps.connections, cid, ctx.principal.id);
      deps.sweeper.touch(cid);
      const { answer, nodes, alarms } = await readOverview(
        deps.mgmt,
        cid,
        ctx.signal,
      );
      const index = deps.sweeper.index(cid);
      const sweep = index?.queueTotals();
      const totals = totalsOf(answer, messagesOf(answer, sweep, clock.now()));
      const status = deps.sweeper.status(cid);
      const version =
        answer.product_version ??
        answer.rabbitmq_version ??
        answer.lavinmq_version;
      return {
        product: answer.product_name ?? 'unknown',
        ...(version == null ? {} : { version }),
        ...(answer.cluster_name == null
          ? {}
          : { clusterName: answer.cluster_name }),
        totals,
        rates: ratesOf(answer),
        nodes: nodesOf(nodes),
        alarms,
        // What the sweep-derived sums stand on: the queue part of the index.
        freshness: describeFreshness({
          kind: 'queues',
          installed: sweep !== undefined,
          version:
            sweep?.version ??
            index?.window({ kind: 'queues', offset: 0, limit: 1 }).version ??
            UNAVAILABLE_VERSION,
          loaded: sweep?.queues ?? 0,
          expected: totals.queues ?? status.expected.get('queues'),
          sweeping: status.sweeping,
          profileHazards: [],
          versionChanged: false,
        }),
      };
    },
  });
};
