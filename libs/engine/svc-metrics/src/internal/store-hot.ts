// The hot store: the last hour of every series, in memory, bounded (I-6, blueprint section 8).
//
//  - one series is a ring of at most `ringPoints` points and `ringPoints * POINT_BYTES` bytes; the
//    oldest point goes first and every eviction is counted;
//  - cluster and node series are few and always kept; queue series are capped per broker
//    (`maxQueueSeries`): when a round pushes a broker past it, whole queues leave, the lowest backlog
//    first, and the queues somebody pinned never do. Refusals and evictions are counted;
//  - at most `maxBrokers` brokers are held, the least recently used goes first;
//  - the tiers of the persisted store (48 h raw, 5 m and 1 h rollups) sit behind this port later
//    (M4-04); nothing here is persisted.
//
// A point is a time and a finite value. A non-finite value is refused by the caller (ingest counts
// it); the store never holds NaN.
import type { ConnectionId, MetricId } from '@app/contracts';
import type { Point } from '@app/forecast';
import { BoundedRing } from '@app/kernel';

import { METRICS, type MetricDef } from './catalog';
import type { MetricsLimits } from '../deps';

/** What names one series. A cluster metric has neither node nor queue; a queue metric has a queue. */
export interface SeriesParts {
  readonly metric: MetricId;
  readonly node?: string;
  readonly vhost?: string;
  readonly queue?: string;
}

export type SeriesSource = 'prometheus' | 'management';

export interface SeriesInfo {
  readonly parts: SeriesParts;
  readonly def: MetricDef;
  readonly source: SeriesSource;
  /** Derived from management sampling rather than read from the broker's own counters. */
  readonly approximate: boolean;
}

export interface StoredSeries {
  readonly info: SeriesInfo;
  readonly points: readonly Point[];
  /** Points this series' ring has evicted. */
  readonly dropped: number;
}

export interface StoreStatus {
  readonly series: number;
  readonly queueSeries: number;
  /** Points evicted by rings, queue series evicted or refused by the cap, over the broker's life. */
  readonly droppedPoints: number;
  readonly droppedSeries: number;
  /** Epoch ms of the newest point of any series. */
  readonly newest: number | undefined;
}

export interface HotStore {
  /** Adds a point; false when the series was refused by the queue-series cap. */
  append(
    cid: ConnectionId,
    parts: SeriesParts,
    meta: { source: SeriesSource; approximate: boolean },
    point: Point,
  ): boolean;
  read(cid: ConnectionId, parts: SeriesParts): StoredSeries | undefined;
  /** The newest point of every series with one, filtered by `include` (the topic names what it wants). */
  latest(
    cid: ConnectionId,
    include?: (info: SeriesInfo) => boolean,
  ): { info: SeriesInfo; point: Point }[];
  /** The queues somebody watches: their series are not evicted by the cap. Replaces the set. */
  pin(
    cid: ConnectionId,
    queues: readonly { vhost: string; name: string }[],
  ): void;
  /** Ends a round: evicts queue series past the cap, lowest backlog first, pinned queues last. */
  endRound(cid: ConnectionId): void;
  status(cid: ConnectionId): StoreStatus;
  /** Drops everything held for a connection. */
  forget(cid: ConnectionId): void;
  readonly brokers: number;
  readonly brokersEvicted: number;
}

/** What one point costs in a ring's byte bound: two doubles. */
export const POINT_BYTES = 16;
const SEP = '\u001f';

export const seriesKey = (parts: SeriesParts): string =>
  [parts.metric, parts.node ?? '', parts.vhost ?? '', parts.queue ?? ''].join(
    SEP,
  );
export const queueKeyOf = (vhost: string, name: string): string =>
  `${vhost}${SEP}${name}`;

interface Series {
  info: SeriesInfo;
  readonly ring: BoundedRing<Point>;
  /** The newest point, kept so a snapshot does not copy a whole ring to read one value. */
  last: Point;
}

interface BrokerData {
  readonly byKey: Map<string, Series>;
  /** Series keys of each queue, for evicting a queue whole. */
  readonly byQueue: Map<string, Set<string>>;
  pinned: Set<string>;
  queueSeries: number;
  droppedPoints: number;
  droppedSeries: number;
  newest: number | undefined;
  lastUsed: number;
}

