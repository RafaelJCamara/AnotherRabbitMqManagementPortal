// How stored series become answers: the series named by a contract `SeriesRef`, the time range, the
// thinning to `maxPoints` and the counter-to-rate view. Pure over the store's read; no I/O.
import { AppError } from '@app/kernel';
import {
  type ConnectionId,
  type MetricsQueryInputSchema,
  type MetricsSeriesResultSchema,
} from '@app/contracts';
import { counterRate, type Point } from '@app/forecast';
import type { z } from 'zod';

import { METRICS } from './catalog';
import type { HotStore, SeriesParts } from './store-hot';

type SeriesRef = z.infer<typeof MetricsQueryInputSchema>['series'][number];
export type SeriesResult = z.infer<typeof MetricsSeriesResultSchema>;

/** The stored series a reference names; a reference whose shape does not fit its metric is refused. */
export function partsOf(ref: SeriesRef): SeriesParts {
  const scope = METRICS[ref.metric].scope;
  const fits =
    scope === 'cluster'
      ? ref.node === undefined && ref.queue === undefined
      : scope === 'node'
        ? ref.node !== undefined && ref.queue === undefined
        : ref.queue !== undefined && ref.node === undefined;
  if (!fits) {
    throw new AppError('VALIDATION_FAILED', {
      detail: `The metric ${ref.metric} is a ${scope} metric: ${
        scope === 'cluster'
          ? 'it names neither a node nor a queue'
          : scope === 'node'
            ? 'it names its node'
            : 'it names its queue'
      }.`,
    });
  }
  return {
    metric: ref.metric,
    ...(ref.node === undefined ? {} : { node: ref.node }),
    ...(ref.queue === undefined
      ? {}
      : { vhost: ref.queue.vhost, queue: ref.queue.name }),
  };
}

/** At most `max` points, the last of each equal stretch, so the newest point always survives. */
export function thin(points: readonly Point[], max: number): Point[] {
  if (points.length <= max) return [...points];
  const stride = points.length / max;
  const out: Point[] = [];
  for (let bucket = 1; bucket <= max; bucket++) {
    const point =
      points[Math.min(points.length - 1, Math.ceil(bucket * stride) - 1)];
    if (point !== undefined) out.push(point);
  }
  return out;
}

export interface Range {
  readonly from?: number | undefined;
  readonly to?: number | undefined;
}

export const inRange = (points: readonly Point[], range: Range): Point[] =>
  points.filter(
    (point) =>
      (range.from === undefined || point.t >= range.from) &&
      (range.to === undefined || point.t <= range.to),
  );

export function resultOf(
  store: HotStore,
  cid: ConnectionId,
  ref: SeriesRef,
  options: { range: Range; maxPoints: number; rate: boolean },
): SeriesResult {
  const held = store.read(cid, partsOf(ref));
  if (held === undefined) {
    return {
      ref,
      found: false,
      view: 'value',
      points: [],
      dropped: 0,
    };
  }
  const windowed = inRange(held.points, options.range);
  const asRate = options.rate && held.info.def.kind === 'counter';
  const shaped = asRate ? counterRate(windowed) : windowed;
  return {
    ref,
    found: true,
    kind: held.info.def.kind,
    unit: held.info.def.unit,
    source: held.info.source,
    approximate: held.info.approximate,
    view: asRate ? 'rate' : 'value',
    points: thin(shaped, options.maxPoints).map(
      (point) => [Math.round(point.t), point.v] as [number, number],
    ),
    dropped: held.dropped,
  };
}

/** The depth series a forecast reads: the total when the source has it, else the ready count. */
export function depthOf(
  store: HotStore,
  cid: ConnectionId,
  target:
    | { scope: 'cluster' }
    | { scope: 'queue'; vhost: string; name: string },
): {
  metric:
    | 'messages'
    | 'messages_ready'
    | 'queue_messages'
    | 'queue_messages_ready';
  points: Point[];
} {
  const choices =
    target.scope === 'cluster'
      ? (['messages', 'messages_ready'] as const)
      : (['queue_messages', 'queue_messages_ready'] as const);
  for (const metric of choices) {
    const parts: SeriesParts =
      target.scope === 'cluster'
        ? { metric }
        : { metric, vhost: target.vhost, queue: target.name };
    const held = store.read(cid, parts);
    if (held !== undefined) return { metric, points: [...held.points] };
  }
  return { metric: choices[0], points: [] };
}
