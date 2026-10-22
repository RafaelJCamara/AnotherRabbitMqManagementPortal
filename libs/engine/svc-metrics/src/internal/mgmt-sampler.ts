// The fallback: when no Prometheus endpoint exists, or it keeps failing, the same series are read from
// the management API, through the BrokerScheduler's wrapper in the background lane (I-8). It reads
// the aggregate endpoints only (`/api/overview`, `/api/nodes`), and single queues only where the
// plan says per-object reads are allowed: Amazon MQ never sees one. Counters derived this way are
// labelled approximate (blueprint section 8): the broker refreshes its statistics on its own
// interval, so a rate over two samples is a coarse figure.
//
// With statistics off the overview carries no totals and no rates; the series are then absent, and
// the answer says so by having no points, never by a zero the broker did not send (I-13).
import type { ConnectionId, MetricId } from '@app/contracts';
import type { MgmtReadPort } from '@app/ports';
import { z } from 'zod';

import type { QueueDemand } from './scrape-planner';
import type { SeriesParts } from './store-hot';

const figure = z.number().nullish();
const stat = z.number().nullish();

// One schema object per endpoint: the scheduler dedupes reads by the identity of the schema.
export const OverviewSchema = z.object({
  queue_totals: z
    .object({
      messages: figure,
      messages_ready: figure,
      messages_unacknowledged: figure,
    })
    .nullish(),
  object_totals: z
    .object({
      connections: figure,
      channels: figure,
      consumers: figure,
      queues: figure,
    })
    .nullish(),
  message_stats: z
    .object({
      publish: stat,
      deliver_get: stat,
      ack: stat,
      redeliver: stat,
    })
    .nullish(),
});

export const NodesSchema = z.array(
  z.object({
    name: z.string(),
    mem_used: figure,
    mem_limit: figure,
    disk_free: figure,
    disk_free_limit: figure,
  }),
);

export const QueueSchema = z.object({
  messages: figure,
  messages_ready: figure,
  messages_unacknowledged: figure,
  consumers: figure,
});

const NODE_COLUMNS = 'name,mem_used,mem_limit,disk_free,disk_free_limit';

export interface SampledPoint {
  readonly parts: SeriesParts;
  readonly value: number;
  /** A counter or a rate derived from sampling: a coarse figure. */
  readonly approximate: boolean;
}

const finite = (n: number | null | undefined): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0;

export interface SampleResult {
  readonly points: SampledPoint[];
  /** Requests made, for the status and the cost history. */
  readonly requests: number;
}

/** Reads one round from the management API. A failed read throws; the collector classifies it. */
export async function sampleManagement(
  mgmt: MgmtReadPort,
  cid: ConnectionId,
  queues: readonly QueueDemand[],
  signal: AbortSignal,
): Promise<SampleResult> {
  const points: SampledPoint[] = [];
  const add = (
    metric: MetricId,
    value: number | null | undefined,
    approximate = false,
    extra: Omit<SeriesParts, 'metric'> = {},
  ): void => {
    if (finite(value))
      points.push({ parts: { metric, ...extra }, value, approximate });
  };
  let requests = 0;

  requests++;
  const overview = await mgmt.get(
    {
      connectionId: cid,
      path: '/api/overview',
      schema: OverviewSchema,
      lane: 'background',
    },
    signal,
  );
  add('messages_ready', overview.queue_totals?.messages_ready);
  add('messages_unacked', overview.queue_totals?.messages_unacknowledged);
  add('messages', overview.queue_totals?.messages);
  add('connections', overview.object_totals?.connections);
  add('channels', overview.object_totals?.channels);
  add('consumers', overview.object_totals?.consumers);
  add('queues', overview.object_totals?.queues);
  add('published_total', overview.message_stats?.publish, true);
  add('delivered_total', overview.message_stats?.deliver_get, true);
  add('acked_total', overview.message_stats?.ack, true);
  add('redelivered_total', overview.message_stats?.redeliver, true);

  requests++;
  const nodes = await mgmt.get(
    {
      connectionId: cid,
      path: '/api/nodes',
      query: { columns: NODE_COLUMNS },
      schema: NodesSchema,
      lane: 'background',
    },
    signal,
  );
  for (const node of nodes) {
    add('memory_bytes', node.mem_used, false, { node: node.name });
    add('memory_limit_bytes', node.mem_limit, false, { node: node.name });
    add('disk_free_bytes', node.disk_free, false, { node: node.name });
    add('disk_free_limit_bytes', node.disk_free_limit, false, {
      node: node.name,
    });
  }

  for (const queue of queues) {
    requests++;
    const answer = await mgmt.get(
      {
        connectionId: cid,
        path: `/api/queues/${encodeURIComponent(queue.vhost)}/${encodeURIComponent(queue.name)}`,
        schema: QueueSchema,
        lane: 'background',
      },
      signal,
    );
    const where = { vhost: queue.vhost, queue: queue.name };
    add('queue_messages', answer.messages, false, where);
    add('queue_messages_ready', answer.messages_ready, false, where);
    add('queue_messages_unacked', answer.messages_unacknowledged, false, where);
    add('queue_consumers', answer.consumers, false, where);
  }
  return { points, requests };
}