export function createHotStore(
  limits: Pick<MetricsLimits, 'ringPoints' | 'maxQueueSeries' | 'maxBrokers'>,
): HotStore {
  const brokers = new Map<ConnectionId, BrokerData>();
  let used = 0;
  let evicted = 0;

  function dataFor(cid: ConnectionId): BrokerData {
    let data = brokers.get(cid);
    if (data === undefined) {
      if (brokers.size >= limits.maxBrokers) {
        let oldest: ConnectionId | undefined;
        let at = Infinity;
        for (const [id, held] of brokers) {
          if (held.lastUsed < at) {
            at = held.lastUsed;
            oldest = id;
          }
        }
        if (oldest !== undefined) {
          brokers.delete(oldest);
          evicted++;
        }
      }
      data = {
        byKey: new Map(),
        byQueue: new Map(),
        pinned: new Set(),
        queueSeries: 0,
        droppedPoints: 0,
        droppedSeries: 0,
        newest: undefined,
        lastUsed: 0,
      };
      brokers.set(cid, data);
    }
    data.lastUsed = ++used;
    return data;
  }

  /** The backlog that ranks a queue: its total, else its ready count; unknown ranks lowest. */
  function backlogOf(data: BrokerData, keys: ReadonlySet<string>): number {
    let ready = -1;
    for (const key of keys) {
      const series = data.byKey.get(key);
      if (series === undefined) continue;
      if (series.info.parts.metric === 'queue_messages') return series.last.v;
      if (series.info.parts.metric === 'queue_messages_ready') {
        ready = series.last.v;
      }
    }
    return ready;
  }

  function removeQueue(data: BrokerData, queue: string): void {
    for (const key of data.byQueue.get(queue) ?? []) {
      data.byKey.delete(key);
      data.queueSeries--;
      data.droppedSeries++;
    }
    data.byQueue.delete(queue);
  }

  return {
    append(cid, parts, meta, point) {
      const data = dataFor(cid);
      const key = seriesKey(parts);
      let series = data.byKey.get(key);
      if (series === undefined) {
        const def = METRICS[parts.metric];
        const queue =
          def.scope === 'queue' &&
          parts.vhost !== undefined &&
          parts.queue !== undefined
            ? queueKeyOf(parts.vhost, parts.queue)
            : undefined;
        if (def.scope === 'queue') {
          // Mid-round guard: a round may overshoot the cap, never double it, except for pinned queues.
          if (
            queue === undefined ||
            (data.queueSeries >= limits.maxQueueSeries * 2 &&
              !data.pinned.has(queue))
          ) {
            data.droppedSeries++;
            return false;
          }
        }
        series = {
          info: {
            parts,
            def,
            source: meta.source,
            approximate: meta.approximate,
          },
          ring: new BoundedRing<Point>({
            maxItems: limits.ringPoints,
            maxBytes: limits.ringPoints * POINT_BYTES,
            sizeOf: () => POINT_BYTES,
            onDrop: (event) => {
              data.droppedPoints += event.items;
            },
          }),
          last: point,
        };
        data.byKey.set(key, series);
        if (queue !== undefined) {
          data.queueSeries++;
          const keys = data.byQueue.get(queue) ?? new Set<string>();
          keys.add(key);
          data.byQueue.set(queue, keys);
        }
      }
      if (
        series.info.source !== meta.source ||
        series.info.approximate !== meta.approximate
      ) {
        series.info = { ...series.info, ...meta };
      }
      series.ring.add(point);
      series.last = point;
      data.newest = Math.max(data.newest ?? point.t, point.t);
      return true;
    },

    read(cid, parts) {
      const data = brokers.get(cid);
      const series = data?.byKey.get(seriesKey(parts));
      if (data === undefined || series === undefined) return undefined;
      data.lastUsed = ++used;
      return {
        info: series.info,
        points: series.ring.toArray(),
        dropped: series.ring.dropped,
      };
    },

    latest(cid, include) {
      const data = brokers.get(cid);
      if (data === undefined) return [];
      data.lastUsed = ++used;
      const out: { info: SeriesInfo; point: Point }[] = [];
      for (const series of data.byKey.values()) {
        if (include?.(series.info) ?? true) {
          out.push({ info: series.info, point: series.last });
        }
      }
      return out;
    },

    pin(cid, queues) {
      dataFor(cid).pinned = new Set(
        queues.map((queue) => queueKeyOf(queue.vhost, queue.name)),
      );
    },

    endRound(cid) {
      const data = brokers.get(cid);
      if (data === undefined || data.queueSeries <= limits.maxQueueSeries) {
        return;
      }
      const ranked = [...data.byQueue]
        .map(([queue, keys]) => ({
          queue,
          pinned: data.pinned.has(queue),
          backlog: backlogOf(data, keys),
        }))
        .sort((a, b) =>
          a.pinned === b.pinned ? a.backlog - b.backlog : a.pinned ? 1 : -1,
        );
      for (const entry of ranked) {
        if (data.queueSeries <= limits.maxQueueSeries) break;
        removeQueue(data, entry.queue);
      }
    },

    status(cid) {
      const data = brokers.get(cid);
      return {
        series: data?.byKey.size ?? 0,
        queueSeries: data?.queueSeries ?? 0,
        droppedPoints: data?.droppedPoints ?? 0,
        droppedSeries: data?.droppedSeries ?? 0,
        newest: data?.newest,
      };
    },

    forget(cid) {
      brokers.delete(cid);
    },

    get brokers() {
      return brokers.size;
    },
    get brokersEvicted() {
      return evicted;
    },
  };
}
