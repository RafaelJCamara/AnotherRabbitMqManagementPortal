// Builders for the specs. Not part of the public API (not exported from index.ts).
import type {
  HeaderTable,
  RoutingTopology,
  TopologyBinding,
  TopologyExchange,
  TopologyQueue,
} from './types.ts';

export function exchange(
  name: string,
  type = 'direct',
  extra: Partial<Omit<TopologyExchange, 'name' | 'type'>> = {},
): TopologyExchange {
  return { name, type, ...extra };
}

export function bind(
  source: string,
  destination: string,
  routingKey = '',
  args?: HeaderTable,
  destinationType: 'queue' | 'exchange' = 'queue',
): TopologyBinding {
  return {
    source,
    destination,
    destinationType,
    routingKey,
    ...(args === undefined ? {} : { arguments: args }),
  };
}

/** A binding to an exchange. */
export function bindX(
  source: string,
  destination: string,
  routingKey = '',
  args?: HeaderTable,
): TopologyBinding {
  return bind(source, destination, routingKey, args, 'exchange');
}

export function topology(
  exchanges: readonly TopologyExchange[],
  queues: readonly string[],
  bindings: readonly TopologyBinding[],
): RoutingTopology {
  return {
    exchanges,
    queues: queues.map((name) => ({ name })),
    bindings,
  };
}

/** Freezes a value and everything reachable from it. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** A queue with dead-letter settings (M1-03). */
export function queue(
  name: string,
  extra: Partial<Omit<TopologyQueue, 'name'>> = {},
): TopologyQueue {
  return { name, ...extra };
}

/** A queue that dead-letters to `exchange` when its messages expire. */
export function expiring(
  name: string,
  exchange: string,
  routingKey?: string,
  extra: Partial<Omit<TopologyQueue, 'name' | 'deadLetter'>> = {},
): TopologyQueue {
  return {
    name,
    messageTtlMs: 1000,
    deadLetter: {
      status: 'set',
      exchange,
      ...(routingKey === undefined ? {} : { routingKey }),
    },
    ...extra,
  };
}

/** A topology whose queues carry their own settings. */
export function topologyOf(
  exchanges: readonly TopologyExchange[],
  queues: readonly TopologyQueue[],
  bindings: readonly TopologyBinding[],
): RoutingTopology {
  return { exchanges, queues, bindings };
}
