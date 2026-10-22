// metrics.query: Read windows of metric series of a connection
// A read of what the hot store holds, thinned to the caller's `maxPoints`. It asks the collector for
// demand (a first call starts the collection and answers `loading` until a round has finished) but
// never scrapes itself: the BrokerScheduler's pacing is the collector's business (I-8).
import { metricsQuery } from '@app/contracts';
import { implementAction, type ActionImpl } from '@app/kernel';

import type { MetricsActionDeps } from '../deps';
import { resultOf } from '../internal/views';
import { requireVisible } from '../internal/visible';

/** The ports this action reads through: a subset of the module's deps (src/deps.ts) and the collector. */
export type MetricsQueryDeps = Pick<
  MetricsActionDeps,
  'connections' | 'collector'
>;

export const createMetricsQueryAction = (
  deps: MetricsQueryDeps,
): ActionImpl<typeof metricsQuery> =>
  implementAction(metricsQuery, {
    execute: async (input, ctx) => {
      await requireVisible(deps.connections, input.cid, ctx.principal.id);
      const results = input.series.map((ref) =>
        resultOf(deps.collector.store, input.cid, ref, {
          range: { from: input.from, to: input.to },
          maxPoints: input.maxPoints,
          rate: input.rate === true,
        }),
      );
      // Demand after validation: a malformed reference starts nothing.
      deps.collector.touch(
        input.cid,
        input.series.flatMap((ref) =>
          ref.queue === undefined
            ? []
            : [{ vhost: ref.queue.vhost, name: ref.queue.name }],
        ),
      );
      return { series: results, status: deps.collector.status(input.cid) };
    },
  });
