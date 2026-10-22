// The source of the metrics.live topic. A subscription is admitted first (an unknown and an invisible
// connection end with the same NOT_FOUND Problem, and nothing is collected for them); once admitted
// it asks the collector for demand, publishes the newest point of every cluster and node series and
// of the queues it named, and then follows the collector's rounds, publishing a series only when its
// point is newer than the one the subscriber already has, and the status whenever it changes. The
// hub owns coalescing (`latest`), pacing (maxHz), the ring bounds and `gap` then `snapshot` on
// overflow (I-6, I-13).
import {
  METRICS_STATUS_KEY,
  type ConnectionId,
  type MetricsLiveItemSchema,
  type MetricsLiveParamsSchema,
  type Problem,
} from '@app/contracts';
import { AppError, toProblem } from '@app/kernel';
import type { TopicSource } from '@app/live';
import type { z } from 'zod';

import type { MetricsActionDeps } from '../deps';

import { queueKeyOf, seriesKey, type SeriesInfo } from './store-hot';
import { requireVisible } from './visible';

type Params = z.infer<typeof MetricsLiveParamsSchema>;
type Item = z.infer<typeof MetricsLiveItemSchema>;

export interface LiveSource extends TopicSource<Params, Item> {
  /** Ends every subscription (the engine is stopping) and refuses new ones. */
  stop(): void;
}

const shuttingDown = (): Problem =>
  toProblem(
    new AppError('ENGINE_SHUTTING_DOWN', {
      detail: 'The engine is shutting down.',
    }),
  );

function seriesItem(info: SeriesInfo, point: { t: number; v: number }): Item {
  const { parts } = info;
  return {
    key: seriesKey(parts),
    ref: {
      metric: parts.metric,
      ...(parts.node === undefined ? {} : { node: parts.node }),
      ...(parts.vhost === undefined || parts.queue === undefined
        ? {}
        : { queue: { vhost: parts.vhost, name: parts.queue } }),
    },
    t: Math.round(point.t),
    v: point.v,
    approximate: info.approximate,
  };
}

export function createLiveSource(
  deps: Pick<MetricsActionDeps, 'connections' | 'collector'>,
): LiveSource {
  /** Live subscriptions admitted for a (principal, connection): what the snapshot may show. */
  const admitted = new Map<string, number>();
  const live = new Set<(problem?: Problem) => void>();
  let closed = false;
  const clearance = (principal: { id: string }, cid: ConnectionId): string =>
    `${principal.id}\u0000${cid}`;

  const included = (params: Params) => {
    const wanted = new Set(
      params.queues.map((queue) => queueKeyOf(queue.vhost, queue.name)),
    );
    return (info: SeriesInfo): boolean =>
      info.def.scope !== 'queue' ||
      (info.parts.vhost !== undefined &&
        info.parts.queue !== undefined &&
        wanted.has(queueKeyOf(info.parts.vhost, info.parts.queue)));
  };

  const statusItem = (cid: ConnectionId): Item => ({
    key: METRICS_STATUS_KEY,
    status: deps.collector.status(cid),
  });

  return {
    snapshot(params, principal) {
      const items: Item[] = [];
      if (admitted.has(clearance(principal, params.cid))) {
        for (const { info, point } of deps.collector.store.latest(
          params.cid,
          included(params),
        )) {
          items.push(seriesItem(info, point));
        }
        items.push(statusItem(params.cid));
      }
      // The hub ends a subscription whose snapshot is over a frame (OQ-125): the size is measured.
      return {
        value: items,
        bytes: Buffer.byteLength(JSON.stringify(items)),
      };
    },

    subscribe(params, principal, sink) {
      const id = clearance(principal, params.cid);
      const include = included(params);
      /** The newest time published per series, and the last status, so only changes go out. */
      const published = new Map<string, number>();
      let lastStatus = '';
      let phase: 'admitting' | 'following' | 'stopped' = 'admitting';
      let unfollow: (() => void) | undefined;

      const stop = (problem?: Problem): void => {
        if (phase === 'stopped') return;
        if (phase === 'following') {
          const left = (admitted.get(id) ?? 1) - 1;
          if (left > 0) admitted.set(id, left);
          else admitted.delete(id);
        }
        phase = 'stopped';
        unfollow?.();
        live.delete(stop);
        if (problem !== undefined) sink.end(problem);
      };

      const publishChanges = (): void => {
        try {
          for (const { info, point } of deps.collector.store.latest(
            params.cid,
            include,
          )) {
            const item = seriesItem(info, point);
            if ((published.get(item.key) ?? -1) < point.t) {
              published.set(item.key, point.t);
              sink.publish(item);
            }
          }
          const status = statusItem(params.cid);
          const text = JSON.stringify(status.status);
          if (text !== lastStatus) {
            lastStatus = text;
            sink.publish(status);
          }
        } catch (error) {
          // A listener must never break the round that feeds it.
          stop(toProblem(error));
        }
      };

      live.add(stop);
      const admit = async (): Promise<void> => {
        if (closed) throw new AppError('ENGINE_SHUTTING_DOWN');
        await requireVisible(deps.connections, params.cid, principal.id);
      };
      admit()
        .then(() => {
          if (phase !== 'admitting') return;
          phase = 'following';
          admitted.set(id, (admitted.get(id) ?? 0) + 1);
          deps.collector.touch(
            params.cid,
            params.queues.map((queue) => ({
              vhost: queue.vhost,
              name: queue.name,
            })),
          );
          unfollow = deps.collector.onRound(params.cid, publishChanges);
          publishChanges();
        })
        .catch((error: unknown) => {
          stop(toProblem(error));
        });
      return () => {
        stop();
      };
    },

    stop() {
      closed = true;
      for (const end of [...live]) end(shuttingDown());
    },
  };
}
