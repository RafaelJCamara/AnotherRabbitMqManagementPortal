// A snapshot of a vhost as the routing library's topology (spec R2), with the gaps of the conversion.
// The settings of each queue are resolved here, so the library never sees an API object. The work is
// done in turns of the event loop (I-5): a vhost of tens of thousands of queues runs the resolver
// once per queue, which must not hold the engine for the whole time.
import type { BrokerProfile } from '@app/domain-model';
import type {
  HeaderTable,
  RoutingTopology,
  TopologyBinding,
  TopologyExchange,
  TopologyQueue,
} from '@app/routing';

import { collectGaps, type TopologyGap } from './gaps';
import {
  resolveQueueConfig,
  toTopologyExchange,
  toTopologyQueue,
  type SettingsInput,
} from './settings';
import type { Snapshot } from './snapshot';

export interface RoutingInput {
  readonly topology: RoutingTopology;
  readonly gaps: readonly TopologyGap[];
}

export interface ConvertOptions {
  /** One turn of the event loop. */
  readonly yieldNow: () => Promise<void>;
  /** Rows converted between two turns. */
  readonly every: number;
}

export async function toRoutingTopology(
  snapshot: Snapshot,
  profile: BrokerProfile,
  options: ConvertOptions,
): Promise<RoutingInput> {
  const settings: SettingsInput = {
    policies: snapshot.policies,
    operatorPolicies: snapshot.operatorPolicies,
    version: profile.versions.min,
  };
  const every = Math.max(1, options.every);
  let done = 0;
  const tick = async (): Promise<void> => {
    done += 1;
    if (done % every === 0) await options.yieldNow();
  };

  let statsMissing = false;
  let undecided = false;
  const queues: TopologyQueue[] = [];
  for (const row of snapshot.queues) {
    const config = resolveQueueConfig(row, settings);
    statsMissing ||= config.statsMissing;
    undecided ||= config.undecided;
    queues.push(toTopologyQueue(row, config, snapshot.ackingQueues));
    await tick();
  }

  const exchanges: TopologyExchange[] = [];
  for (const row of snapshot.exchanges) {
    const converted = toTopologyExchange(row, snapshot.policies);
    undecided ||= converted.undecided;
    exchanges.push(converted.exchange);
    await tick();
  }

  let skipped = 0;
  const bindings: TopologyBinding[] = [];
  for (const row of snapshot.bindings) {
    if (
      row.destination_type === 'queue' ||
      row.destination_type === 'exchange'
    ) {
      bindings.push({
        source: row.source,
        destination: row.destination,
        destinationType: row.destination_type,
        routingKey: row.routing_key,
        ...(row.arguments == null || Object.keys(row.arguments).length === 0
          ? {}
          : { arguments: row.arguments as HeaderTable }),
      });
    } else {
      skipped += 1;
    }
    await tick();
  }

  return {
    topology: { exchanges, queues, bindings },
    gaps: collectGaps(snapshot, profile, { statsMissing, undecided, skipped }),
  };
}
