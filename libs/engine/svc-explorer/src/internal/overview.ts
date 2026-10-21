// The cluster overview: totals, rates, nodes and alarms from at most three interactive-lane reads
// (the overview, the nodes and, only when the nodes do not answer for the alarms, one alarm check),
// plus the message totals the inventory index already holds. It never lists a queue, an exchange or
// a connection. Every value is what the broker sent or is absent; an alarm that cannot be read or
// attributed is `unknown`, never `none` (I-13). The schemas are this service's own (a service
// imports no adapter) and name only the fields read here.
import {
  ErrorCodeSchema,
  OVERVIEW_NODES_MAX,
  type ConnectionId,
  type OverviewGetOutputSchema,
} from '@app/contracts';
import { AppError } from '@app/kernel';
import type { MgmtReadPort } from '@app/ports';
import { z } from 'zod';

import type { QueueTotals } from './index';

type Output = z.infer<typeof OverviewGetOutputSchema>;

const figure = z.number().nullish();
const rate = z.object({ rate: figure }).nullish();

// One schema object per endpoint: the scheduler dedupes reads by the identity of the schema.
export const OverviewAnswerSchema = z.object({
  product_name: z.string().nullish(),
  product_version: z.string().nullish(),
  rabbitmq_version: z.string().nullish(),
  lavinmq_version: z.string().nullish(),
  cluster_name: z.string().nullish(),
  disable_stats: z.boolean().nullish(),
  object_totals: z
    .object({
      queues: figure,
      exchanges: figure,
      connections: figure,
      channels: figure,
      consumers: figure,
    })
    .nullish(),
  queue_totals: z
    .object({
      messages: figure,
      messages_ready: figure,
      messages_unacknowledged: figure,
    })
    .nullish(),
  message_stats: z
    .object({ publish_details: rate, deliver_get_details: rate })
    .nullish(),
});
export const NodeListSchema = z.array(
  z.object({
    name: z.string(),
    running: z.boolean(),
    being_drained: z.boolean().nullish(),
    // Named from the broker's HTTP API; present when the node reports its resource alarms.
    mem_alarm: z.boolean().nullish(),
    disk_free_alarm: z.boolean().nullish(),
  }),
);
export const AlarmCheckSchema = z.object({ status: z.string() });

const NODE_COLUMNS = 'name,running,being_drained,mem_alarm,disk_free_alarm';

/** Fixed texts: broker text never reaches an output (I-10). */
export const OVERVIEW_TEXT = {
  alarmUnreadable: 'The alarm state could not be read.',
} as const;

const count = (n: number | null | undefined): number | undefined =>
  n !== null && n !== undefined && Number.isInteger(n) && n >= 0
    ? n
    : undefined;
const present = <T extends object>(members: {
  [K in keyof T]: T[K] | undefined;
}): T =>
  Object.fromEntries(
    Object.entries(members).filter(([, v]) => v !== undefined),
  ) as T;

/** A failed read becomes a Problem with a fixed text and the code the port reported. */
function readFailure(error: unknown): AppError {
  if ((error as { name?: unknown } | null)?.name === 'AbortError') {
    return new AppError('ENGINE_SHUTTING_DOWN', {
      detail: 'The overview read was cancelled.',
    });
  }
  const code = ErrorCodeSchema.safeParse(
    (error as { code?: unknown } | null)?.code,
  );
  return new AppError(code.success ? code.data : 'BROKER_ERROR', {
    detail: 'The cluster overview could not be read.',
  });
}

async function interactive<T>(
  mgmt: MgmtReadPort,
  cid: ConnectionId,
  path: string,
  schema: z.ZodType<T>,
  signal: AbortSignal,
  query?: Readonly<Record<string, string>>,
): Promise<T> {
  return mgmt.get(
    {
      connectionId: cid,
      path,
      schema,
      lane: 'interactive',
      ...(query ? { query } : {}),
    },
    signal,
  );
}

export function ratesOf(
  answer: z.infer<typeof OverviewAnswerSchema>,
): Output['rates'] {
  // A rate is a decimal: only an absent or non-finite one is "not reported". A reported 0 stays 0.
  const publishPerSec = finite(answer.message_stats?.publish_details?.rate);
  const deliverPerSec = finite(answer.message_stats?.deliver_get_details?.rate);
  if (publishPerSec === undefined && deliverPerSec === undefined) {
    return {
      state: 'unavailable',
      reason: answer.disable_stats === true ? 'statistics-off' : 'not-reported',
    };
  }
  return {
    state: 'available',
    source: 'broker-overview',
    ...present<{ publishPerSec?: number; deliverPerSec?: number }>({
      publishPerSec,
      deliverPerSec,
    }),
  };
}

