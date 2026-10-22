// The series the engine keeps and where each comes from (OQ-865). A Prometheus family name is mapped
// to a metric id here, once, for both products; the management fallback maps its own fields to the
// same ids, so a chart does not care which source answered. Anything not listed is dropped before
// its labels are read.
import {
  CLUSTER_METRIC_IDS,
  NODE_METRIC_IDS,
  QUEUE_METRIC_IDS,
  type MetricId,
} from '@app/contracts';

export type MetricScope = 'cluster' | 'node' | 'queue';
export type MetricKind = 'gauge' | 'counter';
export type MetricUnit = 'messages' | 'count' | 'bytes';

export interface MetricDef {
  readonly id: MetricId;
  readonly scope: MetricScope;
  readonly kind: MetricKind;
  readonly unit: MetricUnit;
}

const def = (
  id: MetricId,
  scope: MetricScope,
  kind: MetricKind,
  unit: MetricUnit,
): MetricDef => ({ id, scope, kind, unit });

export const METRICS: Readonly<Record<MetricId, MetricDef>> = {
  messages_ready: def('messages_ready', 'cluster', 'gauge', 'messages'),
  messages_unacked: def('messages_unacked', 'cluster', 'gauge', 'messages'),
  messages: def('messages', 'cluster', 'gauge', 'messages'),
  connections: def('connections', 'cluster', 'gauge', 'count'),
  channels: def('channels', 'cluster', 'gauge', 'count'),
  consumers: def('consumers', 'cluster', 'gauge', 'count'),
  queues: def('queues', 'cluster', 'gauge', 'count'),
  published_total: def('published_total', 'cluster', 'counter', 'messages'),
  delivered_total: def('delivered_total', 'cluster', 'counter', 'messages'),
  acked_total: def('acked_total', 'cluster', 'counter', 'messages'),
  redelivered_total: def('redelivered_total', 'cluster', 'counter', 'messages'),
  memory_bytes: def('memory_bytes', 'node', 'gauge', 'bytes'),
  memory_limit_bytes: def('memory_limit_bytes', 'node', 'gauge', 'bytes'),
  disk_free_bytes: def('disk_free_bytes', 'node', 'gauge', 'bytes'),
  disk_free_limit_bytes: def('disk_free_limit_bytes', 'node', 'gauge', 'bytes'),
  queue_messages_ready: def(
    'queue_messages_ready',
    'queue',
    'gauge',
    'messages',
  ),
  queue_messages_unacked: def(
    'queue_messages_unacked',
    'queue',
    'gauge',
    'messages',
  ),
  queue_messages: def('queue_messages', 'queue', 'gauge', 'messages'),
  queue_consumers: def('queue_consumers', 'queue', 'gauge', 'count'),
};

/** The exposition names of the aggregated page: RabbitMQ's, and LavinMQ's where they differ. */
const AGGREGATED: readonly (readonly [MetricId, string, string?])[] = [
  [
    'messages_ready',
    'rabbitmq_queue_messages_ready',
    'lavinmq_queue_messages_ready',
  ],
  [
    'messages_unacked',
    'rabbitmq_queue_messages_unacked',
    'lavinmq_queue_messages_unacked',
  ],
  ['messages', 'rabbitmq_queue_messages', 'lavinmq_queue_messages'],
  ['connections', 'rabbitmq_connections', 'lavinmq_connections'],
  ['channels', 'rabbitmq_channels', 'lavinmq_channels'],
  ['consumers', 'rabbitmq_consumers', 'lavinmq_consumers'],
  ['queues', 'rabbitmq_queues', 'lavinmq_queues'],
  ['published_total', 'rabbitmq_channel_messages_published_total'],
  [
    'delivered_total',
    'rabbitmq_channel_messages_delivered_total',
    'lavinmq_global_messages_delivered_total',
  ],
  [
    'acked_total',
    'rabbitmq_channel_messages_acked_total',
    'lavinmq_global_messages_acknowledged_total',
  ],
  [
    'redelivered_total',
    'rabbitmq_channel_messages_redelivered_total',
    'lavinmq_global_messages_redelivered_total',
  ],
  [
    'memory_bytes',
    'rabbitmq_process_resident_memory_bytes',
    'lavinmq_process_resident_memory_bytes',
  ],
  [
    'memory_limit_bytes',
    'rabbitmq_resident_memory_limit_bytes',
    'lavinmq_resident_memory_limit_bytes',
  ],
  [
    'disk_free_bytes',
    'rabbitmq_disk_space_available_bytes',
    'lavinmq_disk_space_available_bytes',
  ],
  ['disk_free_limit_bytes', 'rabbitmq_disk_space_available_limit_bytes'],
];

const DETAILED: readonly (readonly [MetricId, string])[] = [
  ['queue_messages_ready', 'detailed_queue_messages_ready'],
  ['queue_messages_unacked', 'detailed_queue_messages_unacked'],
  ['queue_messages', 'detailed_queue_messages'],
  ['queue_consumers', 'detailed_queue_consumers'],
];
const PREFIXES = ['rabbitmq_', 'lavinmq_'] as const;

const BY_NAME = new Map<string, MetricDef>();
for (const [id, rabbit, lavin] of AGGREGATED) {
  BY_NAME.set(rabbit, METRICS[id]);
  if (lavin !== undefined) BY_NAME.set(lavin, METRICS[id]);
}
for (const [id, suffix] of DETAILED) {
  for (const prefix of PREFIXES) BY_NAME.set(`${prefix}${suffix}`, METRICS[id]);
}

/** The queue info family: the sample that names the leader of a replicated queue. */
const INFO_NAMES: ReadonlySet<string> = new Set(
  PREFIXES.map((prefix) => `${prefix}detailed_queue_info`),
);

export const metricOf = (promName: string): MetricDef | undefined =>
  BY_NAME.get(promName);
export const isQueueInfo = (promName: string): boolean =>
  INFO_NAMES.has(promName);

/** What the parser keeps: a family the catalogue knows, or the queue info. */
export const wantedFamily = (promName: string): boolean =>
  BY_NAME.has(promName) || INFO_NAMES.has(promName);

/** The metrics of each scope, from the contract's lists. */
export const IDS_BY_SCOPE: Readonly<Record<MetricScope, readonly MetricId[]>> =
  {
    cluster: CLUSTER_METRIC_IDS,
    node: NODE_METRIC_IDS,
    queue: QUEUE_METRIC_IDS,
  };

/** The Prometheus families a detailed read asks for (the queue info rides on the coarse family). */
export const DETAILED_FAMILIES = [
  'queue_coarse_metrics',
  'queue_consumer_count',
] as const;
