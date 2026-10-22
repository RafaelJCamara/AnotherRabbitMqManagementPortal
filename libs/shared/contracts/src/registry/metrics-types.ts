// Shared schemas of the metrics contracts (M1-26): the series the engine keeps, the status every
// answer carries and the forecast shape. Every input is bounded (I-7) and every array in an output
// has a maximum; nothing here is a secret, a URL or broker text (I-10).
import { z } from 'zod';

const count = z.number().int().nonnegative();

/** Series about the whole cluster: one value per scrape round, whichever node reported it. */
export const CLUSTER_METRIC_IDS = [
  'messages_ready',
  'messages_unacked',
  'messages',
  'connections',
  'channels',
  'consumers',
  'queues',
  'published_total',
  'delivered_total',
  'acked_total',
  'redelivered_total',
] as const;
/** Series about one node. */
export const NODE_METRIC_IDS = [
  'memory_bytes',
  'memory_limit_bytes',
  'disk_free_bytes',
  'disk_free_limit_bytes',
] as const;
/** Series about one queue; kept only for queues somebody asked for. */
export const QUEUE_METRIC_IDS = [
  'queue_messages_ready',
  'queue_messages_unacked',
  'queue_messages',
  'queue_consumers',
] as const;
export const METRIC_IDS = [
  ...CLUSTER_METRIC_IDS,
  ...NODE_METRIC_IDS,
  ...QUEUE_METRIC_IDS,
] as const;
export type MetricId = (typeof METRIC_IDS)[number];

/** The most series one `metrics.query` names, and the most queues one demand names. */
export const SERIES_QUERY_MAX = 50;
export const QUEUE_DEMAND_MAX = 50;
/** The most points one series carries in an answer. */
export const POINTS_MAX = 2000;

export const QueueRefSchema = z.strictObject({
  vhost: z.string().max(255),
  name: z.string().max(255),
});

/** Names one series: a cluster metric, a node metric with its node, or a queue metric with its queue. */
export const SeriesRefSchema = z.strictObject({
  metric: z.enum(METRIC_IDS),
  node: z.string().max(255).optional(),
  queue: QueueRefSchema.optional(),
});

/** Why an answer is not the whole picture; fixed words, never broker text. */
export const PARTIAL_REASONS = [
  'load-balancer-fronted',
  'nodes-without-endpoint',
  'per-object-unavailable',
  'queue-demand-truncated',
  'targets-unreachable',
  'fallback',
] as const;

export const MetricsStatusSchema = z.strictObject({
  /** `loading`: no round has finished yet. `stale`: the newest point is older than three intervals. */
  state: z.enum(['live', 'stale', 'loading', 'unavailable']),
  source: z.enum(['prometheus', 'management', 'none']),
  /** Epoch ms of the newest point of any series of the connection. */
  asOf: count.optional(),
  /** The cadence the planner chose. */
  intervalMs: count.optional(),
  partial: z.array(z.enum(PARTIAL_REASONS)).max(PARTIAL_REASONS.length),
  /** Why the management API is read instead of Prometheus. */
  fallbackReason: z.enum(['no-endpoint', 'failing']).optional(),
  /** Rates and counters derived from management sampling are approximate. */
  approximate: z.boolean(),
  /** Counted, never silent (I-13). */
  dropped: z.strictObject({
    points: count,
    series: count,
    samples: count,
  }),
});

export const ForecastSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('ok'),
    etaMs: count,
    /** `highMs` is null when the slope could be flat within the band. */
    band: z.strictObject({ lowMs: count, highMs: count.nullable() }),
    ratePerSec: z.number(),
    r2: z.number().min(0).max(1),
    windowMs: count,
    points: count,
  }),
  z.strictObject({ state: z.literal('reached') }),
  z.strictObject({
    state: z.literal('moving-away'),
    ratePerSec: z.number(),
    r2: z.number().min(0).max(1),
    reason: z.enum(['flat', 'away', 'beyond-horizon']),
  }),
  z.strictObject({
    state: z.literal('no-reliable-forecast'),
    r2: z.number().min(0).max(1),
    windowMs: count,
    points: count,
  }),
  z.strictObject({
    state: z.literal('insufficient-data'),
    points: count,
    spanMs: count,
    needed: z.strictObject({ points: count, spanMs: count }),
  }),
]);
