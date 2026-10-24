// routing.simulate: Which queues a publish reaches in a vhost, and by which path
// Nothing is published: the vhost is read and the pure simulator (@app/routing) walks it. The
// optional verification publish of the issue is a mutation and is not part of this action (OQ-1403).
import { routingSimulate } from '@app/contracts';
import { implementAction, type ActionImpl } from '@app/kernel';
import { simulate, type HeaderTable } from '@app/routing';

import {
  loadVhost,
  routingInput,
  snapshotMeta,
  type ActionDeps,
} from '../internal/load';
import { simulationView } from '../internal/routing-view';
import { SIMULATION_LIMITS } from '../internal/routing-limits';

/** The ports this action reads through (src/internal/load.ts). */
export type RoutingSimulateDeps = ActionDeps;

export const createRoutingSimulateAction = (
  deps: RoutingSimulateDeps,
): ActionImpl<typeof routingSimulate> =>
  implementAction(routingSimulate, {
    execute: async (input, ctx) => {
      const loaded = await loadVhost(deps, input, ctx);
      const converted = await routingInput(deps, loaded);
      // `cc` and `bcc` are the CC and BCC headers; when both forms are given the explicit list wins.
      const headers: HeaderTable = {
        ...input.headers,
        ...(input.cc === undefined ? {} : { CC: input.cc }),
        ...(input.bcc === undefined ? {} : { BCC: input.bcc }),
      };
      const result = simulate(
        converted.topology,
        {
          exchange: input.exchange,
          routingKey: input.routingKey,
          headers,
          mandatory: input.mandatory === true,
        },
        SIMULATION_LIMITS,
      );
      return {
        vhost: input.vhost,
        result: simulationView(result, converted.gaps.length === 0),
        gaps: [...converted.gaps],
        snapshot: snapshotMeta(loaded.snapshot),
      };
    },
  });