function finite(n: number | null | undefined): number | undefined {
  return n !== null && n !== undefined && Number.isFinite(n) && n >= 0
    ? n
    : undefined;
}

/** The broker's own totals when it reports all three, else the sum over the queue sweep, else none. */
export function messagesOf(
  answer: z.infer<typeof OverviewAnswerSchema>,
  sweep: QueueTotals | undefined,
  now: number,
): NonNullable<Output['totals']['messages']> | undefined {
  const total = count(answer.queue_totals?.messages);
  const ready = count(answer.queue_totals?.messages_ready);
  const unacknowledged = count(answer.queue_totals?.messages_unacknowledged);
  if (
    total !== undefined &&
    ready !== undefined &&
    unacknowledged !== undefined
  ) {
    return {
      total,
      ready,
      unacknowledged,
      source: 'broker-overview',
      asOf: now,
      complete: true,
    };
  }
  if (sweep === undefined) return undefined;
  return {
    total: sweep.messages,
    ready: sweep.ready,
    unacknowledged: sweep.unacknowledged,
    source: 'queue-sweep',
    asOf: sweep.version.sweptAt,
    complete: sweep.complete && sweep.dropped === 0 && sweep.unreported === 0,
  };
}

type Nodes = z.infer<typeof NodeListSchema>;

/**
 * The alarms of the cluster. The flags the nodes report name a node and a resource. When every node
 * reports both flags and none is raised, there is none. When they are missing (statistics off,
 * another broker), one alarm check decides: its `ok` is the broker saying no alarm is in effect;
 * anything else, a failure included, cannot be attributed and is `unknown`.
 */
export async function alarmsOf(
  nodes: Nodes,
  check: () => Promise<z.infer<typeof AlarmCheckSchema>>,
): Promise<Output['alarms']> {
  const active: { node: string; resource: 'memory' | 'disk' }[] = [];
  for (const node of nodes) {
    if (node.mem_alarm === true) {
      active.push({ node: node.name, resource: 'memory' });
    }
    if (node.disk_free_alarm === true) {
      active.push({ node: node.name, resource: 'disk' });
    }
  }
  if (active.length > 0) return { state: 'active', active };
  if (
    nodes.length > 0 &&
    nodes.every(
      (n) =>
        typeof n.mem_alarm === 'boolean' &&
        typeof n.disk_free_alarm === 'boolean',
    )
  ) {
    return { state: 'none' };
  }
  try {
    return (await check()).status === 'ok'
      ? { state: 'none' }
      : { state: 'unknown', reason: OVERVIEW_TEXT.alarmUnreadable };
  } catch {
    return { state: 'unknown', reason: OVERVIEW_TEXT.alarmUnreadable };
  }
}

export interface OverviewRead {
  readonly answer: z.infer<typeof OverviewAnswerSchema>;
  readonly nodes: Nodes;
  readonly alarms: Output['alarms'];
}

/** Overview and nodes together, then the alarm check only when the nodes did not settle it. */
export async function readOverview(
  mgmt: MgmtReadPort,
  cid: ConnectionId,
  signal: AbortSignal,
): Promise<OverviewRead> {
  let answer: z.infer<typeof OverviewAnswerSchema>;
  let nodes: Nodes;
  try {
    [answer, nodes] = await Promise.all([
      interactive(mgmt, cid, '/api/overview', OverviewAnswerSchema, signal),
      interactive(mgmt, cid, '/api/nodes', NodeListSchema, signal, {
        columns: NODE_COLUMNS,
      }),
    ]);
  } catch (error) {
    throw readFailure(error);
  }
  const alarms = await alarmsOf(nodes, () =>
    interactive(
      mgmt,
      cid,
      '/api/health/checks/alarms',
      AlarmCheckSchema,
      signal,
    ),
  );
  return { answer, nodes, alarms };
}

export function nodesOf(nodes: Nodes): Output['nodes'] {
  return nodes.slice(0, OVERVIEW_NODES_MAX).map((n) => ({
    name: n.name,
    running: n.running,
    ...(n.being_drained == null ? {} : { beingDrained: n.being_drained }),
  }));
}

export function totalsOf(
  answer: z.infer<typeof OverviewAnswerSchema>,
  messages: Output['totals']['messages'],
): Output['totals'] {
  const o = answer.object_totals;
  return {
    ...present<Omit<Output['totals'], 'messages'>>({
      queues: count(o?.queues),
      exchanges: count(o?.exchanges),
      connections: count(o?.connections),
      channels: count(o?.channels),
      consumers: count(o?.consumers),
    }),
    ...(messages === undefined ? {} : { messages }),
  };
}
